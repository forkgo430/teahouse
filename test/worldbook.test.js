import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SECONDARY_LOGIC,
  POSITIONS,
  estimateTokens,
  normalizeEntry,
  validateWorldbook,
  createWorldbook,
  updateEntry,
  removeEntry,
  scanWorldbook,
  renderWorldbook,
} from '../src/worldbook.js';

/* ---------------------------------------------------------------- *
 * 夹具
 * ---------------------------------------------------------------- */

const E = (over = {}) => ({
  id: 'W1',
  keys: ['配电箱'],
  content: '配电箱在三楼楼梯口。',
  ...over,
});

const book = (...entries) => createWorldbook(entries);

/** 固定随机源：让概率测试可复现 */
const seq = (...values) => {
  let i = 0;
  return () => values[i++ % values.length];
};

/* ---------------------------------------------------------------- *
 * 归一化
 * ---------------------------------------------------------------- */

test('normalizeEntry 补齐默认值', () => {
  const e = normalizeEntry({ id: 'a', keys: ['x'], content: 'y' });
  assert.equal(e.constant, false);
  assert.equal(e.order, 100);
  assert.equal(e.probability, 100);
  assert.equal(e.position, 'at-depth');
  assert.equal(e.enabled, true);
  assert.equal(e.recursive, true);
});

test('归一化接受社区的各种字段名', () => {
  const st = normalizeEntry({ uid: 7, key: '甲,乙', keysecondary: '丙', comment: '标题', content: '正文', disable: true, order: 30 });
  assert.equal(st.id, '7');
  assert.deepEqual(st.keys, ['甲', '乙']);
  assert.deepEqual(st.secondary, ['丙']);
  assert.equal(st.heading, '标题');
  assert.equal(st.enabled, false);
  assert.equal(st.order, 30);

  const v2 = normalizeEntry({ id: 3, keys: ['甲'], secondary_keys: ['乙'], name: '名', content: '正文', insertion_order: 5 });
  assert.equal(v2.id, '3');
  assert.deepEqual(v2.secondary, ['乙']);
  assert.equal(v2.heading, '名');
  assert.equal(v2.order, 5);
});

test('normalizeEntry 对空字符串触发词不当作关键词', () => {
  const e = normalizeEntry({ id: 'a', keys: ['', '  ', '有效'], content: 'x' });
  assert.deepEqual(e.keys, ['有效']);
});

/* ---------------------------------------------------------------- *
 * 校验
 * ---------------------------------------------------------------- */

test('非常驻条目没有触发词直接报错（否则永远不会被注入）', () => {
  assert.throws(() => book(E({ keys: [] })), (e) => {
    assert.equal(e.name, 'WorldbookError');
    assert.ok(e.issues.some(i => /触发词/.test(i.message)));
    return true;
  });
});

test('常驻条目不需要触发词', () => {
  const b = book(E({ keys: [], constant: true }));
  assert.equal(b.entries.length, 1);
});

test('缺 content 被拒', () => {
  assert.throws(() => book(E({ content: '' })), /世界书校验失败/);
});

test('重复 id 被拒', () => {
  const { ok, issues } = validateWorldbook([
    normalizeEntry({ id: 'same', keys: ['a'], content: '1' }),
    normalizeEntry({ id: 'same', keys: ['b'], content: '2' }),
  ]);
  assert.equal(ok, false);
  assert.ok(issues.some(i => /重复/.test(i.message)));
});

test('非法副键逻辑与位置被拒', () => {
  const { ok, issues } = validateWorldbook([
    normalizeEntry({ id: 'a', keys: ['x'], content: 'y', secondaryLogic: '乱写', position: '乱写' }),
  ]);
  assert.equal(ok, false);
  assert.ok(issues.some(i => i.path.endsWith('.secondaryLogic')));
  assert.ok(issues.some(i => i.path.endsWith('.position')));
  assert.deepEqual(SECONDARY_LOGIC.length, 4);
  assert.ok(POSITIONS.includes('at-depth'));
});

/* ---------------------------------------------------------------- *
 * 触发
 * ---------------------------------------------------------------- */

test('关键词命中才注入', () => {
  const b = book(E({ keys: ['配电箱', '检修'] }), E({ id: 'W2', keys: ['天台'], content: '天台的门是铁的。' }));

  const hit = scanWorldbook(b, { texts: ['我打开了配电箱'] });
  assert.deepEqual(hit.fired ?? hit.entries.map(e => e.id), ['W1']);

  const none = scanWorldbook(b, { texts: ['今天天气不错'] });
  assert.equal(none.entries.length, 0);
});

test('大小写不敏感，可用 caseSensitive 关掉', () => {
  const b = book(E({ keys: ['Door'] }));
  assert.equal(scanWorldbook(b, { texts: ['OPEN THE DOOR'] }).entries.length, 1);

  const strict = book(E({ keys: ['Door'], caseSensitive: true }));
  assert.equal(scanWorldbook(strict, { texts: ['open the door'] }).entries.length, 0);
  assert.equal(scanWorldbook(strict, { texts: ['open the Door'] }).entries.length, 1);
});

test('匹配全词模式不会命中词内片段', () => {
  const b = book(E({ keys: ['cat'], matchWholeWords: true }));
  assert.equal(scanWorldbook(b, { texts: ['concatenate'] }).entries.length, 0);
  assert.equal(scanWorldbook(b, { texts: ['a cat sits'] }).entries.length, 1);
});

test('常驻条目无条件注入', () => {
  const b = book(E({ id: 'W1', keys: [], constant: true, content: '常驻设定' }));
  assert.equal(scanWorldbook(b, { texts: ['毫不相关'] }).entries.length, 1);
});

test('disabled 条目不参与', () => {
  const b = book(E({ enabled: false }));
  assert.equal(scanWorldbook(b, { texts: ['配电箱'] }).entries.length, 0);
});

test('状态对象也参与匹配', () => {
  const b = book(E({ keys: ['C03'] }));
  const hit = scanWorldbook(b, { texts: [], state: { clues: ['C03'] } });
  assert.equal(hit.entries.length, 1);
});

/* ---------------------------------------------------------------- *
 * 副键四套逻辑
 * ---------------------------------------------------------------- */

test('and-any：主键 + 任一副键', () => {
  const b = book(E({ keys: ['老陈'], secondary: ['配电箱', '天台'], secondaryLogic: 'and-any' }));
  assert.equal(scanWorldbook(b, { texts: ['老陈提到配电箱'] }).entries.length, 1);
  assert.equal(scanWorldbook(b, { texts: ['老陈只是路过'] }).entries.length, 0);
});

test('and-all：主键 + 全部副键', () => {
  const b = book(E({ keys: ['老陈'], secondary: ['配电箱', '天台'], secondaryLogic: 'and-all' }));
  assert.equal(scanWorldbook(b, { texts: ['老陈说配电箱，又说天台'] }).entries.length, 1);
  assert.equal(scanWorldbook(b, { texts: ['老陈说配电箱'] }).entries.length, 0);
});

test('not-any：主键命中但副键都不能出现', () => {
  const b = book(E({ keys: ['老陈'], secondary: ['配电箱'], secondaryLogic: 'not-any' }));
  assert.equal(scanWorldbook(b, { texts: ['老陈在楼下'] }).entries.length, 1);
  assert.equal(scanWorldbook(b, { texts: ['老陈在配电箱旁边'] }).entries.length, 0);
});

test('not-all：副键不全出现时才注入', () => {
  const b = book(E({ keys: ['老陈'], secondary: ['甲', '乙'], secondaryLogic: 'not-all' }));
  assert.equal(scanWorldbook(b, { texts: ['老陈说甲'] }).entries.length, 1);
  assert.equal(scanWorldbook(b, { texts: ['老陈说甲和乙'] }).entries.length, 0);
});

/* ---------------------------------------------------------------- *
 * 概率
 * ---------------------------------------------------------------- */

test('probability=0 永不注入，=100 永远注入', () => {
  const never = book(E({ id: 'W1', keys: ['甲'], content: 'x', probability: 0 }));
  assert.equal(scanWorldbook(never, { texts: ['甲'] }).entries.length, 0);

  const always = book(E({ id: 'W1', keys: ['甲'], content: 'x', probability: 100 }));
  assert.equal(scanWorldbook(always, { texts: ['甲'] }).entries.length, 1);
});

test('概率走注入的随机源，结果可控', () => {
  const b = book(E({ id: 'W1', keys: ['甲'], content: 'x', probability: 50 }));

  // rng() 返回 0.1 → 10 < 50 → 注入
  assert.equal(scanWorldbook(b, { texts: ['甲'], rng: seq(0.1) }).entries.length, 1);
  // rng() 返回 0.9 → 90 > 50 → 跳过，并记录原因
  const miss = scanWorldbook(b, { texts: ['甲'], rng: seq(0.9) });
  assert.equal(miss.entries.length, 0);
  assert.deepEqual(miss.skipped, [{ id: 'W1', reason: 'probability' }]);
});

test('常驻条目不受概率影响', () => {
  const b = book(E({ id: 'W1', keys: [], constant: true, content: 'x', probability: 0 }));
  assert.equal(scanWorldbook(b, { texts: [] }).entries.length, 1);
});

/* ---------------------------------------------------------------- *
 * 递归
 * ---------------------------------------------------------------- */

test('条目内容里的触发词会带出别的条目', () => {
  const b = book(
    E({ id: 'W1', keys: ['配电箱'], content: '配电箱旁边贴着老陈写得检修单。' }),
    E({ id: 'W2', keys: ['老陈'], content: '老陈是管理员。' }),
  );
  const hit = scanWorldbook(b, { texts: ['配电箱'] });
  assert.deepEqual(hit.direct, ['W1']);
  assert.deepEqual(hit.recursed, ['W2']);
});

test('recursive:false 的条目不参与带出别人', () => {
  const b = book(
    E({ id: 'W1', keys: ['配电箱'], content: '配电箱旁边是老陈。', recursive: false }),
    E({ id: 'W2', keys: ['老陈'], content: '老陈是管理员。' }),
  );
  assert.deepEqual(scanWorldbook(b, { texts: ['配电箱'] }).entries.map(e => e.id), ['W1']);
});

test('递归可以整体关掉', () => {
  const b = book(
    E({ id: 'W1', keys: ['甲'], content: '这里提到了乙。' }),
    E({ id: 'W2', keys: ['乙'], content: '乙的设定。' }),
  );
  assert.equal(scanWorldbook(b, { texts: ['甲'], recursive: false }).entries.length, 1);
});

test('直接命中的优先级高于递归命中（输出里能区分）', () => {
  const b = book(
    E({ id: 'W1', keys: ['甲'], content: '提到乙' }),
    E({ id: 'W2', keys: ['乙'], content: '乙' }),
  );
  const hit = scanWorldbook(b, { texts: ['甲与乙都在'] });
  assert.deepEqual(hit.direct, ['W1', 'W2']);
  assert.deepEqual(hit.recursed, []);
});

/* ---------------------------------------------------------------- *
 * 扫描深度
 * ---------------------------------------------------------------- */

test('scanDepth 只扫最近几条', () => {
  const b = { ...book(E({ keys: ['甲'] })), scanDepth: 1 };
  assert.equal(scanWorldbook(b, { texts: ['甲', '无关', '无关'] }).entries.length, 0, '只扫最后一条');
  assert.equal(scanWorldbook(b, { texts: ['无关', '无关', '甲'] }).entries.length, 1);
});

test('条目级 scanDepth 可覆盖全局', () => {
  const b = { ...book(E({ keys: ['甲'], scanDepth: 5 })), scanDepth: 1 };
  assert.equal(scanWorldbook(b, { texts: ['甲', '无关', '无关'] }).entries.length, 1);
});

/* ---------------------------------------------------------------- *
 * 预算与顺序
 * ---------------------------------------------------------------- */

test('order 小的排在前面', () => {
  const b = book(
    E({ id: 'W1', keys: ['甲'], content: '后', order: 200 }),
    E({ id: 'W2', keys: ['甲'], content: '前', order: 10 }),
  );
  assert.deepEqual(scanWorldbook(b, { texts: ['甲'] }).entries.map(e => e.id), ['W2', 'W1']);
});

test('超预算时先保常驻，再保 order 大的', () => {
  const b = book(
    E({ id: 'A', keys: [], constant: true, content: '字'.repeat(50), order: 999 }),
    E({ id: 'B', keys: ['甲'], content: '字'.repeat(50), order: 500 }),
    E({ id: 'C', keys: ['甲'], content: '字'.repeat(50), order: 1 }),
  );
  const hit = scanWorldbook(b, { texts: ['甲'], budget: 120 });

  const ids = hit.entries.map(e => e.id);
  assert.ok(ids.includes('A'), '常驻必须保住');
  assert.ok(ids.includes('B'), 'order 大的其次');
  assert.ok(!ids.includes('C'), 'order 小的先被丢');
  assert.equal(hit.dropped.length, 1);
  assert.equal(hit.dropped[0].id, 'C');
  assert.equal(hit.dropped[0].reason, '超出预算');
});

test('预算充足时全部注入', () => {
  const b = book(E({ id: 'W1', keys: ['甲'], content: '短' }), E({ id: 'W2', keys: ['甲'], content: '短' }));
  const hit = scanWorldbook(b, { texts: ['甲'], budget: 1000 });
  assert.equal(hit.entries.length, 2);
  assert.equal(hit.dropped.length, 0);
  assert.ok(hit.tokens > 0);
});

test('tokens 字段可显式指定，不必估算', () => {
  const b = book(E({ id: 'W1', keys: ['甲'], content: '很长的内容'.repeat(20), tokens: 7 }));
  assert.equal(scanWorldbook(b, { texts: ['甲'], budget: 10 }).tokens, 7);
});

/* ---------------------------------------------------------------- *
 * 确定性
 * ---------------------------------------------------------------- */

test('同一输入重复扫描，顺序与结果完全一致', () => {
  const b = book(
    E({ id: 'W1', keys: ['甲', '乙'], content: '一', order: 20 }),
    E({ id: 'W2', keys: ['乙'], content: '二', order: 20 }),
    E({ id: 'W3', keys: ['丙'], content: '三', order: 5 }),
  );
  const runs = new Set();
  for (let i = 0; i < 20; i++) {
    runs.add(scanWorldbook(b, { texts: ['甲和乙还有丙'] }).entries.map(e => e.id).join(','));
  }
  assert.equal(runs.size, 1);
});

test('扫描不修改世界书本身', () => {
  const b = book(E({ id: 'W1', keys: ['甲'], content: 'x' }));
  const before = JSON.stringify(b);
  scanWorldbook(b, { texts: ['甲'] });
  assert.equal(JSON.stringify(b), before);
});

/* ---------------------------------------------------------------- *
 * 渲染与估算
 * ---------------------------------------------------------------- */

test('renderWorldbook 带上标题', () => {
  const entries = [normalizeEntry({ id: 'a', heading: '配电箱', keys: ['x'], content: '正文' })];
  assert.equal(renderWorldbook(entries), '【配电箱】\n正文');
});

test('renderWorldbook 可挂宏替换', () => {
  const entries = [normalizeEntry({ id: 'a', keys: ['x'], content: '你好 {{name}}' })];
  assert.equal(renderWorldbook(entries, t => t.replace('{{name}}', '陈')), '你好 陈');
});

test('renderWorldbook 对空列表返回空串', () => {
  assert.equal(renderWorldbook([]), '');
  assert.equal(renderWorldbook(null), '');
});

test('estimateTokens 对中文按字估算', () => {
  assert.equal(estimateTokens('你好世界'), 4);
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens(null), 0);
  assert.ok(estimateTokens('hello world') < 5);
  assert.ok(estimateTokens('中'.repeat(100)) === 100);
});

/* ---------------------------------------------------------------- *
 * 就地改 / 删一条（书架上的编辑面板走这条路）
 * ---------------------------------------------------------------- */

test('改一条时，界面上没露出来的字段必须原样留着', () => {
  const raw = [{
    id: 'L1', heading: '旧标题', keys: ['伞'],
    content: '旧内容',
    // 这几个字段界面上没有，但都是从导入带进来的，不能被编辑抹掉
    depth: 6, position: 'at-depth', scanDepth: 3, recursive: false, order: 42,
  }];
  const before = createWorldbook(raw).entries[0];
  assert.equal(before.depth, 6);

  const next = updateEntry(raw, 'L1', {
    heading: '新标题', keys: ['伞', '雨'], content: '新内容', constant: false,
  });
  const after = createWorldbook(next).entries[0];

  assert.equal(after.heading, '新标题');
  assert.deepEqual(after.keys, ['伞', '雨']);
  assert.equal(after.content, '新内容');

  // 没被 patch 的字段一个都不能变
  assert.equal(after.depth, 6, 'depth 被抹掉了');
  assert.equal(after.position, 'at-depth', 'position 被抹掉了');
  assert.equal(after.scanDepth, 3, 'scanDepth 被抹掉了');
  assert.equal(after.recursive, false, 'recursive 被抹掉了');
  assert.equal(after.order, 42, 'order 被抹掉了');
});

test('改条目不能把 id 改掉（id 是定位用的）', () => {
  const next = updateEntry([{ id: 'L1', content: 'x' }], 'L1', { id: 'L9', content: 'y' });
  assert.equal(next[0].id, 'L1');
  assert.equal(next[0].content, 'y');
});

test('改一条只影响那一条', () => {
  const raw = [
    { id: 'L1', content: 'A' },
    { id: 'L2', content: 'B' },
  ];
  const next = updateEntry(raw, 'L1', { content: 'A2' });
  assert.deepEqual(next.map(e => e.content), ['A2', 'B']);
  assert.equal(raw[0].content, 'A', '原数组不该被改动');
});

test('删一条只少那一条', () => {
  const raw = [{ id: 'L1' }, { id: 'L2' }, { id: 'L3' }];
  assert.deepEqual(removeEntry(raw, 'L2').map(e => e.id), ['L1', 'L3']);
  assert.equal(raw.length, 3, '原数组不该被改动');
});

test('关键词清空时自动常驻 —— 否则这条永远等不到触发', () => {
  const raw = [{ id: 'L1', heading: 'H', keys: ['a'], content: '内容' }];
  // 界面上把关键词删光、就自动勾上常驻（ui/app.js 的那条 constant 规则）
  const next = updateEntry(raw, 'L1', { keys: [], content: '内容', constant: true });
  const book = createWorldbook(next);
  assert.equal(book.entries[0].constant, true);
});

test('内容清空会被校验挡住 —— 空条目不该悄悄存进去', () => {
  const raw = [{ id: 'L1', heading: 'H', keys: ['a'], content: '内容' }];
  const next = updateEntry(raw, 'L1', { content: '' });
  assert.throws(() => createWorldbook(next), /必须有 content/);
});
