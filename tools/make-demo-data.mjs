// Writes a few weeks of realistic-looking station data (hourly counts with rush hours,
// quieter weekends and an outage) for trying the analytics page:
//   node tools/make-demo-data.mjs out-dir [days]
// then open analytics.html?data=<url of out-dir>/
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DayBins, addDays, weekday } from '../js/core/countdata.js';

const out = process.argv[2] || 'demo-data';
const nDays = Number(process.argv[3] || 28);
mkdirSync(join(out, 'days'), { recursive: true });
let seed = 7;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const poisson = (l) => {
  let n = 0;
  let p = Math.exp(-l);
  let s = p;
  const u = rnd();
  while (u > s && n < 5000) {
    n++;
    p *= l / n;
    s += p;
  }
  return n;
};
const weekdayProfile = [6, 4, 3, 3, 5, 14, 45, 110, 140, 95, 80, 85, 92, 90, 95, 120, 160, 175, 120, 80, 60, 42, 25, 12];
const weekendProfile = [12, 8, 5, 4, 4, 6, 12, 25, 45, 70, 90, 100, 105, 100, 95, 90, 85, 80, 70, 55, 40, 30, 22, 15];
const mix = [
  [2, 0.86],
  [7, 0.08],
  [5, 0.03],
  [3, 0.03],
];
const today = new Date().toISOString().slice(0, 10);
const days = [];
for (let i = nDays - 1; i >= 0; i--) {
  const date = addDays(today, -i);
  const d = new DayBins(date);
  const wd = weekday(date);
  const prof = wd >= 5 ? weekendProfile : weekdayProfile;
  const lastHour = i === 0 ? new Date().getHours() : 23;
  for (let h = 0; h <= lastHour; h++) {
    let cover = 3600;
    if (i === 9 && h >= 10 && h < 15) cover = 0; // stream outage
    if (i === 9 && h === 15) cover = 1500;
    if (i === 0 && h === lastHour) cover = new Date().getMinutes() * 60;
    if (!cover) continue;
    d.addCoverage(h, cover);
    for (const [line, share] of [
      ['north', 0.58],
      ['south', 0.42],
    ]) {
      for (const dir of ['in', 'out']) {
        const am = h < 12 ? (dir === 'in' ? 1.25 : 0.75) : dir === 'in' ? 0.8 : 1.2;
        const lam = prof[h] * share * 0.5 * am * (cover / 3600) * (0.9 + 0.2 * rnd());
        for (const [cls, f] of mix) {
          const n = poisson(lam * f);
          if (n) d.add(h, line, dir, cls, n);
        }
      }
    }
  }
  writeFileSync(join(out, 'days', `${date}.json`), JSON.stringify(d.toJSON()));
  days.push({ date, total: d.total(), coverageS: Math.round(d.coverageSeconds()) });
}
const classes = ['person', 'bicycle', 'car', 'motorcycle', 'airplane', 'bus', 'train', 'truck'];
writeFileSync(
  join(out, 'index.json'),
  JSON.stringify({
    version: 1,
    name: 'Demo camera',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    updated: new Date().toISOString(),
    lines: [
      { id: 'north', name: 'Northbound' },
      { id: 'south', name: 'Southbound' },
    ],
    classes,
    days,
    status: { online: true, stream: 'live', lastFrame: new Date().toISOString(), analysedFps: 10, inferMs: 41, thisHour: 57, today: days[days.length - 1].total },
  }),
);
console.log(`wrote ${nDays} days of demo data to ${out}`);
