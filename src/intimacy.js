/**
 * 亲密状态卡系统（设定文档 §23）。
 *
 * 文档对它的定位是**记录与呈现**，四条目的里有两条是克制的：
 *   「追踪身体负担与恢复周期」「防止非自愿推进」。
 * 所以这里只做三件事，一件都不多做：
 *   1. 把「已经发生过什么」记成可查的字段（累计次数 / 最近一次）；
 *   2. 把「现在能不能」的**暂停理由**从既有状态里推出来（医嘱禁欲 / 明确拒绝 / 路线未开启）；
 *   3. 把这些摊平成面板数据。
 *
 * 它不含任何文案、不做任何叙事判断 —— 那是内容层与 §9 同意边界的事。
 */

/** 记一次亲密行为的 effects。内容层在相应分支里用它，引擎不猜。 */
export function recordIntimacyEffects(actorId, { day = 0, place = '', mode = '' } = {}) {
  const parts = [String(day), place, mode].filter(Boolean);
  return [
    { path: `actors.${actorId}.intimacy.count`, op: 'add', value: 1 },
    { path: `actors.${actorId}.intimacy.last`, op: 'set', value: parts.join('，') },
  ];
}

/**
 * 当前是不是被暂停了，以及为什么。
 * 三个来源都取自既有状态，不新增判断口径：
 *   医嘱禁欲 → `flags.abstained`（E32/A 落的）
 *   明确拒绝 → `consent[<id>].state === 'refused'`
 *   路线未开 → `routes[<id>]` 为 closed / 缺失
 */
export function pauseReason(state, id) {
  if (state?.flags?.abstained === true) return '医嘱禁欲期';
  const c = state?.consent?.[id];
  if (c && c.state === 'refused') return '角色已明确拒绝';
  const route = state?.routes?.[id];
  if (!route || route === 'closed') return '路线未开启';
  return null;
}

/**
 * 面板用：每个角色的亲密状态摊平。
 * @param {object} state
 * @param {object} world
 * @param {string[]} ids 要出卡的角色
 */
export function intimacyBoard(state, world, ids = []) {
  const out = [];
  for (const id of ids) {
    const a = state?.actors?.[id];
    if (!a) continue;
    const rec = a.intimacy ?? { count: 0, last: '' };
    const c = state?.consent?.[id];
    out.push({
      id,
      name: a.name,
      count: Number(rec.count) || 0,
      last: rec.last ?? '',
      consent: c?.state ?? 'unspoken',
      desire: a.stats?.desire ?? null,
      paused: pauseReason(state, id),
    });
  }
  return out;
}

/** 一行摘要，给面板/抽屉用。 */
export function intimacyLine(entry) {
  const bits = [`累计 ${entry.count} 次`];
  bits.push(entry.last ? `最近：${entry.last}` : '最近：无记录');
  if (entry.desire !== null) bits.push(`性欲望 ${entry.desire}`);
  if (entry.paused) bits.push(`暂停中（${entry.paused}）`);
  return bits.join(' · ');
}
