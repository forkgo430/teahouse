import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MISSING_PATH_RULE,
  resolvePath,
  evaluateAtom,
  evaluate,
  explain,
  matchingIndexes,
  formatTrace,
} from '../src/condition.js';

/* ---------------------------------------------------------------- *
 * 夹具
 * ---------------------------------------------------------------- */

function ctx() {
  return {
    clock: { day: 2, slot: 'night' },
    where: 'corridor',
    actors: { lin: { met: true, stats: { trust: 40, stress: 70 } } },
    routes: { lin: 'open' },
    flags: { opened: true, refused: false },
    clues: ['C01', 'C03'],
    endings: [],
  };
}

/* ---------------------------------------------------------------- *
 * 路径解析
 * ---------------------------------------------------------------- */

test('resolvePath 取嵌套字段', () => {
  const r = resolvePath(ctx(), 'actors.lin.stats.trust');
  assert.equal(r.found, true);
  assert.equal(r.value, 40);
});

test('resolvePath 支持数组下标', () => {
  assert.deepEqual(resolvePath(ctx(), 'clues[1]'), { found: true, value: 'C03' });
});

test('resolvePath 对不存在的键返回 found=false', () => {
  const r = resolvePath(ctx(), 'flags.nope');
  assert.equal(r.found, false);
  assert.equal(r.value, undefined);
});

test('resolvePath 对中间断层返回 found=false 而不抛错', () => {
  assert.equal(resolvePath(ctx(), 'a.b.c.d').found, false);
  assert.equal(resolvePath(ctx(), 'flags.opened.deep').found, false);
});

test('resolvePath 对数组越界返回 found=false', () => {
  assert.equal(resolvePath(ctx(), 'clues[9]').found, false);
});

test('resolvePath 不沿原型链取值', () => {
  assert.equal(resolvePath(ctx(), 'constructor').found, false);
  assert.equal(resolvePath({}, 'toString').found, false);
});

test('resolvePath 对空路径返回 found=false', () => {
  assert.equal(resolvePath(ctx(), '').found, false);
  assert.equal(resolvePath(ctx(), 'a..b').found, false);
});

/* ---------------------------------------------------------------- *
 * 原子运算符
 * ---------------------------------------------------------------- */

test('数值比较运算符', () => {
  const c = ctx();
  assert.equal(evaluateAtom({ path: 'actors.lin.stats.trust', op: '>=', value: 40 }, c), true);
  assert.equal(evaluateAtom({ path: 'actors.lin.stats.trust', op: '>', value: 40 }, c), false);
  assert.equal(evaluateAtom({ path: 'actors.lin.stats.trust', op: '<', value: 50 }, c), true);
  assert.equal(evaluateAtom({ path: 'actors.lin.stats.trust', op: '<=', value: 40 }, c), true);
});

test('严格相等：字符串与数字不混同', () => {
  const c = { n: 40, s: '40' };
  assert.equal(evaluateAtom({ path: 's', op: '==', value: 40 }, c), false);
  assert.equal(evaluateAtom({ path: 'n', op: '==', value: 40 }, c), true);
  assert.equal(evaluateAtom({ path: 's', op: '==', value: '40' }, c), true);
});

test('布尔与 null 的相等判断', () => {
  const c = ctx();
  assert.equal(evaluateAtom({ path: 'flags.opened', op: '==', value: true }, c), true);
  assert.equal(evaluateAtom({ path: 'flags.opened', op: '!=', value: true }, c), false);
  assert.equal(evaluateAtom({ path: 'flags.refused', op: '==', value: false }, c), true);
});

test('contains：数组包含元素', () => {
  const c = ctx();
  assert.equal(evaluateAtom({ path: 'clues', op: 'contains', value: 'C01' }, c), true);
  assert.equal(evaluateAtom({ path: 'clues', op: 'contains', value: 'C99' }, c), false);
});

test('contains 作用在非数组上返回 false', () => {
  assert.equal(evaluateAtom({ path: 'where', op: 'contains', value: 'cor' }, ctx()), false);
});

test('in：值在候选数组中', () => {
  const c = ctx();
  assert.equal(evaluateAtom({ path: 'routes.lin', op: 'in', value: ['open', 'advancing'] }, c), true);
  assert.equal(evaluateAtom({ path: 'where', op: 'in', value: ['room', 'roof'] }, c), false);
});

test('in 的候选不是数组时返回 false 而不抛错', () => {
  assert.equal(evaluateAtom({ path: 'where', op: 'in', value: 'corridor' }, ctx()), false);
});

test('exists：存在且非 null/undefined', () => {
  const c = { a: 0, b: '', d: false, e: null, f: undefined, g: {} };
  assert.equal(evaluateAtom({ path: 'a', op: 'exists' }, c), true);
  assert.equal(evaluateAtom({ path: 'b', op: 'exists' }, c), true);
  assert.equal(evaluateAtom({ path: 'd', op: 'exists' }, c), true, 'false 算存在');
  assert.equal(evaluateAtom({ path: 'e', op: 'exists' }, c), false);
  assert.equal(evaluateAtom({ path: 'f', op: 'exists' }, c), false);
  assert.equal(evaluateAtom({ path: 'g', op: 'exists' }, c), true);
  assert.equal(evaluateAtom({ path: 'zzz', op: 'exists' }, c), false);
});

test('比较运算符遇到非数字返回 false', () => {
  const c = { s: 'abc', n: 5 };
  assert.equal(evaluateAtom({ path: 's', op: '>', value: 1 }, c), false);
  assert.equal(evaluateAtom({ path: 'n', op: '>', value: 'x' }, c), false);
});

/* ---------------------------------------------------------------- *
 * 缺失路径规则
 * ---------------------------------------------------------------- */

test('缺失路径一律 false（除 exists 外）', () => {
  const c = {};
  for (const op of ['==', '!=', '>', '>=', '<', '<=', 'contains', 'in']) {
    const cond = op === 'contains' || op === 'in'
      ? { path: 'nope', op, value: ['x'] }
      : { path: 'nope', op, value: 0 };
    assert.equal(evaluateAtom(cond, c), false, `${op} 应返回 false`);
  }
  assert.equal(MISSING_PATH_RULE, 'missing-path-yields-false');
});

test('表达「未设置」要用显式取反写法', () => {
  const cond = { not: { path: 'flags.seen', op: '==', value: true } };
  assert.equal(evaluate(cond, {}), true, '未设置 → 内层 false → 取反 true');
  assert.equal(evaluate(cond, { flags: { seen: true } }), false);
  assert.equal(evaluate(cond, { flags: { seen: false } }), true);
});

test('未知运算符返回 false 而不抛错', () => {
  assert.equal(evaluateAtom({ path: 'where', op: '~=', value: 'x' }, ctx()), false);
});

/* ---------------------------------------------------------------- *
 * 逻辑组合
 * ---------------------------------------------------------------- */

test('null 条件恒真', () => {
  assert.equal(evaluate(null, ctx()), true);
  assert.equal(evaluate(undefined, ctx()), true);
});

test('not: null 是恒假', () => {
  assert.equal(evaluate({ not: null }, ctx()), false);
});

test('all：全部成立才成立', () => {
  const c = ctx();
  assert.equal(evaluate({ all: [
    { path: 'clock.day', op: '==', value: 2 },
    { path: 'where', op: '==', value: 'corridor' },
  ] }, c), true);

  assert.equal(evaluate({ all: [
    { path: 'clock.day', op: '==', value: 2 },
    { path: 'where', op: '==', value: 'roof' },
  ] }, c), false);
});

test('any：任一成立即成立', () => {
  const c = ctx();
  assert.equal(evaluate({ any: [
    { path: 'where', op: '==', value: 'roof' },
    { path: 'where', op: '==', value: 'corridor' },
  ] }, c), true);

  assert.equal(evaluate({ any: [
    { path: 'where', op: '==', value: 'roof' },
    { path: 'clock.day', op: '==', value: 9 },
  ] }, c), false);
});

test('not：取反', () => {
  const c = ctx();
  assert.equal(evaluate({ not: { path: 'where', op: '==', value: 'corridor' } }, c), false);
  assert.equal(evaluate({ not: { path: 'where', op: '==', value: 'roof' } }, c), true);
});

test('三层嵌套组合', () => {
  const c = ctx();
  const cond = {
    all: [
      { path: 'clock.slot', op: '==', value: 'night' },
      {
        any: [
          { path: 'flags.opened', op: '==', value: true },
          { path: 'routes.lin', op: '==', value: 'advancing' },
        ],
      },
      { not: { path: 'clues', op: 'contains', value: 'C99' } },
    ],
  };
  assert.equal(evaluate(cond, c), true);
});

test('空对象条件返回 false（不抛错）', () => {
  assert.equal(evaluate({}, ctx()), false);
});

/* ---------------------------------------------------------------- *
 * 轨迹与批量
 * ---------------------------------------------------------------- */

test('explain 给出可读的原因', () => {
  const c = ctx();
  const { result, steps } = explain({ path: 'actors.lin.stats.trust', op: '>=', value: 80 }, c);
  assert.equal(result, false);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].found, true);
  assert.equal(steps[0].actual, 40);
  assert.match(steps[0].note, /不满足/);
});

test('explain 标出缺失路径', () => {
  const { steps } = explain({ path: 'flags.gone', op: '==', value: 1 }, {});
  assert.equal(steps[0].found, false);
  assert.match(steps[0].note, /路径不存在/);
});

test('explain 不短路，all 下所有叶子都留痕', () => {
  const c = ctx();
  const { result, steps } = explain({ all: [
    { path: 'where', op: '==', value: 'roof' },
    { path: 'clock.day', op: '==', value: 2 },
  ] }, c);
  assert.equal(result, false);
  assert.equal(steps.filter(s => s.op !== 'all').length, 2, '两个叶子都要有记录');
});

test('explain 结果与 evaluate 一致', () => {
  const c = ctx();
  const conds = [
    null,
    { path: 'where', op: '==', value: 'corridor' },
    { all: [{ path: 'clock.day', op: '==', value: 2 }, { path: 'clues', op: 'contains', value: 'C01' }] },
    { not: { path: 'flags.refused', op: '==', value: true } },
  ];
  for (const cond of conds) {
    assert.equal(explain(cond, c).result, evaluate(cond, c));
  }
});

test('matchingIndexes 返回命中下标', () => {
  const c = ctx();
  const idx = matchingIndexes([
    { path: 'where', op: '==', value: 'roof' },
    { path: 'where', op: '==', value: 'corridor' },
    { path: 'clock.day', op: '==', value: 2 },
  ], c);
  assert.deepEqual(idx, [1, 2]);
});

test('formatTrace 输出多行文本', () => {
  const { steps } = explain({ all: [{ path: 'where', op: '==', value: 'roof' }] }, ctx());
  const text = formatTrace({ steps });
  assert.ok(text.split('\n').length >= 1);
  assert.match(text, /where/);
});

/* ---------------------------------------------------------------- *
 * 确定性与无副作用
 * ---------------------------------------------------------------- */

test('同一条件对同一状态重复求值结果一致', () => {
  const cond = { all: [
    { path: 'clues', op: 'contains', value: 'C03' },
    { any: [{ path: 'routes.lin', op: '==', value: 'open' }] },
  ] };
  const results = new Set();
  for (let i = 0; i < 20; i++) results.add(evaluate(cond, ctx()));
  assert.equal(results.size, 1);
  assert.equal([...results][0], true);
});

test('求值不修改传入的状态对象', () => {
  const c = ctx();
  const before = JSON.stringify(c);
  evaluate({ all: [
    { path: 'actors.lin.stats.trust', op: '>=', value: 10 },
    { path: 'clues', op: 'contains', value: 'C01' },
  ] }, c);
  explain({ path: 'where', op: '==', value: 'roof' }, c);
  assert.equal(JSON.stringify(c), before);
});
