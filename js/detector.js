// Main-thread wrapper around the detection worker.
import { letterbox } from './core/postprocess.js';

export class Detector {
  constructor() {
    this.worker = null;
    this.pending = new Map();
    this.nextId = 1;
    this.info = null;
    this.onProgress = null;
  }

  /**
   * @param {{url?: string, buffer?: ArrayBuffer}} model
   * @param {{prefer?: 'auto'|'wasm', inputSize?: number}} opts
   */
  async load(model, opts = {}) {
    this.dispose();
    this.worker = new Worker(new URL('./detector.worker.js', import.meta.url), { type: 'module' });
    const vendorUrl = new URL('../vendor/ort/', import.meta.url).href;
    const hc = navigator.hardwareConcurrency || 2;
    const threads = Math.min(4, hc >= 4 ? hc - 1 : hc);
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
    if (m.type === 'error') p.reject(new Error(m.message));
    else p.resolve(m);
  }

  /**
   * Detect objects in the current frame of a <video> (or any CanvasImageSource).
   * @returns {Promise<{dets: Float32Array, timing: object}>}
   */
  async detect(source, srcW, srcH, params) {
    if (!this.worker || !this.info) throw new Error('Model not loaded');
    const [inH, inW] = this.info.fixedSize || [params.inputSize, params.inputSize];
    const lb = letterbox(srcW, srcH, inW, inH);
    // the browser resizes the frame (usually on the GPU) while making the bitmap
    const bitmap = await createImageBitmap(source, { resizeWidth: lb.newW, resizeHeight: lb.newH, resizeQuality: 'low' });
    const id = this.nextId++;
    const done = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.worker.postMessage(
      {
        type: 'detect',
        id,
        bitmap,
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
      },
      [bitmap],
    );
    return done;
  }

  dispose() {
    this.worker?.terminate();
    this.worker = null;
    for (const p of this.pending.values()) p.reject(new Error('Detector reset'));
    this.pending.clear();
    this.info = null;
  }
}
