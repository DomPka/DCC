// YOLO detection in Node with ONNX Runtime (CPU, all cores), sharing the browser app's
// output decoding so both count identically.
import { readFileSync } from 'node:fs';
import ort from 'onnxruntime-node';
import { decode, detectFormat, letterbox } from '../../js/core/postprocess.js';
import { readOnnxInfo } from '../../js/core/onnxmeta.js';

export class NodeDetector {
  async load(modelPath, { inputSize = 640, threads = 0 } = {}) {
    const bytes = readFileSync(modelPath);
    const info = readOnnxInfo(bytes);
    const [, , ih, iw] = info.inputShape || [];
    this.size = Number.isInteger(ih) && ih > 0 ? [ih, iw] : [inputSize, inputSize];
    this.names = info.names;
    this.session = await ort.InferenceSession.create(bytes, {
      executionProviders: ['cpu'],
      graphOptimizationLevel: 'all',
      ...(threads ? { intraOpNumThreads: threads } : {}),
    });
    this.inputName = this.session.inputNames.includes(info.inputName) ? info.inputName : this.session.inputNames[0];
    this.outputName = this.session.outputNames[0];
    const [h, w] = this.size;
    this.input = new Float32Array(3 * h * w);
    const out = await this.run();
    this.format = detectFormat(out.dims);
    if (!this.names) this.names = Array.from({ length: out.dims[1] - 4 }, (_, i) => `class ${i}`);
    return { names: this.names, size: this.size, format: this.format };
  }

  async run() {
    const [h, w] = this.size;
    const res = await this.session.run({ [this.inputName]: new ort.Tensor('float32', this.input, [1, 3, h, w]) });
    const o = res[this.outputName];
    return { data: o.data, dims: o.dims };
  }

  /** rgb: Buffer of srcW*srcH*3 bytes. Returns flat [x1,y1,x2,y2,score,cls]*n in source pixels. */
  async detect(rgb, srcW, srcH, { conf, classes, iou = 0.5, agnostic = true }) {
    const [inH, inW] = this.size;
    const lb = letterbox(srcW, srcH, inW, inH);
    fillLetterboxed(rgb, srcW, srcH, this.input, inW, inH, lb);
    const out = await this.run();
    return decode(out.data, out.dims, {
      format: this.format,
      conf,
      classes,
      scaleX: lb.scaleX,
      scaleY: lb.scaleY,
      padX: lb.padX,
      padY: lb.padY,
      srcW,
      srcH,
      iou,
      agnostic,
    });
  }
}

// Bilinear resize into the padded model input, straight to CHW floats in 0..1.
function fillLetterboxed(rgb, sw, sh, dst, W, H, lb) {
  const plane = W * H;
  dst.fill(114 / 255);
  const { padX, padY, newW, newH } = lb;
  const fx = sw / newW;
  const fy = sh / newH;
  const inv = 1 / 255;
  for (let y = 0; y < newH; y++) {
    const sy = Math.max(0, (y + 0.5) * fy - 0.5);
    const y0 = Math.min(sh - 1, Math.floor(sy));
    const y1 = Math.min(sh - 1, y0 + 1);
    const wy = sy - y0;
    const row = (y + padY) * W + padX;
    for (let x = 0; x < newW; x++) {
      const sx = Math.max(0, (x + 0.5) * fx - 0.5);
      const x0 = Math.min(sw - 1, Math.floor(sx));
      const x1 = Math.min(sw - 1, x0 + 1);
      const wx = sx - x0;
      const a = (y0 * sw + x0) * 3;
      const b = (y0 * sw + x1) * 3;
      const c = (y1 * sw + x0) * 3;
      const d = (y1 * sw + x1) * 3;
      const w00 = (1 - wx) * (1 - wy);
      const w01 = wx * (1 - wy);
      const w10 = (1 - wx) * wy;
      const w11 = wx * wy;
      const o = row + x;
      dst[o] = (rgb[a] * w00 + rgb[b] * w01 + rgb[c] * w10 + rgb[d] * w11) * inv;
      dst[o + plane] = (rgb[a + 1] * w00 + rgb[b + 1] * w01 + rgb[c + 1] * w10 + rgb[d + 1] * w11) * inv;
      dst[o + 2 * plane] = (rgb[a + 2] * w00 + rgb[b + 2] * w01 + rgb[c + 2] * w10 + rgb[d + 2] * w11) * inv;
    }
  }
}
