// HTTP server of the station: serves the web app (station setup + analytics pages) and a
// small JSON API. Count data is served at /data/ in the same layout that is published to
// GitHub, so the analytics page reads both the same way.
import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { timingSafeEqual } from 'node:crypto';

const TYPES = {
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
};

export function startServer({ port, host, webRoot, adminPassword, api, log }) {
  const root = resolve(webRoot);
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://station');
    const path = decodeURIComponent(url.pathname);
    const headers = {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'Access-Control-Allow-Origin': '*',
    };
    const json = (code, obj) => {
      res.writeHead(code, { ...headers, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(obj));
    };
    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { ...headers, 'Access-Control-Allow-Methods': 'GET, PUT', 'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Password' });
        return res.end();
      }
      if (path === '/data/index.json') return json(200, api.index());
      const day = path.match(/^\/data\/days\/(\d{4}-\d\d-\d\d)\.json$/);
      if (day) return json(200, api.day(day[1]));
      if (path === '/api/status') return json(200, api.status());
      if (path === '/api/live') return json(200, api.live());
      if (path === '/api/snapshot.png') {
        const png = api.snapshot();
        if (!png) return json(503, { error: 'No frame received from the camera yet' });
        res.writeHead(200, { ...headers, 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
        return res.end(png);
      }
      if (path === '/api/lines' && req.method === 'GET') return json(200, api.getLines());
      if (path === '/api/lines' && req.method === 'PUT') {
        if (adminPassword && !safeEqual(req.headers['x-admin-password'] || '', adminPassword)) {
          return json(401, { error: 'Wrong or missing station password' });
        }
        const body = await readBody(req, 64 * 1024);
        const lines = validateLines(JSON.parse(body));
        api.setLines(lines);
        log(`counting lines updated (${lines.length})`);
        return json(200, lines);
      }
      if (path.startsWith('/api/')) return json(404, { error: 'Unknown API path' });
      return serveStatic(root, path === '/' ? '/station.html' : path, res, headers);
    } catch (err) {
      return json(400, { error: err.message });
    }
  });
  server.listen(port, host, () => log(`web page: http://${host === '0.0.0.0' ? 'localhost' : host}:${port}/`));
  return server;
}

function serveStatic(root, path, res, headers) {
  const file = normalize(join(root, path));
  if (!file.startsWith(root) || /(^|\/)\.|node_modules|\/station\/(data|config)/.test(file.slice(root.length))) {
    res.writeHead(404, headers).end();
    return;
  }
  let st;
  try {
    st = statSync(file);
  } catch {
    res.writeHead(404, headers).end('Not found');
    return;
  }
  if (st.isDirectory()) return serveStatic(root, `${path.replace(/\/$/, '')}/index.html`, res, headers);
  res.writeHead(200, { ...headers, 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': 'no-cache' });
  createReadStream(file).pipe(res);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const parts = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('Request too large'));
        req.destroy();
      } else parts.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    req.on('error', reject);
  });
}

export function validateLines(lines) {
  if (!Array.isArray(lines) || lines.length > 20) throw new Error('Expected a list of up to 20 lines');
  const n = (v) => {
    const x = Number(v);
    if (!Number.isFinite(x) || x < 0 || x > 1) throw new Error('Line points must be between 0 and 1');
    return x;
  };
  return lines.map((l, i) => ({
    id: String(l.id || `line${i + 1}`).slice(0, 40).replace(/[^\w-]/g, '_'),
    name: String(l.name || `Line ${i + 1}`).slice(0, 60),
    a: { x: n(l.a?.x), y: n(l.a?.y) },
    b: { x: n(l.b?.x), y: n(l.b?.y) },
  }));
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}
