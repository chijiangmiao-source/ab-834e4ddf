// app.js — 页面交互：草稿保留、Worker 调度、结论渲染
import { analyze, parseInput } from '/src/engine.js';

const DRAFT_KEY = 'hp-pool-draft-v1';

const $nodes = document.getElementById('nodesInput');
const $events = document.getElementById('eventsInput');
const $nodeCounter = document.getElementById('nodeCounter');
const $eventCounter = document.getElementById('eventCounter');
const $status = document.getElementById('workerStatus');
const $result = document.getElementById('result');
const $verifyBtn = document.getElementById('verifyBtn');
const $clearBtn = document.getElementById('clearBtn');

const OP_LABEL = {
  load: '装载候选', publish: '发布危险指针', reconfirm: '再次确认', read: '读取',
  retire: '摘链退役', scan: '扫描回收', reuse: '复用地址', initial: '初始入链'
};

const EXAMPLES = {
  safe: {
    nodes: 'N1, 监测点-α\nN2, 监测点-β',
    events:
`1 T1 load
2 T1 publish N1
3 T1 reconfirm
4 T1 read
5 T2 retire N1
6 T1 publish null
7 T2 scan
8 T2 reuse N1 payload=新样本-α2
9 T1 load
10 T1 publish N1
11 T1 reconfirm
12 T1 read`
  },
  reuse: {
    nodes: 'N1, 监测点-α\nN2, 监测点-β',
    events:
`1 T1 load
2 T1 publish N1
3 T1 reconfirm
4 T2 retire N1
5 T1 publish null
6 T2 scan
7 T2 reuse N1 payload=新样本-α2
8 T1 read`
  },
  protected: {
    nodes: 'N1, 监测点-α',
    events:
`1 T1 load
2 T1 publish N1
3 T1 reconfirm
4 T2 retire N1
5 T2 scan reclaim=N1
6 T2 reuse N1 payload=不应出现`
  }
};

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
function fmtId(id) { return id ? `${id.address}:${id.generation}` : '—'; }
function fmtEventRef(v) {
  const seq = v.seq != null ? `#${v.seq}` : `第 ${v.eventIndex + 1} 个事件`;
  const line = v.lineNo != null ? `（录入第 ${v.lineNo} 行）` : '';
  return `${seq} ${escapeHtml(v.thread || '')} ${OP_LABEL[v.op] || v.op || ''}${line}`;
}

function updateCounters() {
  const n = $nodes.value.split(/\r?\n/).filter((l) => l.trim()).length;
  const e = $events.value.split(/\r?\n/).filter((l) => l.trim()).length;
  $nodeCounter.textContent = `${n} / 16`;
  $eventCounter.textContent = `${e} / 128`;
  $events.classList.toggle('over-limit', e > 128);
}

function setStatus(text, cls) {
  $status.textContent = text || '';
  $status.className = cls ? `status ${cls}` : 'status';
}

// 草稿：持久化在 localStorage；失败/输入错误时不清空，仅成功结论被替换/清空
function saveDraft() {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ nodes: $nodes.value, events: $events.value }));
  } catch { /* 隐私模式等场景忽略 */ }
}
function loadDraft() {
  try {
    const d = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null');
    if (d) {
      $nodes.value = d.nodes || '';
      $events.value = d.events || '';
    } else {
      $nodes.value = EXAMPLES.safe.nodes;
      $events.value = EXAMPLES.safe.events;
    }
  } catch { /* ignore */ }
  updateCounters();
}
function clearDraftAndConclusion() {
  $nodes.value = '';
  $events.value = '';
  try { localStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ }
  updateCounters();
  setStatus('', '');
  $result.innerHTML = '<div class="placeholder">草稿与结论均已清空。</div>';
}

// ---------------------------------------------------------------- Worker 调度

function runInWorker(data) {
  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = new Worker('/analyze.worker.js', { type: 'module' });
    } catch (err) {
      reject(err);
      return;
    }
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error('Worker 分析超时（10s）'));
    }, 10000);
    worker.onmessage = (e) => {
      clearTimeout(timer);
      worker.terminate();
      resolve(e.data);
    };
    worker.onerror = (e) => {
      clearTimeout(timer);
      worker.terminate();
      reject(new Error(e.message || 'Worker 执行失败'));
    };
    worker.postMessage(data);
  });
}

async function runAnalysis() {
  saveDraft();
  // 关键要求：重新复核时先清除旧的成功证据，避免旧结论残留误导
  $result.innerHTML = '<div class="placeholder">分析进行中…</div>';
  setStatus('Worker 分析中…', 'info');
  $verifyBtn.disabled = true;

  let data;
  try {
    data = await runInWorker({ nodesText: $nodes.value, eventsText: $events.value });
  } catch (workerErr) {
    // Worker 不可用时，在主线程做等价回退（仍会清除旧证据，因为结果区已重置）
    try {
      const parsed = parseInput({ nodesText: $nodes.value, eventsText: $events.value });
      if (!parsed.ok) data = { ok: false, stage: 'parse', errors: parsed.errors };
      else data = { ok: true, stage: 'analysis', fallback: true, ...analyze({ nodes: parsed.nodes, events: parsed.events }) };
    } catch (err) {
      data = { ok: false, stage: 'fatal', errors: [String(workerErr && workerErr.message || workerErr), String(err && err.stack || err)] };
    }
  } finally {
    $verifyBtn.disabled = false;
  }
  render(data);
}

// ---------------------------------------------------------------- 渲染

function render(data) {
  if (!data) {
    setStatus('分析失败：无返回结果（草稿已保留）', 'error');
    $result.innerHTML = '<div class="placeholder">分析失败，未产生结论；输入草稿仍保留在输入区。</div>';
    return;
  }
  if (!data.ok) {
    // 输入错误或分析失败：保留草稿，清除旧成功证据（结果区此前已重置）
    saveDraft();
    setStatus(`未通过输入校验：${(data.errors || []).length} 个问题（草稿已保留，旧结论已清除）`, 'error');
    $result.innerHTML = `
      <div class="verdict fail"><span class="big">✕</span> 输入非法，无法执行复核</div>
      <div class="violation-box">
        <div class="code">STAGE = ${escapeHtml(data.stage || 'unknown')}</div>
        <ul class="msg">${(data.errors || ['未知错误']).map((x) => `<li>${escapeHtml(x)}</li>`).join('')}</ul>
      </div>`;
    return;
  }

  saveDraft();
  if (data.fallback) setStatus('Worker 不可用，已在主线程完成等价分析（草稿已保留）', 'error');
  else setStatus(`分析完成，耗时 ${data.elapsedMs ?? '?'} ms`, 'info');

  if (data.ok === true && data.violation === null) {
    $result.innerHTML = renderPass(data);
  } else {
    $result.innerHTML = renderViolation(data);
  }
}

function renderPass(data) {
  const fs = data.finalState;
  const rows = data.objects.map((o) => `
    <tr>
      <td class="mono">${escapeHtml(o.address)}:${o.generation}</td>
      <td><span class="badge ${o.state}">${o.state}</span></td>
      <td>${escapeHtml(o.payload)}</td>
      <td>${o.bornEvent >= 0 ? (o.bornKind === 'reuse' ? `复用产生 @事件${o.bornEvent + 1}` : '初始节点') : '初始节点'}</td>
      <td>${o.retiredEvent != null ? `@事件${o.retiredEvent + 1}` : '—'}</td>
      <td>${o.freedEvent != null ? `@事件${o.freedEvent + 1}` : '—'}</td>
    </tr>`).join('');

  const trace = data.trace.map((t) => `
    <tr>
      <td class="num">${t.seq ?? t.eventIndex + 1}</td>
      <td class="mono">${escapeHtml(t.thread)}</td>
      <td><span class="op-tag">${t.op}</span></td>
      <td>${escapeHtml(t.detail || '')}</td>
    </tr>`).join('');

  const threads = Object.entries(fs.threads).map(([tid, s]) => `
    <tr>
      <td class="mono">${escapeHtml(tid)}</td>
      <td class="mono">${escapeHtml(fmtId(s.candidate))}</td>
      <td class="mono">${escapeHtml(fmtId(s.hazard))}</td>
      <td>${s.confirmed ? '✓ 已确认' : '—'}</td>
    </tr>`).join('');

  return `
    <div class="verdict pass"><span class="big">✓</span> 通过：全部 ${data.trace.length} 个事件均符合协议，未发现退役后访问或地址混用。</div>
    <div class="section-title">最终链表（头 → 尾）</div>
    <div class="card"><span class="mono">${escapeHtml(fs.list.map(fmtId).join('  →  ') || '（空）')}</span></div>
    <div class="section-title">线程候选与保护快照（终态）</div>
    <div class="card"><table>
      <thead><tr><th>线程</th><th>候选</th><th>危险指针</th><th>头指针确认</th></tr></thead>
      <tbody>${threads || '<tr><td colspan="4" class="empty">无线程活动</td></tr>'}</tbody>
    </table></div>
    <div class="section-title">对象生命周期</div>
    <div class="card"><table>
      <thead><tr><th>(地址:代次)</th><th>状态</th><th>样本</th><th>诞生</th><th>退役</th><th>回收</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="6" class="empty">无对象</td></tr>'}</tbody>
    </table></div>
    <div class="section-title">全序事件轨迹</div>
    <div class="card prefix-list"><table>
      <thead><tr><th class="num">序号</th><th>线程</th><th>操作</th><th>引擎说明</th></tr></thead>
      <tbody>${trace}</tbody>
    </table></div>`;
}

function renderViolation(data) {
  const v = data.violation;
  const head = v.snapshots.head;

  const threadRows = Object.entries(v.snapshots.threads).map(([tid, s]) => `
    <tr>
      <td class="mono">${escapeHtml(tid)}</td>
      <td class="mono">${escapeHtml(fmtId(s.candidate))}</td>
      <td class="mono">${escapeHtml(fmtId(s.hazard))}</td>
      <td>${s.confirmed ? '✓ 已确认' : '—'}</td>
    </tr>`).join('');

  const lifecycle = (v.lifecycle || []).map((r) => {
    const bad = r.eventIndex === v.eventIndex ? 'bad' : '';
    const ref = r.eventIndex >= 0 ? `@${r.seq ?? r.eventIndex + 1}` : '初始';
    const who = r.thread ? escapeHtml(r.thread) : '系统';
    return `<li class="${bad}">
      <span class="lc-meta">${ref} · ${who}</span>
      <span class="kind">${escapeHtml(r.kind || r.op || '')}</span>
      <div>${escapeHtml(r.detail || OP_LABEL[r.op] || '')}</div>
    </li>`;
  }).join('');

  const prefix = (v.prefix || []).map((t) => `
    <tr>
      <td class="num">${t.seq ?? t.eventIndex + 1}</td>
      <td class="mono">${escapeHtml(t.thread)}</td>
      <td><span class="op-tag">${t.op}</span></td>
      <td>${escapeHtml(t.detail || '')}</td>
    </tr>`).join('');

  const allObjects = (data.objects || []).map((o) => `
    <tr>
      <td class="mono">${escapeHtml(o.address)}:${o.generation}</td>
      <td><span class="badge ${o.state}">${o.state}</span></td>
      <td>${escapeHtml(o.payload)}</td>
    </tr>`).join('');

  return `
    <div class="verdict fail"><span class="big">✕</span> 违规：${escapeHtml(v.label)}</div>
    <div class="violation-box">
      <div class="code">${escapeHtml(v.code)}${v.protectors ? ' · protectors=' + escapeHtml(v.protectors.join(',')) : ''}</div>
      <div class="msg">${escapeHtml(v.message)}</div>
      <div class="meta">首个违规事件 → ${fmtEventRef(v)}${v.target ? ` · 目标对象 ${escapeHtml(fmtId(v.target))}` : ''}</div>
    </div>

    <div class="section-title">违规瞬间：线程候选与保护快照（当前头指针：${escapeHtml(fmtId(head))}）</div>
    <div class="snapshot-grid">
      <div class="card"><h3>线程状态</h3>
        <table>
          <thead><tr><th>线程</th><th>候选</th><th>危险指针</th><th>头确认</th></tr></thead>
          <tbody>${threadRows || '<tr><td colspan="4" class="empty">无线程</td></tr>'}</tbody>
        </table>
      </div>
      <div class="card"><h3>违规时点全部对象</h3>
        <table>
          <thead><tr><th>(地址:代次)</th><th>状态</th><th>样本</th></tr></thead>
          <tbody>${allObjects || '<tr><td colspan="3" class="empty">无</td></tr>'}</tbody>
        </table>
      </div>
    </div>

    <div class="section-title">目标对象生命周期（含违规点）</div>
    <div class="card">
      ${v.target ? `<h3>${escapeHtml(fmtId(v.target))}</h3>` : ''}
      ${lifecycle ? `<ul class="lifecycle">${lifecycle}</ul>` : '<div class="empty">该对象无可用生命周期记录。</div>'}
    </div>

    <div class="section-title">违规事件及其前序（全序轨迹）</div>
    <div class="card prefix-list"><table>
      <thead><tr><th class="num">序号</th><th>线程</th><th>操作</th><th>引擎说明</th></tr></thead>
      <tbody>
        ${prefix || ''}
        <tr class="violator">
          <td class="num">${v.seq ?? v.eventIndex + 1}</td>
          <td class="mono">${escapeHtml(v.thread || '')}</td>
          <td><span class="op-tag">${v.op || ''}</span></td>
          <td>▲ ${escapeHtml(v.message)}</td>
        </tr>
      </tbody>
    </table></div>`;
}

// ---------------------------------------------------------------- 事件绑定

$nodes.addEventListener('input', () => { updateCounters(); saveDraft(); });
$events.addEventListener('input', () => { updateCounters(); saveDraft(); });
$verifyBtn.addEventListener('click', runAnalysis);
$clearBtn.addEventListener('click', clearDraftAndConclusion);

document.getElementById('exampleSafeBtn').addEventListener('click', () => {
  $nodes.value = EXAMPLES.safe.nodes; $events.value = EXAMPLES.safe.events;
  updateCounters(); saveDraft();
});
document.getElementById('exampleReuseBtn').addEventListener('click', () => {
  $nodes.value = EXAMPLES.reuse.nodes; $events.value = EXAMPLES.reuse.events;
  updateCounters(); saveDraft();
});
document.getElementById('exampleProtectedBtn').addEventListener('click', () => {
  $nodes.value = EXAMPLES.protected.nodes; $events.value = EXAMPLES.protected.events;
  updateCounters(); saveDraft();
});

loadDraft();
