// Turns raw YOLO ONNX outputs into [x1,y1,x2,y2,score,cls] boxes in source-image pixels.
// Supported output layouts (auto-detected from the tensor shape):
//   'v8'   [1, 4+nc, N]   YOLOv8 / YOLO11 / YOLOv9 (Ultralytics export)
//   'v5'   [1, N, 5+nc]   YOLOv5 / YOLOv7 (export.py --grid), with objectness
//   'e2e6' [1, K, 6]      end-to-end models with NMS inside (x1,y1,x2,y2,score,cls), e.g. YOLOv10/YOLO26
//   'e2e7' [K, 7]         YOLOv7 export.py --end2end (batch,x1,y1,x2,y2,cls,score)

export function detectFormat(dims) {
  if (dims.length === 2 && dims[1] === 7) return 'e2e7';
  if (dims.length === 3) {
    if (dims[1] < dims[2]) return 'v8';
    if (dims[2] === 6 && dims[1] <= 1000) return 'e2e6';
    return 'v5';
  }
  throw new Error(`Unsupported model output shape [${dims.join(', ')}]`);
}

export function numClasses(format, dims) {
  if (format === 'v8') return dims[1] - 4;
  if (format === 'v5') return dims[2] - 5;
  return null; // end-to-end outputs don't reveal the class count
}

/**
 * @param {Float32Array} data output tensor data
 * @param {number[]} dims output dims
 * @param {object} p
 * @param {number} p.conf minimum score kept (use the tracker's low threshold)
 * @param {Set<number>|null} p.classes allowed class ids, null = all
 * @param {number} p.scaleX letterbox scale x (source -> model input); p.scale also accepted
 * @param {number} p.scaleY
 * @param {number} p.padX
 * @param {number} p.padY
 * @param {number} p.srcW
 * @param {number} p.srcH
 * @param {number} [p.iou] NMS IoU threshold
 * @param {boolean} [p.agnostic] class-agnostic NMS
 * @param {number} [p.maxDet]
 * @param {string} [p.format]
 * @returns {Float32Array} flat [x1,y1,x2,y2,score,cls]*n
 */
export function decode(data, dims, p) {
  const format = p.format || detectFormat(dims);
  let cand;
  if (format === 'v8') cand = decodeV8(data, dims, p);
  else if (format === 'v5') cand = decodeV5(data, dims, p);
  else cand = decodeEnd2End(data, dims, p, format);

  if (format === 'v8' || format === 'v5') {
    cand = nms(cand, p.iou ?? 0.5, p.agnostic ?? true, p.maxDet ?? 300);
  } else if (p.agnostic ?? true) {
    cand = nms(cand, p.iou ?? 0.5, true, p.maxDet ?? 300);
  }
  return toSource(cand, p);
}

function decodeV8(data, dims, p) {
  const C = dims[1];
  const N = dims[2];
  const nc = C - 4;
  const best = new Float32Array(N);
  const bestCls = new Int16Array(N).fill(-1);
  const classes = p.classes ? [...p.classes].filter((c) => c >= 0 && c < nc) : null;
  const visit = (c) => {
    const base = (4 + c) * N;
    for (let i = 0; i < N; i++) {
      const s = data[base + i];
      if (s > best[i]) {
        best[i] = s;
        bestCls[i] = c;
      }
    }
  };
  if (classes) classes.forEach(visit);
  else for (let c = 0; c < nc; c++) visit(c);

  const out = [];
  const conf = p.conf;
  for (let i = 0; i < N; i++) {
    const s = best[i];
    if (s < conf || bestCls[i] < 0) continue;
    const cx = data[i];
    const cy = data[N + i];
    const w = data[2 * N + i];
    const h = data[3 * N + i];
    out.push([cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2, s, bestCls[i]]);
  }
  return out;
}

function decodeV5(data, dims, p) {
  const N = dims[1];
  const S = dims[2];
  const nc = S - 5;
  const classes = p.classes ? [...p.classes].filter((c) => c >= 0 && c < nc) : null;
  const conf = p.conf;
  const out = [];
  for (let i = 0; i < N; i++) {
    const o = i * S;
    const obj = data[o + 4];
    if (obj < conf) continue;
    let bs = -1;
    let bc = -1;
    if (classes) {
      for (const c of classes) {
        const v = data[o + 5 + c];
        if (v > bs) {
          bs = v;
          bc = c;
        }
      }
    } else {
      for (let c = 0; c < nc; c++) {
        const v = data[o + 5 + c];
        if (v > bs) {
          bs = v;
          bc = c;
        }
      }
    }
    const s = obj * bs;
    if (bc < 0 || s < conf) continue;
    const cx = data[o];
    const cy = data[o + 1];
    const w = data[o + 2];
    const h = data[o + 3];
    out.push([cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2, s, bc]);
  }
  return out;
}

function decodeEnd2End(data, dims, p, format) {
  const out = [];
  const classes = p.classes;
  if (format === 'e2e6') {
    const K = dims[1];
    for (let i = 0; i < K; i++) {
      const o = i * 6;
      const s = data[o + 4];
      const c = Math.round(data[o + 5]);
      if (s < p.conf || (classes && !classes.has(c))) continue;
      out.push([data[o], data[o + 1], data[o + 2], data[o + 3], s, c]);
    }
  } else {
    const K = dims[0];
    for (let i = 0; i < K; i++) {
      const o = i * 7;
      const c = Math.round(data[o + 5]);
      const s = data[o + 6];
      if (s < p.conf || (classes && !classes.has(c))) continue;
      out.push([data[o + 1], data[o + 2], data[o + 3], data[o + 4], s, c]);
    }
  }
  return out;
}

/** Greedy NMS on [x1,y1,x2,y2,score,cls] arrays. */
export function nms(boxes, iouThr, agnostic, maxDet) {
  if (boxes.length <= 1) return boxes;
  boxes.sort((a, b) => b[4] - a[4]);
  if (boxes.length > 3000) boxes.length = 3000;
  const n = boxes.length;
  const keep = [];
  const removed = new Uint8Array(n);
  const area = new Float32Array(n);
  for (let i = 0; i < n; i++) area[i] = (boxes[i][2] - boxes[i][0]) * (boxes[i][3] - boxes[i][1]);
  for (let i = 0; i < n && keep.length < maxDet; i++) {
    if (removed[i]) continue;
    const a = boxes[i];
    keep.push(a);
    for (let j = i + 1; j < n; j++) {
      if (removed[j]) continue;
      const b = boxes[j];
      if (!agnostic && a[5] !== b[5]) continue;
      const iw = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
      if (iw <= 0) continue;
      const ih = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
      if (ih <= 0) continue;
      const inter = iw * ih;
      if (inter / (area[i] + area[j] - inter) > iouThr) removed[j] = 1;
    }
  }
  return keep;
}

function toSource(cand, p) {
  const out = new Float32Array(cand.length * 6);
  const { padX, padY, srcW, srcH } = p;
  const sx = p.scaleX ?? p.scale;
  const sy = p.scaleY ?? p.scale;
  for (let i = 0; i < cand.length; i++) {
    const c = cand[i];
    out[i * 6] = clamp((c[0] - padX) / sx, 0, srcW);
    out[i * 6 + 1] = clamp((c[1] - padY) / sy, 0, srcH);
    out[i * 6 + 2] = clamp((c[2] - padX) / sx, 0, srcW);
    out[i * 6 + 3] = clamp((c[3] - padY) / sy, 0, srcH);
    out[i * 6 + 4] = c[4];
    out[i * 6 + 5] = c[5];
  }
  return out;
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Letterbox geometry: fit (w,h) into an (S x S) input keeping aspect ratio. */
export function letterbox(srcW, srcH, inputW, inputH = inputW) {
  const scale = Math.min(inputW / srcW, inputH / srcH);
  const newW = Math.max(1, Math.round(srcW * scale));
  const newH = Math.max(1, Math.round(srcH * scale));
  const padX = Math.floor((inputW - newW) / 2);
  const padY = Math.floor((inputH - newH) / 2);
  return { scale, scaleX: newW / srcW, scaleY: newH / srcH, newW, newH, padX, padY, inputW, inputH };
}
