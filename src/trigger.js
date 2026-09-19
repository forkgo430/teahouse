/**
 * 触发表（设定文档 §16「关键词 → 线索 / 事件 / 系统的**唯一映射表**」）。
 *
 * 文档 §16.2 的规则里有两条决定了这里该怎么写：
 *   - 「条目按调查进度分阶段释放」→ 阶段没到的不提示；
 *   - 「线索出现须有来源，不凭空掉」→ 只提示**已持有**的线索，
 *     绝不把还没拿到的东西漏给模型（漏了等于让模型提前写出来）。
 *
 * 所以这个模块的职责是**收着说**：命中关键词时只告诉模型三件事
 *   「这个词关联的哪几件事还没发生（别提前写）」
 *   「哪几条线索你已经拿到了」
 *   「调查相位到哪了」
 * 而不是把整张表倒出去。
 */

/** 玩家原话命中了哪些关键词（纯字符串包含，可判定）。 */
export function matchTriggers(text, table) {
  const t = String(text ?? '');
  if (!t) return [];
  return (table ?? []).filter(row => row.keyword && t.includes(row.keyword));
}

/**
 * 把命中的关键词整理成一小段提示。
 * @returns {string} 空串表示没什么可说的（调用方据此跳过注入）
 */
export function triggerNote(hits, state, world) {
  if (!hits?.length) return '';
  const stage = Number(state?.flags?.case_stage) || 0;
  const done = new Set((state?.history ?? []).map(h => h.eventId));
  const lines = [];

  for (const h of hits) {
    const bits = [];

    for (const s of h.stages ?? []) {
      if (stage >= s) bits.push(`调查已到阶段${s}`);
    }
    for (const c of h.clues ?? []) {
      if (state?.clues?.includes(c)) bits.push(`线索 ${c} 已持有`);
    }

    // 只报「还没发生过」的相关事件，并明说别提前写 —— 这是防剧透的关键一句
    const pending = (h.events ?? []).filter(id => !done.has(id));
    if (pending.length) bits.push(`相关未发生：${pending.join(' / ')}（不要提前写出来）`);

    if (bits.length) lines.push(`· 「${h.keyword}」→ ${bits.join('；')}`);
  }
  return lines.join('\n');
}
