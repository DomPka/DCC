// Station page: live picture from the counting station, drawing and saving counting lines.
import { Overlay } from './overlay.js';

const $ = (id) => document.getElementById(id);
const img = $('snap');
const stage = $('stage');
const canvas = $('overlay');
// the overlay only needs the frame size, which the snapshot image provides
const frameSize = {
  get videoWidth() {
    return img.naturalWidth;
  },
  get videoHeight() {
    return img.naturalHeight;
  },
};
const overlay = new Overlay(canvas, frameSize);

let lines = [];
let savedJson = '[]';
let live = null;
let names = [];
let editing = false;
let placing = false;
let pending = null;
let drag = null;
let password = sessionGet('cc-station-pw') || '';

init();

async function init() {
  try {
    const r = await fetch('api/lines', { cache: 'no-store' });
    if (!r.ok) throw new Error();
    lines = await r.json();
    savedJson = JSON.stringify(lines);
  } catch {
    $('empty-title').textContent = 'This page belongs to the counting station';
    $('empty-sub').textContent = 'Open it from the computer running the station, e.g. http://<station address>:8090/. To see published counts from anywhere, use the Analytics page.';
    $('st-status').textContent = 'Not connected to a station.';
    return;
  }
  renderList();
  bind();
  refreshSnapshot();
  setInterval(refreshSnapshot, 1000);
  pollLive();
  setInterval(pollLive, 1000);
}

async function refreshSnapshot() {
  if (document.hidden) return;
  try {
    const r = await fetch('api/snapshot.png', { cache: 'no-store' });
    if (!r.ok) {
      $('stage-empty').hidden = false;
      $('empty-title').textContent = 'Waiting for the camera';
      $('empty-sub').textContent = (await r.json().catch(() => ({}))).error || '';
      return;
    }
    const url = URL.createObjectURL(await r.blob());
    const old = img.src;
    img.onload = () => {
      if (old.startsWith('blob:')) URL.revokeObjectURL(old);
      $('stage-empty').hidden = true;
      stage.classList.remove('is-empty');
      if (img.naturalWidth) stage.style.aspectRatio = `${img.naturalWidth} / ${img.naturalHeight}`;
      overlay.layout();
      draw();
    };
    img.src = url;
  } catch {
    /* station busy or restarting */
  }
}

async function pollLive() {
  if (document.hidden) return;
  try {
    const r = await fetch('api/live', { cache: 'no-store' });
    live = await r.json();
  } catch {
    $('st-status').textContent = 'Lost connection to the station; retrying…';
    return;
  }
  names = live.classes || [];
  const s = live.status;
  const st = $('st-status');
  st.textContent = '';
  const dot = document.createElement('span');
  dot.className = s.online ? 'dot-ok' : 'dot-bad';
  const b = document.createElement('b');
  b.textContent = s.online ? 'Counting live' : 'Camera offline';
  const m = document.createElement('span');
  m.className = 'muted';
  m.textContent = s.online ? `${s.inferMs} ms per frame` : s.lastError ? `${s.lastError}. Reconnecting by itself.` : 'Reconnecting by itself.';
  st.append(dot, b, m);
  $('st-today').textContent = s.today.toLocaleString('en-GB');
  $('st-hour').textContent = s.thisHour;
  $('st-fps').textContent = s.analysedFps;
  const pub = $('publish-note');
  pub.hidden = !live.publicData;
  if (live.publicData) pub.textContent = `Hourly counts are published to ${live.publicData} for the Analytics page on GitHub Pages.`;
  for (const l of live.lines) {
    const row = document.querySelector(`[data-id="${CSS.escape(l.id)}"]`);
    if (row) {
      row.querySelector('.line-count.in b').textContent = l.in;
      row.querySelector('.line-count.out b').textContent = l.out;
    }
  }
  draw();
}

function draw() {
  const countsById = new Map((live?.lines || []).map((l) => [l.id, { in: l.in, out: l.out }]));
  overlay.draw({
    lines: lines.map((l) => ({ ...l, counts: countsById.get(l.id) || { in: 0, out: 0 } })),
    tracks: $('show-tracks').checked && live ? live.tracks.map((t) => ({ ...t, trail: [] })) : [],
    show: { boxes: true, labels: true, trails: false },
    names,
    editing,
    pending,
    activeLine: drag?.id ?? null,
  });
}

function bind() {
  new ResizeObserver(() => {
    overlay.layout();
    draw();
  }).observe(stage);
  $('btn-add-line').addEventListener('click', () => {
    editing = true;
    placing = true;
    pending = null;
    stage.classList.add('is-editing');
    hint('Tap where the counting line starts');
    draw();
  });
  $('btn-edit-lines').addEventListener('click', () => {
    editing = !editing;
    placing = false;
    stage.classList.toggle('is-editing', editing);
    if (editing) hint('Drag a line by its ends');
    else $('stage-hint').hidden = true;
    draw();
  });
  $('btn-edit-done').addEventListener('click', () => {
    editing = placing = false;
    pending = null;
    stage.classList.remove('is-editing');
    $('stage-hint').hidden = true;
    draw();
  });
  $('btn-save').addEventListener('click', save);
  $('show-tracks').addEventListener('change', draw);
  canvas.addEventListener('pointerdown', (e) => {
    if (!editing) return;
    const hit = overlay.hitHandle(lines, e.clientX, e.clientY);
    if (hit) {
      drag = { id: hit.line.id, end: hit.end };
      canvas.setPointerCapture(e.pointerId);
      e.preventDefault();
      return;
    }
    if (!placing) return;
    const p = overlay.toNorm(e.clientX, e.clientY);
    if (!pending) {
      pending = p;
      hint('Now tap where it ends');
    } else {
      const used = new Set(lines.map((l) => l.name));
      let n = lines.length + 1;
      while (used.has(`Line ${n}`)) n++;
      lines.push({ id: `l${Date.now().toString(36)}`, name: `Line ${n}`, a: pending, b: p });
      pending = null;
      placing = false;
      hint('Line added. Save lines to start counting on it');
      renderList();
    }
    draw();
    e.preventDefault();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const l = lines.find((x) => x.id === drag.id);
    if (l) l[drag.end] = overlay.toNorm(e.clientX, e.clientY);
    draw();
  });
  const end = () => {
    if (drag) {
      drag = null;
      changed();
    }
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  addEventListener('beforeunload', (e) => {
    if (JSON.stringify(lines) !== savedJson) e.preventDefault();
  });
}

function hint(t) {
  $('stage-hint-text').textContent = t;
  $('stage-hint').hidden = false;
}

function changed() {
  $('btn-save').disabled = JSON.stringify(lines) === savedJson;
  draw();
}

function renderList() {
  const ol = $('lines');
  ol.textContent = '';
  $('lines-empty').hidden = lines.length > 0;
  for (const line of lines) {
    const li = document.createElement('li');
    li.className = 'line-row';
    li.dataset.id = line.id;
    li.innerHTML = `
      <div class="line-name"><span class="line-swatch" aria-hidden="true"></span><input aria-label="Line name" maxlength="60" /></div>
      <div class="line-count in"><b>0</b><small>in</small></div>
      <div class="line-count out"><b>0</b><small>out</small></div>
      <div class="line-actions">
        <button class="icon-btn" type="button" data-act="flip" title="Swap in and out">⇅</button>
        <button class="icon-btn" type="button" data-act="delete" title="Delete line">✕</button>
      </div>`;
    const input = li.querySelector('input');
    input.value = line.name;
    input.addEventListener('input', () => {
      line.name = input.value.trim() || 'Line';
      changed();
    });
    li.querySelector('[data-act="flip"]').addEventListener('click', () => {
      [line.a, line.b] = [line.b, line.a];
      changed();
    });
    li.querySelector('[data-act="delete"]').addEventListener('click', () => {
      if (!confirm(`Delete "${line.name}"? Counts already saved stay in the history.`)) return;
      lines = lines.filter((l) => l !== line);
      renderList();
      changed();
    });
    ol.append(li);
  }
  changed();
}

async function save() {
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await fetch('api/lines', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Password': password },
      body: JSON.stringify(lines),
    });
    if (r.status === 401) {
      const p = prompt('Station password (set in the station config):');
      if (p === null) return;
      password = p;
      sessionSet('cc-station-pw', p);
      continue;
    }
    const body = await r.json();
    if (!r.ok) return toast(`Not saved: ${body.error}`);
    lines = body;
    savedJson = JSON.stringify(lines);
    renderList();
    toast('Lines saved. The station counts on them now.');
    return;
  }
}

let toastTimer;
function toast(t) {
  const el = $('toast');
  el.textContent = t;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 4000);
}

function sessionGet(k) {
  try {
    return sessionStorage.getItem(k);
  } catch {
    return null;
  }
}
function sessionSet(k, v) {
  try {
    sessionStorage.setItem(k, v);
  } catch {
    /* ignore */
  }
}
