// Counting sessions run in this browser, stored in IndexedDB so the analytics page can
// show them and long live counts survive a reload.
// A session keeps raw facts (start time, crossing events, analysed time spans); hourly
// bins are derived from them, so fixing the start time later re-dates everything.
import { DayBins, wallParts } from './core/countdata.js';

const DB = 'car-counter';
const STORE = 'sessions';

function open() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in self)) return reject(new Error('IndexedDB unavailable'));
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const out = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(out?.result ?? out);
    t.onerror = () => reject(t.error);
  });
}

export async function saveSession(s) {
  try {
    await tx('readwrite', (st) => st.put(s));
  } catch (err) {
    console.warn('session not saved', err);
  }
}

export async function listSessions() {
  try {
    const req = await tx('readonly', (st) => st.getAll());
    return Array.isArray(req) ? req : [];
  } catch {
    return [];
  }
}

export async function deleteSession(id) {
  await tx('readwrite', (st) => st.delete(id));
}

/** Tracks one counting run: crossing events and the stretches of video actually analysed. */
export class SessionRecorder {
  constructor({ name, kind }) {
    this.s = {
      id: `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      name,
      kind,
      created: new Date().toISOString(),
      start: null, // ISO string whose UTC fields are the wall-clock digits of t = 0
      lines: [],
      classes: [],
      events: [], // [t, lineId, dir, cls]
      spans: [], // [t0, t1] analysed
      updated: null,
    };
    this.lastT = null;
    this.dirty = false;
    this.timer = setInterval(() => this.flush(), 15000);
  }

  setStart(date) {
    this.s.start = date ? date.toISOString() : null;
    this.dirty = true;
  }

  setMeta(lines, classes) {
    this.s.lines = lines.map((l) => ({ id: l.id, name: l.name }));
    this.s.classes = classes || [];
    this.dirty = true;
  }

  frame(t) {
    const sp = this.s.spans;
    const last = sp[sp.length - 1];
    if (last && this.lastT !== null && t >= this.lastT && t - this.lastT < 3) last[1] = t;
    else sp.push([t, t]);
    this.lastT = t;
    this.dirty = true;
  }

  event(e) {
    this.s.events.push([Number(e.t.toFixed(2)), e.lineId, e.dir, e.cls]);
    this.dirty = true;
  }

  reset() {
    this.s.events = [];
    this.s.spans = [];
    this.lastT = null;
    this.dirty = true;
  }

  async flush() {
    if (!this.dirty || (!this.s.events.length && !this.s.spans.length)) return;
    this.dirty = false;
    this.s.updated = new Date().toISOString();
    await saveSession(this.s);
    self.dispatchEvent?.(new CustomEvent('cc:counts-changed'));
  }

  close() {
    clearInterval(this.timer);
    return this.flush();
  }
}

/** Hourly bins of a stored session, or null when its start time is unknown. */
export function sessionDays(s) {
  if (!s.start) return null;
  const t0 = Date.parse(s.start);
  const days = new Map();
  const day = (date) => {
    if (!days.has(date)) days.set(date, new DayBins(date));
    return days.get(date);
  };
  for (const [t, line, dir, cls] of s.events) {
    const w = wallParts(new Date(t0 + t * 1000), null);
    day(w.date).add(w.hour, line, dir, cls, 1);
  }
  for (const [a, b] of s.spans) {
    // split each analysed span across the hours it touches
    let cur = a;
    while (cur < b) {
      const at = new Date(t0 + cur * 1000);
      const w = wallParts(at, null);
      const toHourEnd = 3600 - (w.minute * 60 + w.second + (at.getUTCMilliseconds() / 1000));
      const step = Math.min(b - cur, Math.max(0.001, toHourEnd));
      day(w.date).addCoverage(w.hour, step);
      cur += step;
    }
  }
  return days;
}
