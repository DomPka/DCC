#!/usr/bin/env node
// Car Counter station: counts vehicles crossing lines on a live camera stream, 24/7.
// Usage: node station.mjs [config.json]
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { cpus } from 'node:os';
import { FrameSource } from './lib/frames.mjs';
import { NodeDetector } from './lib/detector-node.mjs';
import { CountStore, writeAtomic } from './lib/store.mjs';
import { GitHubPublisher } from './lib/publish.mjs';
import { encodePng } from './lib/png.mjs';
import { startServer, validateLines } from './lib/server.mjs';
import { ByteTracker } from '../js/core/tracker.js';
import { LineCounter } from '../js/core/counter.js';
import { wallParts } from '../js/core/countdata.js';

const here = dirname(new URL(import.meta.url).pathname);
const configPath = resolve(process.argv[2] || join(here, 'config.json'));
if (!existsSync(configPath)) {
  console.error(`Config not found: ${configPath}\nCopy config.example.json to config.json and set your stream URL.`);
  process.exit(1);
}
const userCfg = JSON.parse(readFileSync(configPath, 'utf8'));
const cfgDir = dirname(configPath);
const cfg = {
  name: 'Camera',
  model: '../models/yolo26n.onnx',
  inputSize: 640,
  confidence: 0.4,
  classes: ['car', 'truck', 'bus', 'motorcycle'],
  anchor: 'center',
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  dataDir: './data',
  threads: 0,
  ...userCfg,
  stream: { fps: 10, maxWidth: 1280, resolve: 'auto', ...(userCfg.stream || {}) },
  http: { port: 8090, host: '0.0.0.0', adminPassword: '', ...(userCfg.http || {}) },
  publish: userCfg.publish || null,
};
const rel = (p) => resolve(cfgDir, p);

const log = (msg) => {
  const w = wallParts(new Date(), cfg.timezone);
  const p = (n) => String(n).padStart(2, '0');
  console.log(`${w.date} ${p(w.hour)}:${p(w.minute)}:${p(w.second)}  ${msg}`);
};

// ------------------------------------------------------------------ setup
const dataDir = rel(cfg.dataDir);
const store = new CountStore({ dir: dataDir, timeZone: cfg.timezone, name: cfg.name });
const linesFile = join(dataDir, 'lines.json');
let lines = existsSync(linesFile) ? JSON.parse(readFileSync(linesFile, 'utf8')) : validateLines(cfg.lines || []);

const detector = new NodeDetector();
const model = await detector.load(rel(cfg.model), { inputSize: cfg.inputSize, threads: cfg.threads || Math.max(1, cpus().length - 1) });
const names = model.names;
store.setClasses(names);
const classIds = cfg.classes.map((n) => names.indexOf(n)).filter((i) => i >= 0);
log(`model ${cfg.model}: ${model.size[1]}x${model.size[0]}, counting ${classIds.map((i) => names[i]).join(', ') || 'all classes'}`);

const conf = Number(cfg.confidence);
const tracker = new ByteTracker({ highThresh: conf, newTrackThresh: Math.min(0.95, conf + 0.1), lowThresh: Math.min(0.1, conf / 2) });
const counter = new LineCounter({ anchor: cfg.anchor });
let frameDims = null;

function applyLines() {
  if (!frameDims) return;
  const [W, H] = frameDims;
  counter.setLines(lines.map((l) => ({ id: l.id, name: l.name, ax: l.a.x * W, ay: l.a.y * H, bx: l.b.x * W, by: l.b.y * H })));
  store.setLines(lines);
}

// ------------------------------------------------------------------ frames
const source = new FrameSource({ ...cfg.stream });
let latest = null;
let waiting = null;
let streamState = 'connecting';
let lastError = '';
source.on('log', log);
source.on('frame', (f) => {
  latest = f;
  streamState = 'live';
  if (waiting) {
    const w = waiting;
    waiting = null;
    w();
  }
});
source.on('down', (err) => {
  streamState = 'reconnecting';
  lastError = err.message;
});

// ------------------------------------------------------------------ main loop
const stats = { started: new Date(), frames: 0, inferMs: 0, lastFrameAt: 0, fpsEma: 0 };
let lastProcessedT = null;
let liveTracks = [];
let snapshotFrame = null;
let snapshotPng = null;

async function loop() {
  for (;;) {
    if (!latest) await new Promise((r) => (waiting = r));
    const f = latest;
    latest = null;
    const t = f.t / 1000;
    if (!frameDims || frameDims[0] !== f.width || frameDims[1] !== f.height) {
      frameDims = [f.width, f.height];
      applyLines();
    }
    if (f.gap || (lastProcessedT !== null && (t - lastProcessedT > 5 || t < lastProcessedT))) {
      tracker.reset(false); // reconnect or stall: start fresh tracks, keep counts
      lastProcessedT = null;
    }
    const t0 = performance.now();
    let dets;
    try {
      dets = await detector.detect(f.data, f.width, f.height, { conf: Math.min(0.1, conf / 2), classes: classIds.length ? classIds : null });
    } catch (err) {
      log(`detection failed: ${err.message}`);
      continue;
    }
    const ms = performance.now() - t0;
    const tracks = tracker.update(dets, t);
    const events = counter.update(tracks, t);
    if (stats.frames % 50 === 0) counter.prune(tracker.liveKeys());
    for (const e of events) store.addEvent({ ...e, time: new Date(e.t * 1000) });
    if (lastProcessedT !== null) {
      const dt = t - lastProcessedT;
      if (dt > 0 && dt < 3) {
        store.addCoverage(new Date(f.t), dt);
        stats.fpsEma = stats.fpsEma ? stats.fpsEma * 0.95 + (1 / dt) * 0.05 : 1 / dt;
      }
    }
    lastProcessedT = t;
    stats.frames++;
    stats.inferMs = stats.inferMs ? stats.inferMs * 0.95 + ms * 0.05 : ms;
    stats.lastFrameAt = f.t;
    liveTracks = tracks.filter((tr) => tr.activated).map((tr) => ({ id: tr.id, cls: tr.cls, box: tr.box.map((v) => Math.round(v)) }));
    snapshotFrame = f;
  }
}

// ------------------------------------------------------------------ status, saving, publishing
function status() {
  const age = stats.lastFrameAt ? (Date.now() - stats.lastFrameAt) / 1000 : null;
  const now = wallParts(new Date(), cfg.timezone);
  const today = store.day(now.date);
  let thisHour = 0;
  for (const [k, v] of today.rows) if (Number(k.split('|')[0]) === now.hour) thisHour += v;
  return {
    online: age !== null && age < 30,
    stream: streamState,
    lastError: streamState === 'live' ? '' : lastError,
    lastFrame: stats.lastFrameAt ? new Date(stats.lastFrameAt).toISOString() : null,
    analysedFps: Number(stats.fpsEma.toFixed(1)),
    inferMs: Math.round(stats.inferMs),
    since: stats.started.toISOString(),
    today: today.total(),
    thisHour,
  };
}

let publishPending = new Set();
function flush() {
  try {
    for (const p of store.flush(status())) publishPending.add(p);
  } catch (err) {
    log(`saving failed: ${err.message}`);
  }
}

let publisher = null;
if (cfg.publish?.repo) {
  const token = cfg.publish.token || process.env[cfg.publish.tokenEnv || 'GITHUB_TOKEN'];
  if (!token) log('publishing disabled: no GitHub token (set GITHUB_TOKEN)');
  else {
    publisher = new GitHubPublisher({ repo: cfg.publish.repo, branch: cfg.publish.branch, token, prefix: cfg.publish.folder });
    log(`publishing to ${publisher.rawBase} every ${cfg.publish.everyMinutes || 10} min`);
  }
}
async function publish() {
  if (!publisher || !publishPending.size) return;
  const files = {};
  for (const p of publishPending) files[p] = readFileSync(join(dataDir, p), 'utf8');
  try {
    await publisher.publish(files, `Counts ${new Date().toISOString().slice(0, 16)}`);
    publishPending = new Set();
  } catch (err) {
    log(`publishing failed (will retry): ${err.message}`);
  }
}

startServer({
  port: cfg.http.port,
  host: cfg.http.host,
  webRoot: resolve(here, '..'),
  adminPassword: cfg.http.adminPassword,
  log,
  api: {
    status,
    index: () => store.index(status()),
    day: (date) => store.day(date).toJSON(),
    live: () => ({
      width: frameDims?.[0] || 0,
      height: frameDims?.[1] || 0,
      tracks: liveTracks,
      lines: counter.lines.map((l) => ({ id: l.id, name: l.name, in: l.counts.in, out: l.counts.out })),
      classes: names,
      status: status(),
      publicData: publisher ? publisher.rawBase : null,
    }),
    snapshot: () => {
      if (!snapshotFrame) return null;
      if (!snapshotPng || snapshotPng.t !== snapshotFrame.t) {
        snapshotPng = { t: snapshotFrame.t, png: encodePng(snapshotFrame.data, snapshotFrame.width, snapshotFrame.height) };
      }
      return snapshotPng.png;
    },
    getLines: () => lines,
    setLines: (newLines) => {
      lines = newLines;
      writeAtomic(linesFile, JSON.stringify(lines, null, 2));
      applyLines();
    },
  },
});

setInterval(flush, 60 * 1000);
setInterval(publish, (cfg.publish?.everyMinutes || 10) * 60 * 1000);
setInterval(() => {
  const s = status();
  log(`${s.stream}, ${s.analysedFps} fps analysed, ${s.inferMs} ms/frame, ${s.thisHour} this hour, ${s.today} today`);
}, 10 * 60 * 1000);

async function shutdown() {
  log('stopping, saving counts');
  source.stop();
  flush();
  await publish();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

if (!lines.length) log('no counting lines yet: open the web page and draw them on the camera picture');
source.start();
loop();
