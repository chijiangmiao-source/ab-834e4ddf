'use strict';
/*
 * 规则测试：地址复用、扫描回收、迟到读取，以及旧代次引用、重复退役、
 * 非法摘链、输入限制与首个违规定位。容器内与仓库本地均可运行。
 */
const test = require('node:test');
const assert = require('node:assert/strict');

let Analyzer;
try {
  Analyzer = require('../web/analyzer.js');            // verify 容器内布局 /app/tests -> /app/web
} catch (e) {
  Analyzer = require('../../web/static/analyzer.js');  // 仓库本地布局 verify/tests -> web/static
}

function run(initial, eventsText) {
  const pi = Analyzer.parseInitial(initial);
  assert.equal(pi.error, undefined, '初始链表应解析成功');
  const pe = Analyzer.parseEvents(eventsText);
  assert.equal(pe.error, undefined, '事件应解析成功');
  return Analyzer.verify(pi.nodes, pe.events);
}

test('完整协议（含地址复用）通过', () => {
  const r = run('A B C', [
    'T1 load', 'T1 protect', 'T1 confirm', 'T1 read',
    'T2 retire A', 'T2 scan',            // A#1 受 T1 保护，扫描跳过
    'T1 load', 'T1 protect', 'T1 confirm', 'T1 read',
    'T2 scan',                           // T1 已改护 B#1，A#1 被回收
    'T3 reuse A',                        // 复用产生 A#2 并压入表头
    'T1 load', 'T1 protect', 'T1 confirm', 'T1 read'
  ].join('\n'));
  assert.equal(r.ok, true);
  assert.equal(r.eventsChecked, 16);
  assert.deepEqual(r.snapshot.list[0], { addr: 'A', gen: 2 });
  assert.deepEqual(r.snapshot.list[1], { addr: 'B', gen: 1 });
  assert.equal(r.snapshot.free.length, 0);
  assert.equal(r.lifecycles.A.length, 2);
  assert.equal(r.lifecycles.A[0].reclaimedAt, 11);
  assert.equal(r.lifecycles.A[1].bornAt, 12);
});

test('迟到读取：对象退役后继续访问被定位', () => {
  const r = run('A B', [
    'T1 load', 'T1 protect', 'T1 confirm',
    'T2 retire A',
    'T1 read',                           // 候选 A#1 已退役
    'T2 retire B'                        // 后续事件不影响首个违规定位
  ].join('\n'));
  assert.equal(r.ok, false);
  assert.equal(r.violation.kind, 'READ_RETIRED');
  assert.equal(r.violation.index, 5);
  assert.equal(r.eventsChecked, 4);
  assert.equal(r.violation.address, 'A');
  assert.deepEqual(r.violation.thread.candidate, { addr: 'A', gen: 1 });
  assert.equal(r.violation.thread.confirmed, true);
  assert.match(r.violation.message, /退役/);
  assert.equal(r.violation.snapshot.list[0].addr, 'B');
  assert.equal(r.violation.lifecycle.length, 1);
  assert.equal(r.violation.lifecycle[0].retiredAt, 4);
});

test('地址复用：旧代次读取不被同地址新代次迷惑', () => {
  const r = run('A B', [
    'T3 load',                           // T3 候选 A#1，始终未保护
    'T1 load', 'T1 protect', 'T1 confirm', 'T1 read',
    'T2 retire A',
    'T1 load', 'T1 protect',             // T1 改护 B#1
    'T2 scan',                           // A#1 无保护，被回收
    'T2 reuse A',                        // A#2 成为新表头
    'T3 read'                            // 读取旧代次 A#1：迟到读取
  ].join('\n'));
  assert.equal(r.ok, false);
  assert.equal(r.violation.kind, 'READ_RECLAIMED');
  assert.equal(r.violation.index, 11);
  assert.match(r.violation.message, /回收/);
  assert.equal(r.violation.snapshot.list[0].gen, 2, '地址 A 已复用为第 2 代');
  assert.equal(r.violation.lifecycle.length, 2);
  assert.equal(r.violation.lifecycle[0].reclaimedAt, 9);
  assert.equal(r.violation.lifecycle[1].bornAt, 10);
});

test('地址复用：旧代次确认被稳定定位为旧代次引用', () => {
  const r = run('A B', [
    'T3 load',
    'T1 load', 'T1 protect', 'T1 confirm', 'T1 read',
    'T2 retire A',
    'T1 load', 'T1 protect',
    'T2 scan',
    'T2 reuse A',
    'T3 protect',                        // 发布对旧代次 A#1 的保护
    'T3 confirm'                         // 头指针已是 A#2
  ].join('\n'));
  assert.equal(r.ok, false);
  assert.equal(r.violation.kind, 'CONFIRM_MISMATCH');
  assert.equal(r.violation.index, 12);
  assert.match(r.violation.message, /旧代次引用/);
});

test('扫描回收：受保护节点跳过、失去保护后回收', () => {
  const r = run('A B', [
    'T1 load', 'T1 protect', 'T1 confirm',
    'T2 retire A',
    'T2 scan',                           // A#1 受 T1 危险指针保护
    'T1 load', 'T1 protect',             // T1 改护 B#1
    'T2 scan'                            // A#1 被回收
  ].join('\n'));
  assert.equal(r.ok, true);
  assert.match(r.effects[4], /无可回收/);
  assert.equal(r.lifecycles.A[0].reclaimedAt, 8);
  assert.deepEqual(r.snapshot.free, ['A']);
  assert.equal(r.snapshot.retired.length, 0);
});

test('重复退役被定位', () => {
  const r = run('A B', ['T1 retire A', 'T2 retire A'].join('\n'));
  assert.equal(r.ok, false);
  assert.equal(r.violation.kind, 'RETIRE_DUPLICATE');
  assert.equal(r.violation.index, 2);
  assert.match(r.violation.message, /重复退役/);
});

test('非法摘链：非头节点不得退役', () => {
  const r = run('A B C', 'T1 retire B');
  assert.equal(r.ok, false);
  assert.equal(r.violation.kind, 'RETIRE_NOT_HEAD');
  assert.match(r.violation.message, /第 2 位/);
});

test('已回收地址再次退役按旧代次引用定位', () => {
  const r = run('A B', ['T1 retire A', 'T1 scan', 'T1 retire A'].join('\n'));
  assert.equal(r.ok, false);
  assert.equal(r.violation.kind, 'RETIRE_STALE');
  assert.equal(r.violation.index, 3);
  assert.match(r.violation.message, /旧代次引用/);
});

test('复用未回收地址被拒绝', () => {
  const live = run('A B', 'T1 reuse A');
  assert.equal(live.violation.kind, 'REUSE_NOT_RECLAIMED');
  assert.match(live.violation.message, /存活/);

  const retiredOnly = run('A B', ['T1 retire A', 'T1 reuse A'].join('\n'));
  assert.equal(retiredOnly.violation.kind, 'REUSE_NOT_RECLAIMED');
  assert.equal(retiredOnly.violation.index, 2);
  assert.match(retiredOnly.violation.message, /尚未被扫描回收/);
});

test('读取前必须发布保护并完成确认', () => {
  const unprotected = run('A B', ['T1 load', 'T1 read'].join('\n'));
  assert.equal(unprotected.violation.kind, 'READ_UNPROTECTED');
  assert.equal(unprotected.violation.index, 2);

  const unconfirmed = run('A B', ['T1 load', 'T1 protect', 'T1 read'].join('\n'));
  assert.equal(unconfirmed.violation.kind, 'READ_UNCONFIRMED');
  assert.equal(unconfirmed.violation.index, 3);

  const noCandidate = run('A B', 'T1 protect');
  assert.equal(noCandidate.violation.kind, 'NO_CANDIDATE');
});

test('地址可连续复用，代次单调递增', () => {
  const r = run('A B', [
    'T1 retire A', 'T1 scan', 'T1 reuse A',
    'T1 retire A', 'T1 scan', 'T1 reuse A'
  ].join('\n'));
  assert.equal(r.ok, true);
  assert.equal(r.snapshot.list[0].gen, 3);
  assert.equal(r.lifecycles.A.length, 3);
  assert.equal(r.lifecycles.A[2].gen, 3);
  assert.equal(r.lifecycles.A[1].reclaimedAt, 5);
});

test('输入限制：节点数、事件数、非法操作', () => {
  assert.ok(Analyzer.parseInitial('').error);
  assert.ok(Analyzer.parseInitial(Array.from({ length: 17 }, (_, i) => 'N' + i).join(' ')).error);
  assert.ok(Analyzer.parseInitial('A A').error);
  assert.equal(Analyzer.parseInitial('A -> B, C').nodes.length, 3);

  const many = Array.from({ length: 129 }, () => 'T1 load').join('\n');
  assert.ok(Analyzer.parseEvents(many).error);
  assert.ok(Analyzer.parseEvents('T1 frobnicate').error);
  assert.ok(Analyzer.parseEvents('T1 retire').error);
  assert.ok(Analyzer.parseEvents('T1 load A').error);
  assert.ok(Analyzer.parseEvents('T1 read 0xZZ').error);
});

test('中文操作别名可用', () => {
  const pe = Analyzer.parseEvents([
    'T1 装载候选', 'T1 发布危险指针', 'T1 再次确认', 'T1 读取',
    'T2 摘链退役 A',
    'T1 装载候选', 'T1 发布危险指针',   // T1 改护 B#1，释放对 A#1 的保护
    'T2 扫描回收',
    'T3 复用地址 A'
  ].join('\n'));
  assert.equal(pe.error, undefined);
  assert.equal(pe.events.length, 9);
  const r = Analyzer.verify(['A', 'B'], pe.events);
  assert.equal(r.ok, true);
  assert.equal(r.snapshot.list[0].gen, 2);
});
