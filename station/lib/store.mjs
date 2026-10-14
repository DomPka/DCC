// Persistent hourly counts for the station: one small JSON file per day plus an index,
// and a CSV of individual crossings per day. Writes are atomic (temp file + rename) so a
// power cut never leaves a half-written file.
import { mkdirSync, readFileSync, writeFileSync, renameSync, appendFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DayBins, wallParts } from '../../js/core/countdata.js';

export class CountStore {
  constructor({ dir, timeZone, name }) {
    this.dir = dir;
    this.timeZone = timeZone;
    this.name = name;
    this.days = new Map(); // date -> DayBins (loaded lazily)
    this.dayMeta = new Map(); // date -> {total, coverageS}
    this.dirty = new Set();
    this.lines = new Map(); // id -> name, every line that ever counted
    this.classes = [];
    mkdirSync(join(dir, 'days'), { recursive: true });
    mkdirSync(join(dir, 'events'), { recursive: true });
    this.loadIndex();
  }

  loadIndex() {
    const p = join(this.dir, 'index.json');
    if (existsSync(p)) {
      try {
        const idx = JSON.parse(readFileSync(p, 'utf8'));
        for (const d of idx.days || []) this.dayMeta.set(d.date, { total: d.total, coverageS: d.coverageS });
        for (const l of idx.lines || []) this.lines.set(l.id, l.name);
        this.classes = idx.classes || [];
      } catch {
        /* rebuild from day files below */
      }
    }
    for (const f of readdirSync(join(this.dir, 'days'))) {
      const date = f.replace(/\.json$/, '');
      if (!this.dayMeta.has(date)) {
        const d = this.day(date);
        this.dayMeta.set(date, { total: d.total(), coverageS: d.coverageSeconds() });
      }
    }
  }

  day(date) {
    let d = this.days.get(date);
    if (!d) {
      const p = join(this.dir, 'days', `${date}.json`);
      d = existsSync(p) ? DayBins.fromJSON(JSON.parse(readFileSync(p, 'utf8'))) : new DayBins(date);
      this.days.set(date, d);
    }
    return d;
  }

  setLines(lines) {
    for (const l of lines) this.lines.set(l.id, l.name);
  }

  setClasses(names) {
    this.classes = names;
  }

  addEvent(ev) {
    const w = wallParts(ev.time, this.timeZone);
    const d = this.day(w.date);
    d.add(w.hour, ev.lineId, ev.dir, ev.cls, 1);
    this.lines.set(ev.lineId, ev.lineName);
    this.touch(w.date);
    const file = join(this.dir, 'events', `${w.date}.csv`);
    if (!existsSync(file)) appendFileSync(file, '﻿time,line,direction,track_id,class\r\n');
    const hh = String(w.hour).padStart(2, '0');
    const mm = String(w.minute).padStart(2, '0');
    const ss = String(w.second).padStart(2, '0');
    const name = /[",\r\n]/.test(ev.lineName) ? `"${ev.lineName.replace(/"/g, '""')}"` : ev.lineName;
    appendFileSync(file, `${w.date} ${hh}:${mm}:${ss},${name},${ev.dir},${ev.trackId},${this.classes[ev.cls] ?? ev.cls}\r\n`);
  }

  /** seconds of stream analysed, ending at `time` (split across an hour boundary if needed) */
  addCoverage(time, seconds) {
    if (!(seconds > 0)) return;
    const w = wallParts(time, this.timeZone);
    const intoHour = w.minute * 60 + w.second;
    const here = Math.min(seconds, intoHour + 1);
    this.day(w.date).addCoverage(w.hour, here);
    this.touch(w.date);
    if (seconds > here) this.addCoverage(new Date(time.getTime() - here * 1000 - 1), seconds - here);
  }

  touch(date) {
    this.dirty.add(date);
    const d = this.days.get(date);
    this.dayMeta.set(date, { total: d.total(), coverageS: Math.round(d.coverageSeconds()) });
  }

  index(status) {
    const days = [...this.dayMeta.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, m]) => ({ date, ...m }));
    return {
      version: 1,
      name: this.name,
      timezone: this.timeZone,
      updated: new Date().toISOString(),
      lines: [...this.lines].map(([id, name]) => ({ id, name })),
      classes: this.classes,
      days,
      status,
    };
  }

  /** Writes changed day files + index. Returns the relative paths written. */
  flush(status) {
    const written = [];
    for (const date of this.dirty) {
      writeAtomic(join(this.dir, 'days', `${date}.json`), JSON.stringify(this.day(date).toJSON()));
      written.push(`days/${date}.json`);
    }
    this.dirty.clear();
    writeAtomic(join(this.dir, 'index.json'), JSON.stringify(this.index(status)));
    written.push('index.json');
    // keep memory small: only today and yesterday stay loaded
    const keep = new Set([...this.days.keys()].sort().slice(-2));
    for (const k of this.days.keys()) if (!keep.has(k)) this.days.delete(k);
    return written;
  }
}

export function writeAtomic(path, text) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}
