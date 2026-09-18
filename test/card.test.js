/**
 * 结构化正文渲染 —— 解析层测试。
 *
 * 渲染层（DOM）由冒烟覆盖；这里测**纯函数**的解析边界。
 * 核心纪律：**不认识的东西原样保留，绝不吞玩家的字**。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseCardMarkup,
  parseInline,
  hasCardMarkup,
  makeStatusCard,
  makeTruthMark,
  isTruthMarked,
  TRUTH_MARK,
  sampleCardMarkup,
} from '../src/card.js';

/* ---------------------------------------------------------------- *
 * 区块解析
 * ---------------------------------------------------------------- */

test('解析一个完整的 [状态栏] 区块', () => {
  const segs = parseCardMarkup('前面的话\n[状态栏]\n好感度 = 72\n疲惫 = 31\n[/状态栏]\n后面的话');
  assert.equal(segs.length, 3);
  assert.equal(segs[0].type, 'text');
  assert.equal(segs[0].text, '前面的话');
  assert.equal(segs[1].type, 'block');
  assert.equal(segs[1].kind, 'stats');
  assert.equal(segs[1].title, '状态栏');
  assert.deepEqual(segs[1].items, [
    { key: '好感度', value: '72' },
    { key: '疲惫', value: '31' },
  ]);
  assert.equal(segs[2].text, '后面的话');
});

test('全角等号与空格都认', () => {
  const segs = parseCardMarkup('[状态栏]\n好感度＝72\n疲惫 ＝ 31\n[/状态栏]');
  assert.deepEqual(segs[0].items, [
    { key: '好感度', value: '72' },
    { key: '疲惫', value: '31' },
  ]);
});

test('[物品栏] 走 list 组件', () => {
  const segs = parseCardMarkup('[物品栏]\n旧钥匙\n半张照片\n[/物品栏]');
  assert.equal(segs[0].kind, 'list');
  assert.deepEqual(segs[0].items, [
    { key: null, value: '旧钥匙' },
    { key: null, value: '半张照片' },
  ]);
});

test('流没闭合也不吞内容（宁可多显示）', () => {
  const segs = parseCardMarkup('[状态栏]\n好感度 = 72');
  assert.equal(segs.length, 1);
  assert.equal(segs[0].type, 'block');
  assert.equal(segs[0].items.length, 1, '未闭合也要把已读到的项留下');
});

test('不认识的名字当普通文本，不做渲染', () => {
  /* 「[注意]」不在组件集里 —— 必须原样留在正文，不能被吃掉 */
  const segs = parseCardMarkup('[注意]\n这里有陷阱\n[/注意]');
  assert.equal(segs.length, 1);
  assert.equal(segs[0].type, 'text');
  assert.match(segs[0].text, /\[注意\]/);
  assert.match(segs[0].text, /这里有陷阱/);
});

test('行内出现的方括号不算区块开始', () => {
  /* 「他说[明天]见」里的 [明天] 不在行首，且不在组件集里 */
  const segs = parseCardMarkup('他说[明天]见。');
  assert.equal(segs.length, 1);
  assert.equal(segs[0].type, 'text');
});

test('组件集里的名字在行内也不当区块（必须独占一行）', () => {
  const segs = parseCardMarkup('他提到了[状态栏]这个词');
  assert.equal(segs.length, 1);
  assert.equal(segs[0].type, 'text', '不独占一行就不该开区块');
});

test('空文本返回空数组', () => {
  assert.deepEqual(parseCardMarkup(''), []);
  assert.deepEqual(parseCardMarkup('   \n  '), []);
});

test('纯正文不受影响（没有标记时只有一段 text）', () => {
  const segs = parseCardMarkup('雨还在下。\n他把伞递了过来。');
  assert.equal(segs.length, 1);
  assert.equal(segs[0].type, 'text');
});

test('两个区块连着出现', () => {
  const segs = parseCardMarkup('[状态栏]\n好感 = 1\n[/状态栏]\n[物品栏]\n钥匙\n[/物品栏]');
  assert.equal(segs.length, 2);
  assert.equal(segs[0].kind, 'stats');
  assert.equal(segs[1].kind, 'list');
});

/* ---------------------------------------------------------------- *
 * 行内标记
 * ---------------------------------------------------------------- */

test('行内 [签:…] 解析成标签', () => {
  const parts = parseInline('他有点[签:紧张]地看着你');
  assert.deepEqual(parts, [
    { type: 'text', text: '他有点' },
    { type: 'tag', text: '紧张', truth: false },
    { type: 'text', text: '地看着你' },
  ]);
});

test('行内 [条:键|当前|上限] 解析成进度条', () => {
  const parts = parseInline('[条:好感度|72|100]');
  assert.equal(parts.length, 1);
  assert.deepEqual(parts[0], { type: 'bar', key: '好感度', value: 72, max: 100, truth: false });
});

test('不认识的行内前缀原样保留 —— 绝不吞字', () => {
  const parts = parseInline('看这个[链接:http://x]和这个[注:说明]');
  const joined = parts.map(p => (p.type === 'text' ? p.text : `[${p.type}]`)).join('');
  assert.match(joined, /\[链接:http:\/\/x\]/);
  assert.match(joined, /\[注:说明\]/);
});

test('纯文本走 parseInline 只出一段', () => {
  const parts = parseInline('没有标记的一句话');
  assert.equal(parts.length, 1);
  assert.equal(parts[0].type, 'text');
  assert.equal(parts[0].text, '没有标记的一句话');
});

/* ---------------------------------------------------------------- *
 * 快速判定
 * ---------------------------------------------------------------- */

test('hasCardMarkup 只认组件集里的区块', () => {
  assert.equal(hasCardMarkup('[状态栏]\n好感 = 1\n[/状态栏]'), true);
  assert.equal(hasCardMarkup('[物品栏]\n钥匙\n[/物品栏]'), true);
  assert.equal(hasCardMarkup('[注意]\n陷阱\n[/注意]'), false, '不在组件集里');
  assert.equal(hasCardMarkup('普通正文，没有标记'), false);
  assert.equal(hasCardMarkup('他说[状态栏]这个词'), false, '不独占一行');
});

test('hasCardMarkup 认行内标记，且不残留 lastIndex 状态', () => {
  assert.equal(hasCardMarkup('有点[签:紧张]'), true);
  /* 连续调用两次结果必须一致 —— 带 g 的正则 lastIndex 会残留 */
  assert.equal(hasCardMarkup('有点[签:紧张]'), true);
  assert.equal(hasCardMarkup('没有标记'), false);
  assert.equal(hasCardMarkup('有点[签:紧张]'), true);
});

/* ---------------------------------------------------------------- *
 * 真值标记 —— 「引擎说的」与「模型说的」得能分开
 * ---------------------------------------------------------------- */

test('真值标记：盖章 / 判章 / 幂等', () => {
  assert.equal(makeTruthMark(72), `72 ${TRUTH_MARK}`);
  assert.equal(makeTruthMark(`72 ${TRUTH_MARK}`), `72 ${TRUTH_MARK}`, '盖两次不该变成 72 ✓ ✓');
  assert.equal(isTruthMarked(`72 ${TRUTH_MARK}`), true);
  assert.equal(isTruthMarked('72'), false);
  assert.equal(isTruthMarked(null), false);
  assert.equal(isTruthMarked(undefined), false);
});

test('真值标记：行内 [条:…] 后面跟 ✓ 才算真值', () => {
  const plain = parseInline('[条:好感度|72|100]');
  const marked = parseInline(`[条:好感度|72|100] ${TRUTH_MARK}`);
  assert.equal(plain[0].truth, false);
  assert.equal(marked[0].truth, true);
  assert.equal(marked.length, 1, '✓ 不该被当成多余的尾巴留下来');
});

test('真值标记：行内 [签:…] 同理', () => {
  assert.equal(parseInline(`[签:门缝里的光] ${TRUTH_MARK}`)[0].truth, true);
  assert.equal(parseInline('[签:门缝里的光]')[0].truth, false);
});

test('真值标记不干扰原文里的普通方括号', () => {
  const parts = parseInline('他写下 [1,2,3] 三个数');
  assert.equal(parts.length, 1);
  assert.equal(parts[0].text, '他写下 [1,2,3] 三个数');
});

/* ---------------------------------------------------------------- *
 * 状态卡 —— 引擎产出卡片标记（不是等模型自发输出）
 * ---------------------------------------------------------------- */

const WORLD = {
  actorLabels: { lin: '林晚' },
  placeLabels: { home: '自己的住处' },
  slotLabels: { night: '深夜' },
  statLabels: { lin: { trust: '信任' } },
};
const STATE = {
  clock: { day: 3, slot: 'night' },
  where: 'home',
  actors: {
    lin: {
      id: 'lin', name: '林晚', met: true,
      stats: { trust: 72 },
      bounds: { trust: { min: 0, max: 100 } },
    },
  },
  clues: ['c1'],
};
const VIEW = {
  clock: { day: 3, slot: 'night', label: '深夜' },
  where: 'home',
  actors: [{ id: 'lin', name: '林晚', met: true, stats: [{ key: 'trust', value: 72, min: 0, max: 100 }] }],
  clues: ['c1'],
  achievements: [],
  endings: [],
};
const IO = { labelOf: (p) => p, valueOf: (p, v) => String(v) };

test('状态卡：产出的是渲染层认得的标记，不是 HTML', () => {
  const text = makeStatusCard({
    changes: [{ path: 'actors.lin.stats.trust', op: 'add', from: 62, to: 72, value: 10 }],
    state: STATE, view: VIEW, world: WORLD, ...IO,
  });
  assert.equal(hasCardMarkup(text), true, '渲染层必须能认出它');
  const segs = parseCardMarkup(text);
  assert.equal(segs.length, 1);
  assert.equal(segs[0].type, 'block');
  assert.equal(segs[0].kind, 'stats');
  assert.equal(segs[0].title, '状态栏');
  assert.doesNotMatch(text, /</, '卡片标记里不许出现尖括号');
});

test('状态卡：数值行是引擎真值，带真值标记', () => {
  const text = makeStatusCard({
    changes: [{ path: 'actors.lin.stats.trust', op: 'add', from: 62, to: 72, value: 10 }],
    state: STATE, view: VIEW, world: WORLD, ...IO,
  });
  assert.match(text, /林晚·信任 = 72 \/ 100 ✓/);
});

test('状态卡：默认只写本轮变化过的字段，不每轮刷全量', () => {
  const one = makeStatusCard({
    changes: [{ path: 'actors.lin.stats.trust', op: 'add', from: 62, to: 72, value: 10 }],
    state: STATE, view: VIEW, world: WORLD, ...IO,
  });
  // 只动 trust，没动别的数值 —— 卡片里不该出现没动过的键
  const items = parseCardMarkup(one)[0].items;
  const statRows = items.filter(i => i.key && i.key.includes('·'));
  assert.equal(statRows.length, 1);
});

test('状态卡：同一字段一轮内被改多次只报一次', () => {
  const text = makeStatusCard({
    changes: [
      { path: 'actors.lin.stats.trust', op: 'add', from: 62, to: 67, value: 5 },
      { path: 'actors.lin.stats.trust', op: 'add', from: 67, to: 72, value: 5 },
    ],
    state: STATE, view: VIEW, world: WORLD, ...IO,
  });
  const hits = [...text.matchAll(/林晚·信任/g)];
  assert.equal(hits.length, 1, '重复报同一条会让卡片被刷屏');
});

test('状态卡：history 与 routes 这类内部路径不进卡片', () => {
  const text = makeStatusCard({
    changes: [
      { path: 'history', op: 'push', value: {} },
      { path: 'routes.X', op: 'set', from: 'closed', to: 'open' },
    ],
    state: STATE, view: VIEW, world: WORLD, ...IO,
  });
  assert.doesNotMatch(text, /history/);
  assert.doesNotMatch(text, /routes/);
});

test('状态卡：时间与地点永远带上 —— 那是玩家最常看的两项', () => {
  const text = makeStatusCard({ changes: [], state: STATE, view: VIEW, world: WORLD, ...IO });
  assert.match(text, /第 3 天 · 深夜/);
  assert.match(text, /自己的住处/);
});

test('状态卡：全量模式列出所有已见过角色的数值', () => {
  const text = makeStatusCard({ full: true, state: STATE, view: VIEW, world: WORLD, ...IO });
  assert.match(text, /林晚·信任 = 72 \/ 100 ✓/);
});

test('状态卡：没有可写内容时返回空串，不产出空壳卡片', () => {
  const text = makeStatusCard({ changes: [], world: WORLD, ...IO });
  assert.equal(text, '', '无信息时不该吐一个空 [状态栏] 出来');
});

test('真值标记必须落在值的最末尾 —— 分数形式也一样', () => {
  /* 踩过的坑：写 `72 ✓ / 100`（标记在中间）时 isTruthMarked 判不出来，
     因为判定只看结尾。于是"引擎真值"与"模型自填"在渲染层长得一样，
     标记白做。这条测试就是钉住"标记永远在末尾"。 */
  const text = makeStatusCard({
    changes: [{ path: 'actors.lin.stats.trust', op: 'add', from: 62, to: 72, value: 10 }],
    state: STATE, view: VIEW, world: WORLD, ...IO,
  });
  const items = parseCardMarkup(text)[0].items;
  const statItem = items.find(i => i.key === '林晚·信任');
  assert.ok(statItem, '应有一行林晚·信任');
  assert.equal(isTruthMarked(statItem.value), true,
    '真值标记必须在末尾，实际 ' + JSON.stringify(statItem.value));
  assert.equal(statItem.value.endsWith(' ' + TRUTH_MARK), true);
});

test('参考块的示例也带真值标记 —— 否则玩家照着抄就做不出标记', () => {
  const items = parseCardMarkup(sampleCardMarkup())[0].items;
  const marked = items.filter(i => isTruthMarked(i.value));
  assert.equal(marked.length, 2, '示例里应有 2 条带真值，实际 ' + JSON.stringify(items));
  const plain = items.find(i => i.key === '模型自填的天气');
  assert.ok(plain);
  assert.equal(isTruthMarked(plain.value), false, '模型自填的那条不该有标记');
});
