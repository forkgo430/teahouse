/**
 * 引擎管线 —— 把「一轮要做什么」固定成一条不可调换的函数链。
 *
 * 每轮固定顺序（对应十步工作流）：
 *   ① 读局面   → ② 定事件   → ③ 挂角色  → ④ 取分支  → ⑤ 算数值
 *   ⑥ 更新账本 → ⑦ 校验边界 → ⑧ 判成就/结局 → ⑨ 出建议 → ⑩ 产出渲染数据
 *
 * 全部是纯函数：入参不修改，出参是新对象。同一个 state + 同一个输入
 * 必然得到同一个结果（确定性由 state.js 的 hashState 验证）。
 *
 * 权威状态由本模块与 state.js 共同持有。事件卡里的 effects 是「申请」，
 * 由 guards 这一层审核后才允许落到状态上。
 */

import { SLOTS, SchemaError, validateEventSet } from './schema.js';
import { evaluate, explain } from './condition.js';
import { applyEffects } from './state.js';
import { parseInput, suggestPhrases, isAutoIntent } from './parser.js';
import { createWorldbook } from './worldbook.js';

/** 时段显示名（可被 world.slotLabels 覆盖；引擎本身不关心文案） */
export const DEFAULT_SLOT_LABELS = Object.freeze({
  dawn: '黎明',
  morning: '上午',
  afternoon: '午后',
  evening: '傍晚',
  night: '深夜',
});

export class TurnRejected extends Error {
  constructor(reason, detail = {}) {
    super(reason);
    this.name = 'TurnRejected';
    this.detail = detail;
  }
}

/* ------------------------------------------------------------------ *
 * world：静态数据 + 索引
 * ------------------------------------------------------------------ */

/**
 * @param {object} def
 * @param {object[]} def.events
 * @param {object[]} [def.achievements]
 * @param {object[]} [def.endings]
 * @param {Function[]} [def.guards] 边界校验器，返回 { ok, reason }
 * @param {object} [def.slotLabels]
 * @param {string} [def.brief] 世界观简述（接模型时作为背景注入）
 * @param {object} [def.placeLabels] 地点 id → 显示名
 * @param {object} [def.actorLabels] 角色 id → 显示名
 * @param {object} [def.statLabels] 角色 id → { 数值 key → 显示名 }
 * @param {object} [def.clueLabels] 线索 id → 显示名
 * @param {number} [def.maxSkips]
 */
export function createWorld(def = {}) {
  const events = def.events ?? [];

  // 非法数据不进引擎：宁可在这里炸，也不要在第 30 轮才发现数值对不上
  const { ok, issues } = validateEventSet(events);
  if (!ok) throw new SchemaError(issues);

  const world = {
    events,
    achievements: def.achievements ?? [],
    endings: def.endings ?? [],
    guards: def.guards ?? [],
    slotLabels: { ...DEFAULT_SLOT_LABELS, ...(def.slotLabels ?? {}) },
    brief: def.brief ?? '',
    placeLabels: def.placeLabels ?? null,
    actorLabels: def.actorLabels ?? null,
    statLabels: def.statLabels ?? null,
    clueLabels: def.clueLabels ?? null,
    flagLabels: def.flagLabels ?? null,
    // 世界书：按关键词触发注入，不做全量塞入
    book: (def.worldbook && def.worldbook.length) ? createWorldbook(def.worldbook) : null,
    loreBudget: def.loreBudget ?? 1024,
    maxSkips: def.maxSkips ?? 12,
    index: buildIndex(events),
  };
  return world;
}

/**
 * 倒排索引：按 day 建桶。查询时取 `state.clock.day` 桶 + 通配桶，
 * 避免每轮遍历全量事件表。
 */
export function buildIndex(events) {
  const byDay = new Map();
  for (const ev of events) {
    const raw = ev.when?.day;
    const days = raw === undefined ? ['*'] : (Array.isArray(raw) ? raw : [raw]);
    for (const d of days) {
      if (!byDay.has(d)) byDay.set(d, []);
      byDay.get(d).push(ev);
    }
  }
  return { byDay };
}

function indexLookup(world, day) {
  const bucket = world.index?.byDay;
  if (!bucket) return world.events;
  const exact = bucket.get(day) ?? [];
  const wild = bucket.get('*') ?? [];
  if (exact.length === 0) return wild;
  if (wild.length === 0) return exact;
  return [...wild, ...exact];
}

/* ------------------------------------------------------------------ *
 * ② 定事件
 * ------------------------------------------------------------------ */

function inWhen(value, current) {
  if (value === undefined) return true;
  return Array.isArray(value) ? value.includes(current) : value === current;
}

function inWhere(value, current) {
  if (value === undefined) return true;
  return Array.isArray(value) ? value.includes(current) : value === current;
}

/** 事件是否命中当前局面 */
export function matchesContext(event, state) {
  if (!inWhen(event.when?.day, state.clock.day)) return false;
  if (!inWhen(event.when?.slot, state.clock.slot)) return false;
  if (!inWhere(event.where, state.where)) return false;
  if (!evaluate(event.require ?? null, state)) return false;
  return true;
}

/** 该事件是否已经用掉（非 repeat 事件只触发一次） */
export function isConsumed(event, state) {
  if (event.repeat === true) return false;
  return (state.history ?? []).some(h => h.eventId === event.id);
}

/**
 * 从当前局面挑一个事件。命中多个时：priority 降序，再按 id 升序（稳定排序）。
 * @returns {object|null}
 */
export function pickEvent(state, world) {
  const candidates = indexLookup(world, state.clock.day)
    .filter(ev => !isConsumed(ev, state) && matchesContext(ev, state));

  if (candidates.length === 0) return null;

  return candidates.slice().sort((a, b) => {
    const pa = a.priority ?? 0;
    const pb = b.priority ?? 0;
    if (pb !== pa) return pb - pa;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  })[0];
}

/** 诊断用：列出当前局面下所有候选事件及命中原因 */
export function inspectContext(state, world) {
  return indexLookup(world, state.clock.day).map(ev => {
    const consumed = isConsumed(ev, state);
    const matches = matchesContext(ev, state);
    return {
      id: ev.id,
      title: ev.title,
      consumed,
      matches: matches && !consumed,
      blockedBy: consumed ? '已触发过' : (matches ? null : '局面不匹配'),
    };
  });
}

/* ------------------------------------------------------------------ *
 * 时间推进
 * ------------------------------------------------------------------ */

/** 当前局面无事件时，推进一个时段（slot 走完则 day+1） */
export function advanceClock(state) {
  const i = SLOTS.indexOf(state.clock.slot);
  const nextIndex = i + 1;

  if (nextIndex < SLOTS.length) {
    return applyEffects(state, [{ path: 'clock.slot', op: 'set', value: SLOTS[nextIndex] }]).state;
  }
  return applyEffects(state, [
    { path: 'clock.day', op: 'add', value: 1 },
    { path: 'clock.slot', op: 'set', value: SLOTS[0] },
  ]).state;
}

/* ------------------------------------------------------------------ *
 * ④ 取分支 / ⑨ 出建议
 * ------------------------------------------------------------------ */

/** 事件中条件成立的分支 */
export function availableBranches(state, event) {
  return (event?.branches ?? []).filter(b => evaluate(b.cond ?? null, state));
}

/**
 * 依玩家输入确定分支。
 *
 * 规则（严格，不给越权的机会）：
 *   1. 输入了明确 key → 必须存在，且其条件必须成立；否则抛 TurnRejected。
 *      不能因为 key 写错就悄悄回落到别的分支，也不能绕过前置条件。
 *   2. 没有输入 → 自动取无条件分支；没有则用 fallback；都没有则抛错。
 */
export function selectBranch(state, event, input) {
  const branches = event.branches ?? [];
  const key = typeof input === 'string' ? input : input?.branchKey;

  if (key != null) {
    const hit = branches.find(b => b.key === key);
    if (!hit) {
      throw new TurnRejected(
        `事件 ${event.id} 不存在分支 ${JSON.stringify(key)}（可选：${branches.map(b => b.key).join(' / ')}）`,
        { eventId: event.id, branchKey: key, reason: 'unknown-branch' },
      );
    }
    if (!evaluate(hit.cond ?? null, state)) {
      throw new TurnRejected(
        `分支 ${key} 的前置条件不成立：${firstFailure(hit.cond, state)}`,
        { eventId: event.id, branchKey: key, reason: 'condition-unmet' },
      );
    }
    return hit;
  }

  // 自动回落：fallback 优先（且必须条件成立）→ 第一个可用的无条件分支 → 任意可用分支
  const usable = branches.filter(b => evaluate(b.cond ?? null, state));

  if (event.fallback) {
    const fb = usable.find(b => b.key === event.fallback);
    if (fb) return fb;
  }

  const free = usable.find(b => (b.cond ?? null) === null);
  if (free) return free;

  if (usable.length > 0) return usable[0];

  throw new TurnRejected(
    `事件 ${event.id} 没有可用的分支（未给输入，且所有分支条件都不成立）`,
    { eventId: event.id, reason: 'no-branch' },
  );
}

/**
 * ⑨ 出建议：可走的分支 + 保底项。
 * 条件不成立的分支也会列出来（标记 blocked），让玩家知道「不是现在」。
 *
 * reason 是给玩家看的一句话，不含字段路径；reasonDetail 留完整轨迹给调试。
 */
export function buildOptions(state, event) {
  if (!event) return [];

  const opts = [];
  for (const b of event.branches ?? []) {
    const ok = evaluate(b.cond ?? null, state);
    const failed = ok ? null : firstFailure(b.cond, state);
    opts.push({
      key: b.key,
      label: b.label ?? b.key,
      kind: (b.cond ?? null) === null ? 'default' : 'branch',
      available: ok,
      reason: failed ? failed.text : null,
      reasonDetail: failed ? failed.detail : null,
    });
  }

  // 保底推进：若一个分支都不可用，强制打开保底项
  if (!opts.some(o => o.available)) {
    const fallbackKey = event.fallback ?? (event.branches ?? [])[0]?.key;
    const hit = opts.find(o => o.key === fallbackKey);
    if (hit) {
      hit.available = true;
      hit.kind = 'fallback';
      hit.reason = null;
      hit.reasonDetail = null;
    }
  }

  return opts;
}

/** 把「哪一步没过」翻译成玩家能读的一句话 */
function shortReason(step) {
  if (!step) return '条件不成立';
  if (!step.found) return '时机未到';
  switch (step.op) {
    case '>':
    case '>=':
      return '还差一些';
    case '<':
    case '<=':
      return '已经过了这个点';
    case 'contains':
    case 'in':
      return '信息还不够';
    case 'exists':
      return '还没有出现';
    default:
      return '时机未到';
  }
}

function firstFailure(cond, state) {
  if (cond === null || cond === undefined) return null;
  const { result, steps } = explain(cond, state);
  if (result) return null;
  const bad = steps.find(s => s.ok === false) ?? steps[steps.length - 1];
  if (!bad) return { text: '条件不成立', detail: '' };
  return { text: shortReason(bad), detail: `${bad.path} — ${bad.note}` };
}

/* ------------------------------------------------------------------ *
 * ⑦ 校验边界
 * ------------------------------------------------------------------ */

function runGuards(state, event, branch, world) {
  for (const guard of world.guards ?? []) {
    const r = guard({ state, event, branch, effects: branch.effects ?? [] });
    if (r && r.ok === false) {
      throw new TurnRejected(r.reason ?? '越界推进被拒绝', { eventId: event.id, branchKey: branch.key });
    }
  }
}

/* ------------------------------------------------------------------ *
 * ③ 挂角色 / unlock / ⑧ 成就结局
 * ------------------------------------------------------------------ */

function markFirstMet(state, event) {
  const effects = [];
  for (const id of event.firstMet ?? []) {
    if (state.actors?.[id] && state.actors[id].met !== true) {
      effects.push({ path: `actors.${id}.met`, op: 'set', value: true });
    }
  }
  return effects.length ? applyEffects(state, effects) : { state, changes: [] };
}

function unlockEffects(event, branch) {
  const u = branch.unlock ?? {};
  const effects = [];
  if (u.clue) effects.push({ path: 'clues', op: 'push', value: u.clue });
  if (u.flag) effects.push({ path: `flags.${u.flag}`, op: 'set', value: true });
  if (u.achievement) effects.push({ path: 'achievements', op: 'push', value: u.achievement });
  if (u.ending) effects.push({ path: 'endings', op: 'push', value: u.ending });
  if (u.route) effects.push({ path: `routes.${u.route.actor}`, op: 'set', value: u.route.state });
  return effects;
}

/** ⑧ 命中且尚未获得的成就（全部返回，逐个展示） */
export function checkAchievements(state, world) {
  const got = new Set(state.achievements ?? []);
  return (world.achievements ?? []).filter(a => !got.has(a.id) && evaluate(a.cond ?? null, state));
}

/** ⑧ 结局：最多命中一个，priority 高者优先 */
export function checkEndings(state, world) {
  const got = new Set(state.endings ?? []);
  const hits = (world.endings ?? [])
    .filter(e => !got.has(e.id) && evaluate(e.cond ?? null, state))
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  return hits.slice(0, 1);
}

function recordHistory(state, event, branch, changes, intent) {
  const entry = {
    turn: (state.history ?? []).length + 1,
    eventId: event.id,
    branchKey: branch.key,
    // 最终展示给玩家的正文。先填预写文本；接模型时由界面层覆盖成模型写的那段，
    // 这样读档、回退之后重建正文用的仍是当时真正看到的内容。
    text: branch.text ?? '',
    // 多版本：一次生成几段，左右切换挑一段。只有一段时也不为空，免得界面要判空。
    variants: branch.text ? [branch.text] : [],
    variantIndex: 0,
    // 玩家这一轮的原话（点选项则为 null），用来在消息流里还原玩家的发言
    said: intent?.raw ?? null,
    day: state.clock.day,
    slot: state.clock.slot,
    where: state.where,
    // 一律落成 JSON 安全的值：undefined 会在 stringify 时被丢掉，
    // 导致同一状态序列化前后指纹不同（读档时会误报存档损坏）。
    changes: changes.map(c => ({
      path: c.path,
      op: c.op,
      from: c.from ?? null,
      to: c.to ?? null,
      value: c.value ?? null,
      clamped: c.clamped ?? null,
    })),
  };
  return applyEffects(state, [{ path: 'history', op: 'push', value: entry }]).state;
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

/**
 * 玩家输入 → 意图。
 *
 * 支持四种写法，按可靠程度依次尝试：
 *   1. 分支 key（'A' / 'b'）—— 精确，最高优先级
 *   2. 序号（'1' / '3'）—— 对应选项列表的位置
 *   3. 自然语言（'开门' / '我想装作没听见'）—— 关键词匹配
 *   4. 留空 / 「随便」 —— 交给保底分支
 *
 * @returns {{ kind:'key'|'auto'|'unknown'|'unavailable', branchKey?:string, matched?:string[], reason?:string, suggestions?:string[], raw?:string }}
 */
export function interpretInput(state, event, raw) {
  const branches = event?.branches ?? [];

  // 对象形式（给程序调用留的口子）
  if (raw !== null && typeof raw === 'object') {
    if (raw.auto === true) return { kind: 'auto' };
    if (raw.branchKey != null) return { kind: 'key', branchKey: String(raw.branchKey) };
    if (raw.text != null) return interpretInput(state, event, String(raw.text));
    return { kind: 'auto' };
  }

  if (raw === null || raw === undefined) return { kind: 'auto' };
  if (typeof raw !== 'string') return { kind: 'unknown', reason: '输入格式无法识别' };

  const text = raw.trim();
  if (text === '') return { kind: 'auto' };

  // 纯字母/数字：先当 key，再当序号
  if (/^[A-Za-z0-9_]+$/.test(text)) {
    const exact = branches.find(b => b.key === text);
    if (exact) return { kind: 'key', branchKey: exact.key };

    const upper = text.toUpperCase();
    if (branches.some(b => b.key === upper)) return { kind: 'key', branchKey: upper };

    if (/^\d+$/.test(text)) {
      const opts = buildOptions(state, event);
      const idx = Number(text) - 1;
      if (opts[idx]) {
        return opts[idx].available
          ? { kind: 'key', branchKey: opts[idx].key }
          : { kind: 'unavailable', branchKey: opts[idx].key, reason: opts[idx].reason };
      }
      return { kind: 'unknown', reason: `没有第 ${text} 个选项` };
    }

    // 看起来像 key 但不存在 —— 交给上层报「不存在分支」
    return { kind: 'key', branchKey: text };
  }

  // 自然语言
  const parsed = parseInput(text, event);
  if (parsed.kind === 'auto') return { kind: 'auto', raw: text };
  if (parsed.kind === 'branch') {
    return { kind: 'key', branchKey: parsed.branchKey, matched: parsed.matched, raw: text };
  }

  const availableKeys = buildOptions(state, event).filter(o => o.available).map(o => o.key);
  return {
    kind: 'unknown',
    raw: text,
    reason: '没听明白你的意思',
    suggestions: suggestPhrases(event, availableKeys),
  };
}

/**
 * ③④⑤⑥⑦⑧ —— 把选定分支落到状态上
 * @returns {{ state: object, report: object }}
 */
export function applyTurn(state, event, input, world) {
  const intent = interpretInput(state, event, input);

  if (intent.kind === 'unknown') {
    throw new TurnRejected(
      intent.reason ?? '无法理解这个输入',
      { eventId: event.id, raw: intent.raw, reason: 'unknown-input', suggestions: intent.suggestions ?? [] },
    );
  }

  const branch = selectBranch(state, event, intent.kind === 'auto' ? undefined : intent.branchKey);

  // ⑦ 先审后写：guards 不通过就不产生任何写入
  runGuards(state, event, branch, world);

  const parts = [];
  let cur = state;

  // ⑤ 算数值 + ⑥ 更新账本（同一条通道）
  const applied = applyEffects(cur, branch.effects ?? []);
  cur = applied.state;
  parts.push(...applied.changes);

  // ③ 挂角色
  const met = markFirstMet(cur, event);
  cur = met.state;
  parts.push(...met.changes);

  // unlock
  const unl = applyEffects(cur, unlockEffects(event, branch));
  cur = unl.state;
  parts.push(...unl.changes);

  // ⑧ 判成就与结局
  const hitAchievements = checkAchievements(cur, world);
  const hitEndings = checkEndings(cur, world);

  const post = [];
  if (hitAchievements.length > 0) {
    const r = applyEffects(cur, hitAchievements.map(a => ({ path: 'achievements', op: 'push', value: a.id })));
    cur = r.state;
    post.push(...r.changes);
  }
  if (hitEndings.length > 0) {
    const r = applyEffects(cur, hitEndings.map(e => ({ path: 'endings', op: 'push', value: e.id })));
    cur = r.state;
    post.push(...r.changes);
  }

  cur = recordHistory(cur, event, branch, [...parts, ...post], intent);

  return {
    state: cur,
    report: {
      kind: 'turn',
      eventId: event.id,
      eventTitle: event.title,
      branchKey: branch.key,
      branchLabel: branch.label ?? branch.key,
      intent,
      text: branch.text ?? '',
      actors: event.actors ?? [],
      firstMet: (event.firstMet ?? []).filter(id => state.actors?.[id]?.met !== true),
      changes: [...parts, ...post],
      achievements: hitAchievements.map(a => ({ id: a.id, title: a.title })),
      ending: hitEndings[0] ? { id: hitEndings[0].id, title: hitEndings[0].title } : null,
      terminal: hitEndings.length > 0,
    },
  };
}

/**
 * 开启一轮：确定当前事件与可选项。局面无事件时自动推进时间。
 * @returns {{ state: object, event: object|null, options: object[], skips: object[] }}
 */
export function nextTurn(state, world) {
  let cur = state;
  const skips = [];

  for (let i = 0; i <= world.maxSkips; i++) {
    const event = pickEvent(cur, world);
    if (event) {
      return { state: cur, event, options: buildOptions(cur, event), skips };
    }
    skips.push({ day: cur.clock.day, slot: cur.clock.slot });
    cur = advanceClock(cur);
  }

  return { state: cur, event: null, options: [], skips };
}

/**
 * 组合入口：开启一轮 + 应用输入（给测试与脚本用）
 */
export function runTurn(state, input, world) {
  const opened = nextTurn(state, world);

  if (!opened.event) {
    return { state: opened.state, event: null, options: [], skips: opened.skips, report: { kind: 'idle', note: '无可推进事件，时间已推进' } };
  }

  const { state: after, report } = applyTurn(opened.state, opened.event, input, world);
  const following = nextTurn(after, world);

  return {
    state: following.state,
    event: opened.event,
    options: following.options,
    nextEvent: following.event,
    skips: opened.skips,
    report,
  };
}

/* ------------------------------------------------------------------ *
 * ⑩ 渲染数据
 * ------------------------------------------------------------------ */

export function buildView(state, world, extra = {}) {
  const labels = world.slotLabels ?? DEFAULT_SLOT_LABELS;

  return {
    clock: {
      day: state.clock.day,
      slot: state.clock.slot,
      label: labels[state.clock.slot] ?? state.clock.slot,
    },
    where: state.where,
    actors: Object.values(state.actors ?? {}).map(a => ({
      id: a.id,
      name: a.name,
      met: a.met === true,
      route: state.routes?.[a.id] ?? 'closed',
      stats: Object.entries(a.stats ?? {}).map(([key, value]) => ({
        key,
        value,
        min: a.bounds?.[key]?.min ?? null,
        max: a.bounds?.[key]?.max ?? null,
      })),
    })),
    ledger: { ...(state.ledger ?? {}) },
    clues: [...(state.clues ?? [])],
    achievements: [...(state.achievements ?? [])],
    endings: [...(state.endings ?? [])],
    options: extra.options ?? [],
    trace: extra.trace ?? null,
  };
}
