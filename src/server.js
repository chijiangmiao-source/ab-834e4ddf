// server.js — 零依赖静态服务：页面 + 引擎模块 + 健康响应
// 可配置：PORT（默认 8080）、HOST（默认 0.0.0.0）
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');

const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number.parseInt(process.env.PORT || '8080', 10);

const MIME = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.ico', 'image/x-icon']
]);

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

// 仅允许访问 public/ 与 /src/engine.js，防止路径穿越
function resolveSafe(urlPath) {
  let clean;
  try {
    clean = decodeURIComponent(urlPath.split('?')[0]);
  } catch {
    return null;
  }
  if (clean === '/src/engine.js') return path.join(ROOT, 'src', 'engine.js');
  const abs = path.normalize(path.join(PUBLIC_DIR, clean === '/' ? 'index.html' : clean.slice(1)));
  if (!abs.startsWith(PUBLIC_DIR + path.sep) && abs !== path.join(PUBLIC_DIR, 'index.html')) return null;
  return abs;
}

export const server = http.createServer(async (req, res) => {
  const urlPath = req.url || '/';
  if (urlPath.split('?')[0] === '/healthz' || urlPath.split('?')[0] === '/health') {
    const body = JSON.stringify({
      status: 'ok',
      service: 'hp-sampling-pool-verify',
      time: new Date().toISOString()
    });
    send(res, 200, body, { 'Content-Type': 'application/json; charset=utf-8' });
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    send(res, 405, 'method not allowed');
    return;
  }
  const abs = resolveSafe(urlPath);
  if (!abs) { send(res, 403, 'forbidden'); return; }
  try {
    const data = await readFile(abs);
    const mime = MIME.get(path.extname(abs).toLowerCase()) || 'application/octet-stream';
    send(res, 200, req.method === 'HEAD' ? '' : data, { 'Content-Type': mime });
  } catch {
    send(res, 404, 'not found', { 'Content-Type': 'text/plain; charset=utf-8' });
  }
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  server.listen(PORT, HOST, () => {
    console.log(`[hp-pool] listening on http://${HOST}:${PORT} (health: /healthz)`);
  });
}
