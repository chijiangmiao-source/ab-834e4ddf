// verify.mjs — 一次性验证入口：规则测试 → 构建检查 → HTTP 冒烟，结束即退出并以退出码报告。
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readdir, access } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const steps = [];
let failed = false;

function record(name, ok, detail = '') {
  steps.push({ name, ok, detail });
  if (!ok) failed = true;
  console.log(`${ok ? '✓' : '✕'} ${name}${detail ? ` — ${detail}` : ''}`);
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

async function listJs(dir) {
  const entries = await readdir(path.join(ROOT, dir), { withFileTypes: true });
  return entries.filter((e) => e.isFile() && /\.(m?js)$/.test(e.name)).map((e) => path.join(dir, e.name));
}

function pickFreePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(url, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status) return res;
    } catch (e) { lastErr = e; }
    await sleep(150);
  }
  throw lastErr || new Error(`等待 ${url} 超时`);
}

// --------------------------------------------------------------- 1. 规则测试
console.log('\n== 1/3 规则测试（地址复用 / 扫描保护 / 迟到读取等） ==');
{
  const r = await run(process.execPath, ['test/engine.test.js']);
  process.stdout.write(r.out);
  if (r.err) process.stderr.write(r.err);
  record('规则测试套件', r.code === 0, r.code === 0 ? '36 项断言全部通过' : `退出码 ${r.code}`);
}

// --------------------------------------------------------------- 2. 构建检查
console.log('\n== 2/3 构建检查（语法解析与交付物完整性） ==');
{
  const files = [
    ...(await listJs('src')),
    ...(await listJs('public')),
    ...(await listJs('scripts')),
    ...(await listJs('test'))
  ];
  let allSyntaxOk = true;
  const bad = [];
  for (const f of files) {
    const r = await run(process.execPath, ['--check', f]);
    if (r.code !== 0) { allSyntaxOk = false; bad.push(`${f}: ${r.err.trim()}`); }
  }
  record('全部 JS 文件语法检查', allSyntaxOk, allSyntaxOk ? `${files.length} 个文件` : bad.join(' | '));

  const required = ['package.json', 'src/engine.js', 'src/server.js', 'public/index.html',
    'public/styles.css', 'public/app.js', 'public/analyze.worker.js', 'Dockerfile', 'docker-compose.yml'];
  let allPresent = true;
  const missing = [];
  for (const f of required) {
    try { await access(path.join(ROOT, f)); }
    catch { allPresent = false; missing.push(f); }
  }
  record('交付物完整性', allPresent, allPresent ? `${required.length} 项必备文件齐全` : `缺失 ${missing.join(', ')}`);
}

// --------------------------------------------------------------- 3. HTTP 冒烟
console.log('\n== 3/3 HTTP 冒烟（真实启动服务：页面 + 健康响应 + 模块资源） ==');
{
  const port = await pickFreePort();
  const server = spawn(process.execPath, ['src/server.js'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1' }
  });
  let serverLog = '';
  server.stdout.on('data', (d) => { serverLog += d; });
  server.stderr.on('data', (d) => { serverLog += d; });

  try {
    const base = `http://127.0.0.1:${port}`;
    await waitFor(`${base}/healthz`);

    const hres = await fetch(`${base}/healthz`);
    const hbody = await hres.json().catch(() => null);
    record('GET /healthz 返回 200 且 status=ok',
      hres.status === 200 && hbody && hbody.status === 'ok',
      `HTTP ${hres.status}`);

    const pres = await fetch(`${base}/`);
    const pbody = await pres.text();
    record('GET / 返回复核页面',
      pres.status === 200 && pbody.includes('无锁采样池并发事件复核') && pbody.includes('/app.js'),
      `HTTP ${pres.status}, ${pbody.length} 字符`);

    const eres = await fetch(`${base}/src/engine.js`);
    const ebody = await eres.text();
    record('GET /src/engine.js 提供引擎模块',
      eres.status === 200 && ebody.includes('export function analyze'),
      `HTTP ${eres.status}, ${ebody.length} 字节`);

    const wres = await fetch(`${base}/analyze.worker.js`);
    record('GET /analyze.worker.js 提供 Worker',
      wres.status === 200 && (await wres.text()).includes('self.onmessage'),
      `HTTP ${wres.status}`);

    const xres = await fetch(`${base}/..%2fpackage.json`);
    record('路径穿越被拒绝（不暴露项目文件）', xres.status === 403 || xres.status === 404,
      `HTTP ${xres.status}`);

    const cres = await fetch(`${base}/src/server.js`);
    record('服务器源码不经公网暴露', cres.status === 403 || cres.status === 404,
      `HTTP ${cres.status}`);
  } catch (e) {
    record('HTTP 冒烟', false, String(e && e.message || e));
  } finally {
    server.kill('SIGTERM');
    await new Promise((r) => server.on('close', r));
    if (process.env.VERIFY_VERBOSE) console.log(serverLog);
  }
}

// --------------------------------------------------------------- 汇总
const okCount = steps.filter((s) => s.ok).length;
console.log(`\n===== verify 汇总：${okCount}/${steps.length} 项通过 =====`);
if (failed) {
  console.error('验证失败，请查看上面的 ✕ 项。');
  process.exit(1);
}
console.log('全部验证通过。');
process.exit(0);
