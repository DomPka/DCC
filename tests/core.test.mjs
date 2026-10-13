// Run with: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { linearAssignment } from '../js/core/hungarian.js';
import { ByteTracker, boxIou } from '../js/core/tracker.js';
import { LineCounter } from '../js/core/counter.js';
import { decode, nms, letterbox, detectFormat } from '../js/core/postprocess.js';
import { readOnnxInfo, parseNames } from '../js/core/onnxmeta.js';
import { eventsCsv, intervalCsv } from '../js/core/csv.js';

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function bruteForce(cost, n, m, limit) {
  // enumerate all partial matchings for tiny sizes, minimising lapjv's extended objective
  let best = Infinity;
  let bestSet = null;
  const used = new Array(m).fill(false);
  const cur = [];
  const rec = (i, acc) => {
    if (i === n) {
      const unmatchedCols = m - cur.filter((x) => x >= 0).length;
      const total = acc + (unmatchedCols * limit) / 2;
      if (total < best - 1e-9) {
        best = total;
        bestSet = cur.slice();
      }
      return;
    }
    cur.push(-1);
    rec(i + 1, acc + limit / 2);
    cur.pop();
    for (let j = 0; j < m; j++) {
      if (used[j]) continue;
      const c = cost[i * m + j];
      if (c > limit) continue;
      used[j] = true;
      cur.push(j);
      rec(i + 1, acc + c);
      cur.pop();
      used[j] = false;
    }
  };
  rec(0, 0);
  return best;
}

test('hungarian matches brute force optimum with a cost limit', () => {
  const r = rng(7);
  for (let trial = 0; trial < 300; trial++) {
    const n = 1 + Math.floor(r() * 5);
    const m = 1 + Math.floor(r() * 5);
    const cost = Float64Array.from({ length: n * m }, () => r());
    const limit = 0.3 + r() * 0.6;
    const { matches, unmatchedCols } = linearAssignment(cost, n, m, limit);
    const total =
      matches.reduce((s, [i, j]) => s + cost[i * m + j], 0) +
      ((n - matches.length) * limit) / 2 +
      (unmatchedCols.length * limit) / 2;
    const bf = bruteForce(cost, n, m, limit);
    assert.ok(Math.abs(total - bf) < 1e-6, `trial ${trial}: got ${total}, best ${bf}`);
    for (const [i, j] of matches) assert.ok(cost[i * m + j] <= limit);
  }
});

test('hungarian without limit gives a full assignment', () => {
  const cost = [4, 1, 3, 2, 0, 5, 3, 2, 2];
  const { matches } = linearAssignment(cost, 3, 3);
  const total = matches.reduce((s, [i, j]) => s + cost[i * 3 + j], 0);
  assert.equal(matches.length, 3);
  assert.equal(total, 5);
});

// ---------- synthetic traffic used by tracker and counter tests ----------
function simulate({ cars, frames, fps, missRate = 0, noise = 0, seed = 1, lowScoreRate = 0 }) {
  const r = rng(seed);
  const out = [];
  for (let f = 0; f < frames; f++) {
    const t = f / fps;
    const dets = [];
    const truth = [];
    for (const c of cars) {
      if (t < c.t0) continue;
      const x = c.x0 + c.vx * (t - c.t0);
      const y = c.y0 + c.vy * (t - c.t0);
      if (x < -c.w || x > 1300 || y < -c.h || y > 800) continue;
      truth.push({ id: c.id, x, y });
      if (r() < missRate) continue;
      const nx = (r() - 0.5) * 2 * noise;
      const ny = (r() - 0.5) * 2 * noise;
      const score = r() < lowScoreRate ? 0.15 + r() * 0.2 : 0.6 + r() * 0.35;
      dets.push(x - c.w / 2 + nx, y - c.h / 2 + ny, x + c.w / 2 + nx, y + c.h / 2 + ny, score, c.cls ?? 2);
    }
    out.push({ t, dets: Float32Array.from(dets), truth });
  }
  return out;
}

const LANE_CARS = [
  { id: 1, x0: -40, y0: 300, vx: 220, vy: 0, w: 60, h: 30, t0: 0 },
  { id: 2, x0: -40, y0: 360, vx: 400, vy: 0, w: 60, h: 30, t0: 0.5 },
  { id: 3, x0: 1300, y0: 450, vx: -300, vy: 0, w: 64, h: 32, t0: 0.2 },
  { id: 4, x0: -40, y0: 300, vx: 220, vy: 0, w: 60, h: 30, t0: 1.2 },
  { id: 5, x0: 1300, y0: 500, vx: -650, vy: 0, w: 70, h: 34, t0: 1.0, cls: 7 },
];

test('tracker keeps one identity per car through misses and noise', () => {
  const tracker = new ByteTracker({ highThresh: 0.5 });
  const seq = simulate({ cars: LANE_CARS, frames: 200, fps: 30, missRate: 0.15, noise: 3, seed: 3, lowScoreRate: 0.1 });
  const idsPerCar = new Map();
  for (const { t, dets, truth } of seq) {
    const tracks = tracker.update(dets, t).filter((tr) => tr.activated);
    for (const tr of tracks) {
      const cx = (tr.box[0] + tr.box[2]) / 2;
      const cy = (tr.box[1] + tr.box[3]) / 2;
      let best = null;
      let bd = 40;
      for (const g of truth) {
        const d = Math.hypot(g.x - cx, g.y - cy);
        if (d < bd) {
          bd = d;
          best = g;
        }
      }
      if (best) {
        if (!idsPerCar.has(best.id)) idsPerCar.set(best.id, new Set());
        idsPerCar.get(best.id).add(tr.id);
      }
    }
  }
  assert.equal(idsPerCar.size, 5);
  for (const [car, ids] of idsPerCar) assert.equal(ids.size, 1, `car ${car} got ids ${[...ids]}`);
});

test('tracker survives low analysis fps (large jumps between frames)', () => {
  const tracker = new ByteTracker();
  const seq = simulate({ cars: LANE_CARS, frames: 40, fps: 6, noise: 2, seed: 9 });
  const ids = new Set();
  for (const { t, dets } of seq) for (const tr of tracker.update(dets, t)) if (tr.activated) ids.add(tr.id);
  assert.equal(ids.size, 5, `expected 5 ids, got ${ids.size}`);
});

test('counter counts each crossing once with the right direction', () => {
  const tracker = new ByteTracker();
  const counter = new LineCounter();
  counter.setLines([{ id: 'L1', name: 'Gate', ax: 640, ay: 200, bx: 640, by: 600 }]);
  const seq = simulate({ cars: LANE_CARS, frames: 200, fps: 30, missRate: 0.1, noise: 2, seed: 5 });
  for (const { t, dets } of seq) counter.update(tracker.update(dets, t), t);
  const c = counter.lines[0].counts;
  // A->B points down; right-hand side of a downward line on screen is -x (left).
  // Cars moving right (1,2,4) go from left (+side) to right (-side) => "out".
  assert.equal(c.out, 3);
  assert.equal(c.in, 2);
  assert.equal(c.byClass.in[7], 1);
});

test('counter ignores jitter of a car stopped on the line', () => {
  const counter = new LineCounter();
  counter.setLines([{ id: 'L', name: 'L', ax: 0, ay: 100, bx: 200, by: 100 }]);
  const r = rng(11);
  for (let f = 0; f < 20; f++) {
    const y = 40 + f * 3; // arrives from above and stops on the line
    counter.update([{ key: 1, id: 1, cls: 2, box: [90, y - 20, 130, y + 20] }], f / 30 - 1);
  }
  for (let f = 0; f < 300; f++) {
    const y = 100 + (r() - 0.5) * 4; // centre wobbles +-2 px around the line
    counter.update([{ key: 1, id: 1, cls: 2, box: [90, y - 20, 130, y + 20] }], f / 30);
  }
  assert.equal(counter.totals().total, 0);
  // now it actually drives across
  for (let f = 0; f < 30; f++) {
    const y = 100 + f * 3;
    counter.update([{ key: 1, id: 1, cls: 2, box: [90, y - 20, 130, y + 20] }], 10 + f / 30);
  }
  assert.equal(counter.totals().total, 1);
});

test('counter needs the crossing to happen within the drawn segment', () => {
  const counter = new LineCounter();
  counter.setLines([{ id: 'L', name: 'L', ax: 0, ay: 100, bx: 200, by: 100 }]);
  for (let f = 0; f < 30; f++) {
    const y = 60 + f * 3;
    counter.update([{ key: 1, id: 1, cls: 2, box: [380, y - 10, 420, y + 10] }], f / 30);
  }
  assert.equal(counter.totals().total, 0);
});

test('a car that skips the line between two analysed frames is still counted', () => {
  const counter = new LineCounter();
  counter.setLines([{ id: 'L', name: 'L', ax: 0, ay: 100, bx: 200, by: 100 }]);
  counter.update([{ key: 1, id: 1, cls: 2, box: [90, 20, 110, 40] }], 0); // y=30, above
  counter.update([{ key: 1, id: 1, cls: 2, box: [90, 160, 110, 180] }], 0.5); // y=170, below
  assert.equal(counter.totals().total, 1);
});

// ---------- post-processing ----------
test('decode v8 layout + NMS + letterbox back to source pixels', () => {
  const N = 8;
  const nc = 3;
  const C = 4 + nc;
  const data = new Float32Array(C * N);
  const put = (i, cx, cy, w, h, cls, s) => {
    data[i] = cx;
    data[N + i] = cy;
    data[2 * N + i] = w;
    data[3 * N + i] = h;
    data[(4 + cls) * N + i] = s;
  };
  put(0, 320, 320, 100, 50, 2, 0.9);
  put(1, 322, 321, 100, 50, 2, 0.8); // duplicate of 0
  put(2, 100, 400, 40, 40, 1, 0.7);
  put(3, 500, 300, 40, 40, 0, 0.6); // filtered by class
  put(4, 322, 321, 100, 50, 1, 0.5); // overlapping, other class -> removed by agnostic NMS
  const lb = letterbox(1280, 720, 640);
  const out = decode(data, [1, C, N], { conf: 0.25, classes: new Set([1, 2]), ...lb, srcW: 1280, srcH: 720, agnostic: true });
  assert.equal(out.length / 6, 2);
  // first box: centre 320,320 in input -> source x = (320-0)/0.5 = 640, y = (320-140)/0.5 = 360
  assert.ok(Math.abs((out[0] + out[2]) / 2 - 640) < 1.5);
  assert.ok(Math.abs((out[1] + out[3]) / 2 - 360) < 1.5);
  assert.equal(detectFormat([1, 84, 8400]), 'v8');
  assert.equal(detectFormat([1, 25200, 85]), 'v5');
  assert.equal(detectFormat([1, 300, 6]), 'e2e6');
  assert.equal(detectFormat([12, 7]), 'e2e7');
});

test('decode v5 layout uses objectness x class score', () => {
  const N = 3;
  const S = 5 + 2;
  const d = new Float32Array(N * S);
  d.set([100, 100, 20, 20, 0.9, 0.1, 0.8], 0);
  d.set([200, 200, 20, 20, 0.3, 0.9, 0.1], S); // 0.27
  d.set([300, 300, 20, 20, 0.05, 0.9, 0.9], 2 * S);
  const out = decode(d, [1, N, S], { format: 'v5', conf: 0.25, classes: null, scale: 1, padX: 0, padY: 0, srcW: 640, srcH: 640 });
  assert.equal(out.length / 6, 2);
  assert.equal(out[5], 1);
  assert.ok(Math.abs(out[4] - 0.72) < 1e-6);
});

test('class-aware NMS keeps overlapping boxes of different classes', () => {
  const boxes = [
    [0, 0, 10, 10, 0.9, 1],
    [0, 0, 10, 10, 0.8, 2],
  ];
  assert.equal(nms(boxes.map((b) => b.slice()), 0.5, false, 10).length, 2);
  assert.equal(nms(boxes.map((b) => b.slice()), 0.5, true, 10).length, 1);
});

test('buffered IoU lets small fast boxes overlap', () => {
  const a = [0, 0, 10, 10];
  const b = [12, 0, 22, 10];
  assert.equal(boxIou(a, b, 0), 0);
  assert.ok(boxIou(a, b, 0.25) > 0);
});

test('reads class names and input shape from a real model', { skip: !existsSync('models/yolo26n.onnx') }, () => {
  const info = readOnnxInfo(readFileSync('models/yolo26n.onnx'));
  assert.equal(info.names[2], 'car');
  assert.equal(info.names.length, 80);
  assert.equal(info.inputShape.length, 4);
  assert.equal(info.inputShape[1], 3);
});

test('parses python-dict class names', () => {
  assert.deepEqual(parseNames("{0: 'car', 1: \"bus\", 2: 'it\\'s'}").slice(0, 2), ['car', 'bus']);
});

test('csv exports', () => {
  const events = [
    { t: 5, lineId: 'a', lineName: 'North, gate', dir: 'in', trackId: 1, cls: 2 },
    { t: 65, lineId: 'a', lineName: 'North, gate', dir: 'out', trackId: 2, cls: 7 },
  ];
  const names = ['person', 'bicycle', 'car', 'motorcycle', 'airplane', 'bus', 'train', 'truck'];
  const ev = eventsCsv(events, names, new Date(Date.UTC(2023, 5, 1, 16, 18, 27)));
  assert.match(ev, /"North, gate",in,1,car/);
  assert.match(ev, /2023-06-01 16:18:32/);
  const iv = intervalCsv(events, [{ id: 'a', name: 'North, gate' }], names, { intervalS: 60, durationS: 120 });
  const lines = iv.trim().split('\r\n');
  assert.equal(lines.length, 3);
  assert.match(lines[1], /^00:00:00,00:01:00,1,0,1,0,1,1$/);
  assert.match(lines[2], /^00:01:00,00:02:00,0,1,0,1,1,2$/);
});

test('reads the recording time from MP4 (moov at start and at end)', async () => {
  const { readMp4CreationTime } = await import('../js/core/mp4time.js');
  const a = await readMp4CreationTime(new File([readFileSync('tests/fixtures/dated.mp4')], 'a.mp4'));
  assert.equal(a.iso, '2023-06-01T16:18:27');
  const b = await readMp4CreationTime(new File([readFileSync('tests/fixtures/dated_moov_end.mp4')], 'b.mp4'));
  assert.equal(b.iso, '2024-02-29T08:05:09');
  const none = await readMp4CreationTime(new File([new Uint8Array(100)], 'x.mp4'));
  assert.equal(none, null);
});

test('interval csv ends at the video length', () => {
  const ev = [{ t: 3, lineId: 'g', lineName: 'Gate', dir: 'out', trackId: 1, cls: 5 }];
  const rows = intervalCsv(ev, [{ id: 'g', name: 'Gate' }], ['a', 'b', 'c', 'd', 'e', 'bus'], { intervalS: 60, durationS: 16 }).trim().split('\r\n');
  assert.equal(rows[1], '00:00:00,00:00:16,0,1,1,1,1');
});
