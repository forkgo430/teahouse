/**
 * 茶馆小二 —— 桥的宿主侧测试。
 *
 * 这里测的是**纯函数**：开关归一化、路径白名单、取值校验、请求→effect 翻译、
 * 快照裁剪。iframe 侧的注入脚本与真实 postMessage 由冒烟覆盖。
 *
 * 纪律：**拒绝必须给出原因**，不能返回一个无声的 false。
 * 脚本作者看到的原因就是这里返回的字符串。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_BOY,
  BOY_MODES,
  BOY_EVENTS,
  BoyError,
  normalizeBoyConfig,
  writablePath,
  isLiteral,
  checkValue,
  requestToEffect,
  readPath,
  snapshotFor,
  isBoyEvent,
  createBoy,
  WRITABLE,
} from '../src/boy.js';

/* ---------------------------------------------------------------- *
 * 开关
 * ---------------------------------------------------------------- */

test('默认一档都不开', () => {
  const c = normalizeBoyConfig();
  assert.equal(c.enabled, false);
  assert.equal(c.mode, 'readonly');
  assert.equal(c.strict, true);
  assert.deepEqual(c, { ...DEFAULT_BOY });
});

test('认不出的档位退回默认，不静默放行', () => {
  const c = normalizeBoyConfig({ enabled: 'yes', mode: 'admin', strict: 'nope' });
  assert.equal(c.enabled, false, '字符串 "yes" 不是 true');
  assert.equal(c.mode, 'readonly', '不认识的档位退回只读');
  assert.equal(c.strict, true, 'strict 只有显式 false 才松');
});

test('strict 漏填时按锁着处理', () => {
  assert.equal(normalizeBoyConfig({ enabled: true, mode: 'write' }).strict, true);
  assert.equal(normalizeBoyConfig({ strict: false }).strict, false);
});

test('档位只有两档', () => {
  assert.deepEqual([...BOY_MODES], ['readonly', 'write']);
});

/* ---------------------------------------------------------------- *
 * 路径白名单
 * ---------------------------------------------------------------- */

test('声明表里的路径放行，且能认出通配段', () => {
  const hit = writablePath('actors.linwan.stats.信任', { strict: false });
  assert.equal(hit.ok, true);
  assert.equal(hit.spec, 'actors.*.stats.*');
});

test('声明表外的路径一律拒绝，并报出可写的清单', () => {
  const hit = writablePath('world.id', { strict: false });
  assert.equal(hit.ok, false);
  assert.match(hit.reason, /不认识这个路径/);
  assert.match(hit.reason, /actors\.\*\.stats\.\*/);
});

test('通配段必须非空 —— 不接受空段', () => {
  assert.equal(writablePath('actors..stats.信任').ok, false);
  assert.equal(writablePath('actors.linwan.stats.').ok, false);
});

test('路径写法不合法时直接拒', () => {
  assert.equal(writablePath('').ok, false);
  assert.equal(writablePath('.a.b').ok, false);
  assert.equal(writablePath('a..b').ok, false);
  assert.equal(writablePath(null).ok, false);
  assert.equal(writablePath('a.b.').ok, false);
});

test('flags.* 是 strictOnly：锁着不给，松了才给', () => {
  const locked = writablePath('flags.tmp', { strict: true });
  assert.equal(locked.ok, false);
  assert.match(locked.reason, /硬约束开着/);

  const loose = writablePath('flags.tmp', { strict: false });
  assert.equal(loose.ok, true);
  assert.equal(loose.rule.kind, 'any');
});

test('路径长度必须逐段对齐 —— 多一段少一段都不算命中', () => {
  assert.equal(writablePath('actors.linwan.stats').ok, false);
  assert.equal(writablePath('actors.linwan.stats.a.b').ok, false);
  assert.equal(writablePath('actors.linwan.stats.a').ok, true);
});

/* ---------------------------------------------------------------- *
 * 取值校验
 * ---------------------------------------------------------------- */

test('字面值只有三种：有限数字 / 布尔 / 文本', () => {
  assert.equal(isLiteral(1), true);
  assert.equal(isLiteral(0), true);
  assert.equal(isLiteral(false), true);
  assert.equal(isLiteral(''), true);
  assert.equal(isLiteral(NaN), false, 'NaN 不是字面值');
  assert.equal(isLiteral(Infinity), false);
  assert.equal(isLiteral(null), false);
  assert.equal(isLiteral(undefined), false);
  assert.equal(isLiteral([]), false);
  assert.equal(isLiteral({}), false);
});

test('硬约束开着时拒绝一切非字面值，且说明收到的是什么', () => {
  const r = checkValue({ kind: 'any' }, { a: 1 }, { strict: true });
  assert.equal(r.ok, false);
  assert.match(r.reason, /硬约束开着/);
  assert.match(r.reason, /对象/);

  const r2 = checkValue({ kind: 'any' }, [1], { strict: true });
  assert.match(r2.reason, /数组/);
});

test('硬约束关掉后对象放行', () => {
  assert.equal(checkValue({ kind: 'any' }, { a: 1 }, { strict: false }).ok, true);
});

test('number 规则：类型 + 上下限', () => {
  const rule = { kind: 'number', min: -100, max: 200 };
  assert.equal(checkValue(rule, 5, { strict: true }).ok, true);
  assert.equal(checkValue(rule, 300, { strict: true }).ok, false);
  assert.match(checkValue(rule, 300, { strict: true }).reason, /大于上限/);
  assert.equal(checkValue(rule, -200, { strict: true }).ok, false);
  assert.match(checkValue(rule, -200, { strict: true }).reason, /小于下限/);
  assert.equal(checkValue(rule, '5', { strict: true }).ok, false);
  assert.match(checkValue(rule, '5', { strict: true }).reason, /要数字/);
});

test('enum 规则：取值不在表里要报出表', () => {
  const rule = { kind: 'enum', of: 'places' };
  const ok = checkValue(rule, 'apartment', { strict: true, places: ['apartment', 'street'] });
  assert.equal(ok.ok, true);

  const bad = checkValue(rule, 'moon', { strict: true, places: ['apartment', 'street'] });
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /不在允许范围内/);
  assert.match(bad.reason, /apartment \/ street/);
});

test('enum 拿不到取值表就拒绝 —— 不猜、不放行', () => {
  const r = checkValue({ kind: 'enum', of: 'places' }, 'apartment', { strict: true });
  assert.equal(r.ok, false);
  assert.match(r.reason, /无法取得 places/);
});

/* ---------------------------------------------------------------- *
 * 请求 → effect
 * ---------------------------------------------------------------- */

const CTX = { strict: true, state: null, places: ['apartment'] };

test('数字写入翻译成 set effect', () => {
  const r = requestToEffect({ path: 'actors.linwan.stats.信任', value: 72 }, CTX);
  assert.equal(r.ok, true);
  assert.deepEqual(r.effect, { path: 'actors.linwan.stats.信任', op: 'set', value: 72 });
});

test('只增列表翻译成 push，一次一项', () => {
  const r = requestToEffect({ path: 'clues', value: 'X1' }, CTX);
  assert.equal(r.ok, true);
  assert.equal(r.effect.op, 'push');
  assert.equal(r.effect.value, 'X1');

  const arr = requestToEffect({ path: 'clues', value: ['X1', 'X2'] }, CTX);
  assert.equal(arr.ok, false);
  assert.match(arr.reason, /一次只能加一项/);

  const none = requestToEffect({ path: 'clues' }, CTX);
  assert.equal(none.ok, false);
  assert.match(none.reason, /必须给 value/);
});

test('增量写入先探一次当前值 —— 非数字要在这里挡住', () => {
  const state = { actors: { linwan: { stats: { 信任: '高' } } } };
  const bad = requestToEffect(
    { path: 'actors.linwan.stats.信任', value: 3, op: 'add' },
    { ...CTX, state },
  );
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /当前不是数字/);
  assert.match(bad.reason, /string/);

  const good = requestToEffect(
    { path: 'actors.linwan.stats.信任', value: 3, op: 'add' },
    { ...CTX, state: { actors: { linwan: { stats: { 信任: 70 } } } } },
  );
  assert.equal(good.ok, true);
  assert.equal(good.effect.op, 'add');
});

test('不认识的 op 退回 set，不报错也不乱翻译', () => {
  const r = requestToEffect({ path: 'actors.a.stats.x', value: 1, op: 'divide' }, CTX);
  assert.equal(r.ok, true);
  assert.equal(r.effect.op, 'set');
});

test('请求缺 path / 不是对象时给出明确原因', () => {
  assert.match(requestToEffect(null, CTX).reason, /必须是对象/);
  assert.match(requestToEffect({ value: 1 }, CTX).reason, /缺少 path/);
});

test('锁着的时候 flags 写不进去，原因与路径白名单一致', () => {
  const r = requestToEffect({ path: 'flags.tmp', value: 1 }, CTX);
  assert.equal(r.ok, false);
  assert.match(r.reason, /硬约束开着/);
});

/* ---------------------------------------------------------------- *
 * readPath
 * ---------------------------------------------------------------- */

test('readPath 读不到就返回 undefined，不抛', () => {
  assert.equal(readPath({ a: { b: 1 } }, 'a.b'), 1);
  assert.equal(readPath({ a: { b: 1 } }, 'a.c'), undefined);
  assert.equal(readPath(null, 'a'), undefined);
  assert.equal(readPath({ a: 1 }, 'a.b'), undefined, '中途遇到非对象');
  assert.equal(readPath({ a: { b: undefined } }, 'a.b'), undefined);
});

test('readPath 不认原型链上的东西', () => {
  assert.equal(readPath({}, 'toString'), undefined);
  assert.equal(readPath({ a: {} }, 'a.constructor'), undefined);
});

/* ---------------------------------------------------------------- *
 * 只读快照
 * ---------------------------------------------------------------- */

const WORLD = {
  actorLabels: { linwan: '林晚' },
  statLabels: { linwan: { trust: '信任' } },
  slotLabels: { night: '夜' },
  placeLabels: { apartment: '旧公寓' },
  clueLabels: { X1: '鑫达租赁' },
};
const STATE = {
  clock: { day: 3, slot: 'night' },
  where: 'apartment',
  actors: {
    linwan: { id: 'linwan', met: true, stats: { trust: 72 }, bounds: { trust: { min: 0, max: 100 } } },
    stranger: { id: 'stranger', met: false, stats: { trust: 1 } },
  },
  clues: ['X1'],
  flags: { path_seeker: true },
  routes: { linwan: 'open' },
  ledger: [{ who: 'linwan', amount: 300 }],
  achievements: ['A1'],
  history: [1, 2, 3],
};

test('快照只含已 met 的角色，且标签换成人类可读的', () => {
  const s = snapshotFor(STATE, WORLD);
  assert.equal(s.actors.length, 1);
  assert.equal(s.actors[0].id, 'linwan');
  assert.equal(s.actors[0].name, '林晚');
  assert.equal(s.actors[0].stats['信任'], 72, '数值键换成标签');
  assert.deepEqual(s.actors[0].bounds, { trust: { min: 0, max: 100 } });
});

test('快照的 turn 是 history 长度 + 1（当轮）', () => {
  assert.equal(snapshotFor(STATE, WORLD).turn, 4);
});

test('快照的标签缺失时退回原键名，不崩', () => {
  const s = snapshotFor(STATE, {});
  assert.equal(s.actors[0].name, 'linwan');
  assert.equal(s.actors[0].stats.trust, 72);
  assert.equal(s.slotLabel, 'night');
  assert.equal(s.whereLabel, 'apartment');
});

test('快照不带世界书正文 / 角色描述这类内容', () => {
  const s = snapshotFor(STATE, { ...WORLD, book: [{ content: '机密设定' }], actors: { desc: '人物描写' } });
  const text = JSON.stringify(s);
  assert.ok(!text.includes('机密设定'), '世界书正文不该出现在快照里');
  assert.ok(!text.includes('人物描写'), '角色描述不该出现在快照里');
});

test('快照没有历史正文，只有轮数', () => {
  const s = snapshotFor(STATE, WORLD);
  assert.ok(!('history' in s), '快照不含 history');
  assert.equal(typeof s.turn, 'number');
});

test('state 为空时快照返回 null，不抛', () => {
  assert.equal(snapshotFor(null, WORLD), null);
});

/* ---------------------------------------------------------------- *
 * 事件表
 * ---------------------------------------------------------------- */

test('小二事件只列茶馆确实有的那几个', () => {
  const keys = Object.keys(BOY_EVENTS);
  assert.equal(keys.length, 8);
  assert.ok(keys.includes('turn:finished'));
  assert.ok(keys.includes('state:changed'));
  assert.ok(!keys.includes('app_ready'), '不含酒馆自身的事件');
  assert.ok(!keys.includes('connection_profile_loaded'));
});

test('isBoyEvent 只认表里的名字', () => {
  assert.equal(isBoyEvent('turn:ready'), true);
  assert.equal(isBoyEvent('message_sent'), false);
  assert.equal(isBoyEvent('toString'), false, '不从原型链上捡东西');
});

/* ------------------------------------------------------------------ *
 * 测试用假 frame
 *
 * 真实环境里 iframe 带 `sandbox="allow-scripts"`（无 allow-same-origin），
 * 跑在 opaque origin 里 —— 父窗口读不到 contentDocument，event.source
 * 也与 frame.contentWindow 不是同一对象。所以桥**不靠身份比对认亲**，
 * 只要求"确实挂了一个还在文档里的 frame"。这里就用一个最小的假 frame
 * 满足那个前提，同时把出站消息收集下来供断言。
 * ------------------------------------------------------------------ */

function makeFrame() {
  const sent = [];
  return {
    sent,
    isConnected: true,
    contentWindow: { postMessage: (m) => sent.push(m) },
    setAttribute() {},
    removeAttribute() {},
  };
}

/* ---------------------------------------------------------------- *
 * 桥对象
 * ---------------------------------------------------------------- */

test('桥默认关着时不发任何事件', () => {
  const boy = createBoy({ host: () => ({}) });
  assert.equal(boy.emit('turn:ready', {}), false);
});

test('打开之后没有 frame 也发不出去 —— 但不抛', () => {
  const boy = createBoy({ host: () => ({}) });
  boy.setConfig({ enabled: true, mode: 'readonly' });
  assert.equal(boy.emit('turn:ready', {}), false);
});

test('只读档拒绝写入，且真的没有落到 apply', () => {
  let applied = 0;
  const sent = [];
  const fakeFrame = {
    contentWindow: { postMessage: (m) => sent.push(m) },
    setAttribute() {}, removeAttribute() {},
  };
  const boy = createBoy({
    host: () => ({ state: { clues: [] }, places: [] }),
    apply: () => { applied++; return { changes: [] }; },
  });
  boy.setConfig({ enabled: true, mode: 'readonly' });
  boy.attach(fakeFrame);
  boy.onMessage({
    data: { __teahouse: true, dir: 'write', id: 'x', path: 'clues', value: 'X1' },
    source: fakeFrame.contentWindow,
  });
  assert.equal(boy.log.length, 1);
  assert.equal(boy.log[0].ok, false);
  assert.match(boy.log[0].reason, /只读/);
  assert.equal(applied, 0, '只读档绝不能碰到 apply');
  assert.equal(sent.at(-1).ok, false, '脚本要收到拒绝回执');
});

test('可写档 + 锁：flags 写不进去（strictOnly）', () => {
  let applied = 0;
  const boy = createBoy({
    host: () => ({ state: { actors: {}, flags: {} }, places: [] }),
    apply: () => { applied++; return { changes: [] }; },
  });
  const fakeFrame = makeFrame();
  boy.setConfig({ enabled: true, mode: 'write', strict: true });
  boy.attach(fakeFrame);
  boy.onMessage({
    data: { __teahouse: true, dir: 'write', id: 'x', path: 'flags.tmp', value: 1 },
    source: fakeFrame.contentWindow,
  });
  assert.equal(boy.log[0].ok, false);
  assert.match(boy.log[0].reason, /硬约束开着/);
  assert.equal(applied, 0);
});

test('可写档 + 锁：走的是 apply 回调（不是直接改 state）', () => {
  const seen = [];
  const hostState = { actors: { linwan: { stats: { trust: 70 } } } };
  const boy = createBoy({
    host: () => ({ state: hostState, places: [] }),
    apply: (effects) => { seen.push(...effects); return { changes: [{ path: effects[0].path }] }; },
  });
  const fakeFrame = makeFrame();
  boy.setConfig({ enabled: true, mode: 'write', strict: true });
  boy.attach(fakeFrame);
  boy.onMessage({
    data: { __teahouse: true, dir: 'write', id: 'x', path: 'actors.linwan.stats.trust', value: 72 },
    source: fakeFrame.contentWindow,
  });
  assert.equal(boy.log[0].ok, true);
  assert.deepEqual(seen, [{ path: 'actors.linwan.stats.trust', op: 'set', value: 72 }]);
  assert.deepEqual(boy.log[0].changes, [{ path: 'actors.linwan.stats.trust' }]);
  assert.equal(hostState.actors.linwan.stats.trust, 70, '桥自己绝不能改 state');
});

test('apply 抛错时把引擎的原话透给脚本，不自己改写成"写入失败"', () => {
  const boy = createBoy({
    host: () => ({ state: { actors: {} }, places: [] }),
    apply: () => { throw new Error('数值缺少边界声明：actors.a.stats.x'); },
  });
  const fakeFrame = makeFrame();
  boy.setConfig({ enabled: true, mode: 'write' });
  boy.attach(fakeFrame);
  boy.onMessage({
    data: { __teahouse: true, dir: 'write', id: 'x', path: 'actors.a.stats.x', value: 1 },
    source: fakeFrame.contentWindow,
  });
  assert.equal(boy.log[0].ok, false);
  assert.match(boy.log[0].reason, /数值缺少边界声明/);
});

test('读通道：认识的资源给出值，不认识的抛并报出可用清单', () => {
  // frame 用假的 postMessage 接住回执，这样能断言真实载荷而不是"没抛就算过"
  const sent = [];
  const fakeFrame = {
    contentWindow: { postMessage: (m) => sent.push(m) },
    setAttribute() {}, removeAttribute() {},
  };
  const boy = createBoy({
    host: () => ({ state: STATE, world: WORLD }),
  });
  boy.setConfig({ enabled: true });
  boy.attach(fakeFrame);

  boy.onMessage({ data: { __teahouse: true, dir: 'read', id: 'a', what: 'snapshot' }, source: fakeFrame.contentWindow });
  const snap = sent.at(-1);
  assert.equal(snap.dir, 'reply');
  assert.equal(snap.ok, true);
  assert.equal(snap.value.turn, 4, '快照真的送到了');
  assert.equal(snap.value.actors[0].name, '林晚');

  // vars 通道已删：它从前是个写死的空 {}，永远给不出东西 —— 一个骗人的通道。
  // 现在读它必须抛，且报错里要列出真正可用的那批（别让脚本作者去猜）。
  boy.onMessage({ data: { __teahouse: true, dir: 'read', id: 'b', what: 'vars' }, source: fakeFrame.contentWindow });
  const gone = sent.at(-1);
  assert.equal(gone.ok, false);
  assert.match(gone.error, /不认识这个资源：vars/);
  assert.doesNotMatch(gone.error, /vars \/ books/, '可用清单里不该再出现 vars');

  boy.onMessage({ data: { __teahouse: true, dir: 'read', id: 'c', what: 'nope' }, source: fakeFrame.contentWindow });
  const bad = sent.at(-1);
  assert.equal(bad.ok, false);
  assert.match(bad.error, /不认识这个资源：nope/);
  assert.match(bad.error, /snapshot \/ state \/ turn/);
});

test('world 资源只给结构，不给世界书正文', () => {
  const sent = [];
  const fakeFrame = {
    contentWindow: { postMessage: (m) => sent.push(m) },
    setAttribute() {}, removeAttribute() {},
  };
  const boy = createBoy({
    host: () => ({
      state: STATE,
      world: { ...WORLD, book: [{ content: '机密设定' }], title: '雨夜' },
    }),
  });
  boy.setConfig({ enabled: true });
  boy.attach(fakeFrame);
  boy.onMessage({ data: { __teahouse: true, dir: 'read', id: 'a', what: 'world' }, source: fakeFrame.contentWindow });
  const w = sent.at(-1).value;
  assert.equal(w.title, '雨夜');
  assert.deepEqual(w.placeLabels, { apartment: '旧公寓' });
  assert.ok(!('book' in w), 'world 资源不该带世界书');
  assert.ok(!JSON.stringify(w).includes('机密设定'));
});

test('脚本的 say / request / toast 交给 UI 接，不走引擎', () => {
  const got = [];
  const boy = createBoy({ host: () => ({}) });
  const fakeFrame = makeFrame();
  boy.setConfig({ enabled: true, mode: 'write' });
  boy.attach(fakeFrame);
  boy.onLocal('say', (d) => got.push(['say', d.text]));
  boy.onLocal('request', (d) => got.push(['request', d.text]));

  const src = fakeFrame.contentWindow;
  boy.onMessage({ data: { __teahouse: true, dir: 'say', id: '1', text: '天气已更新' }, source: src });
  boy.onMessage({ data: { __teahouse: true, dir: 'request', id: '2', text: '我要走了' }, source: src });
  boy.onMessage({ data: { __teahouse: true, dir: 'toast', id: '3', text: '没接这条' }, source: src });

  assert.deepEqual(got, [['say', '天气已更新'], ['request', '我要走了']]);
  assert.equal(boy.log.length, 0, '这两条不是写入，不该进写入日志');
});

test('detach 之后拒绝在途请求，不挂死', () => {
  const boy = createBoy({ host: () => ({}) });
  boy.setConfig({ enabled: true });
  assert.doesNotThrow(() => boy.detach());
  assert.equal(boy.frame, null);
});

test('未知 dir 的消息被忽略，不炸', () => {
  const boy = createBoy({ host: () => ({}) });
  assert.doesNotThrow(() =>
    boy.onMessage({ data: { __teahouse: true, dir: 'evil' }, source: null }));
});

test('不带 __teahouse 的 message 一律无视', () => {
  const boy = createBoy({ host: () => ({}) });
  boy.setConfig({ enabled: true, mode: 'write' });
  boy.onMessage({ data: { dir: 'write', path: 'flags.x', value: 1 }, source: null });
  assert.equal(boy.log.length, 0, '外来消息不该进日志');
});

/* 这条取代了原先的"别人的 frame 不认"。
   为什么换：沙箱（allow-scripts，无 allow-same-origin）让 iframe 跑在
   opaque origin 里，父窗口**拿不到**可做身份比对的 contentWindow ——
   原来的 `event.source !== frame.contentWindow` 会拦下所有入站消息，
   表现为"脚本一片安静、连报错都没有"。所以改成：认"有没有挂 frame"。 */
test('没有挂 frame 时，入站消息一律不接', () => {
  const boy = createBoy({ host: () => ({}) });
  boy.setConfig({ enabled: true, mode: 'write' });
  boy.onMessage({ data: { __teahouse: true, dir: 'write', path: 'clues', value: 'X' }, source: null });
  assert.equal(boy.log.length, 0);
});

test('frame 已被移除时，入站消息也不接', () => {
  const boy = createBoy({ host: () => ({}) });
  const dead = makeFrame();
  dead.isConnected = false;
  boy.setConfig({ enabled: true, mode: 'write' });
  boy.attach(dead);
  boy.onMessage({ data: { __teahouse: true, dir: 'write', path: 'clues', value: 'X' }, source: dead.contentWindow });
  assert.equal(boy.log.length, 0);
});

test('挂上 frame 之后，同样这条消息就会被处理', () => {
  let applied = 0;
  const boy = createBoy({
    host: () => ({ state: { clues: [] }, places: [] }),
    apply: () => { applied++; return { changes: [] }; },
  });
  const live = makeFrame();
  boy.setConfig({ enabled: true, mode: 'write' });
  boy.attach(live);
  boy.onMessage({ data: { __teahouse: true, dir: 'write', path: 'clues', value: 'X' }, source: live.contentWindow });
  assert.equal(boy.log.length, 1);
  assert.equal(applied, 1);
});

/* ---------------------------------------------------------------- *
 * $auto 引擎独占：脚本不能写引擎自己算的观测值
 * ---------------------------------------------------------------- */

test('$auto 在两种档位下都写不进去', () => {
  for (const strict of [true, false]) {
    const r = writablePath('$auto.achievement_count', { strict });
    assert.equal(r.ok, false, `strict=${strict} 时也不该放行`);
    assert.match(r.reason, /引擎自己算的观测值/);
  }
});

test('$auto 的拒绝理由要说清"写了也会被覆盖"，不是笼统的"不认识"', () => {
  const r = writablePath('$auto.withdraw_count');
  assert.equal(r.ok, false);
  assert.match(r.reason, /重算|覆盖/, '要说明为什么不该写，否则脚本作者会以为是权限没开');
});

test('$auto 挡的是它自己，不禁掉别的 $ 开头路径', () => {
  // 挡太宽会误伤。只认 $auto.，别的一律走正常流程
  const r = writablePath('$other.thing');
  assert.equal(r.ok, false);
  assert.match(r.reason, /写通道不认识这个路径/, '应落到兜底拒绝，而不是 $auto 那条专门理由');
});

test('$auto 整段（不带点）同样被挡', () => {
  assert.equal(writablePath('$auto').ok, false);
});

/* ---------------------------------------------------------------- *
 * bookEntries：只给结构，不给正文
 * ---------------------------------------------------------------- */

test('projectBookEntries 的字段是白名单，正文一个都不漏', () => {
  const sent = [];
  const fakeFrame = {
    contentWindow: { postMessage: (m) => sent.push(m) },
    setAttribute() {}, removeAttribute() {},
  };
  const boy = createBoy({
    host: () => ({
      state: STATE,
      world: WORLD,
      books: {
        entries: [{
          id: 'W1',
          heading: '旧公寓的雨',
          category: '概要',
          keys: ['雨'],
          secondary: ['副键'],
          content: '正文不能出去',
          constant: false,
          enabled: true,
        }],
      },
    }),
  });
  boy.setConfig({ enabled: true });
  boy.attach(fakeFrame);
  boy.onMessage({ data: { __teahouse: true, dir: 'read', id: 'a', what: 'bookEntries' } });

  const list = sent.at(-1).value;
  assert.equal(list.length, 1);
  const keys = Object.keys(list[0]).sort();
  assert.deepEqual(keys, ['category', 'constant', 'enabled', 'heading', 'id', 'keys']);
  assert.equal(list[0].content, undefined, 'content 是正文，绝不能出去');
  assert.equal(list[0].secondary, undefined, 'secondary 也是正文');
});

test('拿不到世界书时 bookEntries 给 null，不抛', () => {
  const sent = [];
  const fakeFrame = {
    contentWindow: { postMessage: (m) => sent.push(m) },
    setAttribute() {}, removeAttribute() {},
  };
  const boy = createBoy({ host: () => ({ state: STATE, world: WORLD }) });
  boy.setConfig({ enabled: true });
  boy.attach(fakeFrame);
  boy.onMessage({ data: { __teahouse: true, dir: 'read', id: 'a', what: 'bookEntries' } });
  assert.equal(sent.at(-1).ok, true);
  assert.equal(sent.at(-1).value, null);
});

/* ---------------------------------------------------------------- *
 * bindStore：状态变更接成 state:changed
 * ---------------------------------------------------------------- */

test('bindStore 把 store 的每次提交转成一条 state:changed', () => {
  const emitted = [];
  const subs = new Set();
  const fakeStore = {
    subscribe: (fn) => { subs.add(fn); return () => subs.delete(fn); },
  };
  const boy = createBoy({ host: () => ({ state: STATE, world: WORLD }) });
  boy.setConfig({ enabled: true });
  boy.attach({ contentWindow: { postMessage: (m) => emitted.push(m) }, setAttribute() {}, removeAttribute() {} });

  boy.bindStore(fakeStore);
  assert.equal(subs.size, 1, '订阅真的挂上去了');

  for (const fn of subs) fn({ turn: 5, mode: 'commit', changes: [{ path: 'flags.a', op: 'set', from: false, to: true }] });

  const hits = emitted.filter(m => m.dir === 'emit' && m.type === 'state:changed');
  assert.equal(hits.length, 1, '必须真的发出去一条，不是"没报错就算过"');
  assert.equal(hits[0].payload.turn, 5);
  assert.equal(hits[0].payload.mode, 'commit');
  assert.equal(hits[0].payload.changes[0].path, 'flags.a');
});

test('state:changed 在没有 changes 时给 null 而不是空数组', () => {
  const emitted = [];
  const subs = new Set();
  const boy = createBoy({ host: () => ({ state: STATE, world: WORLD }) });
  boy.setConfig({ enabled: true });
  boy.attach({ contentWindow: { postMessage: (m) => emitted.push(m) }, setAttribute() {}, removeAttribute() {} });
  boy.bindStore({ subscribe: (fn) => { subs.add(fn); return () => subs.delete(fn); } });

  for (const fn of subs) fn({ turn: 9, mode: 'rollback', changes: null });
  const hit = emitted.find(m => m.type === 'state:changed');
  assert.equal(hit.payload.changes, null, '回滚是整表恢复，没有逐条 diff —— 给 null，别假装有');
});

test('重复 bindStore 先解掉旧的，事件不发两遍', () => {
  const emitted = [];
  const subs = new Set();
  const store = { subscribe: (fn) => { subs.add(fn); return () => subs.delete(fn); } };
  const boy = createBoy({ host: () => ({ state: STATE, world: WORLD }) });
  boy.setConfig({ enabled: true });
  boy.attach({ contentWindow: { postMessage: (m) => emitted.push(m) }, setAttribute() {}, removeAttribute() {} });

  boy.bindStore(store);
  boy.bindStore(store);
  assert.equal(subs.size, 1, '不该挂两份');

  for (const fn of subs) fn({ turn: 1, mode: 'commit' });
  assert.equal(emitted.filter(m => m.type === 'state:changed').length, 1);
});

test('detach 会把 store 订阅解掉', () => {
  const subs = new Set();
  const boy = createBoy({ host: () => ({ state: STATE, world: WORLD }) });
  boy.setConfig({ enabled: true });
  boy.attach({ contentWindow: { postMessage() {} }, setAttribute() {}, removeAttribute() {} });
  boy.bindStore({ subscribe: (fn) => { subs.add(fn); return () => subs.delete(fn); } });
  assert.equal(subs.size, 1);
  boy.detach();
  assert.equal(subs.size, 0, '小二关了就别再跑订阅');
});

test('bindStore 收到不带 subscribe 的东西就抛，不静默不接', () => {
  const boy = createBoy({ host: () => ({ state: STATE }) });
  assert.throws(() => boy.bindStore({}), /subscribe/);
  assert.throws(() => boy.bindStore(null), /subscribe/);
});
