// Main-thread wrapper around the detection worker.
import { letterbox } from './core/postprocess.js';

// Ways to hand a video frame to the worker, fastest first. Browsers differ in which of
// these work for which videos: a way that throws, hangs, can't be sent to the worker or
// keeps giving empty (uniform) pictures is dropped for the next.
// Example: Firefox for Android keeps hardware-decoded video frames on the GPU and can't
// copy them into a 2D canvas or ImageBitmap (they come out blank), but WebGL can upload
// them GPU-to-GPU and read the pixels back. It also treats local files as cross-origin
// unless the video is loaded in CORS mode (see app.js, openFile).
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
    name: 'webgl',
    kind: 'pixels',
    available: () => GlReader.supported(),
    grab: (src, lb, d) => (d.gl ||= new GlReader()).read(src, lb.newW, lb.newH),
  },
  {
    name: 'webgl+videoframe',
    kind: 'pixels',
    available: () => typeof VideoFrame === 'function' && GlReader.supported(),
    grab: (src, lb, d) => {
      const vf = new VideoFrame(src);
      try {
        return (d.gl ||= new GlReader()).read(vf, lb.newW, lb.newH);
      } finally {
        vf.close();
      }
    },
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

/** Resizes a video frame on the GPU with WebGL and reads the pixels back (top row first). */
class GlReader {
  static supported() {
    if (GlReader.ok === undefined) {
      try {
        const c = document.createElement('canvas');
        GlReader.ok = !!(c.getContext('webgl2') || c.getContext('webgl'));
      } catch {
        GlReader.ok = false;
      }
    }
    return GlReader.ok;
  }

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.addEventListener('webglcontextlost', (e) => e.preventDefault());
    this.init();
  }

  init() {
    const opts = { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false, preserveDrawingBuffer: false };
    const gl = this.canvas.getContext('webgl2', opts) || this.canvas.getContext('webgl', opts);
    if (!gl) throw new Error('WebGL is not available');
    const shader = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      return s;
    };
    const prog = gl.createProgram();
    // clip-space y = -1 (the first row readPixels returns) samples texture row 0 (the picture's top)
    gl.attachShader(prog, shader(gl.VERTEX_SHADER, 'attribute vec2 p; varying vec2 uv; void main() { uv = p * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }'));
    gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, 'precision mediump float; varying vec2 uv; uniform sampler2D t; void main() { gl_FragColor = texture2D(t, uv); }'));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(`WebGL program failed: ${gl.getProgramInfoLog(prog)}`);
    gl.useProgram(prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    this.gl = gl;
  }

  read(src, w, h) {
    if (this.gl.isContextLost()) this.init();
    const gl = this.gl;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    gl.viewport(0, 0, w, h);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    const out = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, out);
    return out.buffer;
  }
}

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
    this.notes = new Map();
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
        if (err.where === 'frame') this.note(was, err.message);
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
        if (res.blank && ++this.blankRun >= 3) {
          this.note(was, 'blank');
          if (this.nextCapture()) {
            console.warn(`Frames read as '${was}' are empty; trying '${this.captureName}'`);
            this.blankRun = 0;
          }
        } else if (!res.blank) this.blankRun = 0;
      }
      return res;
    }
  }

  /** What happened with each way of reading frames, for error messages. */
  note(name, what) {
    this.notes.set(name, String(what).slice(0, 120));
  }

  get captureLog() {
    return [...this.notes].map(([k, v]) => `${k}: ${v}`).join('; ');
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
      frameKind: g.kind || g.name,
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
