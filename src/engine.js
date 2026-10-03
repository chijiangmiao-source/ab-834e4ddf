// engine.js — 无锁采样池并发事件复核核心引擎（零依赖，浏览器 / Node 通用 ESM）
//
// 对象身份：(address, generation)。初始节点代次为 1；同一地址每次“复用”产生严格
// 递增的新代次。引擎按事件在数组中的顺序作为全局全序逐步执行，命中首个违规即停止。
//
// 合法协议（危险指针读时序）：
//   load(装载候选) -> publish(发布危险指针) -> reconfirm(再次确认当前头指针) -> read(读取)
// 其他事件：retire(摘链退役) / scan(扫描回收) / reuse(复用地址) / publish null(撤销保护)

export const LIMITS = Object.freeze({ MAX_NODES: 16, MAX_EVENTS: 128 });

export const OP = Object.freeze({
  LOAD: 'load',
  PUBLISH: 'publish',
  RECONFIRM: 'reconfirm',
  READ: 'read',
  RETIRE: 'retire',
  SCAN: 'scan',
  REUSE: 'reuse'
});

// 稳定违规代码（页面与测试均以此为准）
export const CODE = Object.freeze({
  INVALID_INPUT: 'INVALID_INPUT',         // 输入格式 / 规模非法
  OPERAND_MISMATCH: 'OPERAND_MISMATCH',   // 事件实参与线程候选不一致
  NO_CANDIDATE: 'NO_CANDIDATE',           // 发布/确认/读取时没有候选
  STALE_GENERATION: 'STALE_GENERATION',   // 旧代次引用（地址已回收 / 已复用）
  NOT_PROTECTED: 'NOT_PROTECTED',         // 读取时同代次危险指针未发布
  HEAD_NOT_CONFIRMED: 'HEAD_NOT_CONFIRMED', // 读取前未在发布后成功再确认头指针
  ACCESS_AFTER_RETIRE: 'ACCESS_AFTER_RETIRE', // 退役后继续访问
  DOUBLE_RETIRE: 'DOUBLE_RETIRE',         // 重复退役
  ILLEGAL_UNLINK: 'ILLEGAL_UNLINK',       // 非法摘链（不在链 / 未知地址 / 旧代次）
  ILLEGAL_RECLAIM: 'ILLEGAL_RECLAIM',     // 回收了非退役节点或已回收节点
  FREE_PROTECTED: 'FREE_PROTECTED',       // 回收仍受某线程危险指针保护的节点
  REUSE_NOT_RECYCLED: 'REUSE_NOT_RECYCLED' // 复用地址未经过回收
});

export const CODE_LABEL = Object.freeze({
  INVALID_INPUT: '输入非法',
  OPERAND_MISMATCH: '实参与候选不一致',
  NO_CANDIDATE: '线程无候选',
  STALE_GENERATION: '旧代次引用（地址复用 ABA）',
  NOT_PROTECTED: '读取未受同代次危险指针保护',
  HEAD_NOT_CONFIRMED: '读取前未成功再确认当前头指针',
  ACCESS_AFTER_RETIRE: '对象退役后继续访问',
  DOUBLE_RETIRE: '重复退役',
  ILLEGAL_UNLINK: '非法摘链',
  ILLEGAL_RECLAIM: '非法回收',
  FREE_PROTECTED: '回收受保护节点',
  REUSE_NOT_RECYCLED: '地址未回收即复用'
});

const ADDR_RE = /^[A-Za-z0-9_\-.]+$/;

const OP_ALIASES = new Map([
  ['load', OP.LOAD], ['装载', OP.LOAD], ['装载候选', OP.LOAD], ['候选', OP.LOAD],
  ['publish', OP.PUBLISH], ['发布', OP.PUBLISH], ['发布危险指针', OP.PUBLISH], ['保护', OP.PUBLISH],
  ['reconfirm', OP.RECONFIRM], ['confirm', OP.RECONFIRM], ['再次确认', OP.RECONFIRM], ['确认', OP.RECONFIRM],
  ['read', OP.READ], ['读取', OP.READ], ['读', OP.READ],
  ['retire', OP.RETIRE], ['摘链退役', OP.RETIRE], ['退役', OP.RETIRE], ['摘链', OP.RETIRE],
  ['scan', OP.SCAN], ['扫描', OP.SCAN], ['扫描回收', OP.SCAN], ['回收', OP.SCAN],
  ['reuse', OP.REUSE], ['复用', OP.REUSE], ['复用地址', OP.REUSE]
]);

// ---------------------------------------------------------------------------
// 文本解析：节点每行 `地址[,说明]`；事件每行 `[序号] 线程 操作 [地址] [key=value ...]`
// ---------------------------------------------------------------------------

export function parseInput({ nodesText = '', eventsText = '' } = {}) {
  const errors = [];
  const nodes = [];
  const seenAddr = new Set();

  const nodeLines = String(nodesText).split(/\r?\n/);
  for (let i = 0; i < nodeLines.length; i++) {
    const line = nodeLines[i].trim();
    if (!line) continue;
    const m = line.match(/^([^,\s]+)\s*[,，]\s*(.+)$/) || line.match(/^(\S+)\s*$/);
    const address = m ? m[1].trim() : line;
    const payload = m && m[2] !== undefined ? m[2].trim() : address;
    if (!ADDR_RE.test(address)) {
      errors.push(`节点第 ${i + 1} 行地址非法：${address || '(空)'}`);
      continue;
    }
    if (seenAddr.has(address)) {
      errors.push(`节点第 ${i + 1} 行地址重复：${address}`);
      continue;
    }
    seenAddr.add(address);
    nodes.push({ address, payload });
  }
  if (nodes.length > LIMITS.MAX_NODES) {
    errors.push(`初始节点为 ${nodes.length} 个，超过上限 ${LIMITS.MAX_NODES}`);
  }

  const events = [];
  const eventLines = String(eventsText).split(/\r?\n/);
  for (let i = 0; i < eventLines.length; i++) {
    const raw = eventLines[i].trim();
    if (!raw) continue;
    const lineNo = i + 1;
    const tokens = raw.split(/[\s,，|]+/).filter(Boolean);
    if (!tokens.length) continue;
    let p = 0;
    let seq = null;
    if (/^\d+$/.test(tokens[p])) seq = Number(tokens[p++]);
    const thread = tokens[p++];
    const opWord = tokens[p++];
    if (!thread) {
      errors.push(`事件第 ${lineNo} 行缺少线程标识：${raw}`);
      continue;
    }
    if (!opWord || !OP_ALIASES.has(opWord.toLowerCase())) {
      errors.push(`事件第 ${lineNo} 行操作无法识别：${opWord || '(空)'}`);
      continue;
    }
    const op = OP_ALIASES.get(opWord.toLowerCase());
    const ev = { lineNo, seq, thread, op };

    for (const tok of tokens.slice(p)) {
      const kv = tok.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.+)$/);
      if (kv) {
        if (kv[1] === 'reclaim') ev.reclaim = kv[2].split(/[:;；]+/).filter(Boolean);
        else if (kv[1] === 'payload' || kv[1] === 'note') ev.payload = kv[2];
        else errors.push(`事件第 ${lineNo} 行出现未知参数：${kv[1]}`);
      } else if (op === OP.SCAN) {
        // scan 的裸地址一律视为显式回收清单项
        ev.reclaim = ev.reclaim || [];
        ev.reclaim.push(tok);
      } else if (!ev.address) {
        ev.address = tok;
      } else {
        errors.push(`事件第 ${lineNo} 行多余实参：${tok}`);
      }
    }
    if (ev.address && !ADDR_RE.test(ev.address)) {
      errors.push(`事件第 ${lineNo} 行地址非法：${ev.address}`);
    }
    events.push(ev);
  }

  if (events.length > LIMITS.MAX_EVENTS) {
    errors.push(`全局事件为 ${events.length} 个，超过上限 ${LIMITS.MAX_EVENTS}`);
  }
  if (errors.length) return { ok: false, errors, nodes, events };
  return { ok: true, nodes, events };
}

// ---------------------------------------------------------------------------
// 主分析：输入 { nodes:[{address,payload}], events:[{thread,op,address,reclaim}] }
// ---------------------------------------------------------------------------

export function analyze(input) {
  let nodes, events;
  try {
    ({ nodes = [], events = [] } = input || {});
  } catch {
    return failure(CODE.INVALID_INPUT, '输入无法解析', -1);
  }
  if (!Array.isArray(nodes) || !Array.isArray(events)) {
    return failure(CODE.INVALID_INPUT, 'nodes / events 必须是数组', -1);
  }
  if (nodes.length > LIMITS.MAX_NODES) {
    return failure(CODE.INVALID_INPUT, `节点数 ${nodes.length} 超过上限 ${LIMITS.MAX_NODES}`, -1);
  }
  if (events.length > LIMITS.MAX_EVENTS) {
    return failure(CODE.INVALID_INPUT, `事件数 ${events.length} 超过上限 ${LIMITS.MAX_EVENTS}`, -1);
  }

  /** 每地址 -> { latest, gens: Map<gen, obj> }；obj 状态 linked/retired/freed */
  const store = new Map();
  const list = []; // 当前链表中的身份键，索引 0 为头
  const candidate = new Map(); // tid -> id|null
  const hazard = new Map();    // tid -> id|null
  const confirmed = new Map(); // tid -> bool（最近一次发布后是否成功再确认）
  const threads = [];
  const trace = [];

  const idOf = (address, generation) => ({ address, generation });
  const key = (id) => `${id.address}#${id.generation}`;
  const sameId = (a, b) => !!a && !!b && a.address === b.address && a.generation === b.generation;

  function rememberThread(t) {
    if (!threads.includes(t)) threads.push(t);
    if (!candidate.has(t)) candidate.set(t, null);
    if (!hazard.has(t)) hazard.set(t, null);
    if (!confirmed.has(t)) confirmed.set(t, false);
  }
  function entry(address, create = false) {
    let e = store.get(address);
    if (!e && create) { e = { latest: 0, gens: new Map() }; store.set(address, e); }
    return e;
  }
  function getObj(id) { return store.get(id.address)?.gens.get(id.generation) || null; }
  function latestObj(address) {
    const e = store.get(address);
    return e ? e.gens.get(e.latest) : null;
  }
  function addRef(obj, idx, kind, detail) {
    obj.refs.push({
      eventIndex: idx,
      seq: events[idx]?.seq ?? null,
      thread: events[idx]?.thread ?? null,
      op: events[idx]?.op ?? null,
      kind,
      detail: detail || ''
    });
  }
  function isProtected(id) {
    for (const t of threads) if (sameId(hazard.get(t), id)) return true;
    return false;
  }
  function threadSnapshot() {
    const out = {};
    for (const t of threads) {
      const c = candidate.get(t), h = hazard.get(t);
      out[t] = {
        candidate: c ? { ...c } : null,
        hazard: h ? { ...h } : null,
        confirmed: !!confirmed.get(t)
      };
    }
    return out;
  }
  function objectsSnapshot() {
    const out = [];
    for (const [address, e] of store) {
      for (const g of [...e.gens.keys()].sort((a, b) => a - b)) {
        const o = e.gens.get(g);
        out.push({
          address, generation: g, state: o.state, payload: o.payload,
          bornEvent: o.bornEvent, bornKind: o.bornKind,
          retiredEvent: o.retiredEvent, freedEvent: o.freedEvent
        });
      }
    }
    return out;
  }
  function lifecycleOf(obj) {
    const birth = {
      eventIndex: obj.bornEvent,
      seq: events[obj.bornEvent]?.seq ?? null,
      thread: events[obj.bornEvent]?.thread ?? null,
      op: events[obj.bornEvent]?.op ?? (obj.bornKind === 'initial' ? 'initial' : null),
      kind: 'born', detail: obj.bornKind === 'initial' ? '初始节点入链' : '地址复用产生新代次，压入链头'
    };
    return [birth, ...obj.refs].sort((a, b) => a.eventIndex - b.eventIndex);
  }
  function fail(code, message, idx, targetId, extra) {
    const ev = idx >= 0 ? events[idx] : null;
    let target = null;
    let lifecycle = [];
    if (targetId) {
      target = { ...targetId };
      const obj = getObj(targetId) ||
        (store.has(targetId.address) ? store.get(targetId.address).gens.get(targetId.generation) : null);
      if (obj) lifecycle = lifecycleOf(obj);
    }
    return {
      ok: false,
      violation: {
        code,
        label: CODE_LABEL[code] || code,
        message,
        eventIndex: idx,
        lineNo: ev?.lineNo ?? null,
        seq: ev?.seq ?? null,
        thread: ev?.thread ?? null,
        op: ev?.op ?? null,
        target,
        snapshots: { head: list.length ? { ...list[0] } : null, threads: threadSnapshot() },
        lifecycle,
        prefix: trace.map((x) => ({ ...x })),
        ...(extra || {})
      },
      trace,
      objects: objectsSnapshot()
    };
  }

  // 初始化节点：地址 -> 代次 1，按录入顺序成链，首个为头
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (!n || typeof n.address !== 'string' || !ADDR_RE.test(n.address)) {
      return fail(CODE.INVALID_INPUT, `第 ${i + 1} 个初始节点地址非法：${JSON.stringify(n?.address)}`, -1);
    }
  }
  if (new Set(nodes.map((n) => n.address)).size !== nodes.length) {
    return fail(CODE.INVALID_INPUT, '初始节点地址重复', -1);
  }
  for (const n of nodes) {
    const e = entry(n.address, true);
    const obj = {
      state: 'linked', payload: n.payload ?? n.address,
      bornEvent: -1, bornKind: 'initial', retiredEvent: null, freedEvent: null, refs: []
    };
    e.latest = 1;
    e.gens.set(1, obj);
    const id = idOf(n.address, 1);
    list.push(id);
  }

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (!ev || !ev.thread || !ev.op) {
      return fail(CODE.INVALID_INPUT, `事件 ${i} 结构不完整`, i);
    }
    rememberThread(ev.thread);
    const note = { eventIndex: i, seq: ev.seq ?? null, thread: ev.thread, op: ev.op, detail: '' };

    switch (ev.op) {
      case OP.LOAD: {
        const head = list.length ? list[0] : null;
        candidate.set(ev.thread, head ? { ...head } : null);
        confirmed.set(ev.thread, false);
        note.detail = head ? `候选 <- 头指针 ${head.address}:${head.generation}` : '候选 <- 空（池为空）';
        if (head) addRef(getObj(head), i, 'load', '装载为线程候选');
        break;
      }

      case OP.PUBLISH: {
        const c = candidate.get(ev.thread);
        if (ev.address === 'null' || ev.address === '0' || ev.address === '∅') {
          hazard.set(ev.thread, null);
          confirmed.set(ev.thread, false);
          note.detail = '撤销危险指针（发布 NULL）';
          break;
        }
        if (!c) return fail(CODE.NO_CANDIDATE, `线程 ${ev.thread} 尚无候选，不能发布危险指针`, i);
        if (ev.address && ev.address !== c.address) {
          return fail(CODE.OPERAND_MISMATCH,
            `发布地址 ${ev.address} 与线程候选 ${c.address}:${c.generation} 不一致`, i, c);
        }
        const obj = getObj(c);
        const entryNow = store.get(c.address);
        if (!obj || !entryNow || obj.state === 'freed' || c.generation !== entryNow.latest) {
          return fail(CODE.STALE_GENERATION,
            `候选 ${c.address}:${c.generation} 是已回收的旧代次（该地址当前代为 ${entryNow?.latest ?? '?'}），发布即旧代次引用`,
            i, c);
        }
        hazard.set(ev.thread, { ...c });
        confirmed.set(ev.thread, false); // 发布后必须重新确认当前头指针
        addRef(obj, i, 'publish', obj.state === 'retired' ? '危险指针指向已退役（但未回收）节点' : '发布危险指针');
        note.detail = `危险指针 <- ${c.address}:${c.generation}`;
        break;
      }

      case OP.RECONFIRM: {
        const c = candidate.get(ev.thread);
        if (!c) return fail(CODE.NO_CANDIDATE, `线程 ${ev.thread} 尚无候选，无法再确认`, i);
        const obj = getObj(c);
        const head = list.length ? list[0] : null;
        const match = !!obj && obj.state === 'linked' && !!head && sameId(head, c);
        confirmed.set(ev.thread, match);
        addRef(obj, i, 'reconfirm', match ? '再确认：候选仍是当前头指针' : '再确认失败：候选已不是当前头指针（或已退役/回收）');
        note.detail = match
          ? `再确认通过：头指针 == ${c.address}:${c.generation}`
          : `再确认失败：头指针 ${head ? `${head.address}:${head.generation}` : '空'} != 候选 ${c.address}:${c.generation}`;
        break;
      }

      case OP.READ: {
        const c = candidate.get(ev.thread);
        const h = hazard.get(ev.thread);
        if (!c) return fail(CODE.NO_CANDIDATE, `线程 ${ev.thread} 读取时没有候选`, i);
        if (!sameId(h, c)) {
          return fail(CODE.NOT_PROTECTED,
            `读取 ${c.address}:${c.generation} 时，同代次危险指针未发布（当前保护：${h ? `${h.address}:${h.generation}` : '无'}）`,
            i, c);
        }
        const e = store.get(c.address);
        if (!e || c.generation !== e.latest) {
          return fail(CODE.STALE_GENERATION,
            `读取的 ${c.address}:${c.generation} 为旧代次，该地址已复用为第 ${e?.latest} 代——不得仅凭地址相同混用新旧样本`,
            i, c);
        }
        const obj = e.gens.get(c.generation);
        if (obj.state === 'freed') {
          return fail(CODE.STALE_GENERATION,
            `读取的 ${c.address}:${c.generation} 已被扫描回收（地址已进入可复用状态）`, i, c);
        }
        if (obj.state === 'retired') {
          return fail(CODE.ACCESS_AFTER_RETIRE,
            `${c.address}:${c.generation} 已摘链退役，危险指针只能阻止回收，不能让退役样本继续被读取`,
            i, c);
        }
        if (!confirmed.get(ev.thread)) {
          return fail(CODE.HEAD_NOT_CONFIRMED,
            `读取 ${c.address}:${c.generation} 前未在本次发布后成功确认其仍为当前头指针`, i, c);
        }
        // 确认之后、读取之前，链表仍可能变化（retire / reuse 压入新头），读取瞬间再核对一次
        const headNow = list.length ? list[0] : null;
        if (!headNow || !sameId(headNow, c)) {
          confirmed.set(ev.thread, false);
          return fail(CODE.HEAD_NOT_CONFIRMED,
            `再确认与读取之间头指针已变化（当前头 ${headNow ? `${headNow.address}:${headNow.generation}` : '空'}），本次读取必须重新发布并确认`,
            i, c);
        }
        addRef(obj, i, 'read', '协议完整的安全读取');
        note.detail = `读取 ${c.address}:${c.generation}（同代次已保护且头指针已确认）`;
        confirmed.set(ev.thread, false); // 一次确认只授权一次读取，后续读取须重新确认
        break;
      }

      case OP.RETIRE: {
        if (!ev.address) return fail(CODE.INVALID_INPUT, 'retire 事件必须给出地址', i);
        const obj = latestObj(ev.address);
        if (!obj) {
          return fail(CODE.ILLEGAL_UNLINK, `摘链目标地址 ${ev.address} 从未分配`, i,
            store.has(ev.address) ? { address: ev.address, generation: store.get(ev.address).latest } : null);
        }
        const id = idOf(ev.address, store.get(ev.address).latest);
        if (obj.state === 'freed') {
          return fail(CODE.ILLEGAL_UNLINK,
            `${ev.address}:${id.generation} 已回收，按该地址摘链会触及旧代次`, i, id);
        }
        if (obj.state === 'retired') {
          addRef(obj, i, 'retire-attempt', '重复退役（非法）');
          return fail(CODE.DOUBLE_RETIRE,
            `${ev.address}:${id.generation} 已处于退役状态，不得重复摘链退役`, i, id);
        }
        const pos = list.findIndex((x) => sameId(x, id));
        if (pos < 0) {
          return fail(CODE.ILLEGAL_UNLINK, `${ev.address}:${id.generation} 已不在链表中，摘链非法`, i, id);
        }
        list.splice(pos, 1);
        obj.state = 'retired';
        obj.retiredEvent = i;
        addRef(obj, i, 'retire', '摘链并加入退役集合（危险指针不阻止退役，只阻止回收）');
        note.detail = `摘链退役 ${ev.address}:${id.generation}，新头指针 ${list[0] ? `${list[0].address}:${list[0].generation}` : '空'}`;
        break;
      }

      case OP.SCAN: {
        const reclaim = ev.reclaim;
        const reclaimed = [];
        const doFree = (address, idx) => {
          const e = store.get(address);
          const obj = e ? e.gens.get(e.latest) : null;
          const id = obj ? idOf(address, e.latest) : null;
          if (!obj || obj.state === 'freed') {
            return { err: fail(CODE.ILLEGAL_RECLAIM,
              `扫描记录要求回收 ${address}，但其当前代次${obj ? `（${address}:${e.latest}）已回收` : '不存在'}`,
              idx, id) };
          }
          if (obj.state !== 'retired') {
            return { err: fail(CODE.ILLEGAL_RECLAIM,
              `扫描记录要求回收 ${address}:${e.latest}，但该节点仍在链表中（未退役）`, idx, id) };
          }
          if (isProtected(id)) {
            const owners = threads.filter((t) => sameId(hazard.get(t), id));
            return { err: fail(CODE.FREE_PROTECTED,
              `扫描回收 ${address}:${e.latest} 时它仍受线程 ${owners.join('、')} 的危险指针保护——仅可回收未受任何线程保护的退役节点`,
              idx, id, { protectors: owners }) };
          }
          obj.state = 'freed';
          obj.freedEvent = idx;
          addRef(obj, idx, 'reclaim', '扫描确认无任何危险指针保护，予以回收');
          reclaimed.push({ ...id });
          return { id };
        };

        if (Array.isArray(reclaim) && reclaim.length) {
          for (const address of reclaim) {
            const r = doFree(address, i);
            if (r.err) return r.err;
          }
        } else {
          // 未显式给出回收清单：按规则回收所有“已退役且无人保护”的节点
          for (const [address, e] of [...store.entries()]) {
            const obj = e.gens.get(e.latest);
            if (obj && obj.state === 'retired' && !isProtected(idOf(address, e.latest))) {
              const r = doFree(address, i);
              if (r.err) return r.err;
            }
          }
        }
        note.detail = reclaimed.length
          ? `回收 ${reclaimed.map((x) => `${x.address}:${x.generation}`).join('、')}`
          : '扫描：无可回收节点（退役节点仍受保护或不存在退役节点）';
        break;
      }

      case OP.REUSE: {
        if (!ev.address) return fail(CODE.INVALID_INPUT, 'reuse 事件必须给出地址', i);
        const e = store.get(ev.address);
        const latest = e ? e.gens.get(e.latest) : null;
        if (!latest || latest.state !== 'freed') {
          const reason = !latest
            ? '该地址从未分配，复用只能取自已回收地址'
            : latest.state === 'retired'
              ? `当前代 ${ev.address}:${e.latest} 仅退役、尚未被扫描回收`
              : `当前代 ${ev.address}:${e.latest} 仍在链表中`;
          return fail(CODE.REUSE_NOT_RECYCLED,
            `地址 ${ev.address} 不能复用：${reason}`, i,
            latest ? idOf(ev.address, e.latest) : null);
        }
        const gen = e.latest + 1;
        const obj = {
          state: 'linked', payload: ev.payload ?? `${ev.address}:${gen}`,
          bornEvent: i, bornKind: 'reuse', retiredEvent: null, freedEvent: null, refs: []
        };
        e.latest = gen;
        e.gens.set(gen, obj);
        const id = idOf(ev.address, gen);
        list.unshift(id); // 复用节点重新发布到采样池，压入链头
        addRef(obj, i, 'born', `复用已回收地址，新代次 ${ev.address}:${gen}`);
        note.detail = `复用地址 ${ev.address} -> 新代次 ${gen}，压入链头`;
        break;
      }

      default:
        return fail(CODE.INVALID_INPUT, `不支持的操作：${ev.op}`, i);
    }
    trace.push(note);
  }

  return {
    ok: true,
    violation: null,
    trace,
    objects: objectsSnapshot(),
    finalState: {
      head: list.length ? { ...list[0] } : null,
      list: list.map((x) => ({ ...x })),
      threads: threadSnapshot()
    }
  };
}
