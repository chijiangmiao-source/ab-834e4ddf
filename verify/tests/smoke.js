'use strict';
/* HTTP 冒烟：等待 web 就绪后检查 /health、首页与静态资源。 */
const base = (process.argv[2] || 'http://web').replace(/\/+$/, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(path) {
  const res = await fetch(base + path);
  return { status: res.status, text: await res.text() };
}

(async () => {
  let health = null;
  for (let i = 0; i < 30; i++) {
    try {
      const r = await get('/health');
      if (r.status === 200) { health = r; break; }
    } catch (e) { /* web 尚未就绪，继续等待 */ }
    await sleep(1000);
  }
  if (!health) {
    console.error('冒烟失败：' + base + '/health 30 秒内未返回 200');
    process.exit(1);
  }
  if (!/ok/.test(health.text)) {
    console.error('冒烟失败：/health 响应体异常：' + JSON.stringify(health.text));
    process.exit(1);
  }
  console.log('冒烟通过：GET /health -> 200');

  let ok = true;
  const home = await get('/');
  if (home.status !== 200 || !home.text.includes('id="events"') || !home.text.includes('id="review"')) {
    console.error('冒烟失败：首页缺失关键元素（status=' + home.status + '）');
    ok = false;
  } else {
    console.log('冒烟通过：GET / -> 200 且包含复核表单');
  }
  for (const p of ['/analyzer.js', '/worker.js', '/app.js']) {
    const r = await get(p);
    if (r.status !== 200 || r.text.length === 0) {
      console.error('冒烟失败：' + p + '（status=' + r.status + '）');
      ok = false;
    } else {
      console.log('冒烟通过：GET ' + p + ' -> 200');
    }
  }
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error('冒烟异常：' + (e && e.message ? e.message : e));
  process.exit(1);
});
