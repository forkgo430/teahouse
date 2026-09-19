/**
 * 资源调用系统（设定文档 §18 资源调用系统 / §10.1 资源与事件的绑定）。
 *
 * 为什么单独一层：
 *   文档里「律师朋友 / 银行渠道 / 警方熟人 / 世界管家团队 / 政界新星」各有用途、
 *   代价与触发事件，但之前的实现里它们**只是账本上的一行文案** ——
 *   没有可调用入口、没有冷却、没有成本、没有前置，调用与否全靠模型在正文里"提一嘴"。
 *   那不是机制，是布景。
 *
 * 设计原则（和引擎其余部分一致）：
 *   - 调用是**引擎动作**，不是模型动作：模型只能选分支，调用与否由玩家点、由引擎算。
 *   - 代价与推进**全部落成 effects**，所以会进 `【已经发生的变化】`，模型写正文时
 *     看到的就是既成事实，不会写成"你打了个电话就什么都知道了"。
 *   - 冷却与次数记在 **flags** 上（`flags.res_<id>_calls` / `_day`），
 *     不新增 state 字段 —— flags 是可写的、可判定的、也进存档指纹。
 *   - §18 明确「资源不自动等于亲密同意」：这里**绝不产生任何 consent / routes 效果**。
 */

/** flags 上记录调用用的键。命名空间隔离，避免和内容层的 flag 撞。 */
export function resourceFlags(id) {
  return { calls: `res_${id}_calls`, day: `res_${id}_day` };
}

function flagOf(state, key) {
  const v = state?.flags?.[key];
  return Number.isFinite(v) ? v : (v === undefined ? null : null);
}

/**
 * 能不能调用。
 * @returns {{ok:boolean, reason?:string, def?:object, effects?:Array}}
 */
export function callResource(state, world, id) {
  const def = (world?.resources ?? []).find(r => r.id === id);
  if (!def) return { ok: false, reason: `没有这个资源：${id}` };

  const f = resourceFlags(id);
  const calls = flagOf(state, f.calls) ?? 0;
  const lastDay = flagOf(state, f.day);
  const day = state?.clock?.day ?? 0;

  if (def.once && calls > 0) {
    return { ok: false, reason: `${def.name}只能用一次，已经用过了` };
  }

  const cd = Number(def.cooldownDays) || 0;
  if (lastDay !== null && cd > 0) {
    const wait = cd - (day - lastDay);
    if (wait > 0) {
      return { ok: false, reason: `${def.name}上次是第 ${lastDay} 天用的，还要等 ${wait} 天` };
    }
  }

  /* 代价不足就别让他点 —— 摆出来却点不动比不给更糟（引擎里一贯的做法） */
  const need = Number(def.expense) || 0;
  if (need > 0) {
    const cash = Number(state?.ledger?.cash);
    if (Number.isFinite(cash) && cash < need) {
      return { ok: false, reason: `${def.name}要花 ${need}，账上不够` };
    }
  }

  const effects = [
    { path: `flags.${f.calls}`, op: 'add', value: 1 },
    { path: `flags.${f.day}`, op: 'set', value: day },
  ];
  if (def.stageGain) {
    effects.push({ path: 'flags.case_stage', op: 'add', value: Number(def.stageGain) });
  }
  if (need > 0) effects.push({ path: 'ledger.expense', op: 'add', value: need });
  if (def.cash) effects.push({ path: 'ledger.cash', op: 'add', value: -Math.abs(Number(def.cash)) });

  // 文档 §10.1：调用可能改变角色的安全感与信任（不是同意）
  for (const [who, v] of Object.entries(def.trust ?? {})) {
    effects.push({ path: `actors.${who}.stats.trust`, op: 'add', value: Number(v) });
  }
  for (const [who, v] of Object.entries(def.safety ?? {})) {
    effects.push({ path: `actors.${who}.stats.safety`, op: 'add', value: Number(v) });
  }

  return { ok: true, def, effects };
}

/** 面板/抽屉用：把每个资源当前的可调用状态摊平。 */
export function resourceBoard(state, world) {
  return (world?.resources ?? []).map((def) => {
    const r = callResource(state, world, def.id);
    const f = resourceFlags(def.id);
    return {
      id: def.id,
      name: def.name,
      uses: def.uses ?? [],
      cost: Number(def.expense) || 0,
      lastDay: flagOf(state, f.day),
      calls: flagOf(state, f.calls) ?? 0,
      available: r.ok,
      reason: r.reason ?? null,
      note: def.note ?? def.risk ?? '',
    };
  });
}
