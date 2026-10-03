/* 页面交互：草稿持久化、调用 Web Worker 复核、渲染结论。 */
(function () {
  'use strict';

  var DRAFT_KEY = 'hpmon.draft.v1';
  var VERDICT_KEY = 'hpmon.verdict.v1';

  var KINDS = {
    NO_CANDIDATE: '缺少候选',
    CONFIRM_MISMATCH: '头指针确认失败',
    READ_UNPROTECTED: '未保护读取',
    READ_UNCONFIRMED: '未确认读取',
    READ_RETIRED: '迟到读取（对象已退役）',
    READ_RECLAIMED: '迟到读取（对象已回收）',
    RETIRE_NOT_HEAD: '非法摘链',
    RETIRE_DUPLICATE: '重复退役',
    RETIRE_STALE: '旧代次引用',
    RETIRE_UNKNOWN: '未知地址',
    REUSE_NOT_RECLAIMED: '复用未回收地址'
  };

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmtNode(n) { return n ? n.addr + '#第' + n.gen + '代' : '空'; }

  var initialEl = $('initial');
  var eventsEl = $('events');
  var resultEl = $('result');
  var statusEl = $('status');
  var reviewBtn = $('review');
  var clearBtn = $('clear');

  /* ---------- 草稿与成功证据 ---------- */
  function saveDraft() {
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify({ initial: initialEl.value, events: eventsEl.value }));
    } catch (e) { /* 存储不可用时忽略 */ }
  }
  function clearVerdict() {
    try { localStorage.removeItem(VERDICT_KEY); } catch (e) { /* 忽略 */ }
  }
  function hideResult() {
    resultEl.hidden = true;
    resultEl.innerHTML = '';
  }
  function onInput() {
    saveDraft();
    clearVerdict(); /* 输入变化后，旧成功证据不再有效 */
    hideResult();
    statusEl.textContent = '';
  }
  initialEl.addEventListener('input', onInput);
  eventsEl.addEventListener('input', onInput);

  function restore() {
    var draft = null;
    try { draft = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null'); } catch (e) { /* 忽略 */ }
    if (draft) {
      initialEl.value = draft.initial || '';
      eventsEl.value = draft.events || '';
    }
    var verdict = null;
    try { verdict = JSON.parse(localStorage.getItem(VERDICT_KEY) || 'null'); } catch (e) { /* 忽略 */ }
    if (verdict && verdict.ok && draft &&
        verdict.initial === (draft.initial || '') && verdict.events === (draft.events || '')) {
      renderPass(verdict.result, true);
    }
  }

  clearBtn.addEventListener('click', function () {
    try { localStorage.removeItem(DRAFT_KEY); } catch (e) { /* 忽略 */ }
    clearVerdict();
    initialEl.value = '';
    eventsEl.value = '';
    hideResult();
    statusEl.textContent = '草稿与结论已清空';
  });

  /* ---------- 渲染 ---------- */
  function threadsHtml(threads, highlight) {
    var names = Object.keys(threads);
    if (!names.length) return '<p class="muted">（尚无线程状态）</p>';
    var html = '<table><tr><th>线程</th><th>候选</th><th>危险指针</th><th>已确认头指针</th></tr>';
    names.forEach(function (name) {
      var t = threads[name];
      html += '<tr' + (name === highlight ? ' class="hl"' : '') + '><td>' + esc(name) + '</td><td>' +
        esc(fmtNode(t.candidate)) + '</td><td>' + esc(fmtNode(t.hazard)) + '</td><td>' +
        (t.confirmed ? '是' : '否') + '</td></tr>';
    });
    return html + '</table>';
  }

  function lifeTableHtml(entries) {
    var html = '<table><tr><th>代次</th><th>出生</th><th>退役</th><th>回收</th><th>前序</th></tr>';
    entries.forEach(function (e) {
      html += '<tr><td>第' + e.gen + '代</td><td>' +
        (e.bornAt === 0 ? '初始链表' : '事件 #' + e.bornAt) + '</td><td>' +
        (e.retiredAt == null ? '—' : '事件 #' + e.retiredAt) + '</td><td>' +
        (e.reclaimedAt == null ? '—' : '事件 #' + e.reclaimedAt) + '</td><td>' +
        (e.gen > 1 ? '第' + (e.gen - 1) + '代' : '—') + '</td></tr>';
    });
    return html + '</table>';
  }

  function allLifecyclesHtml(lifecycles) {
    var addrs = Object.keys(lifecycles);
    if (!addrs.length) return '';
    var html = '<h3>对象生命周期（按地址）</h3>';
    addrs.forEach(function (a) {
      html += '<p class="kv">地址 ' + esc(a) + '</p>' + lifeTableHtml(lifecycles[a]);
    });
    return html;
  }

  function stateHtml(s) {
    return '<h3>状态快照</h3>' +
      '<p class="kv">链表：' + esc(s.list.length ? s.list.map(fmtNode).join(' → ') : '空') + '</p>' +
      '<p class="kv">退役集：' + esc(s.retired.length ? s.retired.map(fmtNode).join('、') : '空') + '</p>' +
      '<p class="kv">空闲地址：' + esc(s.free.length ? s.free.join('、') : '空') + '</p>';
  }

  function effectsHtml(effects, title) {
    if (!effects || !effects.length) return '';
    var html = '<details><summary>' + esc(title) + '（' + effects.length + ' 条）</summary><ol class="effects">';
    effects.forEach(function (e) { html += '<li>' + esc(e) + '</li>'; });
    return html + '</ol></details>';
  }

  function show(html) {
    resultEl.innerHTML = html;
    resultEl.hidden = false;
  }

  function renderPass(result, historical) {
    var html = '<span class="badge ok">通过</span> ';
    if (historical) html += '<span class="muted">上次复核的成功证据；修改输入后需重新复核。</span>';
    html += '<p>共检查 ' + result.eventsChecked + ' 条事件，全部满足规则。</p>';
    html += stateHtml(result.snapshot);
    html += '<h3>线程候选与保护快照</h3>' + threadsHtml(result.snapshot.threads, null);
    html += allLifecyclesHtml(result.lifecycles);
    html += effectsHtml(result.effects, '事件执行效果');
    show(html);
    statusEl.textContent = historical ? '已恢复上次通过结论' : '复核通过';
  }

  function renderViolation(result) {
    var v = result.violation;
    var html = '<span class="badge bad">首个违规</span>';
    html += '<p>事件 #' + v.index + '（输入第 ' + v.line + ' 行）：<code>' + esc(v.event.raw) + '</code></p>';
    html += '<p><strong>' + esc(KINDS[v.kind] || v.kind) + '</strong>：' + esc(v.message) + '</p>';
    html += '<h3>线程候选与保护快照</h3>' + threadsHtml(v.snapshot.threads, v.event.thread);
    if (v.address && v.lifecycle) {
      html += '<h3>地址 ' + esc(v.address) + ' 的对象生命周期及前序</h3>' + lifeTableHtml(v.lifecycle);
    }
    html += stateHtml(v.snapshot);
    html += effectsHtml(result.effects, '违规前已执行事件');
    show(html);
    statusEl.textContent = '发现违规，旧成功证据已清除';
  }

  function renderError(title, message) {
    show('<span class="badge warn">' + esc(title) + '</span><p>' + esc(message) + '</p>' +
      '<p class="muted">草稿已保留；旧成功证据已清除。</p>');
    statusEl.textContent = title;
  }

  /* ---------- Worker ---------- */
  var worker = null;
  try { worker = new Worker('worker.js'); } catch (e) { /* 点击复核时报告 */ }
  var pending = false;

  reviewBtn.addEventListener('click', function () {
    if (pending) return;
    if (!worker) { clearVerdict(); renderError('分析失败', 'Web Worker 不可用'); return; }
    pending = true;
    statusEl.textContent = '分析中…';
    saveDraft();
    worker.postMessage({ initial: initialEl.value, events: eventsEl.value });
  });

  if (worker) {
    worker.onmessage = function (e) {
      pending = false;
      var msg = e.data || {};
      if (msg.type === 'result' && msg.result && msg.result.ok) {
        try {
          localStorage.setItem(VERDICT_KEY, JSON.stringify({
            ok: true, initial: initialEl.value, events: eventsEl.value, result: msg.result
          }));
        } catch (err) { /* 忽略 */ }
        renderPass(msg.result, false);
      } else if (msg.type === 'result' && msg.result) {
        clearVerdict();
        renderViolation(msg.result);
      } else if (msg.type === 'input-error') {
        clearVerdict();
        renderError('输入错误', msg.message || '无法解析输入');
      } else {
        clearVerdict();
        renderError('分析失败', msg.message || '未知错误');
      }
    };
    worker.onerror = function (e) {
      pending = false;
      clearVerdict();
      renderError('分析失败', (e && e.message) || 'Worker 异常');
    };
  }

  /* ---------- 示例 ---------- */
  $('exPass').addEventListener('click', function () {
    initialEl.value = 'A B C';
    eventsEl.value = [
      'T1 load', 'T1 protect', 'T1 confirm', 'T1 read',
      'T2 retire A', 'T2 scan',
      'T1 load', 'T1 protect', 'T1 confirm', 'T1 read',
      'T2 scan', 'T3 reuse A',
      'T1 load', 'T1 protect', 'T1 confirm', 'T1 read'
    ].join('\n');
    onInput();
  });
  $('exLate').addEventListener('click', function () {
    initialEl.value = 'A B';
    eventsEl.value = ['T1 load', 'T1 protect', 'T1 confirm', 'T2 retire A', 'T1 read'].join('\n');
    onInput();
  });

  restore();
})();
