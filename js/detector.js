// Main-thread wrapper around the detection worker.
import { letterbox } from './core/postprocess.js';

// Ways to hand a video frame to the worker, fastest first. Browsers differ in which of
// these work for which videos: a way that throws, hangs, can't be sent to the worker or
// keeps giving empty (uniform) pictures is dropped for the next.
// Example: Firefox for Android marks pictures taken from a local video file as
// "cross-origin", so they can't be sent to the worker; a VideoFrame of a video loaded in
// CORS mode is exempt from that check (see app.js, openFile).
const GRABBERS = [
  {
    name: 'bitmap',
    grab: (src, lb) => createImageBitmap(src, { resizeWidth: lb.newW, resizeHeight: lb.newH, resizeQuality: 'low' }),
  },
  {
    name: 'videoframe',
    available: () => typeof VideoFrame === 'function',
    grab: (src) => new VideoFrame(src),
  },
  {
    name: 'canvas',
    grab: (src, lb, d) => createImageBitmap(d.drawToCanvas(src, lb)),
  },
  {
    name: 'pixels',
    grab: (src, lb, d) => {
      d.drawToCanvas(src, lb);
      return d.ctx.getImageData(0, 0, lb.newW, lb.newH).data.buffer;
    },
  },
];

const withTimeout = (p, ms, what) =>
  Promise.race([p, new Promise((_, reject) => setTimeout(() => reject(new Error(`${what} took too long`)), ms))]);

export class Detector {
  constructor() {
    this.worker = null;
    this.pending = new Map();
    this.nextId = 1;
    this.info = null;
    this.onProgress = null;
    this.capture = 0; // index into GRABBERS
    this.blankRun = 0;
    this.lastLoad = null;
    this.fellBack = false;
  }

  get captureName() {
    return GRABBERS[this.capture].name;
  }

  /**
   * @param {{url?: string, buffer?: ArrayBuffer}} model
   * @param {{prefer?: 'auto'|'wasm', inputSize?: number, threads?: number}} opts
   */
  async load(model, opts = {}) {
    this.dispose();
    this.lastLoad = model.url ? { model, opts } : null;
    this.fellBack = false;
    this.worker = new Worker(new URL('./detector.worker.js', import.meta.url), { type: 'module' });
    const vendorUrl = new URL('../vendor/ort/', import.meta.url).href;
    const hc = navigator.hardwareConcurrency || 2;
    const threads = opts.threads || Math.min(4, hc >= 4 ? hc - 1 : hc);
    const ready = new Promise((resolve, reject) => {
      this.worker.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'progress') this.onProgress?.(m.loaded, m.total);
        else if (m.type === 'ready') resolve(m);
        else if (m.type === 'error' && m.stage === 'load') reject(new Error(m.message));
        else this.handle(m);
      };
      this.worker.onerror = (e) => reject(new Error(e.message || 'Detector worker failed to start'));
    });
    const msg = {
      type: 'load',
      modelUrl: model.url ? new URL(model.url, location.href).href : null,
      modelBuffer: model.buffer || null,
      vendorUrl,
      prefer: opts.prefer || 'auto',
      threads,
      inputSize: opts.inputSize || 640,
    };
    this.worker.postMessage(msg, model.buffer ? [model.buffer] : []);
    this.info = await ready;
    this.worker.onmessage = (e) => this.handle(e.data);
    return this.info;
  }

  handle(m) {
    const p = this.pending.get(m.id);
    if (!p) return;
    this.pending.delete(m.id);
    if (m.type === 'error') p.reject(Object.assign(new Error(m.message), { where: m.where || 'model' }));
    else p.resolve(m);
  }

  /**
   * Detect objects in the current frame of a <video> (or any CanvasImageSource).
   * Falls back to slower ways of reading the frame when the fast one fails on this browser,
   * and to the single-threaded CPU engine when the model itself fails.
   * @returns {Promise<{dets: Float32Array, timing: object, blank?: boolean, skipped?: boolean}>}
   */
  async detect(source, srcW, srcH, params) {
    if (!this.worker || !this.info) throw new Error('Model not loaded');
    for (;;) {
      let res;
      try {
        res = await this.detectOnce(source, srcW, srcH, params);
      } catch (err) {
        const was = this.captureName;
        if (err.where === 'frame' && this.nextCapture()) {
          console.warn(`Reading video frames as '${was}' failed (${err.message}); trying '${this.captureName}'`);
          continue;
        }
        if (err.where === 'model' && !this.fellBack && this.lastLoad && this.info?.backend !== 'WASM ×1') {
          // e.g. a GPU or multi-threading problem on this device: retry on one CPU thread
          console.warn(`Detection failed on ${this.info.backend} (${err.message}); retrying on a single CPU thread`);
          this.fellBack = true;
          const { model, opts } = this.lastLoad;
          const onProgress = this.onProgress; // quiet reload: the model comes from the cache
          this.onProgress = null;
          try {
            await this.load(model, { ...opts, prefer: 'wasm', threads: 1 });
          } finally {
            this.onProgress = onProgress;
          }
          this.fellBack = true;
          continue;
        }
        throw err;
      }
      if (!res.skipped) {
        const was = this.captureName;
        if (res.blank && ++this.blankRun >= 3 && this.nextCapture()) {
          console.warn(`Frames read as '${was}' are empty; trying '${this.captureName}'`);
          this.blankRun = 0;
        } else if (!res.blank) this.blankRun = 0;
      }
      return res;
    }
  }

  nextCapture() {
    for (let i = this.capture + 1; i < GRABBERS.length; i++) {
      if (!GRABBERS[i].available || GRABBERS[i].available()) {
        this.capture = i;
        return true;
      }
    }
    return false;
  }

  async detectOnce(source, srcW, srcH, params) {
    const [inH, inW] = this.info.fixedSize || [params.inputSize, params.inputSize];
    const lb = letterbox(srcW, srcH, inW, inH);
    const g = GRABBERS[this.capture];
    let frame;
    try {
      frame = await withTimeout(Promise.resolve().then(() => g.grab(source, lb, this)), 3000, 'Reading the video frame');
    } catch (err) {
      throw Object.assign(err instanceof Error ? err : new Error(String(err)), { where: 'frame' });
    }
    const id = this.nextId++;
    const msg = {
      type: 'detect',
      id,
      frame,
      frameKind: g.name,
      padX: lb.padX,
      padY: lb.padY,
      newW: lb.newW,
      newH: lb.newH,
      inputW: inW,
      inputH: inH,
      scaleX: lb.scaleX,
      scaleY: lb.scaleY,
      srcW,
      srcH,
      conf: params.conf,
      classes: params.classes,
      iou: params.iou ?? 0.5,
      agnostic: params.agnostic ?? true,
    };
    try {
      // fails when the browser considers the picture cross-origin ("write-only")
      this.worker.postMessage(msg, [frame]);
    } catch (err) {
      frame.close?.();
      throw Object.assign(new Error(`The picture can't be sent to the detector (${err.message})`), { where: 'frame' });
    }
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  /** Draws the frame, already shrunk to the model's size, on a plain 2D canvas (the most widely supported way). */
  drawToCanvas(src, lb) {
    if (!this.canvas) this.canvas = document.createElement('canvas');
    const c = this.canvas;
    if (c.width !== lb.newW || c.height !== lb.newH) {
      c.width = lb.newW;
      c.height = lb.newH;
      this.ctx = null;
    }
    if (!this.ctx) this.ctx = c.getContext('2d', { willReadFrequently: GRABBERS[this.capture].name === 'pixels' });
    this.ctx.drawImage(src, 0, 0, lb.newW, lb.newH);
    return c;
  }

  dispose() {
    this.worker?.terminate();
    this.worker = null;
    for (const p of this.pending.values()) p.reject(new Error('Detector reset'));
    this.pending.clear();
    this.info = null;
  }
}
