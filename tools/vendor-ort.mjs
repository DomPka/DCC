// Copies the ONNX Runtime Web files the app needs from node_modules into vendor/ort/.
// Run after upgrading:  npm install onnxruntime-web@latest && npm run vendor
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';

const src = 'node_modules/onnxruntime-web/dist/';
const dst = 'vendor/ort/';
const files = [
  'ort.webgpu.min.mjs', // WebGPU build (loads the asyncify wasm below)
  'ort-wasm-simd-threaded.asyncify.mjs',
  'ort-wasm-simd-threaded.asyncify.wasm',
  'ort.wasm.min.mjs', // CPU-only build for devices without WebGPU
  'ort-wasm-simd-threaded.mjs',
  'ort-wasm-simd-threaded.wasm',
];
mkdirSync(dst, { recursive: true });
for (const f of files) copyFileSync(src + f, dst + f);
const { version } = JSON.parse(readFileSync('node_modules/onnxruntime-web/package.json', 'utf8'));
console.log(`Copied onnxruntime-web ${version} into ${dst}. Bump VERSION in sw.js so phones fetch it.`);
