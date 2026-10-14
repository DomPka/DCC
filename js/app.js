// Car Counter 2 - main controller.
import { Detector } from './detector.js';
import { ByteTracker } from './core/tracker.js';
import { LineCounter } from './core/counter.js';
import { eventsCsv, intervalCsv } from './core/csv.js';
import { readMp4CreationTime } from './core/mp4time.js';
import { Overlay, classColor } from './overlay.js';
import { Runner } from './runner.js';
import { SessionRecorder } from './sessions.js';

const $ = (id) => document.getElementById(id);
const els = {
  stage: $('stage'),
  video: $('video'),
  canvas: $('overlay'),
  empty: $('stage-empty'),
  hint: $('stage-hint'),
  hintText: $('stage-hint-text'),
  loading: $('stage-loading'),
  loadingText: $('loading-text'),
  loadingBar: $('loading-bar'),
  transport: $('transport'),
  run: $('btn-run'),
  addLine: $('btn-add-line'),
  editLines: $('btn-edit-lines'),
  editDone: $('btn-edit-done'),
  source: $('btn-source'),
  progress: $('progress'),
  seek: $('seek'),
  progressTime: $('progress-time'),
  slow: $('slow-warning'),
  problem: $('frame-warning'),
  chipEngine: $('chip-engine'),
  chipSpeed: $('chip-speed'),
  total: $('total'),
  totalIn: $('total-in'),
  totalOut: $('total-out'),
  active: $('active-tracks'),
  lines: $('lines'),
  linesEmpty: $('lines-empty'),
  csvIntervals: $('btn-csv-intervals'),
  csvEvents: $('btn-csv-events'),
  reset: $('btn-reset'),
  fileInput: $('file-input'),
  modelFile: $('model-file'),
  sheet: $('source-sheet'),
  toast: $('toast'),
  install: $('btn-install'),
  iosInstall: $('ios-install'),
  set: {
    model: $('set-model'),
    modelNote: $('model-note'),
    size: $('set-size'),
    conf: $('set-conf'),
    confOut: $('conf-out'),
    classes: $('set-classes'),
    anchor: $('set-anchor'),
    mode: $('set-mode'),
    fps: $('set-fps'),
    interval: $('set-interval'),
    start: $('set-start'),
    startNote: $('start-note'),
    boxes: $('show-boxes'),
    labels: $('show-labels'),
    trails: $('show-trails'),
    engine: $('set-engine'),
  },
};

// ---------------------------------------------------------------- persistence
const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v ? JSON.parse(v) : fallback;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* private mode or storage blocked: settings just won't persist */
    }
  },
};

const DEFAULTS = {
  model: 'models/yolo26n.onnx',
  size: 640,
  conf: 0.4,
  classNames: ['car', 'motorcycle', 'bus', 'truck'],
  anchor: 'center',
  mode: 'fast',
  fps: 15,
  interval: 60,
  show: { boxes: true, labels: true, trails: true },
  engine: 'auto',
};
const settings = { ...DEFAULTS, ...store.get('cc.settings', {}) };
const saveSettings = () => store.set('cc.settings', settings);

// Names used when a custom 5-class model carries no names: the lab's Roboflow
// "cars-from-drone" dataset (data/data.yaml in the v1 repo).
const DRONE_DATASET_NAMES = ['bicycle', 'bus', 'car', 'motorcycle', 'truck'];
const COCO_VEHICLES = ['car', 'truck', 'bus', 'motorcycle', 'bicycle', 'person'];

// ---------------------------------------------------------------- state
const detector = new Detector();
const tracker = new ByteTracker();
const counter = new LineCounter({ anchor: settings.anchor });
const overlay = new Overlay(els.canvas, els.video);
const runner = new Runner(els.video, analyse);

let lines = store.get('cc.lines', []);
let names = null;
let selectedClassIds = null;
let source = null; // {kind: 'camera'|'file', name, stream?, url?}
let startDate = null; // Date whose UTC fields are the wall-clock digits of recording start
let lastTracks = [];
let lastAnalysedT = null;
let frameCount = 0;
let modelReady = false;
let editing = false;
let placing = false;
let pending = null;
let drag = null;
let wakeLock = null;
let customModel = null; // {name, buffer}
let recorder = null; // saves this counting run for the analytics page
let failStreak = 0; // analysis attempts in a row that failed
let blankStreak = 0; // analysed frames in a row that came through as one flat colour
let problemKind = null;
let resumeAfterSeek = false;
let hls = null;

// ---------------------------------------------------------------- startup
init();

async function init() {
  applySettingsToForm();
  bindUi();
  renderLineList();
  setupInstall();
  const reloading = await ensureCrossOriginIsolation();
  if (reloading) return;
  await loadModel();
}

/** Multi-threaded WASM needs cross-origin isolation, which GitHub Pages can't set as headers;
 *  our service worker adds them, which takes effect after one reload on the first visit. */
async function ensureCrossOriginIsolation() {
  if (!('serviceWorker' in navigator)) return false;
  // A newer version took over while this page was open: reload into it, unless the person
  // has already opened a video or camera (they'd lose it); then it applies on the next visit.
  if (navigator.serviceWorker.controller) {
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!source && runner.state !== 'running') location.reload();
    });
  }
  try {
    await navigator.serviceWorker.register('./sw.js');
  } catch (err) {
    console.warn('Service worker not registered', err);
    return false;
  }
  if (self.crossOriginIsolated) return false;
  let tried = false;
  try {
    tried = sessionStorage.getItem('cc-coi-reload') === '1';
  } catch {
    tried = true;
  }
  if (tried) return false;
  if (!navigator.serviceWorker.controller) {
    await new Promise((res) => {
      navigator.serviceWorker.addEventListener('controllerchange', res, { once: true });
      setTimeout(res, 2500);
    });
  }
  if (!navigator.serviceWorker.controller) return false;
  try {
    sessionStorage.setItem('cc-coi-reload', '1');
  } catch {
    return false;
  }
  location.reload();
  return true;
}

// ---------------------------------------------------------------- model
async function loadModel() {
  modelReady = false;
  if (runner.state === 'running') runner.pause();
  els.run.disabled = true;
  els.chipEngine.textContent = 'Loading model';
  els.chipEngine.classList.remove('is-warn');
  showLoading(customModel ? `Loading ${customModel.name}` : 'Downloading detection model', 0);
  detector.onProgress = (loaded, total) => {
    const mb = (x) => (x / 1048576).toFixed(1);
    showLoading(`Downloading detection model, ${mb(loaded)} of ${mb(total)} MB`, total ? loaded / total : 0);
  };
  try {
    const model = customModel ? { buffer: customModel.buffer.slice(0) } : { url: settings.model };
    const info = await detector.load(model, { prefer: settings.engine, inputSize: settings.size });
    showLoading('Preparing the detector', 1);
    names = info.names;
    let namesNote = '';
    if (!names || !names.length) {
      if (info.nc === 5) {
        names = DRONE_DATASET_NAMES;
        namesNote = 'This model has no class names inside; using the cars-from-drone dataset names.';
      } else {
        names = Array.from({ length: info.nc || 80 }, (_, i) => `class ${i}`);
        namesNote = 'This model has no class names inside, so classes are shown by number.';
      }
    }
    buildClassChecks();
    els.set.size.disabled = !!info.fixedSize;
    const sizeNote = info.fixedSize ? `This model has a fixed ${info.fixedSize[1]}×${info.fixedSize[0]} input.` : '';
    els.set.modelNote.textContent = [customModel ? `Using ${customModel.name}.` : '', sizeNote, namesNote].filter(Boolean).join(' ');
    els.chipEngine.textContent = info.backend;
    els.chipEngine.title = info.crossOriginIsolated ? '' : 'Single-threaded: the page is not cross-origin isolated';
    modelReady = true;
    hideLoading();
    updateRunButton();
  } catch (err) {
    console.error(err);
    hideLoading();
    els.chipEngine.textContent = 'Model failed';
    els.chipEngine.classList.add('is-warn');
    toast(`The detection model could not be loaded: ${err.message}`);
    if (customModel) {
      customModel = null;
      els.set.model.value = settings.model;
    }
  }
}

function buildClassChecks() {
  const box = els.set.classes;
  box.textContent = '';
  const isCoco = names.includes('car') && names.includes('truck') && names.length >= 80;
  const offered = isCoco ? COCO_VEHICLES.map((n) => names.indexOf(n)).filter((i) => i >= 0) : names.map((_, i) => i).slice(0, 60);
  const wanted = new Set(settings.classNames);
  const anyKnown = offered.some((i) => wanted.has(names[i]));
  for (const i of offered) {
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = String(i);
    cb.checked = anyKnown ? wanted.has(names[i]) : true;
    const dot = document.createElement('span');
    dot.className = 'class-dot';
    dot.style.background = classColor(names, i);
    label.append(cb, dot, ` ${names[i]}`);
    box.append(label);
  }
  readClassChecks();
}

function readClassChecks() {
  const ids = [...els.set.classes.querySelectorAll('input:checked')].map((c) => Number(c.value));
  selectedClassIds = ids;
  if (ids.length) {
    settings.classNames = ids.map((i) => names[i]);
    saveSettings();
  }
}

// ---------------------------------------------------------------- sources
async function openFile(file) {
  if (!file) return;
  stopSource();
  const url = URL.createObjectURL(file);
  source = { kind: 'file', name: file.name, url, key: `file:${file.name}:${file.size}` };
  const v = els.video;
  v.srcObject = null;
  // CORS mode for our own blob URL changes nothing in loading, but it lets browsers that
  // misjudge a local file's origin (Firefox for Android) still hand its frames to the detector
  v.crossOrigin = 'anonymous';
  v.src = url;
  v.muted = true;
  try {
    await once(v, 'loadedmetadata', 15000);
  } catch {
    toast('This video format cannot be played in this browser. Try MP4 (H.264).');
    return;
  }
  await seekPreview(0);
  afterSourceReady();
  runner.setMode(settings.mode, Number(settings.fps));
  els.progress.hidden = false;
  updateProgress(0);
  const meta = await readMp4CreationTime(file);
  if (meta) {
    setStartDate(meta.date, `Read from the video file: ${meta.iso.replace('T', ' ')}.`);
  } else {
    setStartDate(null, 'No recording time found in this file. Enter it to get clock times in the CSV.');
  }
}

async function startCamera() {
  stopSource();
  if (!navigator.mediaDevices?.getUserMedia) {
    toast('Camera access needs a secure (https) page.');
    return;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
    });
  } catch (err) {
    toast(err.name === 'NotAllowedError' ? 'Camera permission was denied. Allow it in the browser settings to count live.' : `Camera unavailable: ${err.message}`);
    return;
  }
  source = { kind: 'camera', name: 'camera', stream };
  const v = els.video;
  v.removeAttribute('src');
  v.srcObject = stream;
  v.muted = true;
  await v.play().catch(() => {});
  if (!v.videoWidth) await once(v, 'loadeddata', 5000).catch(() => {});
  afterSourceReady();
  runner.setMode('live', 30);
  els.progress.hidden = true;
  setStartDate(null, 'Set automatically when counting starts.');
}

function nowDigits() {
  const now = new Date();
  return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), now.getMinutes(), now.getSeconds()));
}

const STREAM_HELP = {
  youtube:
    "YouTube doesn't let web pages read its video, so this counter can't analyse YouTube links. The counting station can: put this link in its config as stream.url.",
  page:
    'This is a web page, not a video stream. Paste the stream link itself, usually ending in .m3u8. On a computer: open the page, press F12, open Network, type m3u8 in the filter, play the video, and copy that link.',
  blocked: "This stream's server doesn't let other websites read it, so it can't be analysed here. The counting station can count it: put the link in its config.",
  notfound: 'Nothing was found at that link. Check that it is complete, or copy it again.',
  expired: 'The server refused the link. Stream links with a token often expire after a while; copy a fresh one.',
  timeout: "The stream didn't start within 15 seconds. Check that it's live, then try again.",
  unclear:
    "This doesn't look like a video stream link (those usually end in .m3u8), and its server didn't let the page check. If it's a web page with a video player, paste the stream link itself: on a computer, open the page, press F12, open Network, type m3u8 in the filter, play the video, and copy that link.",
};

function streamKind(u) {
  if (/(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/i.test(u.hostname)) return 'youtube';
  if (/\.m3u8$/i.test(u.pathname) || /m3u8/i.test(u.search)) return 'hls';
  if (/\.(mp4|webm|mov|m4v|mkv|ts)$/i.test(u.pathname)) return 'file';
  return 'unknown';
}

/** For links without a telling extension: ask the server what it is (needs CORS). */
async function sniffStream(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  try {
    const r = await fetch(url, { mode: 'cors', signal: ctl.signal });
    const type = (r.headers.get('content-type') || '').toLowerCase();
    ctl.abort(); // headers are enough
    if (r.status === 404) return 'notfound';
    if (r.status === 401 || r.status === 403) return 'expired';
    if (type.includes('mpegurl')) return 'hls';
    if (type.startsWith('video/')) return 'file';
    return 'page';
  } catch {
    return 'unclear';
  } finally {
    clearTimeout(timer);
  }
}

function streamFailed(kind, url) {
  stopSource();
  els.empty.hidden = false;
  els.stage.classList.add('is-empty');
  els.transport.hidden = true;
  hideLoading();
  askStream(url, STREAM_HELP[kind] || STREAM_HELP.blocked);
}

async function openStream(url) {
  if (!url) return;
  let u;
  try {
    u = new URL(url);
  } catch {
    askStream(url, 'That is not a complete link. It should start with https://');
    return;
  }
  let kind = streamKind(u);
  if (kind === 'youtube') return askStream(url, STREAM_HELP.youtube);
  stopSource();
  showLoading('Connecting to the stream…', 0);
  if (kind === 'unknown') {
    kind = await sniffStream(url);
    if (kind !== 'hls' && kind !== 'file') return streamFailed(kind, url);
  }
  source = { kind: 'stream', name: u.hostname, url };
  const v = els.video;
  v.srcObject = null;
  v.crossOrigin = 'anonymous';
  v.muted = true;
  let started = false;
  try {
    const failed = new Promise((_, reject) => {
      v.addEventListener('error', () => !started && reject(Object.assign(new Error('media error'), { kind: 'blocked' })), { once: true });
      if (kind === 'hls' && !v.canPlayType('application/vnd.apple.mpegurl')) {
        import('../vendor/hls/hls.light.min.mjs').then(({ default: Hls }) => {
          if (!Hls.isSupported()) return reject(Object.assign(new Error('no HLS'), { kind: 'blocked' }));
          hls = new Hls({ liveSyncDurationCount: 3, lowLatencyMode: false });
          let fatalCount = 0;
          hls.on(Hls.Events.ERROR, (_e, data) => {
            if (!data.fatal) return;
            if (!started) {
              const code = data.response?.code;
              reject(Object.assign(new Error(data.details), { kind: code === 404 ? 'notfound' : code === 401 || code === 403 ? 'expired' : 'blocked' }));
              return;
            }
            fatalCount++; // streams drop: keep trying
            if (data.type === Hls.ErrorTypes.MEDIA_ERROR && fatalCount < 5) hls.recoverMediaError();
            else setTimeout(() => hls?.loadSource(url), Math.min(60, 5 * fatalCount) * 1000);
          });
          hls.loadSource(url);
          hls.attachMedia(v);
        }, reject);
      } else {
        v.src = url;
      }
    });
    v.play().catch(() => {}); // may stay pending until data arrives, so don't wait on it
    if (!v.videoWidth) await Promise.race([once(v, 'loadeddata', 15000), failed]);
    started = true;
    // make sure the browser lets us read the pixels (the server must allow cross-origin use)
    const probe = new OffscreenCanvas(8, 8).getContext('2d');
    probe.drawImage(v, 0, 0, 8, 8);
    probe.getImageData(0, 0, 1, 1);
  } catch (err) {
    return streamFailed(err?.kind || (/timeout/.test(String(err?.message)) ? 'timeout' : 'blocked'), url);
  }
  hideLoading();
  afterSourceReady();
  runner.setMode('live', 30);
  els.progress.hidden = true;
  setStartDate(null, 'Set automatically when counting starts.');
  // keep counting through stalls
  v.addEventListener('pause', () => runner.state === 'running' && source?.kind === 'stream' && v.play().catch(() => {}));
}


function stopSource() {
  closeRecorder();
  if (hls) {
    hls.destroy();
    hls = null;
  }
  runner.reset();
  releaseWakeLock();
  hideProblem();
  failStreak = 0;
  blankStreak = 0;
  resumeAfterSeek = false;
  if (source?.stream) source.stream.getTracks().forEach((t) => t.stop());
  if (source?.url) URL.revokeObjectURL(source.url);
  source = null;
  resetCounting(true);
  updateRunButton();
}

function afterSourceReady() {
  const v = els.video;
  els.empty.hidden = true;
  els.stage.classList.remove('is-empty');
  els.transport.hidden = false;
  if (v.videoWidth) els.stage.style.aspectRatio = `${v.videoWidth} / ${v.videoHeight}`;
  overlay.layout();
  syncCounterLines();
  render();
  updateRunButton();
  if (!lines.length) startPlacing();
}

function seekPreview(t) {
  const v = els.video;
  return new Promise((resolve) => {
    const done = () => {
      v.removeEventListener('seeked', done);
      resolve();
    };
    v.addEventListener('seeked', done);
    v.currentTime = Math.min(Math.max(0, t), Math.max(0, (v.duration || 0) - 0.01));
    setTimeout(done, 1500);
  });
}

function setStartDate(date, note) {
  startDate = date;
  recorder?.setStart(date);
  els.set.start.value = date ? date.toISOString().slice(0, 19) : '';
  els.set.startNote.textContent = note;
}

// ---------------------------------------------------------------- analysis
async function analyse(t) {
  if (!modelReady || !els.video.videoWidth) return false;
  const v = els.video;
  if (lastAnalysedT !== null && (t < lastAnalysedT - 0.05 || t - lastAnalysedT > 3)) {
    tracker.reset(false); // jumped in the video: start fresh tracks, keep the counts
  }
  const conf = Number(settings.conf);
  tracker.setOptions({ highThresh: conf, newTrackThresh: Math.min(0.95, conf + 0.1), lowThresh: Math.min(0.1, conf / 2) });
  let res;
  try {
    res = await detector.detect(v, v.videoWidth, v.videoHeight, {
      inputSize: Number(settings.size),
      conf: Math.min(0.1, conf / 2),
      classes: selectedClassIds && selectedClassIds.length ? selectedClassIds : null,
      iou: 0.5,
      agnostic: true,
    });
  } catch (err) {
    console.error(err);
    // never let a video play to the end silently while nothing can be analysed
    if (++failStreak >= 3 && runner.state === 'running') {
      runner.pause();
      const how = err.where === 'frame' && detector.captureLog ? ` Tried: ${detector.captureLog}.` : '';
      showProblem(`Counting stopped: this browser couldn't analyse the video. The error was: ${err.message}.${how}`);
    }
    return false;
  }
  if (res.skipped) return false;
  failStreak = 0;
  blankStreak = res.blank ? blankStreak + 1 : 0;
  if (blankStreak === 15) {
    showProblem(`This browser is giving the page only blank pictures from the video, so nothing can be detected. Try opening it in another browser. Tried: ${detector.captureLog || detector.captureName}.`, 'blank');
  } else if (blankStreak === 0) {
    hideProblem('blank');
  }
  lastAnalysedT = t;
  const tracks = tracker.update(res.dets, t);
  const events = counter.update(tracks, t);
  if (++frameCount % 30 === 0) counter.prune(tracker.liveKeys());
  lastTracks = tracks.filter((tr) => tr.activated);
  if (recorder) recorder.frame(t);
  for (const e of events) {
    overlay.flash.set(e.lineId, performance.now());
    flashRow(e.lineId);
    recorder?.event(e);
  }
  render();
  updateTally();
  if (res.timing) els.chipEngine.textContent = `${detector.info.backend}, ${Math.round(res.timing.infer)} ms`;
  return true;
}

function closeRecorder() {
  if (recorder) recorder.close();
  recorder = null;
}

function ensureRecorder() {
  if (recorder || !source) return;
  recorder = new SessionRecorder({ name: source.name, kind: source.kind });
  // counting the same video file again replaces its earlier saved result
  if (source.key) recorder.s.id = source.key;
  recorder.setStart(startDate);
  recorder.setMeta(lines, names);
}

function resetCounting(silent) {
  closeRecorder();
  tracker.reset(true);
  counter.resetCounts();
  lastTracks = [];
  lastAnalysedT = null;
  frameCount = 0;
  updateTally();
  render();
  if (!silent) toast('Counts reset.');
}

// ---------------------------------------------------------------- run controls
function onRunClick() {
  if (!source || !modelReady) return;
  if (runner.state === 'running') {
    runner.pause();
    return;
  }
  if (!lines.length) {
    toast('Add a counting line first.');
    startPlacing();
    return;
  }
  if (runner.state === 'done') {
    resetCounting(true);
    runner.reset();
    if (source.kind === 'file') {
      runner.setMode(settings.mode, Number(settings.fps));
      els.video.currentTime = 0;
    }
  }
  if (source.kind === 'file') runner.setMode(settings.mode, Number(settings.fps));
  if (source.kind !== 'file' && !runner.liveStart) setStartDate(nowDigits(), 'Set to when counting started.');
  failStreak = 0;
  blankStreak = 0;
  hideProblem();
  syncCounterLines();
  ensureRecorder();
  runner.start();
}

runner.onState = (state) => {
  updateRunButton();
  if (state !== 'running') recorder?.flush();
  if (state === 'running') requestWakeLock();
  else releaseWakeLock();
  if (state === 'done') {
    toast('Finished. The CSV downloads are next to the counts, and Analytics shows the result by hour.');
    updateProgress(els.video.duration || 0);
  }
};

runner.onStats = (s) => {
  if (source?.kind === 'file') updateProgress(s.t);
  const parts = [];
  if (runner.mode === 'live') parts.push(`${s.analysedPerVideoSec.toFixed(0)} fps`);
  else parts.push(`${s.speedX.toFixed(1)}× speed`);
  els.chipSpeed.hidden = false;
  els.chipSpeed.textContent = parts.join('');
  const slow = s.analysedPerVideoSec < 9.5 && s.analysed > 10;
  els.slow.hidden = !slow;
  if (slow) {
    els.slow.textContent =
      runner.mode === 'live'
        ? `Only ${s.analysedPerVideoSec.toFixed(0)} frames per second are being analysed, so fast vehicles may be missed. Choose a smaller detection size in the settings.`
        : 'This device analyses fewer than 10 frames per second of video even at the slowest playback. Choose a smaller detection size, or Exact mode.';
  }
};

function updateRunButton() {
  const label = els.run.querySelector('span');
  const icon = els.run.querySelector('use');
  els.run.disabled = !source || !modelReady;
  const st = runner.state;
  if (st === 'running') {
    label.textContent = 'Pause';
    icon.setAttribute('href', '#i-pause');
  } else {
    label.textContent = st === 'paused' ? 'Resume' : st === 'done' ? 'Count again' : 'Start counting';
    icon.setAttribute('href', '#i-play');
  }
  els.seek.disabled = source?.kind !== 'file';
  els.source.disabled = st === 'running';
}

function updateProgress(t) {
  const d = els.video.duration || 0;
  if (!d || !Number.isFinite(d)) return;
  els.seek.value = String(Math.round((t / d) * 1000));
  els.progressTime.textContent = `${fmt(t)} / ${fmt(d)}`;
}

// ---------------------------------------------------------------- lines
function syncCounterLines() {
  const W = els.video.videoWidth || 1;
  const H = els.video.videoHeight || 1;
  counter.anchor = settings.anchor;
  counter.setLines(lines.map((l) => ({ id: l.id, name: l.name, ax: l.a.x * W, ay: l.a.y * H, bx: l.b.x * W, by: l.b.y * H })));
}

function saveLines() {
  store.set('cc.lines', lines.map(({ id, name, a, b }) => ({ id, name, a, b })));
  recorder?.setMeta(lines, names);
}

function linesForDrawing() {
  return lines.map((l) => ({ ...l, counts: counter.lines.find((c) => c.id === l.id)?.counts }));
}

function addLine(a, b) {
  const used = new Set(lines.map((l) => l.name));
  let n = lines.length + 1;
  while (used.has(`Line ${n}`)) n++;
  lines.push({ id: `l${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, name: `Line ${n}`, a, b });
  saveLines();
  syncCounterLines();
  renderLineList();
}

function startPlacing() {
  if (!source) return;
  editing = true;
  placing = true;
  pending = null;
  els.stage.classList.add('is-editing');
  showHint('Tap where the counting line starts');
  render();
}

function startEditing() {
  editing = true;
  placing = false;
  pending = null;
  els.stage.classList.add('is-editing');
  showHint(lines.length ? 'Drag a line by its ends' : 'Tap where the counting line starts');
  if (!lines.length) placing = true;
  render();
}

function stopEditing() {
  editing = false;
  placing = false;
  pending = null;
  drag = null;
  els.stage.classList.remove('is-editing');
  els.hint.hidden = true;
  render();
}

function showHint(text) {
  els.hintText.textContent = text;
  els.hint.hidden = false;
}

function bindLineEditing() {
  const c = els.canvas;
  c.addEventListener('pointerdown', (e) => {
    if (!editing) return;
    const hit = overlay.hitHandle(lines, e.clientX, e.clientY);
    if (hit) {
      drag = { id: hit.line.id, end: hit.end };
      c.setPointerCapture(e.pointerId);
      render();
      e.preventDefault();
      return;
    }
    if (!placing) return;
    const p = overlay.toNorm(e.clientX, e.clientY);
    if (!pending) {
      pending = p;
      showHint('Now tap where it ends');
    } else {
      const r = overlay.rect;
      if (Math.hypot((p.x - pending.x) * r.w, (p.y - pending.y) * r.h) < 20) return;
      addLine(pending, p);
      pending = null;
      placing = false;
      showHint('Line added. Drag its ends to adjust');
    }
    render();
    e.preventDefault();
  });
  c.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const line = lines.find((l) => l.id === drag.id);
    if (!line) return;
    line[drag.end] = overlay.toNorm(e.clientX, e.clientY);
    render();
  });
  const endDrag = () => {
    if (!drag) return;
    drag = null;
    saveLines();
    syncCounterLines();
    render();
  };
  c.addEventListener('pointerup', endDrag);
  c.addEventListener('pointercancel', endDrag);
}

function renderLineList() {
  els.lines.textContent = '';
  els.linesEmpty.hidden = lines.length > 0;
  for (const line of lines) {
    const li = document.createElement('li');
    li.className = 'line-row';
    li.dataset.id = line.id;
    li.innerHTML = `
      <div class="line-name"><span class="line-swatch" aria-hidden="true"></span><input aria-label="Line name" maxlength="40" /></div>
      <div class="line-count in"><b>0</b><small>in</small></div>
      <div class="line-count out"><b>0</b><small>out</small></div>
      <div class="line-actions">
        <button class="icon-btn" type="button" data-act="flip" title="Swap in and out"><svg aria-hidden="true"><use href="#i-flip" /></svg><span class="visually-hidden">Swap in and out for ${escapeHtml(line.name)}</span></button>
        <button class="icon-btn" type="button" data-act="delete" title="Delete line"><svg aria-hidden="true"><use href="#i-trash" /></svg><span class="visually-hidden">Delete ${escapeHtml(line.name)}</span></button>
      </div>
      <p class="line-classes"></p>`;
    const input = li.querySelector('input');
    input.value = line.name;
    input.addEventListener('input', () => {
      line.name = input.value.trim() || 'Line';
      saveLines();
      syncCounterLines();
      render();
    });
    li.querySelector('[data-act="flip"]').addEventListener('click', () => {
      counter.flipLine(line.id);
      [line.a, line.b] = [line.b, line.a];
      saveLines();
      syncCounterLines();
      updateTally();
      render();
    });
    li.querySelector('[data-act="delete"]').addEventListener('click', () => {
      const c = counter.lines.find((x) => x.id === line.id)?.counts;
      if (c && c.in + c.out > 0 && !confirm(`Delete "${line.name}" and its ${c.in + c.out} counts?`)) return;
      lines = lines.filter((l) => l.id !== line.id);
      counter.events = counter.events.filter((e) => e.lineId !== line.id);
      counter.forgetLine(line.id);
      saveLines();
      syncCounterLines();
      renderLineList();
      render();
    });
    els.lines.append(li);
  }
  updateTally();
}

function flashRow(lineId) {
  const row = els.lines.querySelector(`[data-id="${lineId}"]`);
  if (!row) return;
  row.classList.add('flash');
  clearTimeout(row._flashTimer);
  row._flashTimer = setTimeout(() => row.classList.remove('flash'), 500);
}

function updateTally() {
  const t = counter.totals();
  els.total.textContent = t.total;
  els.totalIn.textContent = t.in;
  els.totalOut.textContent = t.out;
  els.active.textContent = lastTracks.length;
  for (const l of counter.lines) {
    const row = els.lines.querySelector(`[data-id="${l.id}"]`);
    if (!row) continue;
    row.querySelector('.line-count.in b').textContent = l.counts.in;
    row.querySelector('.line-count.out b').textContent = l.counts.out;
    const merged = {};
    for (const dir of ['in', 'out']) for (const [c, n] of Object.entries(l.counts.byClass[dir])) merged[c] = (merged[c] || 0) + n;
    row.querySelector('.line-classes').textContent = Object.entries(merged)
      .sort((a, b) => b[1] - a[1])
      .map(([c, n]) => `${names?.[c] ?? `class ${c}`} ${n}`)
      .join(', ');
  }
  const has = counter.events.length > 0;
  els.csvIntervals.disabled = !has;
  els.csvEvents.disabled = !has;
  els.reset.disabled = !has;
}

// ---------------------------------------------------------------- drawing
let rafPending = false;
function render() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    overlay.draw({
      lines: linesForDrawing(),
      tracks: lastTracks,
      show: settings.show,
      names,
      editing,
      pending,
      activeLine: drag?.id ?? null,
    });
    if (overlay.isAnimating()) render();
  });
}

// ---------------------------------------------------------------- CSV
function download(name, text) {
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function fileStem() {
  const d = startDate || new Date();
  const iso = (startDate ? d.toISOString() : new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString()).slice(0, 19);
  return iso.replace('T', '_').replace(/:/g, '-');
}

function exportIntervals() {
  const nameNow = new Map(lines.map((l) => [l.id, l.name]));
  const dur = source?.kind === 'file' ? els.video.duration || 0 : lastAnalysedT || 0;
  const csv = intervalCsv(
    counter.events,
    counter.lines.map((l) => ({ id: l.id, name: nameNow.get(l.id) || l.name })),
    names,
    { intervalS: Number(settings.interval), durationS: dur, startDate },
  );
  download(`counts_${fileStem()}.csv`, csv);
}

function exportEvents() {
  const nameNow = new Map(lines.map((l) => [l.id, l.name]));
  const ev = counter.events.map((e) => ({ ...e, lineName: nameNow.get(e.lineId) || e.lineName }));
  download(`vehicles_${fileStem()}.csv`, eventsCsv(ev, names, startDate));
}

// ---------------------------------------------------------------- settings form
function applySettingsToForm() {
  const s = els.set;
  s.model.value = settings.model;
  if (s.model.value !== settings.model) s.model.value = DEFAULTS.model;
  s.size.value = String(settings.size);
  s.conf.value = String(settings.conf);
  s.confOut.textContent = Number(settings.conf).toFixed(2);
  s.anchor.value = settings.anchor;
  s.mode.value = settings.mode;
  s.fps.value = String(settings.fps);
  s.interval.value = String(settings.interval);
  s.boxes.checked = settings.show.boxes;
  s.labels.checked = settings.show.labels;
  s.trails.checked = settings.show.trails;
  s.engine.value = settings.engine;
}

function bindUi() {
  const s = els.set;
  s.model.addEventListener('change', () => {
    if (s.model.value === 'custom') {
      els.modelFile.click();
      return;
    }
    customModel = null;
    settings.model = s.model.value;
    saveSettings();
    loadModel();
  });
  els.modelFile.addEventListener('change', async () => {
    const f = els.modelFile.files[0];
    els.modelFile.value = '';
    if (!f) {
      s.model.value = customModel ? 'custom' : settings.model;
      return;
    }
    customModel = { name: f.name, buffer: await f.arrayBuffer() };
    loadModel();
  });
  s.size.addEventListener('change', () => {
    settings.size = Number(s.size.value);
    saveSettings();
  });
  s.conf.addEventListener('input', () => {
    settings.conf = Number(s.conf.value);
    s.confOut.textContent = settings.conf.toFixed(2);
    saveSettings();
  });
  s.classes.addEventListener('change', readClassChecks);
  s.anchor.addEventListener('change', () => {
    settings.anchor = s.anchor.value;
    counter.anchor = settings.anchor;
    saveSettings();
  });
  s.mode.addEventListener('change', () => {
    settings.mode = s.mode.value;
    saveSettings();
    if (source?.kind === 'file' && runner.state !== 'running') runner.setMode(settings.mode, Number(settings.fps));
  });
  s.fps.addEventListener('change', () => {
    settings.fps = Number(s.fps.value);
    saveSettings();
    if (source?.kind === 'file' && runner.state !== 'running') runner.setMode(settings.mode, settings.fps);
  });
  s.interval.addEventListener('change', () => {
    settings.interval = Number(s.interval.value);
    saveSettings();
  });
  s.start.addEventListener('change', () => {
    const m = s.start.value.match(/^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)(?::(\d\d))?/);
    startDate = m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0))) : null;
    recorder?.setStart(startDate);
  });
  for (const k of ['boxes', 'labels', 'trails']) {
    s[k].addEventListener('change', () => {
      settings.show[k] = s[k].checked;
      saveSettings();
      render();
    });
  }
  s.engine.addEventListener('change', () => {
    settings.engine = s.engine.value;
    saveSettings();
    loadModel();
  });

  $('btn-camera-empty').addEventListener('click', startCamera);
  els.fileInput.addEventListener('change', () => {
    const f = els.fileInput.files[0];
    els.fileInput.value = '';
    openFile(f);
  });
  els.run.addEventListener('click', onRunClick);
  els.addLine.addEventListener('click', startPlacing);
  els.editLines.addEventListener('click', () => (editing ? stopEditing() : startEditing()));
  els.editDone.addEventListener('click', stopEditing);
  els.source.addEventListener('click', () => {
    if (els.sheet.showModal) els.sheet.showModal();
    else els.fileInput.click();
  });
  els.sheet.addEventListener('close', () => {
    if (els.sheet.returnValue === 'camera') startCamera();
    else if (els.sheet.returnValue === 'file') els.fileInput.click();
    else if (els.sheet.returnValue === 'stream') askStream();
  });
  $('btn-stream-empty').addEventListener('click', () => askStream());
  const streamSheet = $('stream-sheet');
  streamSheet.addEventListener('close', () => {
    if (streamSheet.returnValue === 'open') {
      const url = $('stream-url').value.trim();
      store.set('cc.stream', url);
      openStream(url);
    }
  });
  addEventListener('pagehide', () => recorder?.flush());
  // The timeline follows the video, and can be dragged at any time. Dragging while counting
  // pauses, jumps, and carries on counting from the new place when the finger lifts.
  els.video.addEventListener('timeupdate', () => {
    if (source?.kind === 'file' && !seekDragging) updateProgress(els.video.currentTime);
  });
  let seekDragging = false;
  const seekTo = async () => {
    if (source?.kind !== 'file') return;
    if (runner.state === 'running') {
      resumeAfterSeek = true;
      runner.pause();
    }
    const t = (Number(els.seek.value) / 1000) * (els.video.duration || 0);
    els.progressTime.textContent = `${fmt(t)} / ${fmt(els.video.duration || 0)}`;
    await seekPreview(t);
    tracker.reset(false); // different place in the video: new tracks, counts kept
    lastAnalysedT = null;
    lastTracks = [];
    render();
  };
  els.seek.addEventListener('pointerdown', () => (seekDragging = true));
  els.seek.addEventListener('input', () => {
    seekDragging = true;
    seekTo();
  });
  els.seek.addEventListener('change', async () => {
    await seekTo();
    seekDragging = false;
    if (resumeAfterSeek) {
      resumeAfterSeek = false;
      if (runner.state === 'paused' && source?.kind === 'file') runner.start();
    }
  });
  addEventListener('pointerup', () => (seekDragging = false));
  els.csvIntervals.addEventListener('click', exportIntervals);
  els.csvEvents.addEventListener('click', exportEvents);
  els.reset.addEventListener('click', () => {
    if (confirm('Clear all counts? Counting lines are kept.')) resetCounting(false);
  });

  bindLineEditing();
  new ResizeObserver(() => {
    overlay.layout();
    render();
  }).observe(els.stage);
  els.video.addEventListener('loadedmetadata', () => {
    overlay.layout();
    render();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && runner.state === 'running') requestWakeLock();
  });
}

function askStream(url, problem) {
  const d = $('stream-sheet');
  $('stream-url').value = typeof url === 'string' ? url : store.get('cc.stream', '') || '';
  const err = $('stream-error');
  err.hidden = !problem;
  err.textContent = problem || '';
  if (d.open) return;
  if (d.showModal) d.showModal();
  else openStream(prompt('Stream link (.m3u8 or .mp4)') || '');
}

// ---------------------------------------------------------------- small helpers
function showLoading(text, frac) {
  els.loading.hidden = false;
  els.loadingText.textContent = text;
  els.loadingBar.style.width = `${Math.round(frac * 100)}%`;
}
function hideLoading() {
  els.loading.hidden = true;
}

/** A message that stays under the video until the problem is gone or counting restarts. */
function showProblem(text, kind = 'error') {
  els.problem.textContent = text;
  els.problem.hidden = false;
  problemKind = kind;
}

function hideProblem(kind) {
  if (kind && kind !== problemKind) return;
  els.problem.hidden = true;
  problemKind = null;
}

let toastTimer = null;
function toast(text) {
  els.toast.textContent = text;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (els.toast.hidden = true), 4200);
}

function once(target, event, timeout) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), timeout);
    target.addEventListener(
      event,
      (e) => {
        clearTimeout(t);
        resolve(e);
      },
      { once: true },
    );
  });
}

function fmt(t) {
  const s = Math.max(0, Math.floor(t));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => (wakeLock = null));
    }
  } catch {
    /* not critical */
  }
}
function releaseWakeLock() {
  wakeLock?.release().catch(() => {});
  wakeLock = null;
}

function setupInstall() {
  let deferred = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e;
    els.install.hidden = false;
  });
  els.install.addEventListener('click', async () => {
    if (!deferred) return;
    deferred.prompt();
    await deferred.userChoice.catch(() => {});
    deferred = null;
    els.install.hidden = true;
  });
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  if (/iPhone|iPad|iPod/.test(navigator.userAgent) && !standalone) els.iosInstall.hidden = false;
}

// exposed for automated tests
window.__carCounter = { detector, tracker, counter, runner, openStream, get recorder() { return recorder; }, get lines() { return lines; }, set lines(v) { lines = v; saveLines(); syncCounterLines(); renderLineList(); render(); }, openFile, analyse };
