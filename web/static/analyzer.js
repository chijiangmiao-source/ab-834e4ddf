/*
 * 无锁采样池事件复核核心。
 * 同一份代码同时运行于 Web Worker（页面分析）与 Node（verify 服务规则测试）。
 *
 * 规则摘要：
 *  - 节点以「地址 + 单调代次」共同标识；复用只能取已回收地址并产生新代次。
 *  - 读取前必须：装载候选 → 发布同代次危险指针 → 再次确认当前头指针；
 *    且读取时该候选代次不得已退役或已回收（迟到读取）。
 *  - 扫描仅回收未受任何线程危险指针保护的退役节点。
 *  - 旧代次引用、重复退役、非法摘链、复用未回收地址均定位到首个违规事件。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.Analyzer = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  var MAX_NODES = 16;
  var MAX_EVENTS = 128;
  var ADDR_RE = /^(0x[0-9a-fA-F]+|[A-Za-z_][A-Za-z0-9_]*)$/;
  var THREAD_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]*$/;

  var OPS = {
    load: 'load', '装载': 'load', '装载候选': 'load',
    protect: 'protect', '发布': 'protect', '发布危险指针': 'protect',
    confirm: 'confirm', '确认': 'confirm', '再次确认': 'confirm',
    read: 'read', '读取': 'read',
    retire: 'retire', '退役': 'retire', '摘链': 'retire', '摘链退役': 'retire',
    scan: 'scan', '扫描': 'scan', '扫描回收': 'scan',
    reuse: 'reuse', '复用': 'reuse', '复用地址': 'reuse'
  };
  var NEED_ADDR = { retire: true, reuse: true };

  /* 解析初始链表：表头在前，空格/逗号/分号/-> 分隔。 */
  function parseInitial(text) {
    var tokens = String(text == null ? '' : text)
      .replace(/->|→|，/g, ' ')
      .split(/[\s,;]+/)
      .filter(Boolean);
    if (tokens.length === 0) return { error: '初始链表至少包含 1 个节点地址' };
    if (tokens.length > MAX_NODES) {
      return { error: '初始链表最多 ' + MAX_NODES + ' 个节点，当前 ' + tokens.length + ' 个' };
    }
    var seen = {};
    for (var i = 0; i < tokens.length; i++) {
      var t = tokens[i];
      if (!ADDR_RE.test(t)) return { error: '非法节点地址：' + t };
      if (seen[t]) return { error: '初始链表地址重复：' + t };
      seen[t] = true;
    }
    return { nodes: tokens };
  }

  /* 解析全局有序事件：每行「线程 操作 [地址]」，# 或 // 之后为注释。 */
  function parseEvents(text) {
    var lines = String(text == null ? '' : text).split(/\r?\n/);
    var events = [];
    for (var i = 0; i < lines.length; i++) {
      var raw = lines[i];
      var line = raw.replace(/(#|\/\/).*$/, '').trim();
      if (!line) continue;
      var parts = line.split(/\s+/);
      var thread = parts[0];
      if (!THREAD_RE.test(thread)) {
        return { error: '第 ' + (i + 1) + ' 行：非法线程标识「' + thread + '」' };
      }
      var op = OPS[String(parts[1] || '').toLowerCase()];
      if (!op) return { error: '第 ' + (i + 1) + ' 行：未知操作「' + (parts[1] || '') + '」' };
      var addr = parts.length > 2 ? parts[2] : null;
      if (parts.length > 3) return { error: '第 ' + (i + 1) + ' 行：字段过多' };
      if (NEED_ADDR[op] && !addr) {
        return { error: '第 ' + (i + 1) + ' 行：操作 ' + op + ' 需要地址参数' };
      }
      if (!NEED_ADDR[op] && addr) {
        return { error: '第 ' + (i + 1) + ' 行：操作 ' + op + ' 不接受地址参数' };
      }
      if (addr && !ADDR_RE.test(addr)) {
        return { error: '第 ' + (i + 1) + ' 行：非法地址「' + addr + '」' };
      }
      events.push({ thread: thread, op: op, addr: addr, line: i + 1, raw: raw.trim() });
    }
    if (events.length === 0) return { error: '至少需要 1 条事件' };
    if (events.length > MAX_EVENTS) {
      return { error: '事件最多 ' + MAX_EVENTS + ' 条，当前 ' + events.length + ' 条' };
    }
    return { events: events };
  }

  function fmt(n) { return n ? n.addr + '#第' + n.gen + '代' : '空'; }
  function key(n) { return n.addr + '@' + n.gen; }

  /* 逐条模拟全局有序事件，返回通过结论或首个违规的完整上下文。 */
  function verify(initial, events) {
    var genOf = Object.create(null);  // 地址 -> 当前最大代次
    var life = Object.create(null);   // 地址 -> [ {gen, bornAt, retiredAt, reclaimedAt} ]
    var threads = Object.create(null);// 线程 -> {candidate, hazard, confirmed}
    var list = [];                    // 链表，表头在前
    var retired = [];                 // 退役集
    var free = new Set();             // 已回收、可复用的地址
    var effects = [];                 // 每条事件的效果说明

    for (var k = 0; k < initial.length; k++) {
      var a = initial[k];
      genOf[a] = 1;
      life[a] = [{ gen: 1, bornAt: 0, retiredAt: null, reclaimedAt: null }];
      list.push({ addr: a, gen: 1 });
    }

    function ts(t) {
      return threads[t] || (threads[t] = { candidate: null, hazard: null, confirmed: false });
    }
    function lifeEntry(addr, gen) {
      var arr = life[addr] || [];
      for (var i = 0; i < arr.length; i++) if (arr[i].gen === gen) return arr[i];
      return null;
    }
    function snapshot() {
      return {
        list: list.map(function (n) { return { addr: n.addr, gen: n.gen }; }),
        retired: retired.map(function (n) { return { addr: n.addr, gen: n.gen }; }),
        free: Array.from(free),
        threads: JSON.parse(JSON.stringify(threads))
      };
    }
    function violate(index, ev, kind, message, address) {
      var t = ts(ev.thread);
      var addr = address || ev.addr || (t.candidate && t.candidate.addr) || null;
      return {
        ok: false,
        violation: {
          index: index + 1,
          line: ev.line,
          event: { thread: ev.thread, op: ev.op, addr: ev.addr, raw: ev.raw },
          kind: kind,
          message: message,
          address: addr,
          thread: JSON.parse(JSON.stringify(t)),
          snapshot: snapshot(),
          lifecycle: addr ? (life[addr] || null) : null
        },
        effects: effects,
        lifecycles: life,
        eventsChecked: index
      };
    }

    for (var i = 0; i < events.length; i++) {
      var ev = events[i];
      var t = ts(ev.thread);
      var c, head, idx, entry;

      if (ev.op === 'load') {
        t.candidate = list[0] ? { addr: list[0].addr, gen: list[0].gen } : null;
        t.confirmed = false;
        effects.push('装载候选 ' + fmt(t.candidate));

      } else if (ev.op === 'protect') {
        if (!t.candidate) {
          return violate(i, ev, 'NO_CANDIDATE', '线程 ' + ev.thread + ' 尚未装载候选，无法发布危险指针');
        }
        t.hazard = { addr: t.candidate.addr, gen: t.candidate.gen };
        t.confirmed = false;
        effects.push('发布危险指针 ' + fmt(t.hazard));

      } else if (ev.op === 'confirm') {
        if (!t.candidate) {
          return violate(i, ev, 'NO_CANDIDATE', '线程 ' + ev.thread + ' 尚未装载候选，无法再次确认');
        }
        head = list[0] || null;
        if (!head || head.addr !== t.candidate.addr || head.gen !== t.candidate.gen) {
          var msg;
          if (head && head.addr === t.candidate.addr) {
            msg = '旧代次引用：候选停留在 ' + fmt(t.candidate) + '，当前头指针已是 ' + fmt(head);
          } else {
            msg = '再次确认失败：候选 ' + fmt(t.candidate) + ' 已不再是当前头指针（当前头 ' + fmt(head) + '）';
          }
          return violate(i, ev, 'CONFIRM_MISMATCH', msg, t.candidate.addr);
        }
        t.confirmed = true;
        effects.push('确认头指针仍为 ' + fmt(head));

      } else if (ev.op === 'read') {
        if (!t.candidate) {
          return violate(i, ev, 'NO_CANDIDATE', '线程 ' + ev.thread + ' 尚未装载候选，无法读取');
        }
        c = t.candidate;
        var live = list.some(function (n) { return n.addr === c.addr && n.gen === c.gen; });
        if (!live) {
          entry = lifeEntry(c.addr, c.gen);
          if (entry && entry.reclaimedAt != null) {
            return violate(i, ev, 'READ_RECLAIMED',
              '迟到读取：候选 ' + fmt(c) + ' 已在事件 #' + entry.reclaimedAt + ' 被扫描回收', c.addr);
          }
          if (entry && entry.retiredAt != null) {
            return violate(i, ev, 'READ_RETIRED',
              '迟到读取：候选 ' + fmt(c) + ' 已在事件 #' + entry.retiredAt + ' 摘链退役', c.addr);
          }
          return violate(i, ev, 'READ_RETIRED', '迟到读取：候选 ' + fmt(c) + ' 已不在链表中', c.addr);
        }
        if (!t.hazard || t.hazard.addr !== c.addr || t.hazard.gen !== c.gen) {
          return violate(i, ev, 'READ_UNPROTECTED',
            '读取前未发布与候选同代次的危险指针（候选 ' + fmt(c) + '，保护 ' + fmt(t.hazard) + '）', c.addr);
        }
        if (!t.confirmed) {
          return violate(i, ev, 'READ_UNCONFIRMED', '读取前未完成对当前头指针的再次确认', c.addr);
        }
        effects.push('读取 ' + fmt(c));

      } else if (ev.op === 'retire') {
        idx = -1;
        for (var j = 0; j < list.length; j++) if (list[j].addr === ev.addr) { idx = j; break; }
        if (idx === -1) {
          var dup = null;
          for (var m = 0; m < retired.length; m++) if (retired[m].addr === ev.addr) { dup = retired[m]; break; }
          if (dup) {
            entry = lifeEntry(dup.addr, dup.gen);
            return violate(i, ev, 'RETIRE_DUPLICATE',
              '重复退役：' + fmt(dup) + ' 已在事件 #' + (entry ? entry.retiredAt : '?') + ' 退役', ev.addr);
          }
          if (free.has(ev.addr) || genOf[ev.addr]) {
            return violate(i, ev, 'RETIRE_STALE',
              '旧代次引用：地址 ' + ev.addr + ' 的存活代次已回收，无可退役节点', ev.addr);
          }
          return violate(i, ev, 'RETIRE_UNKNOWN', '未知地址 ' + ev.addr + '，无法摘链退役', ev.addr);
        }
        if (idx !== 0) {
          return violate(i, ev, 'RETIRE_NOT_HEAD',
            '非法摘链：' + fmt(list[idx]) + ' 位于链表第 ' + (idx + 1) + ' 位，仅头节点可退役', ev.addr);
        }
        var node = list.shift();
        retired.push(node);
        lifeEntry(node.addr, node.gen).retiredAt = i + 1;
        effects.push('摘链退役 ' + fmt(node));

      } else if (ev.op === 'scan') {
        var protectedKeys = Object.create(null);
        for (var name in threads) {
          var h = threads[name].hazard;
          if (h) protectedKeys[key(h)] = true;
        }
        var reclaimed = [];
        for (var r = retired.length - 1; r >= 0; r--) {
          var n = retired[r];
          if (protectedKeys[key(n)]) continue;
          retired.splice(r, 1);
          free.add(n.addr);
          lifeEntry(n.addr, n.gen).reclaimedAt = i + 1;
          reclaimed.push(fmt(n));
        }
        effects.push(reclaimed.length ? '扫描回收 ' + reclaimed.join('、') : '扫描：无可回收节点');

      } else if (ev.op === 'reuse') {
        if (!free.has(ev.addr)) {
          var reason;
          if (list.some(function (x) { return x.addr === ev.addr; })) reason = '该地址仍在链表中存活';
          else if (retired.some(function (x) { return x.addr === ev.addr; })) reason = '该地址已退役但尚未被扫描回收';
          else reason = '该地址从未被回收';
          return violate(i, ev, 'REUSE_NOT_RECLAIMED', '复用地址 ' + ev.addr + ' 失败：' + reason, ev.addr);
        }
        free.delete(ev.addr);
        genOf[ev.addr] += 1;
        var born = { addr: ev.addr, gen: genOf[ev.addr] };
        list.unshift(born);
        life[ev.addr].push({ gen: born.gen, bornAt: i + 1, retiredAt: null, reclaimedAt: null });
        effects.push('复用地址 ' + ev.addr + '，生成 ' + fmt(born));
      }
    }

    return {
      ok: true,
      eventsChecked: events.length,
      snapshot: snapshot(),
      lifecycles: life,
      effects: effects
    };
  }

  return {
    MAX_NODES: MAX_NODES,
    MAX_EVENTS: MAX_EVENTS,
    parseInitial: parseInitial,
    parseEvents: parseEvents,
    verify: verify
  };
});
