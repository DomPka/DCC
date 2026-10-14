// Small SVG chart kit for the analytics page: stacked columns, horizontal bar lists and a
// heatmap. Marks follow fixed specs (<=24px bars, 4px rounded data ends, 2px surface gaps,
// hairline grid); one shared tooltip; all text set with textContent.

const NS = 'http://www.w3.org/2000/svg';

function el(name, attrs = {}, parent) {
  const n = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) n.setAttribute(k, String(v));
  if (parent) parent.append(n);
  return n;
}

function text(parent, x, y, str, attrs = {}) {
  const t = el('text', { x, y, ...attrs }, parent);
  t.textContent = str;
  return t;
}

export function niceScale(max, ticks = 4) {
  if (!(max > 0)) return { max: 1, step: 1, ticks: [0, 1] };
  const raw = max / ticks;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || 10 * mag;
  const top = Math.ceil(max / step) * step;
  const out = [];
  for (let v = 0; v <= top + step / 2; v += step) out.push(Number(v.toFixed(6)));
  return { max: top, step, ticks: out };
}

export function compact(v) {
  if (v >= 1e6) return `${trim(v / 1e6)}M`;
  if (v >= 1e4) return `${trim(v / 1e3)}K`;
  if (v >= 1e3) return `${trim(v / 1e3)}K`;
  return Number.isInteger(v) ? String(v) : v.toFixed(v < 10 ? 1 : 0);
}
function trim(v) {
  return v >= 100 ? v.toFixed(0) : v.toFixed(1).replace(/\.0$/, '');
}

// rounded top corners only (data end), square at the baseline
function columnPath(x, y, w, h, r) {
  r = Math.min(r, w / 2, h);
  if (h <= 0) return '';
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}
function barPath(x, y, w, h, r) {
  r = Math.min(r, h / 2, w);
  if (w <= 0) return '';
  return `M${x},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h - r}Q${x + w},${y + h} ${x + w - r},${y + h}H${x}Z`;
}

// ------------------------------------------------------------------ tooltip
let tip;
function tooltip() {
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'viz-tip';
    tip.hidden = true;
    document.body.append(tip);
  }
  return tip;
}

/** rows: [{value, label, color}] ; head: string ; foot: string */
function showTip(evt, { head, rows = [], foot }) {
  const t = tooltip();
  t.textContent = '';
  if (head) {
    const h = document.createElement('div');
    h.className = 'viz-tip-head';
    h.textContent = head;
    t.append(h);
  }
  for (const r of rows) {
    const row = document.createElement('div');
    row.className = 'viz-tip-row';
    const key = document.createElement('span');
    key.className = 'viz-tip-key';
    if (r.color) key.style.background = r.color;
    const v = document.createElement('b');
    v.textContent = r.value;
    const l = document.createElement('span');
    l.textContent = r.label;
    row.append(key, v, l);
    t.append(row);
  }
  if (foot) {
    const f = document.createElement('div');
    f.className = 'viz-tip-foot';
    f.textContent = foot;
    t.append(f);
  }
  t.hidden = false;
  const pad = 14;
  const r = t.getBoundingClientRect();
  let x = evt.clientX + pad;
  let y = evt.clientY + pad;
  if (x + r.width > innerWidth - 8) x = evt.clientX - r.width - pad;
  if (y + r.height > innerHeight - 8) y = evt.clientY - r.height - pad;
  t.style.left = `${Math.max(8, x)}px`;
  t.style.top = `${Math.max(8, y)}px`;
}
export function hideTip() {
  if (tip) tip.hidden = true;
}

function bindHover(target, getTip) {
  target.addEventListener('pointermove', (e) => {
    const info = getTip(e);
    if (info) showTip(e, info);
    else hideTip();
  });
  target.addEventListener('pointerleave', hideTip);
}

// ------------------------------------------------------------------ stacked columns
/**
 * @param {HTMLElement} host
 * @param {object} o
 * @param {string[]} o.labels x category labels
 * @param {(i:number)=>boolean} [o.showLabel] which x labels to print
 * @param {Array<{name, color, values:number[]}>} o.series stacked bottom-up in this order
 * @param {number[]} [o.watched] 0..1 per column, drawn as a thin strip under the axis
 * @param {(i:number)=>object} o.tip tooltip content for column i
 * @param {string} o.ariaLabel
 */
export function columnChart(host, o) {
  host.textContent = '';
  const W = Math.max(280, host.clientWidth);
  const H = o.height || 260;
  const n = o.labels.length;
  const totals = o.labels.map((_, i) => o.series.reduce((s, se) => s + (se.values[i] || 0), 0));
  const sc = niceScale(Math.max(...totals, 0));
  const tickLabels = sc.ticks.map(compact);
  const left = 10 + Math.max(...tickLabels.map((t) => t.length)) * 7.5;
  const right = 8;
  const top = 10;
  const stripH = o.watched ? 10 : 0;
  const bottom = 26 + stripH;
  const pw = W - left - right;
  const ph = H - top - bottom;
  const band = pw / n;
  const bw = Math.max(2, Math.min(24, band * 0.72));
  const y = (v) => top + ph - (v / sc.max) * ph;

  const svg = el('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': o.ariaLabel, class: 'viz-svg' }, host);
  const grid = el('g', { class: 'viz-grid' }, svg);
  sc.ticks.forEach((t, i) => {
    const yy = Math.round(y(t)) + 0.5;
    el('line', { x1: left, x2: W - right, y1: yy, y2: yy }, grid);
    text(svg, left - 8, yy + 4, tickLabels[i], { class: 'viz-tick', 'text-anchor': 'end' });
  });

  const marks = el('g', {}, svg);
  for (let i = 0; i < n; i++) {
    const x = left + i * band + (band - bw) / 2;
    let base = 0;
    const segs = o.series.map((se) => ({ se, v: se.values[i] || 0 })).filter((s) => s.v > 0);
    segs.forEach((s, k) => {
      const y0 = y(base);
      const y1 = y(base + s.v);
      base += s.v;
      const isTop = k === segs.length - 1;
      const gap = k > 0 ? 2 : 0; // surface gap between stacked segments
      const h = y0 - y1 - gap;
      if (h <= 0.4) return;
      el('path', { d: isTop ? columnPath(x, y1, bw, h, 4) : `M${x},${y1}h${bw}v${h}h${-bw}Z`, fill: s.se.color, class: 'viz-mark' }, marks);
    });
    if (o.watched) {
      const sy = H - 22 - stripH + 4;
      el('rect', { x, y: sy, width: bw, height: 4, rx: 1, class: 'viz-strip-track' }, svg);
      const f = Math.max(0, Math.min(1, o.watched[i] || 0));
      if (f > 0) el('rect', { x, y: sy, width: bw * f, height: 4, rx: 1, class: 'viz-strip-fill' }, svg);
    }
    if (!o.showLabel || o.showLabel(i, band)) {
      text(svg, left + i * band + band / 2, H - 6, o.labels[i], { class: 'viz-tick', 'text-anchor': 'middle' });
    }
  }
  el('line', { x1: left, x2: W - right, y1: top + ph + 0.5, y2: top + ph + 0.5, class: 'viz-axis' }, svg);

  const hover = el('rect', { x: left, y: top, width: pw, height: ph + stripH + 6, fill: 'transparent' }, svg);
  const hl = el('rect', { x: 0, y: top, width: band, height: ph, class: 'viz-hover', visibility: 'hidden' }, svg);
  svg.insertBefore(hl, marks);
  bindHover(hover, (e) => {
    const r = svg.getBoundingClientRect();
    const i = Math.floor((e.clientX - r.left - left) / band);
    if (i < 0 || i >= n) {
      hl.setAttribute('visibility', 'hidden');
      return null;
    }
    hl.setAttribute('x', left + i * band);
    hl.setAttribute('visibility', 'visible');
    return o.tip(i);
  });
  hover.addEventListener('pointerleave', () => hl.setAttribute('visibility', 'hidden'));
}

// ------------------------------------------------------------------ horizontal bar list
/**
 * rows: [{label, bars: [{name, color, value}]}] ; one bar per series per row (grouped)
 */
export function barList(host, { rows, ariaLabel, format = (v) => v.toLocaleString() }) {
  host.textContent = '';
  const W = Math.max(260, host.clientWidth);
  const perRow = Math.max(...rows.map((r) => r.bars.length), 1);
  const barH = 16;
  const rowH = 22 + perRow * (barH + 4);
  const H = rows.length * rowH + 4;
  const max = Math.max(1, ...rows.flatMap((r) => r.bars.map((b) => b.value)));
  const labelW = 0;
  const valueW = 64;
  const pw = W - labelW - valueW;
  const svg = el('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': ariaLabel, class: 'viz-svg' }, host);
  rows.forEach((row, ri) => {
    const y0 = ri * rowH;
    text(svg, 0, y0 + 14, row.label, { class: 'viz-row-label' });
    row.bars.forEach((b, bi) => {
      const y = y0 + 20 + bi * (barH + 4);
      const w = Math.max(b.value > 0 ? 3 : 0, (b.value / max) * pw);
      el('rect', { x: 0, y, width: pw, height: barH, rx: 3, class: 'viz-track' }, svg);
      if (w > 0) el('path', { d: barPath(0, y, w, barH, 4), fill: b.color, class: 'viz-mark' }, svg);
      text(svg, w + 6, y + barH - 3, format(b.value), { class: 'viz-value' });
      const hit = el('rect', { x: 0, y: y - 2, width: W, height: barH + 4, fill: 'transparent' }, svg);
      bindHover(hit, () => ({ head: row.label, rows: [{ value: format(b.value), label: b.name, color: b.color }] }));
    });
  });
}

// ------------------------------------------------------------------ heatmap
/**
 * values[r][c] = number or null (no data). ramp: array of hex light->dark meaning low->high.
 */
export function heatmap(host, { rowLabels, colLabels, values, ramp, ariaLabel, tip, showCol }) {
  host.textContent = '';
  const W = Math.max(300, host.clientWidth);
  const left = 40;
  const top = 4;
  const bottom = 22;
  const cols = colLabels.length;
  const cw = (W - left) / cols;
  const ch = Math.min(28, Math.max(18, cw));
  const H = top + rowLabels.length * ch + bottom;
  const all = values.flat().filter((v) => v !== null && v !== undefined);
  const max = Math.max(1e-9, ...all);
  const svg = el('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': ariaLabel, class: 'viz-svg' }, host);
  rowLabels.forEach((rl, r) => {
    text(svg, left - 8, top + r * ch + ch / 2 + 4, rl, { class: 'viz-tick', 'text-anchor': 'end' });
    for (let c = 0; c < cols; c++) {
      const v = values[r][c];
      const x = left + c * cw;
      const y = top + r * ch;
      if (v === null || v === undefined) {
        el('rect', { x: x + 1, y: y + 1, width: cw - 2, height: ch - 2, rx: 2, class: 'viz-empty' }, svg);
      } else {
        const idx = Math.min(ramp.length - 1, Math.floor((v / max) * (ramp.length - 1) + 0.5));
        el('rect', { x: x + 1, y: y + 1, width: cw - 2, height: ch - 2, rx: 2, fill: ramp[idx], class: 'viz-mark' }, svg);
      }
      const hit = el('rect', { x, y, width: cw, height: ch, fill: 'transparent' }, svg);
      bindHover(hit, () => tip(r, c));
    }
  });
  colLabels.forEach((cl, c) => {
    if (!showCol || showCol(c, cw)) text(svg, left + c * cw + cw / 2, H - 6, cl, { class: 'viz-tick', 'text-anchor': 'middle' });
  });
  return { max };
}
