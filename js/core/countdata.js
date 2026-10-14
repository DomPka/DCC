// Shared count data format used by the counting station, the app's saved sessions and the
// analytics page. Counts are kept per local clock hour:
//   day file  {date: 'YYYY-MM-DD', rows: [[hour, lineId, dir, cls, count], ...],
//              coverage: [[hour, seconds analysed], ...]}
//   index     {version, name, timezone, updated, lines: [{id, name}], classes: [names],
//              days: [{date, total, coverageS}], status: {...}}
// Coverage says how much of each hour was actually watched, so gaps (stream down,
// app closed) are visible instead of looking like quiet traffic.

export class DayBins {
  constructor(date) {
    this.date = date;
    this.rows = new Map(); // `${hour}|${lineId}|${dir}|${cls}` -> count
    this.coverage = new Float64Array(24);
  }

  add(hour, lineId, dir, cls, n = 1) {
    const k = `${hour}|${lineId}|${dir}|${cls}`;
    this.rows.set(k, (this.rows.get(k) || 0) + n);
  }

  addCoverage(hour, seconds) {
    this.coverage[hour] = Math.min(3600, this.coverage[hour] + seconds);
  }

  total() {
    let s = 0;
    for (const v of this.rows.values()) s += v;
    return s;
  }

  coverageSeconds() {
    return this.coverage.reduce((a, b) => a + b, 0);
  }

  toJSON() {
    const rows = [];
    for (const [k, v] of this.rows) {
      const [h, line, dir, cls] = k.split('|');
      rows.push([Number(h), line, dir, Number(cls), v]);
    }
    rows.sort((a, b) => a[0] - b[0] || String(a[1]).localeCompare(String(b[1])) || a[2].localeCompare(b[2]) || a[3] - b[3]);
    const coverage = [];
    this.coverage.forEach((s, h) => s > 0 && coverage.push([h, Math.round(s)]));
    return { date: this.date, rows, coverage };
  }

  static fromJSON(j) {
    const d = new DayBins(j.date);
    for (const [h, line, dir, cls, n] of j.rows || []) d.add(h, line, dir, cls, n);
    for (const [h, s] of j.coverage || []) d.coverage[h] = s;
    return d;
  }
}

const formatters = new Map();
/**
 * Local calendar date and hour of an instant.
 * @param {Date} date
 * @param {string|null} timeZone IANA zone, or null when `date` already carries wall-clock
 *   digits in its UTC fields (how the browser app stores recording times)
 */
export function wallParts(date, timeZone) {
  if (!timeZone) {
    return { date: date.toISOString().slice(0, 10), hour: date.getUTCHours(), minute: date.getUTCMinutes(), second: date.getUTCSeconds() };
  }
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(timeZone, f);
  }
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24, minute: Number(p.minute), second: Number(p.second) };
}

/** Weekday 0=Monday..6=Sunday of a 'YYYY-MM-DD' date. */
export function weekday(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

export function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
