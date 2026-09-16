import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  KIND,
  DEFAULT_STATS,
  detectKind,
  importWorldbook,
  importCharacterBook,
  importCharacterCard,
  importAny,
  decodeBase64Utf8,
  readPngCard,
  importPngCard,
} from '../src/importers.js';
import { scanWorldbook, createWorldbook } from '../src/worldbook.js';

/* ---------------------------------------------------------------- *
 * 真实格式的样例
 * ---------------------------------------------------------------- */

/** SillyTavern 独立世界书：entries 是对象，键是 uid */
const ST_WORLDBOOK = {
  name: '旧楼设定集',
  description: '测试用',
  scan_depth: 4,
  token_budget: 2048,
  recursive_scanning: true,
  extensions: { 'myext/flag': true },
  entries: {
    0: {
      uid: 0,
      key: ['配电箱', '电闸'],
      keysecondary: ['老陈'],
      comment: '配电箱位置',
      content: '配电箱在三楼楼梯口，箱门是虚掩的。',
      constant: false,
      selective: true,
      order: 100,
      position: 0,
      disable: false,
      probability: 100,
      depth: 4,
      scanDepth: null,
      caseSensitive: null,
    },
    1: {
      uid: 1,
      key: [],
      comment: '世界底色',
      content: '这是一栋建了三十多年的旧楼。',
      constant: true,
      order: 10,
      position: 1,
      disable: false,
    },
    2: {
      uid: 2,
      key: ['废弃'],
      comment: '关掉的条目',
      content: '这条被禁用了。',
      disable: true,
    },
  },
};

/** CharacterBook V2：entries 是数组 */
const V2_BOOK = {
  name: '内置设定',
  scan_depth: 2,
  token_budget: 500,
  recursive_scanning: false,
  extensions: {},
  entries: [
    {
      keys: ['天台', '铁门'],
      content: '天台的门是铁的，从来不锁。',
      enabled: true,
      insertion_order: 20,
      case_sensitive: false,
      name: '天台',
      priority: 5,
      id: 0,
      comment: '天台',
      selective: false,
      secondary_keys: [],
      constant: false,
      position: 'after_char',
      extensions: {},
    },
  ],
};

const CARD_V1 = {
  name: '林晚晴',
  description: '三十六岁，话少。',
  personality: '克制',
  scenario: '雨夜来投奔你。',
  first_mes: '她站在门口，没进来。',
  mes_example: '<START>\n{{user}}: 进来吧\n{{char}}: 她把伞收起来。',
};

const CARD_V2 = {
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: '周若宁',
    description: '十八岁，学生。',
    personality: '警觉',
    scenario: '跟着母亲来的。',
    first_mes: '她躲在母亲身后。',
    mes_example: '',
    creator_notes: '测试卡',
    system_prompt: '保持克制。',
    post_history_instructions: '不要跳时间。',
    alternate_greetings: ['她从楼梯上往下看。', '她抱着书包站在走廊里。'],
    character_book: V2_BOOK,
    tags: ['都市', '悬疑'],
    creator: 'someone',
    character_version: '1.2',
    extensions: { talkativeness: '0.5' },
    custom_field: '未识别的字段',
  },
};

/* ---------------------------------------------------------------- *
 * 识别
 * ---------------------------------------------------------------- */

test('识别角色卡 V1', () => {
  assert.equal(detectKind(CARD_V1), KIND.CHARACTER);
});

test('识别角色卡 V2（靠 data 字段）', () => {
  assert.equal(detectKind(CARD_V2), KIND.CHARACTER);
  assert.equal(detectKind({ spec: 'chara_card_v2', data: {} }), KIND.CHARACTER);
});

test('识别世界书', () => {
  assert.equal(detectKind(ST_WORLDBOOK), KIND.WORLDBOOK);
  assert.equal(detectKind({ entries: [] }), KIND.WORLDBOOK);
});

test('认不出来的东西如实说认不出来', () => {
  assert.equal(detectKind({ foo: 1 }), KIND.UNKNOWN);
  assert.equal(detectKind(null), KIND.UNKNOWN);
  const r = importAny({ foo: 1 });
  assert.equal(r.kind, KIND.UNKNOWN);
  assert.match(r.warnings[0], /认不出/);
});

/* ---------------------------------------------------------------- *
 * 世界书导入
 * ---------------------------------------------------------------- */

test('导入 SillyTavern 世界书：字段全部映射到位', () => {
  const { kind, entries, meta } = importWorldbook(ST_WORLDBOOK);
  assert.equal(kind, KIND.WORLDBOOK);
  assert.equal(meta.name, '旧楼设定集');
  assert.equal(meta.scanDepth, 4);
  assert.equal(meta.tokenBudget, 2048);
  assert.equal(meta.recursiveScanning, true);
  assert.deepEqual(meta.extensions, { 'myext/flag': true }, '认不出的扩展字段不能丢');

  const e0 = entries.find(e => e.id === '0');
  assert.deepEqual(e0.keys, ['配电箱', '电闸']);
  assert.deepEqual(e0.secondary, ['老陈']);
  assert.equal(e0.heading, '配电箱位置');
  assert.equal(e0.order, 100);
  assert.equal(e0.constant, false);
  assert.equal(e0.enabled, true);
  assert.equal(e0.position, 'before-char', 'position 0 应映射成 before-char');
});

test('constant 条目导入后仍是常驻', () => {
  const { entries } = importWorldbook(ST_WORLDBOOK);
  const c = entries.find(e => e.id === '1');
  assert.equal(c.constant, true);
  assert.equal(c.position, 'after-char', 'position 1 → after-char');
});

test('disable 的条目保留但标记为禁用，扫描时不参与', () => {
  const { entries } = importWorldbook(ST_WORLDBOOK);
  const disabled = entries.find(e => e.id === '2');

  assert.ok(disabled, '用户的数据不能在我们这里蒸发');
  assert.equal(disabled.enabled, false, '要标成禁用，而不是删掉');

  const book = createWorldbook(entries);
  const hit = scanWorldbook(book, { texts: ['废弃'] });
  assert.ok(!hit.entries.some(e => e.id === '2'), '扫描时不应参与');
});

test('导入结果可以直接交给引擎扫描', () => {
  const { entries } = importWorldbook(ST_WORLDBOOK);
  const book = { ...createWorldbook(entries), scanDepth: 4 };

  const hit = scanWorldbook(book, { texts: ['老陈提到配电箱'] });
  assert.ok(hit.entries.some(e => e.id === '0'));
  assert.ok(hit.entries.some(e => e.id === '1'), '常驻也在');
});

test('导入 CharacterBook（数组形式）', () => {
  const { entries } = importWorldbook(V2_BOOK);
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0].keys, ['天台', '铁门']);
  assert.equal(entries[0].order, 20, 'insertion_order → order');
  assert.equal(entries[0].position, 'after-char');
});

test('空正文的条目被跳过并给出警告', () => {
  const { entries, warnings } = importWorldbook({
    entries: [
      { uid: 0, key: ['x'], content: '有内容' },
      { uid: 1, key: ['y'], content: '   ' },
    ],
  });
  assert.equal(entries.length, 1);
  assert.ok(warnings.some(w => /没有正文/.test(w)));
});

test('entries 形状不对时如实报告', () => {
  const r = importWorldbook({ entries: 42 });
  assert.equal(r.entries.length, 0);
  assert.ok(r.warnings.length > 0);
});

test('importCharacterBook 就是世界书导入', () => {
  assert.equal(importCharacterBook(V2_BOOK).entries.length, 1);
});

/* ---------------------------------------------------------------- *
 * 角色卡导入
 * ---------------------------------------------------------------- */

test('导入角色卡 V1', () => {
  const r = importCharacterCard(CARD_V1);
  assert.equal(r.kind, KIND.CHARACTER);
  assert.equal(r.spec, 'v1');
  assert.equal(r.actor.name, '林晚晴');
  assert.equal(r.actor.adult, true);
  assert.deepEqual(r.actor.stats.map(s => s.key), DEFAULT_STATS.map(s => s.key));
  assert.deepEqual(r.greetings, ['她站在门口，没进来。']);
  assert.match(r.persona.description, /三十六岁/);
  assert.match(r.persona.example, /她把伞收起来/);
});

test('导入角色卡 V2：开场白与备用开场都带出来', () => {
  const r = importCharacterCard(CARD_V2);
  assert.equal(r.spec, 'v2');
  assert.equal(r.actor.name, '周若宁');
  assert.equal(r.greetings.length, 3);
  assert.equal(r.greetings[1], '她从楼梯上往下看。');
  assert.equal(r.systemPrompt, '保持克制。');
  assert.equal(r.postHistory, '不要跳时间。');
});

test('角色卡里嵌的世界书会被一并取出来', () => {
  const r = importCharacterCard(CARD_V2);
  assert.equal(r.book.length, 1);
  assert.deepEqual(r.book[0].keys, ['天台', '铁门']);
});

test('元数据完整保留', () => {
  const r = importCharacterCard(CARD_V2);
  assert.equal(r.meta.creator, 'someone');
  assert.equal(r.meta.version, '1.2');
  assert.deepEqual(r.meta.tags, ['都市', '悬疑']);
  assert.equal(r.meta.notes, '测试卡');
  assert.deepEqual(r.meta.extensions, { talkativeness: '0.5' });
});

test('未识别的字段原样保存在 meta.extra，不丢弃', () => {
  const r = importCharacterCard(CARD_V2);
  assert.equal(r.meta.extra.custom_field, '未识别的字段');
  assert.ok(r.warnings.some(w => /未识别的字段/.test(w)));
});

test('角色 id 由名字派生且可用于路径', () => {
  const r = importCharacterCard(CARD_V1);
  assert.match(r.actor.id, /^[a-z0-9\u4e00-\u9fff-]+$/);
  assert.ok(!r.actor.id.includes(' '));
});

test('缺 name 时用占位并给出警告', () => {
  const r = importCharacterCard({ description: '只有描述' });
  assert.equal(r.actor.name, '未命名');
  assert.ok(r.warnings.some(w => /name/.test(w)));
});

test('非对象输入不崩', () => {
  const r = importCharacterCard(null);
  assert.equal(r.actor, null);
  assert.ok(r.warnings.length > 0);
});

test('importAny 自动分流', () => {
  assert.equal(importAny(CARD_V2).spec, 'v2');
  assert.equal(importAny(ST_WORLDBOOK).kind, KIND.WORLDBOOK);
});

/* ---------------------------------------------------------------- *
 * PNG 角色卡
 * ---------------------------------------------------------------- */

function crc32Placeholder() {
  return new Uint8Array(4);   // 解析器不校验 CRC
}

function makeChunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  out.set(crc32Placeholder(), 8 + data.length);
  return out;
}

function utf8ToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** 造一个最小的、带 chara 块的 PNG */
function makePngCard(card) {
  const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const payload = new TextEncoder().encode(`chara\0${utf8ToBase64(JSON.stringify(card))}`);
  const textChunk = makeChunk('tEXt', payload);
  const iend = makeChunk('IEND', new Uint8Array(0));

  const out = new Uint8Array(sig.length + textChunk.length + iend.length);
  out.set(sig, 0);
  out.set(textChunk, sig.length);
  out.set(iend, sig.length + textChunk.length);
  return out;
}

test('decodeBase64Utf8 正确处理中文', () => {
  const b64 = utf8ToBase64('中文测试');
  assert.equal(decodeBase64Utf8(b64), '中文测试');
});

test('decodeBase64Utf8 容忍空白字符', () => {
  const b64 = utf8ToBase64('abc');
  assert.equal(decodeBase64Utf8(` ${b64}\n`), 'abc');
});

test('decodeBase64Utf8 对空内容抛错', () => {
  assert.throws(() => decodeBase64Utf8(''), /为空/);
});

test('从 PNG 里读出角色卡', () => {
  const png = makePngCard(CARD_V2);
  const card = readPngCard(png);
  assert.equal(card.spec, 'chara_card_v2');
  assert.equal(card.data.name, '周若宁');
});

test('PNG 一步导入成内部角色', () => {
  const r = importPngCard(makePngCard(CARD_V1));
  assert.equal(r.actor.name, '林晚晴');
  assert.equal(r.book.length, 0);
});

test('非 PNG 文件被明确拒绝', () => {
  assert.throws(() => readPngCard(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9])), /不是 PNG/);
  assert.throws(() => readPngCard(new Uint8Array([1, 2, 3])), /太小/);
});

test('没有 chara 块的 PNG 说清楚原因', () => {
  const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const other = makeChunk('tEXt', new TextEncoder().encode('software\0xx'));
  const iend = makeChunk('IEND', new Uint8Array(0));
  const png = new Uint8Array(sig.length + other.length + iend.length);
  png.set(sig, 0);
  png.set(other, sig.length);
  png.set(iend, sig.length + other.length);

  assert.throws(() => readPngCard(png), /没有角色卡数据/);
});

test('截断的 PNG 不崩，给出可读错误', () => {
  const png = makePngCard(CARD_V1).slice(0, 20);
  assert.throws(() => readPngCard(png), /没有角色卡数据|不是 PNG/);
});
