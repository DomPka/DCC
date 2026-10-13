// CSV builders for the count results.
// events.csv  - one row per counted crossing
// counts.csv  - one row per time interval: per line in/out, per class, total, cumulative

export function eventsCsv(events, names, startDate) {
  const rows = [['video_time_s', 'video_time', 'clock_time', 'line', 'direction', 'track_id', 'class']];
  for (const e of events) {
    rows.push([
      e.t.toFixed(2),
      hms(e.t),
      startDate ? clock(startDate, e.t) : '',
      e.lineName,
      e.dir,
      e.trackId,
      className(names, e.cls),
    ]);
  }
  return toCsv(rows);
}

export function intervalCsv(events, lines, names, { intervalS = 60, durationS = 0, startDate = null } = {}) {
  const lastT = events.length ? events[events.length - 1].t : 0;
  const end = Math.max(durationS, lastT) || intervalS;
  const nBins = Math.max(1, Math.ceil(end / intervalS - 1e-9));
  const classIds = [...new Set(events.map((e) => e.cls))].sort((a, b) => a - b);

  const header = ['interval_start', 'interval_end'];
  if (startDate) header.push('clock_start');
  for (const l of lines) header.push(`${l.name} in`, `${l.name} out`);
  for (const c of classIds) header.push(className(names, c));
  header.push('total', 'cumulative_total');

  const bins = Array.from({ length: nBins }, () => ({ line: new Map(), cls: new Map(), total: 0 }));
  for (const e of events) {
    const b = bins[Math.min(nBins - 1, Math.floor(e.t / intervalS))];
    const k = `${e.lineId}|${e.dir}`;
    b.line.set(k, (b.line.get(k) || 0) + 1);
    b.cls.set(e.cls, (b.cls.get(e.cls) || 0) + 1);
    b.total++;
  }

  const rows = [header];
  let cum = 0;
  bins.forEach((b, i) => {
    const t0 = i * intervalS;
    const t1 = Math.min(end, (i + 1) * intervalS);
    cum += b.total;
    const row = [hms(t0), hms(t1)];
    if (startDate) row.push(clock(startDate, t0));
    for (const l of lines) row.push(b.line.get(`${l.id}|in`) || 0, b.line.get(`${l.id}|out`) || 0);
    for (const c of classIds) row.push(b.cls.get(c) || 0);
    row.push(b.total, cum);
    rows.push(row);
  });
  return toCsv(rows);
}

export function toCsv(rows) {
  // UTF-8 BOM so Excel shows Lithuanian letters in line names correctly
  return '﻿' + rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

function cell(v) {
  const s = String(v ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function hms(t) {
  const s = Math.max(0, Math.floor(t + 1e-6));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${pad(h)}:${pad(m)}:${pad(s % 60)}`;
}

function clock(startDate, t) {
  const d = new Date(startDate.getTime() + t * 1000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function className(names, c) {
  return (names && names[c]) || `class ${c}`;
}
