// Old-vs-new counting benchmark, part 2: runs the v2 tracker + line counter on the
// scenarios written by simulate_and_run_old.py and prints a comparison table.
// Usage: node tests/bench/run_new.mjs <out_dir>
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ByteTracker } from '../../js/core/tracker.js';
import { LineCounter } from '../../js/core/counter.js';

const dir = process.argv[2];
const { lineXYXY, simFps, scenarios } = JSON.parse(readFileSync(join(dir, 'scenarios.json'), 'utf8'));
const old = JSON.parse(readFileSync(join(dir, 'old_results.json'), 'utf8'));

const rows = [];
for (const sc of scenarios) {
  for (const fps of [30, 15, 10, 5]) {
    const step = simFps / fps;
    const tracker = new ByteTracker();
    const counter = new LineCounter();
    const [ax, ay, bx, by] = lineXYXY;
    counter.setLines([{ id: 'L', name: 'Line', ax, ay, bx, by }]);
    let ms = 0;
    let n = 0;
    for (let i = 0; i < sc.frames.length; i += step) {
      const fr = sc.frames[i];
      const flat = Float32Array.from(fr.dets.flatMap((d) => d.slice(0, 6)));
      const t0 = performance.now();
      const tracks = tracker.update(flat, fr.t);
      counter.update(tracks, fr.t);
      if (n % 30 === 0) counter.prune(tracker.liveKeys());
      ms += performance.now() - t0;
      n++;
    }
    const o = old.find((r) => r.scenario === sc.name && r.fps === fps);
    const nw = counter.totals().total;
    rows.push({ scenario: sc.name, fps, gt: sc.gt.total, old: o.old, new: nw, msPerFrame: ms / n });
  }
}

const err = (v, gt) => `${v} (${v >= gt ? '+' : ''}${(((v - gt) / gt) * 100).toFixed(1)}%)`;
let md = '| Scenario | Analysis fps | True count | v1 (SORT + zone) | v2 (ByteTrack + line) |\n|---|---|---|---|---|\n';
for (const r of rows) md += `| ${r.scenario} | ${r.fps} | ${r.gt} | ${err(r.old, r.gt)} | ${err(r.new, r.gt)} |\n`;
const mae = (k) => (rows.reduce((s, r) => s + Math.abs(r[k] - r.gt) / r.gt, 0) / rows.length) * 100;
md += `\nMean absolute error: v1 ${mae('old').toFixed(1)}%, v2 ${mae('new').toFixed(1)}%\n`;
md += `v2 tracking + counting cost: ${(rows.reduce((s, r) => s + r.msPerFrame, 0) / rows.length).toFixed(3)} ms per frame\n`;
console.log(md);
writeFileSync(join(dir, 'comparison.md'), md);
