// Tiny static server for local testing: `node tools/serve.mjs [port]`.
// Sends the same cross-origin isolation headers the service worker adds on GitHub Pages.
import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const port = Number(process.argv[2] || 8080);
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream',
  '.mp4': 'video/mp4',
  '.txt': 'text/plain; charset=utf-8',
};

createServer((req, res) => {
  let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (path.endsWith('/')) path += 'index.html';
  const file = normalize(join(root, path));
  if (!file.startsWith(root)) {
    res.writeHead(403).end();
    return;
  }
  let st;
  try {
    st = statSync(file);
  } catch {
    res.writeHead(404).end('Not found');
    return;
  }
  if (st.isDirectory()) {
    res.writeHead(301, { Location: `${path}/` }).end();
    return;
  }
  res.writeHead(200, {
    'Content-Type': types[extname(file)] || 'application/octet-stream',
    'Content-Length': st.size,
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Cache-Control': 'no-cache',
  });
  createReadStream(file).pipe(res);
}).listen(port, () => console.log(`Car Counter on http://localhost:${port}/`));
