import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SCHEMA_VERSION,
  SLOTS,
  SchemaError,
  validateEventOnly,
  validateEventSet,
  assertEvent,
  assertEventSet,
  validateCondition,
  validateEffect,
  createInitialState,
} from '../src/schema.js';

/* ---------------------------------------------------------------- *
 * 夹具
 * ---------------------------------------------------------------- */

/** 一个字段齐全的合法事件 */
function goodEvent(overrides = {}) {
  return {
    id: 'E01',
    title: '门铃响',
    when: { day: 1, slot: 'night' },
    where: 'entrance',
    priority: 10,
    actors: ['lin', 'ning'],
    firstMet: ['lin', 'ning'],
    require: null,
    branches: [
      {
        key: 'A',
        label: '开门',
        cond: { path: 'stats.lin.trust', op: '>=', value: 30 },
        text: '你打开门。',
        effects: [
          { path: 'stats.lin.trust', op: 'add', value: 5 },
          { path: 'flags.opened', op: 'set', value: true },
        ],
        unlock: { clue: 'C01', route: { actor: 'lin', state: 'open' } },
      },
      {
        key: 'B',
        label: '不开',
        cond: null,
        text: '',
        effects: [{ path: 'stats.lin.stress', op: 'add', value: 3 }],
      },
    ],
    fallback: 'B',
    tags: ['opening'],
    ...overrides,
  };
}

const pathsOf = (issues) => issues.map(i => i.path);

/* ---------------------------------------------------------------- *
 * 契约常量
 * ---------------------------------------------------------------- */

test('契约常量已冻结且顺序稳定', () => {
  assert.equal(SCHEMA_VERSION, 1);
  assert.deepEqual(SLOTS, ['dawn', 'morning', 'afternoon', 'evening', 'night']);
});

/* ---------------------------------------------------------------- *
 * 合法数据
 * ---------------------------------------------------------------- */

test('合法事件无问题项', () => {
  const { ok, issues } = validateEventOnly(goodEvent());
  assert.equal(ok, true, `不应有问题项，实际：${JSON.stringify(issues)}`);
  assert.equal(issues.length, 0);
});

test('assertEvent 对合法事件返回 true', () => {
  assert.equal(assertEvent(goodEvent()), true);
});

test('合法事件集通过，且 id 不重复', () => {
  const set = [goodEvent({ id: 'E01' }), goodEvent({ id: 'E02', when: { day: 2, slot: 'morning' } })];
  assert.deepEqual(validateEventSet(set), { ok: true, issues: [] });
  assert.equal(assertEventSet(set), true);
});

/* ---------------------------------------------------------------- *
 * 非法数据 —— 每例只破坏一处，断言路径精确
 * ---------------------------------------------------------------- */

test('缺 id 报 event.id', () => {
  const ev = goodEvent();
  delete ev.id;
  const issues = validateEventOnly(ev).issues;
  assert.ok(pathsOf(issues).includes('event.id'), JSON.stringify(issues));
});

test('id 含非法字符被拒', () => {
  const issues = validateEventOnly(goodEvent({ id: 'E 01/乱' })).issues;
  assert.ok(pathsOf(issues).includes('event.id'));
});

test('branches 为空数组被拒', () => {
  const issues = validateEventOnly(goodEvent({ branches: [] })).issues;
  assert.ok(pathsOf(issues).includes('event.branches'));
});

test('分支 key 重复被拒并指出位置', () => {
  const ev = goodEvent();
  ev.branches[1].key = 'A';
  const issues = validateEventOnly(ev).issues;
  assert.ok(pathsOf(issues).includes('event.branches[1].key'), JSON.stringify(issues));
  assert.match(issues.find(i => i.path === 'event.branches[1].key').message, /重复/);
});

test('多个无条件分支但有 fallback 时通过', () => {
  const ev = goodEvent();
  ev.branches[0].cond = null;
  const issues = validateEventOnly(ev).issues;
  assert.deepEqual(issues, [], `应通过，实际：${JSON.stringify(issues)}`);
});

test('多个无条件分支且未给 fallback 被拒', () => {
  const ev = goodEvent();
  ev.branches[0].cond = null;
  delete ev.fallback;
  const issues = validateEventOnly(ev).issues;
  const hit = issues.find(i => i.path === 'event.branches');
  assert.ok(hit, JSON.stringify(issues));
  assert.match(hit.message, /自动回落目标不唯一/);
});

test('单个无条件分支无需 fallback', () => {
  const ev = goodEvent();
  ev.branches[0].cond = { path: 'a', op: '==', value: 1 };
  delete ev.fallback;
  assert.deepEqual(validateEventOnly(ev).issues, []);
});

test('fallback 指向不存在的分支被拒', () => {
  const issues = validateEventOnly(goodEvent({ fallback: 'Z' })).issues;
  assert.ok(pathsOf(issues).includes('event.fallback'));
});

test('未知时段被拒', () => {
  const issues = validateEventOnly(goodEvent({ when: { day: 1, slot: 'noon' } })).issues;
  assert.ok(pathsOf(issues).includes('event.when.slot'), JSON.stringify(issues));
});

test('firstMet 不在 actors 内被拒', () => {
  const ev = goodEvent({ actors: ['lin'], firstMet: ['lin', 'ning'] });
  const issues = validateEventOnly(ev).issues;
  assert.ok(pathsOf(issues).includes('event.firstMet[1]'), JSON.stringify(issues));
});

test('事件集内 id 重复被拒并指出首次出现位置', () => {
  const set = [goodEvent({ id: 'E01' }), goodEvent({ id: 'E01' })];
  const { ok, issues } = validateEventSet(set);
  assert.equal(ok, false);
  const hit = issues.find(i => i.path === 'events[1].id');
  assert.ok(hit, JSON.stringify(issues));
  assert.match(hit.message, /events\[0\]/);
});

/* ---------------------------------------------------------------- *
 * 条件
 * ---------------------------------------------------------------- */

test('null 条件合法（表示恒真）', () => {
  const issues = [];
  validateCondition(null, 'c', issues);
  assert.deepEqual(issues, []);
});

test('空条件对象被拒', () => {
  const issues = [];
  validateCondition({}, 'c', issues);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].path, 'c');
});

test('逻辑组合递归校验到叶子', () => {
  const issues = [];
  validateCondition({ all: [{ path: 'a.b', op: '>', value: 1 }, { any: [{ path: 'x', op: '??', value: 1 }] }] }, 'c', issues);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].path, 'c.all[1].any[0].op');
});

test('未知运算符被拒', () => {
  const issues = [];
  validateCondition({ path: 'a', op: '~=', value: 1 }, 'c', issues);
  assert.equal(issues[0].path, 'c.op');
});

test('比较运算符的 value 必须是数字', () => {
  const issues = [];
  validateCondition({ path: 'a', op: '>=', value: '30' }, 'c', issues);
  assert.equal(issues[0].path, 'c.value');
});

test('exists 不接受 value', () => {
  const issues = [];
  validateCondition({ path: 'flags.x', op: 'exists', value: true }, 'c', issues);
  assert.equal(issues[0].path, 'c.value');
});

test('exists 不带 value 合法', () => {
  const issues = [];
  validateCondition({ path: 'flags.x', op: 'exists' }, 'c', issues);
  assert.deepEqual(issues, []);
});

test('条件必须是对象或 null', () => {
  const issues = [];
  validateCondition('trust>=30', 'c', issues);
  assert.equal(issues.length, 1);
  assert.match(issues[0].message, /对象或 null/);
});

test('路径含空段被拒', () => {
  const issues = [];
  validateCondition({ path: 'a..b', op: '==', value: 1 }, 'c', issues);
  assert.equal(issues[0].path, 'c.path');
});

/* ---------------------------------------------------------------- *
 * 效果
 * ---------------------------------------------------------------- */

test('add 缺 value 被拒', () => {
  const issues = [];
  validateEffect({ path: 'stats.lin.trust', op: 'add' }, 'e', issues);
  assert.equal(issues[0].path, 'e.value');
});

test('add 的 value 必须是数字（字符串被拒）', () => {
  const issues = [];
  validateEffect({ path: 'stats.lin.trust', op: 'add', value: '+5' }, 'e', issues);
  assert.equal(issues[0].path, 'e.value');
  assert.match(issues[0].message, /必须是有限数字/);
});

test('NaN / Infinity 被拒（不是所有 number 都算合法数字）', () => {
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    const issues = [];
    validateEffect({ path: 'stats.lin.trust', op: 'add', value: bad }, 'e', issues);
    assert.equal(issues.length, 1, `${String(bad)} 应被拒`);
    assert.equal(issues[0].path, 'e.value');
  }
});

test('未知操作符被拒', () => {
  const issues = [];
  validateEffect({ path: 'a', op: '加减', value: 1 }, 'e', issues);
  assert.equal(issues[0].path, 'e.op');
});

test('toggle 无需 value', () => {
  const issues = [];
  validateEffect({ path: 'flags.x', op: 'toggle' }, 'e', issues);
  assert.deepEqual(issues, []);
});

test('clamp 需要合法区间', () => {
  const issues = [];
  validateEffect({ path: 'a', op: 'clamp', value: { min: 10, max: 5 } }, 'e', issues);
  assert.equal(issues[0].path, 'e.value');

  const okIssues = [];
  validateEffect({ path: 'a', op: 'clamp', value: { min: 0, max: 100 } }, 'e', okIssues);
  assert.deepEqual(okIssues, []);
});

/* ---------------------------------------------------------------- *
 * 角色与初始状态
 * ---------------------------------------------------------------- */

const actorDef = () => ({
  id: 'lin',
  name: '林晚晴',
  stats: [
    { key: 'trust', min: 0, max: 100, init: 30 },
    { key: 'stress', min: 0, max: 100, init: 70 },
  ],
});

test('createInitialState 按定义实例化数值', () => {
  const s = createInitialState({ actors: [actorDef()], clock: { day: 1, slot: 'night' }, where: 'entrance' });
  assert.equal(s.actors.lin.stats.trust, 30);
  assert.equal(s.actors.lin.stats.stress, 70);
  assert.equal(s.actors.lin.met, false);
  assert.equal(s.clock.slot, 'night');
  assert.equal(s.where, 'entrance');
  assert.deepEqual(s.clues, []);
  assert.deepEqual(s.endings, []);
});

test('init 越界被拒', () => {
  const bad = actorDef();
  bad.stats[0].init = 120;
  assert.throws(() => createInitialState({ actors: [bad] }), (e) => {
    assert.ok(e instanceof SchemaError);
    assert.ok(e.issues.some(i => i.path === 'actors[0].stats[0].init'));
    return true;
  });
});

test('min > max 被拒', () => {
  const bad = actorDef();
  bad.stats[0].min = 90;
  bad.stats[0].max = 10;
  bad.stats[0].init = 50;
  assert.throws(() => createInitialState({ actors: [bad] }), SchemaError);
});

test('数值 key 重复被拒', () => {
  const bad = actorDef();
  bad.stats[1].key = 'trust';
  assert.throws(() => createInitialState({ actors: [bad] }), SchemaError);
});

test('未知时段在初始状态层被拦', () => {
  assert.throws(() => createInitialState({ actors: [], clock: { day: 1, slot: 'noon' } }), (e) => {
    assert.ok(e.issues.some(i => i.path === 'clock.slot'));
    return true;
  });
});

/* ---------------------------------------------------------------- *
 * 错误形态
 * ---------------------------------------------------------------- */

test('SchemaError 携带结构化 issues 且消息含字段路径', () => {
  const ev = goodEvent();
  delete ev.title;
  ev.when = { day: 1, slot: 'noon' };
  try {
    assertEvent(ev);
    assert.fail('应当抛错');
  } catch (e) {
    assert.ok(e instanceof SchemaError);
    assert.ok(e.issues.length >= 2);
    assert.ok(e.issues.some(i => i.path === 'event.title'));
    assert.ok(e.issues.some(i => i.path === 'event.when.slot'));
    assert.match(e.message, /event\.title/);
  }
});

test('校验函数不修改传入数据', () => {
  const ev = goodEvent();
  const before = JSON.stringify(ev);
  validateEventOnly(ev);
  assert.equal(JSON.stringify(ev), before);
});
