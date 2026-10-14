// Detection worker: runs the YOLO ONNX model with ONNX Runtime Web (WebGPU when the
// device has it, multi-threaded WASM otherwise) and returns decoded boxes.
// Keeping inference off the main thread keeps the camera view and UI smooth.

import { decode, detectFormat, numClasses } from './core/postprocess.js';
import { readOnnxInfo } from './core/onnxmeta.js';

let ort = null;
let session = null;
let backend = '';
let inputName = 'images';
let outputName = null;
let fixedSize = null; // [h, w] if the model has a static input size
let names = null;
let format = null;
let nc = null;
let canvas = null;
let ctx = null;
let inputBuf = null;
let busy = false;

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === 'load') await load(m);
    else if (m.type === 'detect') await detect(m);
  } catch (err) {
    if (m.type === 'detect') m.frame?.close?.();
    self.postMessage({ type: 'error', id: m.id, stage: m.type, where: err?.where, message: String(err?.message || err) });
  }
};

async function load({ modelUrl, modelBuffer, vendorUrl, prefer = 'auto', threads = 1, inputSize = 640 }) {
  const bytes = modelBuffer ? new Uint8Array(modelBuffer) : await fetchWithProgress(modelUrl);
  const info = readOnnxInfo(bytes);
  names = info.names;
  inputName = info.inputName || 'images';
  const [, , ih, iw] = info.inputShape || [];
  fixedSize = Number.isInteger(ih) && Number.isInteger(iw) && ih > 0 ? [ih, iw] : null;

  let gpuOk = false;
  if (prefer !== 'wasm' && self.navigator?.gpu) {
    try {
      gpuOk = !!(await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }));
    } catch {
      gpuOk = false;
    }
  }

  session = null;
  if (gpuOk) {
    try {
      ort = await import(`${vendorUrl}ort.webgpu.min.mjs`);
      configure(vendorUrl, threads);
      session = await ort.InferenceSession.create(bytes, {
        executionProviders: ['webgpu', 'wasm'],
        graphOptimizationLevel: 'all',
      });
      backend = 'WebGPU';
    } catch (err) {
      console.warn('WebGPU session failed, falling back to WASM', err);
      session = null;
    }
  }
  if (!session) {
    ort = await import(`${vendorUrl}ort.wasm.min.mjs`);
    configure(vendorUrl, threads);
    session = await ort.InferenceSession.create(bytes, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    });
    backend = `WASM ×${ort.env.wasm.numThreads || 1}`;
  }
  inputName = session.inputNames.includes(inputName) ? inputName : session.inputNames[0];
  outputName = session.outputNames[0];

  // warm-up run: compiles kernels and tells us the output layout
  const size = fixedSize || [inputSize, inputSize];
  const t0 = performance.now();
  const out = await run(new Float32Array(3 * size[0] * size[1]), size[0], size[1]);
  const warmMs = performance.now() - t0;
  format = detectFormat(out.dims);
  nc = numClasses(format, out.dims) ?? names?.length ?? null;

  self.postMessage({
    type: 'ready',
    backend,
    names,
    nc,
    format,
    fixedSize,
    warmMs,
    crossOriginIsolated: self.crossOriginIsolated === true,
    meta: { author: info.meta.author || '', description: info.meta.description || '', license: info.meta.license || '' },
  });
}

function configure(vendorUrl, threads) {
  ort.env.wasm.wasmPaths = vendorUrl;
  ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.max(1, threads) : 1;
  ort.env.logLevel = 'error';
}

async function run(data, h, w) {
  const tensor = new ort.Tensor('float32', data, [1, 3, h, w]);
  const res = await session.run({ [inputName]: tensor });
  const o = res[outputName];
  let out = o.data;
  if (o.type === 'float16') out = halfToFloat(out);
  const dims = o.dims.slice();
  for (const k of Object.keys(res)) res[k].dispose?.();
  return { data: out, dims };
}

async function detect(m) {
  if (busy) {
    m.frame?.close?.();
    self.postMessage({ type: 'result', id: m.id, dets: new Float32Array(0), skipped: true });
    return;
  }
  busy = true;
  let px;
  let blank;
  const [h, w] = fixedSize || [m.inputH, m.inputW];
  const t0 = performance.now();
  try {
    if (!canvas || canvas.width !== w || canvas.height !== h) {
      canvas = new OffscreenCanvas(w, h);
      ctx = canvas.getContext('2d', { willReadFrequently: true });
      inputBuf = new Float32Array(3 * w * h);
    }
    ctx.fillStyle = 'rgb(114,114,114)';
    ctx.fillRect(0, 0, w, h);
    if (m.frameKind === 'pixels') {
      ctx.putImageData(new ImageData(new Uint8ClampedArray(m.frame), m.newW, m.newH), m.padX, m.padY);
    } else {
      ctx.drawImage(m.frame, m.padX, m.padY, m.newW, m.newH);
      m.frame.close();
    }
    px = ctx.getImageData(0, 0, w, h).data;
    blank = isUniform(px, w, m.padX, m.padY, m.newW, m.newH);
  } catch (err) {
    busy = false;
    throw Object.assign(err instanceof Error ? err : new Error(String(err)), { where: 'frame' });
  }
  try {
    const plane = w * h;
    const inv = 1 / 255;
    for (let i = 0, j = 0; i < plane; i++, j += 4) {
      inputBuf[i] = px[j] * inv;
      inputBuf[i + plane] = px[j + 1] * inv;
      inputBuf[i + 2 * plane] = px[j + 2] * inv;
    }
    const t1 = performance.now();
    let out;
    try {
      out = await run(inputBuf, h, w);
    } catch (err) {
      throw Object.assign(err instanceof Error ? err : new Error(String(err)), { where: 'model' });
    }
    const t2 = performance.now();
    const dets = decode(out.data, out.dims, {
      format,
      conf: m.conf,
      classes: m.classes ? new Set(m.classes) : null,
      scaleX: m.scaleX,
      scaleY: m.scaleY,
      padX: m.padX,
      padY: m.padY,
      srcW: m.srcW,
      srcH: m.srcH,
      iou: m.iou,
      agnostic: m.agnostic,
    });
    const t3 = performance.now();
    self.postMessage(
      { type: 'result', id: m.id, dets, blank, timing: { pre: t1 - t0, infer: t2 - t1, post: t3 - t2 } },
      [dets.buffer],
    );
  } finally {
    busy = false;
  }
}

/** True when the picture area is one flat colour: what a browser hands over when it can't read the frame. */
function isUniform(px, stride, x0, y0, w, h) {
  let lo = 765;
  let hi = 0;
  const sx = Math.max(1, Math.floor(w / 40));
  const sy = Math.max(1, Math.floor(h / 40));
  for (let y = y0; y < y0 + h; y += sy) {
    for (let x = x0; x < x0 + w; x += sx) {
      const j = (y * stride + x) * 4;
      const v = px[j] + px[j + 1] + px[j + 2];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    if (hi - lo > 12) return false;
  }
  return true;
}

async function fetchWithProgress(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not download model (${res.status})`);
  const total = Number(res.headers.get('content-length')) || 0;
  if (!res.body || !total) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const buf = new Uint8Array(total);
  let got = 0;
  let lastPost = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (got + value.length > buf.length) {
      // content-length was compressed size; fall back to growing
      const bigger = new Uint8Array(Math.max(buf.length * 2, got + value.length));
      bigger.set(buf.subarray(0, got));
      return finishGrowing(reader, bigger, got, value);
    }
    buf.set(value, got);
    got += value.length;
    const now = performance.now();
    if (now - lastPost > 100) {
      lastPost = now;
      self.postMessage({ type: 'progress', loaded: got, total });
    }
  }
  self.postMessage({ type: 'progress', loaded: got, total });
  return buf.subarray(0, got);
}

async function finishGrowing(reader, buf, got, first) {
  buf.set(first, got);
  got += first.length;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (got + value.length > buf.length) {
      const bigger = new Uint8Array(Math.max(buf.length * 2, got + value.length));
      bigger.set(buf.subarray(0, got));
      buf = bigger;
    }
    buf.set(value, got);
    got += value.length;
  }
  return buf.subarray(0, got);
}

// fp16 models: ORT returns raw IEEE half bits (Uint16Array) or a Float16Array
function halfToFloat(src) {
  if (typeof Float16Array !== 'undefined' && src instanceof Float16Array) return Float32Array.from(src);
  const out = new Float32Array(src.length);
  for (let i = 0; i < src.length; i++) {
    const h = src[i];
    const s = h & 0x8000 ? -1 : 1;
    const e = (h >> 10) & 0x1f;
    const f = h & 0x3ff;
    out[i] = e === 0 ? s * 2 ** -14 * (f / 1024) : e === 31 ? (f ? NaN : s * Infinity) : s * 2 ** (e - 15) * (1 + f / 1024);
  }
  return out;
}
