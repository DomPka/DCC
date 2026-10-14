// Traffic analytics: hourly, daily and weekday patterns from the counting station's
// published data, from counts made in this browser, or from an exported CSV.
import { DayBins, weekday, addDays, wallParts } from './core/countdata.js';
import { listSessions, sessionDays, deleteSession } from './sessions.js';
import { columnChart, barList, heatmap, compact, hideTip } from './charts.js';

const $ = (id) => document.getElementById(id);
const store = {
  get: (k) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k, v) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* ignore */
    }
  },
};

// Vehicle types keep one colour slot each, whatever is filtered (colour follows the entity).
const CLASS_SLOT = { car: 1, truck: 2, bus: 3, motorcycle: 4, bicycle: 5, person: 6, van: 7, 'cargo-trike': 7, tram: 8 };
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const RAMP_LIGHT = ['#cde2fb', '#b7d3f6', '#9ec5f4', '#86b6ef', '#6da7ec', '#5598e7', '#3987e5', '#2a78d6', '#256abf', '#1c5cab', '#184f95', '#104281', '#0d366b'];
const RAMP_DARK = ['#0d366b', '#104281', '#184f95', '#1c5cab', '#256abf', '#2a78d6', '#3987e5', '#5598e7', '#6da7ec', '#86b6ef'];

const state = {
  source: null, // {kind, index, getDay(date), timezone}
  filters: { range: '7', from: null, to: null, line: 'all', dir: 'both', excluded: new Set() },
  dayCache: new Map(),
  unknownSlots: new Map(),
  lastRender: null,
  refreshTimer: null,
};

init();

async function init() {
  bindFilters();
  const params = new URLSearchParams(location.search);
  if (params.get('source') === 'device') {
    $('f-source').value = 'device';
    return loadDevice();
  }
  const remote = params.get('data') || (await stationDataUrl()) || store.get('cc.remote') || githubPagesGuess();
  if (remote) {
    $('f-remote').value = remote;
    await loadRemote(remote);
  } else {
    $('f-source').value = 'device';
    await loadDevice();
  }
}

async function stationDataUrl() {
  try {
    const r = await fetch('data/index.json', { cache: 'no-store' });
    if (r.ok && (r.headers.get('content-type') || '').includes('json')) {
      $('nav-station').hidden = false;
      return new URL('data/', location.href).href;
    }
  } catch {
    /* not on a station */
  }
  return null;
}

function githubPagesGuess() {
  const m = location.hostname.match(/^([^.]+)\.github\.io$/i);
  if (!m) return null;
  const seg = location.pathname.split('/').filter(Boolean)[0];
  const repo = seg && !seg.endsWith('.html') ? seg : `${m[1]}.github.io`;
  return `https://raw.githubusercontent.com/${m[1]}/${repo}/data/counts/`;
}

// ------------------------------------------------------------------ sources
async function loadRemote(base) {
  base = base.endsWith('/') ? base : `${base}/`;
  $('sessions').hidden = true;
  setLoading(true);
  try {
    const res = await fetch(`${base}index.json`, { cache: 'no-store' });
    if (!res.ok) throw new Error(res.status === 404 ? 'no data published there yet' : `HTTP ${res.status}`);
    const index = await res.json();
    state.dayCache = new Map();
    state.source = {
      kind: 'remote',
      base,
      index,
      timezone: index.timezone || null,
      getDay: async (date) => {
        if (!index.days.some((d) => d.date === date)) return null;
        const r = await fetch(`${base}days/${date}.json`, { cache: 'no-store' });
        return r.ok ? DayBins.fromJSON(await r.json()) : null;
      },
    };
    store.set('cc.remote', base);
    $('remote-setup').hidden = true;
    $('f-source').value = 'remote';
    afterLoad();
    clearInterval(state.refreshTimer);
    state.refreshTimer = setInterval(refreshRemote, 60000);
  } catch (err) {
    setLoading(false);
    $('f-source').value = 'remote';
    $('remote-setup').hidden = false;
    showEmpty(`Could not load station data from that address (${err.message}). Check the address, or choose another data source.`);
  }
}

async function refreshRemote() {
  const src = state.source;
  if (src?.kind !== 'remote' || document.hidden) return;
  try {
    const res = await fetch(`${src.base}index.json`, { cache: 'no-store' });
    if (!res.ok) return;
    src.index = await res.json();
    const today = todayStr();
    for (const k of [...state.dayCache.keys()]) if (k >= addDays(today, -1)) state.dayCache.delete(k);
    afterLoad(true);
  } catch {
    /* keep showing the last data */
  }
}

async function loadDevice() {
  clearInterval(state.refreshTimer);
  setLoading(true);
  const sessions = await listSessions();
  const classes = [];
  const lines = new Map();
  const merged = new Map();
  let undated = 0;
  for (const s of sessions) {
    const days = sessionDays(s);
    if (!days) {
      undated++;
      continue;
    }
    const remap = (s.classes || []).map((n) => {
      let i = classes.indexOf(n);
      if (i < 0) i = classes.push(n) - 1;
      return i;
    });
    for (const l of s.lines || []) lines.set(l.id, l.name);
    for (const [date, d] of days) {
      if (!merged.has(date)) merged.set(date, new DayBins(date));
      const m = merged.get(date);
      for (const [k, v] of d.rows) {
        const [h, line, dir, cls] = k.split('|');
        m.add(Number(h), line, dir, remap[Number(cls)] ?? Number(cls), v);
      }
      d.coverage.forEach((sec, h) => sec && m.addCoverage(h, sec));
    }
  }
  drawSessions(sessions);
  useLocal('device', merged, classes, lines, undated ? `${undated} counting session${undated > 1 ? 's have' : ' has'} no recording time and ${undated > 1 ? 'are' : 'is'} not shown. Set "Recording started at" in the counter to include ${undated > 1 ? 'them' : 'it'}.` : '');
}

function drawSessions(sessions) {
  const box = $('sessions');
  const ul = $('session-list');
  ul.textContent = '';
  box.hidden = !sessions.length;
  for (const s of sessions.sort((a, b) => (b.updated || '').localeCompare(a.updated || ''))) {
    const li = document.createElement('li');
    const info = document.createElement('span');
    const when = s.start ? `${s.start.slice(0, 10)} ${s.start.slice(11, 16)}` : 'no recording time';
    info.textContent = `${s.name} `;
    const small = document.createElement('small');
    small.textContent = `${when}, ${s.events.length} vehicles`;
    info.append(small);
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'btn btn-small an-btn';
    del.textContent = 'Delete';
    del.addEventListener('click', async () => {
      if (!confirm(`Delete the saved counts of "${s.name}"?`)) return;
      await deleteSession(s.id);
      loadDevice();
    });
    li.append(info, del);
    ul.append(li);
  }
}

function useLocal(kind, daysMap, classes, lines, note) {
  if (kind !== 'device') $('sessions').hidden = true;
  const days = [...daysMap.values()].sort((a, b) => a.date.localeCompare(b.date)).map((d) => ({ date: d.date, total: d.total(), coverageS: d.coverageSeconds() }));
  state.dayCache = new Map();
  state.source = {
    kind,
    index: { name: kind === 'device' ? 'This device' : 'CSV file', lines: [...lines].map(([id, name]) => ({ id, name })), classes, days, note },
    timezone: null,
    getDay: async (date) => daysMap.get(date) || null,
  };
  $('remote-setup').hidden = true;
  afterLoad();
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim()));
}

async function loadCsv(file) {
  const rows = parseCsv((await file.text()).replace(/^﻿/, ''));
  const head = rows.shift()?.map((h) => h.trim().toLowerCase()) || [];
  const ti = head.indexOf('clock_time') >= 0 ? head.indexOf('clock_time') : head.indexOf('time');
  const li = head.indexOf('line');
  const di = head.indexOf('direction');
  const ci = head.indexOf('class');
  if (ti < 0 || li < 0 || di < 0) {
    showEmpty('That CSV is not a vehicle list. Use "Every vehicle" from the counter or an events file from the station.');
    return;
  }
  const classes = [];
  const lines = new Map();
  const days = new Map();
  let skipped = 0;
  for (const r of rows) {
    const m = (r[ti] || '').match(/^(\d{4}-\d\d-\d\d)[ T](\d\d):/);
    if (!m) {
      skipped++;
      continue;
    }
    const name = r[ci] || 'vehicle';
    let cls = classes.indexOf(name);
    if (cls < 0) cls = classes.push(name) - 1;
    const line = r[li] || 'Line';
    lines.set(line, line);
    if (!days.has(m[1])) days.set(m[1], new DayBins(m[1]));
    days.get(m[1]).add(Number(m[2]), line, r[di] === 'out' ? 'out' : 'in', cls, 1);
  }
  if (!days.size) {
    showEmpty('That file has no clock times. In the counter, set "Recording started at" before exporting, then try again.');
    return;
  }
  useLocal('csv', days, classes, lines, skipped ? `${skipped} rows without a clock time were skipped.` : '');
  state.source.noCoverage = true;
}

// ------------------------------------------------------------------ filters
function bindFilters() {
  $('f-source').addEventListener('change', async () => {
    const v = $('f-source').value;
    if (v === 'remote') {
      const saved = $('f-remote').value || store.get('cc.remote') || githubPagesGuess();
      if (saved) loadRemote(saved);
      else {
        $('remote-setup').hidden = false;
        showEmpty('Enter the address where your counting station publishes its data.');
      }
    } else if (v === 'device') loadDevice();
    else $('f-csv').click();
  });
  $('f-csv').addEventListener('change', () => {
    const f = $('f-csv').files[0];
    $('f-csv').value = '';
    if (f) loadCsv(f);
  });
  $('f-remote-load').addEventListener('click', () => $('f-remote').value && loadRemote($('f-remote').value.trim()));
  $('f-range').addEventListener('change', () => {
    state.filters.range = $('f-range').value;
    const custom = state.filters.range === 'custom';
    $('f-from-wrap').hidden = !custom;
    $('f-to-wrap').hidden = !custom;
    if (custom) {
      const r = resolveRange();
      $('f-from').value = r.from;
      $('f-to').value = r.to;
    }
    render();
  });
  for (const id of ['f-from', 'f-to']) $(id).addEventListener('change', render);
  $('f-line').addEventListener('change', () => {
    state.filters.line = $('f-line').value;
    render();
  });
  $('f-dir').addEventListener('change', () => {
    state.filters.dir = $('f-dir').value;
    render();
  });
  $('dl-csv').addEventListener('click', downloadTable);
  let w = innerWidth;
  addEventListener('resize', () => {
    if (Math.abs(innerWidth - w) > 20) {
      w = innerWidth;
      render();
    }
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => render());
}

function afterLoad(keepFilters = false) {
  const idx = state.source.index;
  const sel = $('f-line');
  const cur = sel.value;
  sel.textContent = '';
  sel.append(new Option('All lines', 'all'));
  for (const l of idx.lines || []) sel.append(new Option(l.name, l.id));
  sel.value = keepFilters && [...sel.options].some((o) => o.value === cur) ? cur : 'all';
  state.filters.line = sel.value;
  if (!keepFilters) {
    state.filters.excluded = new Set();
    state.unknownSlots = new Map();
    $('f-classes').dataset.key = '';
  }
  render();
}

/** Chips for the vehicle types present in the loaded period, in palette order. */
function buildChips(seen) {
  const idx = state.source.index;
  const chips = $('f-classes');
  const order = [...seen].filter((c) => idx.classes[c] !== undefined).sort((a, b) => slotOf(idx.classes[a]) - slotOf(idx.classes[b]) || a - b);
  const key = order.join(',');
  if (chips.dataset.key === key) return;
  chips.dataset.key = key;
  chips.textContent = '';
  for (const c of order) {
    const label = document.createElement('label');
    label.className = 'chip-toggle';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = String(c);
    cb.checked = !state.filters.excluded.has(c);
    const sw = document.createElement('span');
    sw.className = 'sw';
    sw.style.background = colorOf(idx.classes[c]);
    label.append(cb, sw, document.createTextNode(idx.classes[c]));
    cb.addEventListener('change', () => {
      if (cb.checked) state.filters.excluded.delete(c);
      else state.filters.excluded.add(c);
      render();
    });
    chips.append(label);
  }
}

function slotOf(name) {
  if (CLASS_SLOT[name]) return CLASS_SLOT[name];
  if (!state.unknownSlots.has(name)) state.unknownSlots.set(name, 7 + Math.min(2, state.unknownSlots.size));
  return state.unknownSlots.get(name); // 7, 8, then 9 = "other" grey
}

function colorOf(name) {
  const slot = slotOf(name);
  if (slot > 8) return '#8a96a0';
  return getComputedStyle(document.body).getPropertyValue(`--series-${slot}`).trim() || '#2a78d6';
}
function cssVar(n) {
  return getComputedStyle(document.body).getPropertyValue(n).trim();
}

function todayStr() {
  const tz = state.source?.timezone;
  if (tz) return wallParts(new Date(), tz).date;
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function resolveRange() {
  const days = state.source?.index.days || [];
  const today = todayStr();
  const r = state.filters.range;
  if (r === 'today') return { from: today, to: today };
  if (r === 'yesterday') return { from: addDays(today, -1), to: addDays(today, -1) };
  if (r === '7' || r === '30') return { from: addDays(today, -(Number(r) - 1)), to: today };
  if (r === 'all') return { from: days[0]?.date || today, to: days[days.length - 1]?.date || today };
  let from = $('f-from').value || today;
  let to = $('f-to').value || from;
  if (to < from) [from, to] = [to, from];
  return { from, to };
}

// ------------------------------------------------------------------ aggregation + render
let renderSeq = 0;
async function render() {
  if (!state.source) return;
  const seq = ++renderSeq;
  hideTip();
  setLoading(true);
  const { from, to } = resolveRange();
  const dates = [];
  for (let d = from; d <= to && dates.length < 800; d = addDays(d, 1)) dates.push(d);
  const loaded = await Promise.all(
    dates.map(async (d) => {
      if (!state.dayCache.has(d)) state.dayCache.set(d, state.source.getDay(d).catch(() => null));
      return [d, await state.dayCache.get(d)];
    }),
  );
  if (seq !== renderSeq) return;

  const idx = state.source.index;
  const f = state.filters;
  const agg = {
    dates,
    hour: new Map(), // `${date}|${h}` -> {byClass: Map, total, cov}
    lineDir: new Map(), // lineId -> {in, out}
    byClass: new Map(),
    total: 0,
    tin: 0,
    tout: 0,
    coverS: 0,
    seenClasses: new Set(),
  };
  for (const [date, day] of loaded) {
    if (!day) continue;
    day.coverage.forEach((s, h) => {
      if (s > 0) {
        cell(agg, date, h).cov += s;
        agg.coverS += s;
      }
    });
    for (const [k, n] of day.rows) {
      const [hs, line, dir, cs] = k.split('|');
      const cls = Number(cs);
      agg.seenClasses.add(cls);
      if (f.line !== 'all' && line !== f.line) continue;
      if (f.dir !== 'both' && dir !== f.dir) continue;
      if (f.excluded.has(cls)) continue;
      const c = cell(agg, date, Number(hs));
      c.byClass.set(cls, (c.byClass.get(cls) || 0) + n);
      c.total += n;
      agg.total += n;
      if (dir === 'in') agg.tin += n;
      else agg.tout += n;
      const ld = agg.lineDir.get(line) || { in: 0, out: 0 };
      ld[dir === 'in' ? 'in' : 'out'] += n;
      agg.lineDir.set(line, ld);
      agg.byClass.set(cls, (agg.byClass.get(cls) || 0) + n);
    }
  }
  buildChips(agg.seenClasses);
  state.lastRender = agg;
  setLoading(false);
  drawStatus(idx);
  const hasAny = agg.total > 0 || agg.coverS > 0;
  if (!hasAny) {
    const latest = idx.days?.[idx.days.length - 1]?.date;
    showEmpty(
      idx.days?.length
        ? `Nothing counted in this period. The latest data is from ${fmtDate(latest, true)}; try "Everything".`
        : 'No counts yet. Counts appear here once the counting station or the counter on this device has counted vehicles.',
    );
  } else hideEmpty(idx.note);
  drawHero(agg, from, to);
  drawHourly(agg, from, to);
  drawDaily(agg);
  drawHeat(agg);
  drawLines(agg, idx);
  drawTypes(agg, idx);
  drawTable(agg, idx);
}

function cell(agg, date, h) {
  const k = `${date}|${h}`;
  let c = agg.hour.get(k);
  if (!c) {
    c = { byClass: new Map(), total: 0, cov: 0 };
    agg.hour.set(k, c);
  }
  return c;
}

function seriesClasses(agg) {
  const idx = state.source.index;
  return [...agg.byClass.keys()].filter((c) => agg.byClass.get(c) > 0).sort((a, b) => slotOf(idx.classes[a]) - slotOf(idx.classes[b]) || a - b);
}

function drawLegend(host, classes) {
  const idx = state.source.index;
  host.textContent = '';
  host.hidden = classes.length < 2;
  for (const c of classes) {
    const li = document.createElement('li');
    const sw = document.createElement('span');
    sw.className = 'sw';
    sw.style.background = colorOf(idx.classes[c]);
    li.append(sw, document.createTextNode(idx.classes[c]));
    host.append(li);
  }
}

function drawStatus(idx) {
  const el = $('status');
  const s = idx.status;
  el.textContent = '';
  if (!s || state.source.kind !== 'remote') {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  const dot = document.createElement('span');
  dot.className = s.online ? 'dot-ok' : 'dot-bad';
  dot.setAttribute('aria-hidden', 'true');
  const main = document.createElement('b');
  const last = s.lastFrame ? timeOf(s.lastFrame) : null;
  main.textContent = s.online ? `${idx.name || 'Camera'}: counting live` : `${idx.name || 'Camera'}: camera offline${last ? ` since ${last}` : ''}`;
  const extra = document.createElement('span');
  extra.className = 'muted';
  const upd = idx.updated ? Math.round((Date.now() - Date.parse(idx.updated)) / 60000) : null;
  extra.textContent = [
    s.online ? `${s.thisHour ?? 0} vehicles this hour, ${s.analysedFps} frames analysed per second.` : `It reconnects by itself${s.lastError ? ` (${s.lastError})` : ''}.`,
    upd !== null ? `Data updated ${upd <= 1 ? 'just now' : `${upd} min ago`}.` : '',
  ]
    .filter(Boolean)
    .join(' ');
  el.append(dot, main, extra);
}

function drawHero(agg, from, to) {
  $('h-total').textContent = agg.total.toLocaleString('en-GB');
  $('h-caption').textContent = from === to ? `vehicles on ${fmtDate(from, true)}` : `vehicles, ${fmtDate(from)} to ${fmtDate(to, true)}`;
  let peak = null;
  for (const [k, c] of agg.hour) if (!peak || c.total > peak.c.total) peak = { k, c };
  if (peak && peak.c.total > 0) {
    const [date, h] = peak.k.split('|');
    $('h-peak').textContent = `${from === to ? '' : `${fmtDate(date)}, `}${hh(h)}:00 (${peak.c.total.toLocaleString('en-GB')})`;
  } else $('h-peak').textContent = '–';
  const covH = agg.coverS / 3600;
  $('h-rate').textContent = covH > 0.05 ? `${fmtNum(agg.total / covH)} vehicles` : '–';
  $('h-split').textContent = agg.total ? `${agg.tin.toLocaleString('en-GB')} in, ${agg.tout.toLocaleString('en-GB')} out` : '–';
  if (state.source.noCoverage) $('h-watched').textContent = 'not recorded';
  else {
    const span = agg.dates.length * 86400;
    $('h-watched').textContent = agg.coverS ? `${dur(agg.coverS)} (${Math.round((agg.coverS / span) * 100)}%)` : '–';
  }
}

function drawHourly(agg, from, to) {
  const single = from === to;
  const classes = seriesClasses(agg);
  drawLegend($('legend-classes'), classes);
  const idx = state.source.index;
  const nDays = agg.dates.length;
  const useRate = !single && !state.source.noCoverage;
  const values = classes.map(() => new Array(24).fill(0));
  const cov = new Array(24).fill(0);
  const tot = new Array(24).fill(0);
  for (const [k, c] of agg.hour) {
    const h = Number(k.split('|')[1]);
    cov[h] += c.cov;
    tot[h] += c.total;
    classes.forEach((cls, i) => (values[i][h] += c.byClass.get(cls) || 0));
  }
  const scaleH = (h) => (useRate ? (cov[h] > 60 ? 3600 / cov[h] : 0) : single ? 1 : 1 / nDays);
  const series = classes.map((cls, i) => ({ name: idx.classes[cls], color: colorOf(idx.classes[cls]), values: values[i].map((v, h) => v * scaleH(h)) }));
  $('c-hourly-title').textContent = single ? 'Vehicles by hour' : 'Average vehicles per hour of the day';
  $('c-hourly-sub').textContent = single
    ? fmtDate(from, true)
    : useRate
      ? `Each hour of the day averaged over the ${nDays} days, counting only time the camera was watched.`
      : `Each hour of the day averaged over the ${nDays} days.`;
  const watched = state.source.noCoverage ? null : cov.map((s) => s / (3600 * (single ? 1 : nDays)));
  document.querySelector('.strip-note').hidden = !watched;
  columnChart($('c-hourly'), {
    labels: [...Array(24).keys()].map((h) => String(h)),
    showLabel: (i, band) => band >= 22 || i % 3 === 0,
    series,
    watched,
    ariaLabel: `Vehicles per hour, ${classes.map((c) => idx.classes[c]).join(', ')}`,
    tip: (h) => ({
      head: `${hh(h)}:00–${hh((h + 1) % 24)}:00${single ? `, ${fmtDate(from)}` : ''}`,
      rows: series.filter((s) => s.values[h] > 0).reverse().map((s) => ({ value: fmtNum(s.values[h]), label: s.name, color: s.color })),
      foot: single
        ? `${tot[h]} vehicles, watched ${Math.round(cov[h] / 60)} of 60 min`
        : `${fmtNum(series.reduce((a, s) => a + s.values[h], 0))} per hour on average${useRate ? `, ${dur(cov[h])} watched` : ''}`,
    }),
  });
}

function drawDaily(agg) {
  const card = $('card-daily');
  if (agg.dates.length < 2) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  const idx = state.source.index;
  const classes = seriesClasses(agg);
  const per = new Map(agg.dates.map((d) => [d, { byClass: new Map(), total: 0, cov: 0 }]));
  for (const [k, c] of agg.hour) {
    const d = per.get(k.split('|')[0]);
    d.total += c.total;
    d.cov += c.cov;
    for (const [cls, n] of c.byClass) d.byClass.set(cls, (d.byClass.get(cls) || 0) + n);
  }
  const series = classes.map((cls) => ({ name: idx.classes[cls], color: colorOf(idx.classes[cls]), values: agg.dates.map((d) => per.get(d).byClass.get(cls) || 0) }));
  $('c-daily-sub').textContent = 'Days with a short grey strip were only partly watched, so their totals are lower than the real traffic.';
  columnChart($('c-daily'), {
    labels: agg.dates.map((d) => (agg.dates.length > 14 ? d.slice(8) : `${WEEKDAYS[weekday(d)]} ${Number(d.slice(8))}`)),
    showLabel: (i, band) => band >= 46 || i % Math.ceil(46 / band) === 0,
    series,
    watched: state.source.noCoverage ? null : agg.dates.map((d) => per.get(d).cov / 86400),
    height: 220,
    ariaLabel: 'Vehicles per day',
    tip: (i) => {
      const d = agg.dates[i];
      const p = per.get(d);
      return {
        head: fmtDate(d, true),
        rows: series.filter((s) => s.values[i] > 0).reverse().map((s) => ({ value: s.values[i].toLocaleString('en-GB'), label: s.name, color: s.color })),
        foot: `${p.total.toLocaleString('en-GB')} vehicles${state.source.noCoverage ? '' : `, ${dur(p.cov)} watched`}`,
      };
    },
  });
}

function drawHeat(agg) {
  const card = $('card-heat');
  const sums = [...Array(7)].map(() => new Array(24).fill(0));
  const covs = [...Array(7)].map(() => new Array(24).fill(0));
  const wdSeen = new Set();
  for (const [k, c] of agg.hour) {
    const [d, h] = k.split('|');
    const wd = weekday(d);
    sums[wd][h] += c.total;
    covs[wd][h] += c.cov;
    if (c.cov > 0) wdSeen.add(wd);
  }
  if (state.source.noCoverage || wdSeen.size < 3) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  const vals = sums.map((row, wd) => row.map((s, h) => (covs[wd][h] >= 600 ? (s / covs[wd][h]) * 3600 : null)));
  const dark = getComputedStyle(document.body).getPropertyValue('--chart-surface').trim().toLowerCase() !== '#ffffff';
  const ramp = dark ? RAMP_DARK : RAMP_LIGHT;
  const { max } = heatmap($('c-heat'), {
    rowLabels: WEEKDAYS,
    colLabels: [...Array(24).keys()].map(String),
    values: vals,
    ramp,
    ariaLabel: 'Average vehicles per hour by weekday and hour',
    showCol: (c, cw) => cw >= 22 || c % 3 === 0,
    tip: (r, c) => ({
      head: `${WEEKDAYS[r]} ${hh(c)}:00–${hh((c + 1) % 24)}:00`,
      rows: vals[r][c] === null ? [] : [{ value: fmtNum(vals[r][c]), label: 'vehicles per hour', color: ramp[ramp.length - 3] }],
      foot: vals[r][c] === null ? 'Not watched long enough' : `${sums[r][c]} counted in ${dur(covs[r][c])} watched`,
    }),
  });
  const lg = $('heat-legend');
  lg.textContent = '';
  const lo = document.createElement('span');
  lo.textContent = '0';
  const rampEl = document.createElement('span');
  rampEl.className = 'ramp';
  for (const c of ramp) {
    const s = document.createElement('span');
    s.style.background = c;
    rampEl.append(s);
  }
  const hi = document.createElement('span');
  hi.textContent = `${fmtNum(max)} vehicles per hour`;
  lg.append(lo, rampEl, hi);
}

function drawLines(agg, idx) {
  const names = new Map((idx.lines || []).map((l) => [l.id, l.name]));
  const inC = cssVar('--in') || '#0e7c86';
  const outC = cssVar('--out') || '#c2187a';
  const leg = $('legend-dirs');
  leg.textContent = '';
  for (const [n, c] of [
    ['In', inC],
    ['Out', outC],
  ]) {
    const li = document.createElement('li');
    const sw = document.createElement('span');
    sw.className = 'sw';
    sw.style.background = c;
    li.append(sw, document.createTextNode(n));
    leg.append(li);
  }
  const rows = [...agg.lineDir]
    .sort((a, b) => b[1].in + b[1].out - (a[1].in + a[1].out))
    .map(([id, v]) => ({
      label: names.get(id) || id,
      bars: [
        { name: 'In', color: inC, value: v.in },
        { name: 'Out', color: outC, value: v.out },
      ],
    }));
  if (!rows.length) {
    $('c-lines').textContent = 'No crossings in this period.';
    return;
  }
  barList($('c-lines'), { rows, ariaLabel: 'Vehicles per counting line and direction' });
}

function drawTypes(agg, idx) {
  const rows = [...agg.byClass]
    .sort((a, b) => b[1] - a[1])
    .map(([cls, n]) => ({ label: `${idx.classes[cls]}, ${agg.total ? Math.round((n / agg.total) * 100) : 0}%`, bars: [{ name: idx.classes[cls], color: colorOf(idx.classes[cls]), value: n }] }));
  if (!rows.length) {
    $('c-types').textContent = 'No vehicles in this period.';
    return;
  }
  barList($('c-types'), { rows, ariaLabel: 'Vehicles by type' });
}

function tableRows(agg, idx) {
  const classes = seriesClasses(agg);
  const head = ['Date', 'Hour', ...classes.map((c) => idx.classes[c]), 'Total', ...(state.source.noCoverage ? [] : ['Watched (min)'])];
  const rows = [...agg.hour]
    .filter(([, c]) => c.total > 0 || c.cov > 0)
    .sort((a, b) => {
      const [da, ha] = a[0].split('|');
      const [db, hb] = b[0].split('|');
      return da.localeCompare(db) || Number(ha) - Number(hb);
    })
    .map(([k, c]) => {
      const [d, h] = k.split('|');
      return [d, `${hh(h)}:00`, ...classes.map((cls) => c.byClass.get(cls) || 0), c.total, ...(state.source.noCoverage ? [] : [Math.round(c.cov / 60)])];
    });
  return { head, rows };
}

function drawTable(agg, idx) {
  const { head, rows } = tableRows(agg, idx);
  const t = $('table');
  t.textContent = '';
  const thead = t.createTHead().insertRow();
  for (const h of head) {
    const th = document.createElement('th');
    th.textContent = h;
    thead.append(th);
  }
  const tb = t.createTBody();
  for (const r of rows.slice(0, 5000)) {
    const tr = tb.insertRow();
    for (const v of r) tr.insertCell().textContent = typeof v === 'number' ? v.toLocaleString('en-GB') : v;
  }
}

function downloadTable() {
  if (!state.lastRender) return;
  const { head, rows } = tableRows(state.lastRender, state.source.index);
  const esc = (v) => (/[",\r\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const csv = '﻿' + [head, ...rows].map((r) => r.map(esc).join(',')).join('\r\n') + '\r\n';
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const { from, to } = resolveRange();
  a.download = `hourly-counts_${from}_${to}.csv`;
  document.body.append(a);
  a.click();
  a.remove();
}

// ------------------------------------------------------------------ helpers
function setLoading(on) {
  document.body.classList.toggle('is-loading', on);
}
function showEmpty(msg) {
  setLoading(false);
  const e = $('empty');
  e.hidden = false;
  e.textContent = msg;
}
function hideEmpty(note) {
  const e = $('empty');
  e.hidden = !note;
  e.textContent = note || '';
}
function hh(h) {
  return String(h).padStart(2, '0');
}
function fmtNum(v) {
  return v >= 100 ? Math.round(v).toLocaleString('en-GB') : v >= 10 ? v.toFixed(0) : v.toFixed(1);
}
function fmtDate(d, withYear = false) {
  if (!d) return '';
  const [y, m, day] = d.split('-').map(Number);
  return `${WEEKDAYS[weekday(d)]} ${day} ${MONTHS[m - 1]}${withYear ? ` ${y}` : ''}`;
}
function dur(s) {
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}
function timeOf(iso) {
  const tz = state.source?.timezone || undefined;
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: tz });
}
