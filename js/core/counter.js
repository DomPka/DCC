// Direction-aware line-crossing counter.
// A track is counted when its anchor point moves from one side of a counting line to the
// other *within the line's extent*. A small hysteresis band (scaled to the vehicle's size)
// stops box jitter around the line from producing counts, and each track is counted at
// most once per line, so a car queueing on the line is never counted twice.

export const ANCHORS = {
  center: (b) => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2],
  bottom: (b) => [(b[0] + b[2]) / 2, b[3]],
};

export class LineCounter {
  /**
   * @param {object} opts
   * @param {'center'|'bottom'} [opts.anchor]
   * @param {number} [opts.bandFrac] hysteresis half-width as a fraction of box height
   * @param {number} [opts.extentMargin] tolerance past the line ends, fraction of length
   */
  constructor(opts = {}) {
    this.anchor = opts.anchor || 'center';
    this.bandFrac = opts.bandFrac ?? 0.1;
    this.extentMargin = opts.extentMargin ?? 0.02;
    this.lines = [];
    this.events = [];
    this.state = new Map(); // `${trackKey}|${lineId}` -> {side, x, y}
    this.counted = new Set(); // `${trackKey}|${lineId}`
  }

  /** lines: [{id, name, ax, ay, bx, by}] in source pixels. Keeps counts of lines that persist. */
  setLines(lines) {
    const old = new Map(this.lines.map((l) => [l.id, l]));
    this.lines = lines.map((l) => {
      const prev = old.get(l.id);
      const geometryChanged = prev && (prev.ax !== l.ax || prev.ay !== l.ay || prev.bx !== l.bx || prev.by !== l.by);
      if (geometryChanged) this.forgetLine(l.id);
      return {
        ...l,
        counts: prev ? prev.counts : emptyCounts(),
      };
    });
  }

  forgetLine(lineId) {
    const suffix = `|${lineId}`;
    for (const k of this.state.keys()) if (k.endsWith(suffix)) this.state.delete(k);
  }

  /** Swap a line's direction: A<->B, in<->out for counts, history and per-track sides. */
  flipLine(lineId) {
    const l = this.lines.find((x) => x.id === lineId);
    if (!l) return;
    [l.ax, l.ay, l.bx, l.by] = [l.bx, l.by, l.ax, l.ay];
    const c = l.counts;
    l.counts = { in: c.out, out: c.in, byClass: { in: c.byClass.out, out: c.byClass.in } };
    for (const e of this.events) if (e.lineId === lineId) e.dir = e.dir === 'in' ? 'out' : 'in';
    const suffix = `|${lineId}`;
    for (const [k, st] of this.state) if (k.endsWith(suffix)) st.side = -st.side;
  }

  resetCounts() {
    for (const l of this.lines) l.counts = emptyCounts();
    this.events = [];
    this.state.clear();
    this.counted.clear();
  }

  /**
   * @param {Array} tracks confirmed tracks updated this frame: {key, id, cls, box:[x1,y1,x2,y2]}
   * @param {number} t video time in seconds
   * @returns {Array} new crossing events
   */
  update(tracks, t) {
    const out = [];
    const anchorFn = ANCHORS[this.anchor] || ANCHORS.center;
    for (const tr of tracks) {
      const [px, py] = anchorFn(tr.box);
      const bh = Math.max(1, tr.box[3] - tr.box[1]);
      const band = Math.max(1, this.bandFrac * bh);
      for (const line of this.lines) {
        const dx = line.bx - line.ax;
        const dy = line.by - line.ay;
        const len = Math.hypot(dx, dy);
        if (len < 1) continue;
        // signed distance; positive = right-hand side of A->B on screen
        const dist = (dx * (py - line.ay) - dy * (px - line.ax)) / len;
        const side = dist > band ? 1 : dist < -band ? -1 : 0;
        const key = `${tr.key}|${line.id}`;
        const st = this.state.get(key);
        if (!st) {
          if (side !== 0) this.state.set(key, { side, x: px, y: py });
          continue;
        }
        if (side === 0) continue;
        if (side !== st.side) {
          if (!this.counted.has(key) && withinExtent(line, dx, dy, len, st.x, st.y, px, py, this.extentMargin)) {
            const dir = side > 0 ? 'in' : 'out';
            this.counted.add(key);
            const c = line.counts;
            c[dir]++;
            c.byClass[dir][tr.cls] = (c.byClass[dir][tr.cls] || 0) + 1;
            const ev = { t, lineId: line.id, lineName: line.name, dir, trackId: tr.id, cls: tr.cls };
            this.events.push(ev);
            out.push(ev);
          }
          st.side = side;
        }
        st.x = px;
        st.y = py;
      }
    }
    return out;
  }

  /** Drop per-track state for tracks the tracker no longer knows. */
  prune(liveKeys) {
    for (const k of this.state.keys()) {
      const trackKey = Number(k.slice(0, k.indexOf('|')));
      if (!liveKeys.has(trackKey)) this.state.delete(k);
    }
  }

  totals() {
    let tin = 0;
    let tout = 0;
    for (const l of this.lines) {
      tin += l.counts.in;
      tout += l.counts.out;
    }
    return { in: tin, out: tout, total: tin + tout };
  }
}

function emptyCounts() {
  return { in: 0, out: 0, byClass: { in: {}, out: {} } };
}

// Where does the movement segment P0->P1 cross the line A->B? Accept if the crossing point
// lies on the drawn segment (plus a small margin).
function withinExtent(line, dx, dy, len, x0, y0, x1, y1, margin) {
  const mx = x1 - x0;
  const my = y1 - y0;
  const denom = dx * my - dy * mx;
  let u;
  if (Math.abs(denom) < 1e-9) {
    u = ((x1 - line.ax) * dx + (y1 - line.ay) * dy) / (len * len);
  } else {
    // solve A + u*(B-A) = P0 + s*(P1-P0)
    u = ((x0 - line.ax) * my - (y0 - line.ay) * mx) / denom;
  }
  return u >= -margin && u <= 1 + margin;
}
