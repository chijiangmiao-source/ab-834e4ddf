// engine.test.js — 规则测试：地址复用、扫描保护、迟到读取等，零依赖测试器
import { analyze, parseInput, CODE, OP } from '../src/engine.js';

let passed = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) { passed++; }
  else failures.push(`${name}${detail ? ` —— ${detail}` : ''}`);
}
function eq(name, actual, expected) {
  check(name, actual === expected, `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}
function ev(op, thread, address, extra = {}) { return { op, thread, address, ...extra }; }
function run(events, nodes = ['N1', 'N2', 'N3']) {
  return analyze({
    nodes: nodes.map((a) => ({ address: a, payload: a })),
    events
  });
}
// 标准安全前置：T1 对 N1 完成装载/发布/确认
function protect(tid = 'T1', addr = 'N1') {
  return [ev(OP.LOAD, tid), ev(OP.PUBLISH, tid, addr), ev(OP.RECONFIRM, tid)];
}

// 1. 完整安全协议（含回收、复用、对新代次重新走协议）
{
  const r = run([
    ...protect('T1'),
    ev(OP.READ, 'T1'),
    ev(OP.RETIRE, 'T2', 'N2'),
    ev(OP.SCAN, 'T2'),                 // N2 无人保护 -> 可回收
    ev(OP.REUSE, 'T2', 'N2', { payload: 'N2-gen2' }),
    ev(OP.LOAD, 'T1'),
    ev(OP.PUBLISH, 'T1', 'N2'),        // 头指针现在是 N2:2
    ev(OP.RECONFIRM, 'T1'),
    ev(OP.READ, 'T1')
  ]);
  check('安全全流程通过', r.ok === true, JSON.stringify(r.violation));
  const n2g2 = r.objects.find((o) => o.address === 'N2' && o.generation === 2);
  eq('复用产生新代次 2', n2g2 && n2g2.state, 'linked');
  const n2g1 = r.objects.find((o) => o.address === 'N2' && o.generation === 1);
  eq('旧代次保留为 freed', n2g1 && n2g1.state, 'freed');
}

// 2. 地址复用 ABA：旧代次迟到读取必须被识别（不能按地址相同混用）
{
  const r = run([
    ...protect('T1'),
    ev(OP.RETIRE, 'T2', 'N1'),
    ev(OP.PUBLISH, 'T1', 'null'),
    ev(OP.SCAN, 'T2'),
    ev(OP.REUSE, 'T2', 'N1', { payload: '新样本' }), // N1:2 成为新头
    ev(OP.READ, 'T1')                                  // T1 候选仍指向 N1:1
  ]);
  check('ABA 迟到读取被拦截', r.ok === false);
  check('违规码为 NOT_PROTECTED/STALE_GENERATION 之一',
    [CODE.NOT_PROTECTED, CODE.STALE_GENERATION].includes(r.violation?.code),
    r.violation?.code);
  check('违规目标锁定旧代次 1', r.violation?.target?.generation === 1,
    JSON.stringify(r.violation?.target));
}

// 3. 即便重新装载到新代次，旧危险指针语义不继承
{
  const r = run([
    ...protect('T1'),
    ev(OP.RETIRE, 'T2', 'N1'),
    ev(OP.PUBLISH, 'T1', 'null'),
    ev(OP.SCAN, 'T2'),
    ev(OP.REUSE, 'T2', 'N1'),
    ev(OP.LOAD, 'T1'),                  // 候选更新为 N1:2
    ev(OP.READ, 'T1')                   // 未对新代次发布
  ]);
  eq('新代次未发布读取 -> NOT_PROTECTED', r.violation?.code, CODE.NOT_PROTECTED);
  eq('目标为新代次 2', r.violation?.target?.generation, 2);
}

// 4. 扫描不得回收受危险指针保护的退役节点
{
  const r = run([
    ...protect('T1'),
    ev(OP.RETIRE, 'T2', 'N1'),
    ev(OP.SCAN, 'T2', undefined, { reclaim: ['N1'] })
  ]);
  eq('回收受保护节点 -> FREE_PROTECTED', r.violation?.code, CODE.FREE_PROTECTED);
  check('保护者快照包含 T1', (r.violation?.protectors || []).includes('T1'));
}

// 5. 保护存在时自动扫描也不得回收；撤销保护后扫描+复用合法
{
  let r = run([
    ...protect('T1'),
    ev(OP.RETIRE, 'T2', 'N1'),
    ev(OP.SCAN, 'T2')                    // 自动清单：N1 受保护 -> 不可回收，事件本身不违规
  ]);
  check('受保护时扫描跳过不违规', r.ok === true, JSON.stringify(r.violation));
  r = run([
    ...protect('T1'),
    ev(OP.RETIRE, 'T2', 'N1'),
    ev(OP.SCAN, 'T2'),
    ev(OP.REUSE, 'T2', 'N1')             // 尚未真正回收
  ]);
  eq('未回收即复用 -> REUSE_NOT_RECYCLED', r.violation?.code, CODE.REUSE_NOT_RECYCLED);
  r = run([
    ...protect('T1'),
    ev(OP.RETIRE, 'T2', 'N1'),
    ev(OP.PUBLISH, 'T1', 'null'),
    ev(OP.SCAN, 'T2'),
    ev(OP.REUSE, 'T2', 'N1')
  ]);
  check('撤销保护后扫描+复用通过', r.ok === true, JSON.stringify(r.violation));
}

// 6. 退役后继续访问：危险指针只能阻止回收，不能读取退役样本
{
  const r = run([
    ...protect('T1'),
    ev(OP.RETIRE, 'T2', 'N1'),           // 头指针变为 N2，T1 仍保护 N1:1
    ev(OP.READ, 'T1')
  ]);
  eq('退役后读取 -> ACCESS_AFTER_RETIRE', r.violation?.code, CODE.ACCESS_AFTER_RETIRE);
}

// 7. 未发布 / 未确认即读取
{
  let r = run([ev(OP.LOAD, 'T1'), ev(OP.READ, 'T1')]);
  eq('未发布读取 -> NOT_PROTECTED', r.violation?.code, CODE.NOT_PROTECTED);

  r = run([ev(OP.LOAD, 'T1'), ev(OP.PUBLISH, 'T1', 'N1'), ev(OP.READ, 'T1')]);
  eq('未再确认读取 -> HEAD_NOT_CONFIRMED', r.violation?.code, CODE.HEAD_NOT_CONFIRMED);

  r = run([
    ...protect('T1'),
    ev(OP.READ, 'T1'),                   // 第一次读取合法
    ev(OP.READ, 'T1')                    // 确认一次性，第二次须重新确认
  ]);
  eq('确认标志一次性 -> HEAD_NOT_CONFIRMED', r.violation?.code, CODE.HEAD_NOT_CONFIRMED);
}

// 8. 重复退役、非法摘链、非法回收
{
  let r = run([...protect('T2'), ev(OP.RETIRE, 'T3', 'N1'), ev(OP.RETIRE, 'T3', 'N1')]);
  eq('重复退役 -> DOUBLE_RETIRE', r.violation?.code, CODE.DOUBLE_RETIRE);

  r = run([ev(OP.RETIRE, 'T2', 'NX')]);
  eq('摘链未知地址 -> ILLEGAL_UNLINK', r.violation?.code, CODE.ILLEGAL_UNLINK);

  r = run([ev(OP.SCAN, 'T2', undefined, { reclaim: ['N1'] })]);
  eq('回收未退役节点 -> ILLEGAL_RECLAIM', r.violation?.code, CODE.ILLEGAL_RECLAIM);
}

// 9. 发布实参与候选不一致；空池发布
{
  let r = run([ev(OP.LOAD, 'T1'), ev(OP.PUBLISH, 'T1', 'N2')]);
  eq('发布地址与候选不符 -> OPERAND_MISMATCH', r.violation?.code, CODE.OPERAND_MISMATCH);

  r = run([
    ev(OP.RETIRE, 'T2', 'N1'), ev(OP.RETIRE, 'T2', 'N2'), ev(OP.RETIRE, 'T2', 'N3'),
    ev(OP.SCAN, 'T2'),
    ev(OP.LOAD, 'T1'),
    ev(OP.PUBLISH, 'T1', 'null')
  ]);
  check('空池装载候选为 null 且发布 null 合法', r.ok === true, JSON.stringify(r.violation));

  r = run([
    ev(OP.RETIRE, 'T2', 'N1'), ev(OP.RETIRE, 'T2', 'N2'), ev(OP.RETIRE, 'T2', 'N3'),
    ev(OP.SCAN, 'T2'),
    ev(OP.LOAD, 'T1'),
    ev(OP.RECONFIRM, 'T1')
  ]);
  eq('空池再确认 -> NO_CANDIDATE', r.violation?.code, CODE.NO_CANDIDATE);
}

// 10. 代次单调：连续复用同地址两次得到 2、3 代，旧代次状态不被覆盖
{
  const r = run([
    ev(OP.RETIRE, 'T2', 'N1'), ev(OP.SCAN, 'T2'), ev(OP.REUSE, 'T2', 'N1'),
    ev(OP.RETIRE, 'T2', 'N1'), ev(OP.SCAN, 'T2'), ev(OP.REUSE, 'T2', 'N1')
  ]);
  check('连续两次复用通过', r.ok === true, JSON.stringify(r.violation));
  const gens = r.objects.filter((o) => o.address === 'N1').map((o) => o.generation).sort();
  check('代次序列为 1,2,3', JSON.stringify(gens) === '[1,2,3]', JSON.stringify(gens));
  check('终态最新代为 3 且在链', r.finalState.head.address === 'N1' && r.finalState.head.generation === 3,
    JSON.stringify(r.finalState.head));
}

// 11. 生命周期与前序：违规结果携带生命周期与前缀轨迹
{
  const r = run([
    ...protect('T1'),
    ev(OP.RETIRE, 'T2', 'N1'),
    ev(OP.SCAN, 'T2', undefined, { reclaim: ['N1'] })
  ]);
  check('违规附生命周期', Array.isArray(r.violation?.lifecycle) && r.violation.lifecycle.length >= 4,
    `len=${r.violation?.lifecycle?.length}`);
  check('违规附前序轨迹', r.violation?.prefix?.length === 4,
    `len=${r.violation?.prefix?.length}`);
  check('快照含线程候选与危险指针',
    r.violation?.snapshots?.threads?.T1?.hazard?.generation === 1);
}

// 12. 解析器：中文操作别名、规模上限、错误定位
{
  const p = parseInput({
    nodesText: 'A,样本A\nB',
    eventsText: '1 线程甲 装载\n2 线程甲 发布 A\n3 线程甲 再次确认\n4 线程甲 读取'
  });
  check('中文操作解析通过', p.ok && p.events[1].op === OP.PUBLISH && p.nodes.length === 2,
    JSON.stringify(p.errors));

  const tooManyNodes = parseInput({
    nodesText: Array.from({ length: 17 }, (_, i) => `N${i}`).join('\n'),
    eventsText: ''
  });
  check('超过 16 节点报错', !tooManyNodes.ok && tooManyNodes.errors[0].includes('16'));

  const tooManyEvents = parseInput({
    nodesText: 'N1',
    eventsText: Array.from({ length: 129 }, (_, i) => `${i + 1} T1 read`).join('\n')
  });
  check('超过 128 事件报错', !tooManyEvents.ok);

  const bad = parseInput({ nodesText: 'N1', eventsText: '1 T1 frobnicate' });
  check('未知操作报错且保留行号', !bad.ok && bad.events.length === 0 && /第 1 行/.test(bad.errors[0]));
}

// 13. 扫描显式清单回收多个节点，且只回收列出的
{
  const r = run([
    ev(OP.RETIRE, 'T2', 'N2'),
    ev(OP.RETIRE, 'T3', 'N3'),
    ev(OP.SCAN, 'T2', undefined, { reclaim: ['N2'] })
  ]);
  check('显式清单扫描通过', r.ok === true, JSON.stringify(r.violation));
  eq('N2 已回收', r.objects.find((o) => o.address === 'N2').state, 'freed');
  eq('N3 仍退役（未列入清单）', r.objects.find((o) => o.address === 'N3').state, 'retired');
}

// ---------------------------------------------------------------- 汇总

const total = passed + failures.length;
console.log(`规则测试：${passed}/${total} 通过`);
if (failures.length) {
  for (const f of failures) console.error(`  ✕ ${f}`);
  process.exitCode = 1;
} else {
  console.log('全部规则测试通过。');
}
