// Draws counting lines, tracked vehicles and trails over the video, in video pixel space
// mapped onto the letterboxed area where <video object-fit: contain> shows the frame.

const CLASS_COLORS = {
  car: '#4fc3f7',
  truck: '#ff8a65',
  bus: '#ba68c8',
  motorcycle: '#81c784',
  bicycle: '#f06292',
  person: '#e0e0e0',
};
const FALLBACK = ['#4fc3f7', '#ff8a65', '#ba68c8', '#81c784', '#f06292', '#ffd54f', '#4db6ac', '#e0e0e0'];
const MARKING = '#f2b705';

export function classColor(names, cls) {
  const n = names?.[cls];
  return CLASS_COLORS[n] || FALLBACK[cls % FALLBACK.length];
}

export class Overlay {
  constructor(canvas, video) {
    this.canvas = canvas;
    this.video = video;
    this.ctx = canvas.getContext('2d');
    this.dpr = 1;
    this.rect = { x: 0, y: 0, w: 1, h: 1, k: 1 };
    this.flash = new Map(); // lineId -> time of last count
  }

  /** Recompute canvas size and the on-screen rectangle of the video frame. */
  layout() {
    const c = this.canvas;
    const cw = c.clientWidth;
    const ch = c.clientHeight;
    this.dpr = Math.min(3, window.devicePixelRatio || 1);
    const W = Math.round(cw * this.dpr);
    const H = Math.round(ch * this.dpr);
    if (c.width !== W || c.height !== H) {
      c.width = W;
      c.height = H;
    }
    const vw = this.video.videoWidth || 16;
    const vh = this.video.videoHeight || 9;
    const k = Math.min(cw / vw, ch / vh);
    this.rect = { x: (cw - vw * k) / 2, y: (ch - vh * k) / 2, w: vw * k, h: vh * k, k, vw, vh };
  }

  /** client (CSS px, relative to canvas) -> normalised 0..1 frame coordinates */
  toNorm(clientX, clientY) {
    const b = this.canvas.getBoundingClientRect();
    const r = this.rect;
    return {
      x: clamp((clientX - b.left - r.x) / r.w, 0, 1),
      y: clamp((clientY - b.top - r.y) / r.h, 0, 1),
    };
  }

  normToScreen(p) {
    const r = this.rect;
    return { x: r.x + p.x * r.w, y: r.y + p.y * r.h };
  }

  /**
   * @param {object} s
   * @param {Array} s.lines [{id,name,a:{x,y},b:{x,y},counts}] normalised coordinates
   * @param {Array} s.tracks confirmed tracks with box in video pixels
   * @param {object} s.show {boxes, labels, trails}
   * @param {string[]} s.names class names
   * @param {boolean} s.editing show drag handles
   * @param {object|null} s.pending first point of a line being placed
   * @param {string|null} s.activeLine id of the line being dragged
   */
  draw(s) {
    const ctx = this.ctx;
    const d = this.dpr;
    ctx.setTransform(d, 0, 0, d, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width / d, this.canvas.height / d);
    const r = this.rect;
    const k = r.k;
    const now = performance.now();

    if (s.tracks && this.video.videoWidth) {
      ctx.lineJoin = 'round';
      for (const tr of s.tracks) {
        const col = classColor(s.names, tr.cls);
        if (s.show.trails && tr.trail.length > 1) {
          ctx.beginPath();
          tr.trail.forEach(([x, y], i) => {
            const X = r.x + x * k;
            const Y = r.y + y * k;
            if (i === 0) ctx.moveTo(X, Y);
            else ctx.lineTo(X, Y);
          });
          ctx.strokeStyle = col;
          ctx.globalAlpha = 0.55;
          ctx.lineWidth = 2;
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
        const [x1, y1, x2, y2] = tr.box;
        const X = r.x + x1 * k;
        const Y = r.y + y1 * k;
        const w = (x2 - x1) * k;
        const h = (y2 - y1) * k;
        if (s.show.boxes) {
          ctx.lineWidth = 2;
          ctx.strokeStyle = 'rgba(0,0,0,0.55)';
          ctx.strokeRect(X - 1, Y - 1, w + 2, h + 2);
          ctx.strokeStyle = col;
          ctx.strokeRect(X, Y, w, h);
        }
        if (s.show.labels) {
          const label = `${tr.id} ${s.names?.[tr.cls] ?? tr.cls}`;
          ctx.font = '700 12px Overpass, system-ui, sans-serif';
          const tw = ctx.measureText(label).width + 8;
          const ly = Y > 16 ? Y - 16 : Y + h;
          ctx.fillStyle = col;
          ctx.fillRect(X, ly, tw, 16);
          ctx.fillStyle = '#10171d';
          ctx.fillText(label, X + 4, ly + 12);
        }
      }
    }

    for (const line of s.lines) {
      const a = this.normToScreen(line.a);
      const b = this.normToScreen(line.b);
      const flashAge = now - (this.flash.get(line.id) || -1e9);
      const hot = flashAge < 450;
      // dark casing + yellow road marking
      ctx.lineCap = 'round';
      ctx.strokeStyle = 'rgba(16,23,29,0.75)';
      ctx.lineWidth = hot ? 11 : 8;
      line2(ctx, a, b);
      ctx.strokeStyle = hot ? '#ffffff' : MARKING;
      ctx.lineWidth = hot ? 7 : 4;
      line2(ctx, a, b);

      // direction chevron on the "in" (right-hand) side + counts
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const nx = -(b.y - a.y) / len;
      const ny = (b.x - a.x) / len;
      chevron(ctx, mx + nx * 14, my + ny * 14, nx, ny);

      const c = line.counts || { in: 0, out: 0 };
      const text = `${line.name}   in ${c.in}   out ${c.out}`;
      ctx.font = '800 13px Overpass, system-ui, sans-serif';
      const tw = ctx.measureText(text).width + 14;
      // put the label on the "out" side, far enough that it never sits on the line
      const off = Math.abs(nx) * (tw / 2) + Math.abs(ny) * 11 + 10;
      let lx = mx - nx * off - tw / 2;
      let ly = my - ny * off - 11;
      lx = clamp(lx, 4, this.canvas.width / d - tw - 4);
      ly = clamp(ly, 4, this.canvas.height / d - 26);
      ctx.fillStyle = 'rgba(16,23,29,0.82)';
      roundRect(ctx, lx, ly, tw, 22, 11);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.fillText(text, lx + 7, ly + 15.5);

      if (s.editing) {
        for (const p of [a, b]) {
          ctx.beginPath();
          ctx.arc(p.x, p.y, line.id === s.activeLine ? 13 : 10, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(16,23,29,0.6)';
          ctx.fill();
          ctx.lineWidth = 3;
          ctx.strokeStyle = MARKING;
          ctx.stroke();
        }
      }
    }

    if (s.pending) {
      const p = this.normToScreen(s.pending);
      ctx.beginPath();
      ctx.arc(p.x, p.y, 10, 0, Math.PI * 2);
      ctx.lineWidth = 3;
      ctx.strokeStyle = MARKING;
      ctx.stroke();
    }
  }

  /** true while a line is still flashing (caller keeps redrawing) */
  isAnimating() {
    const now = performance.now();
    for (const t of this.flash.values()) if (now - t < 450) return true;
    return false;
  }

  hitHandle(lines, clientX, clientY) {
    const b = this.canvas.getBoundingClientRect();
    const x = clientX - b.left;
    const y = clientY - b.top;
    let best = null;
    let bd = 28; // generous touch target
    for (const line of lines) {
      for (const end of ['a', 'b']) {
        const p = this.normToScreen(line[end]);
        const dd = Math.hypot(p.x - x, p.y - y);
        if (dd < bd) {
          bd = dd;
          best = { line, end };
        }
      }
    }
    return best;
  }
}

function line2(ctx, a, b) {
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
}

function chevron(ctx, x, y, nx, ny) {
  const tx = -ny;
  const ty = nx;
  ctx.beginPath();
  ctx.moveTo(x + tx * 8, y + ty * 8);
  ctx.lineTo(x + nx * 9, y + ny * 9);
  ctx.lineTo(x - tx * 8, y - ty * 8);
  ctx.lineWidth = 5;
  ctx.strokeStyle = 'rgba(16,23,29,0.75)';
  ctx.stroke();
  ctx.lineWidth = 3;
  ctx.strokeStyle = MARKING;
  ctx.stroke();
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h);
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}
