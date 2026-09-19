/**
 * 场景面板 —— 从**权威状态**生成声明式标记。
 *
 * 为什么要有这一层：
 *   设定文档 §11.4 规定每轮输出顺序是
 *     〔当前局面〕→ 正文 → 角色卡 → 账本 → 线索。
 *   如果这几块只在开场写死成一段静态文案，那么剧情改了什么，卡片不会跟着变
 *   —— 正文说「她把粥端过来，手在抖」，卡上还写着「情绪：平静」。
 *   引擎最不该出的就是这种自相矛盾。
 *
 *   所以面板**一律由 state 现算**：谁改了什么，卡片立刻反映。
 *   渲染仍走既有的声明式标记（src/card.js），不在这里碰 DOM。
 *
 * 数据来源分两层（这是刻意的）：
 *   - 判定类（路线状态、当轮意愿、数值）→ 读 state
 *   - 描写类（情绪/身体档案/当前穿着…）→ 读 `state.actors[id]` 的同名字段，
 *     由内容层用 effects 写；没写就留空，不编。
 */

import { DISPLAY_FIELDS } from './schema.js';
import { intimacyBoard, intimacyLine } from './intimacy.js';

const FIELD_LABELS = Object.freeze({
  emotion: '情绪',
  publicRelation: '公开关系',
  profile: '身体档案',
  wearing: '当前穿着',
  bodyState: '身体状态',
  hiddenIntent: '隐藏打算',
});

const ROUTE_LABELS = Object.freeze({
  closed: '未开启', open: '已开启', advancing: '推进中', frozen: '已冻结', settled: '已定局',
});

const CONSENT_LABELS = Object.freeze({
  agreed: '已公开表达', refused: '已明确拒绝', pending: '未公开表达',
});

/** 数值行：`信任35 / 100` 这种写法会被前端画成进度条 */
function statLine(actor, labels) {
  const parts = [];
  for (const [key, val] of Object.entries(actor.stats ?? {})) {
    const b = actor.bounds?.[key] ?? {};
    const max = Number.isFinite(b.max) ? b.max : 100;
    const name = labels?.[key] ?? key;
    parts.push(`${name}${val} / ${max}`);
  }
  return parts.join(' · ');
}

function isBlank(v) {
  return v === undefined || v === null || String(v).trim() === '';
}

/** 读一个点号路径上的数值；缺失返回 null（不抛）。 */
function readNumber(state, path) {
  let cur = state;
  for (const seg of String(path ?? '').split('.')) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return null;
    cur = cur[seg];
  }
  return Number.isFinite(cur) ? cur : null;
}

/**
 * 生成面板标记。
 *
 * @param {object} state 权威状态
 * @param {object} world 世界（用它的 placeLabels / statLabels / clueLabels）
 * @param {object} [opts]
 * @param {string[]} [opts.actorIds] 要出卡的角色的 id 顺序；不给则用 state 里的全部
 * @param {string} [opts.dateText]  局面行左侧（默认「第 N 天 · <时段>」）
 * @param {string} [opts.situation] 局面行下面那句
 * @param {object} [opts.roster]    账本要显示的额外键值
 * @returns {string} 声明式标记文本
 */
export function scenePanelMarkup(state, world = {}, opts = {}) {
  const out = [];
  const clock = state.clock ?? {};
  const place = world.placeLabels?.[state.where] ?? state.where ?? '';
  const slot = world.slotLabels?.[clock.slot] ?? clock.slot ?? '';

  /* ── 1. 当前局面 ── */
  const dateText = opts.dateText ?? `第 ${clock.day} 天 · ${slot}`;
  out.push('[当前局面]', [dateText, place].filter(Boolean).join(' · '));
  if (opts.situation) out.push(opts.situation);
  out.push('[/当前局面]');

  /* ── 2. 角色卡 ── */
  const ids = opts.actorIds ?? Object.keys(state.actors ?? {});
  for (const id of ids) {
    const a = state.actors?.[id];
    if (!a) continue;
    const age = Number.isInteger(a.age) ? `${a.age}岁` : '';
    const title = `${a.name}${age ? '｜' + age : ''} · 当前状态`;
    const stats = statLine(a, world.statLabels?.[id]);
    const route = ROUTE_LABELS[state.routes?.[id] ?? 'closed'] ?? '未开启';
    const consent = state.consent?.[id];
    const consentText = consent
      ? (CONSENT_LABELS[consent.state] ?? consent.state ?? '未公开表达')
      : '未公开表达';

    const rows = [];
    for (const f of DISPLAY_FIELDS) {
      const v = a[f];
      if (f === 'profile' || f === 'wearing' || f === 'bodyState' || f === 'hiddenIntent') continue;
      if (!isBlank(v)) rows.push(`${FIELD_LABELS[f]} = ${v}`);
    }
    rows.push(`路线状态 = ${route}`);
    rows.push(`当轮意愿与边界 = ${consentText}`);
    for (const f of ['profile', 'wearing', 'bodyState', 'hiddenIntent']) {
      if (!isBlank(a[f])) rows.push(`${FIELD_LABELS[f]} = ${a[f]}`);
    }
    if (stats) rows.push(`数值 = ${stats}`);

    // §23 亲密状态：与 §4 的「当轮意愿与边界」并列，但记的是**已发生过什么**
    // 受「雨夜机制 → 亲密状态卡」开关控制（opts.intimacy === false 就不出这一行）
    if (opts.intimacy !== false) {
      const im = intimacyBoard(state, world, [id])[0];
      if (im && (im.count > 0 || im.paused)) rows.push(`亲密记录 = ${intimacyLine(im)}`);
    }

    out.push(`[${title}]`, ...rows, `[/${title}]`);
  }

  /* ── 3. 玩家与共同生活账本 ── */
  const ledger = state.ledger ?? {};
  const ledgerRows = [];
  if (opts.roster) for (const [k, v] of Object.entries(opts.roster)) ledgerRows.push(`${k} = ${v}`);
  /* §7：各条线各自的**状态词表**和通用五态不同名
     （调查线：未开启/侦查/突破/收网/结案；事业线：未开启/起步/上升/掌权/定局）。
     线名与词表由数据给，这里只做「阶段数 → 词」的映射。 */
  if (Array.isArray(world.lines)) {
    for (const ln of world.lines) {
      const stages = ln.stages ?? [];
      if (stages.length === 0) continue;
      const raw = readNumber(state, ln.path);
      const idx = Math.max(0, Math.min(stages.length - 1, raw ?? 0));
      ledgerRows.push(`${ln.label} = ${stages[idx]}`);
    }
  }
  ledgerRows.push(`现金 = ${ledger.cash ?? 0}`);
  ledgerRows.push(`本轮收支 = 收入 ${ledger.income ?? 0} · 支出 ${ledger.expense ?? 0}`);
  out.push('[玩家与共同生活账本]', ...ledgerRows, '[/玩家与共同生活账本]');

  /* ── 4. 债务线索与长期事件 ── */
  const clues = state.clues ?? [];
  const clueRows = clues
    .map(c => (world.clueLabels?.[c] ? `${c} · ${world.clueLabels[c]}` : String(c)));
  out.push('[债务线索与长期事件]',
    ...(clueRows.length ? clueRows : ['（暂无）']),
    '[/债务线索与长期事件]');

  return out.join('\n');
}
