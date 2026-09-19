/**
 * 「模型可提 effects」—— 设定文档之外、由用户点名要的一档能力。
 *
 * 这是整个引擎里唯一动到「**谁能改状态**」的地方，所以规则**写死在代码里**，
 * 不靠提示词里的君子协定：
 *
 *   白名单 —— 只准动：描写字段、数值、开销、氛围 flag
 *   黑名单 —— 线索 / 调查阶段 / 路线 / 同意边界 / 结局 / 成就 / history / clock 一律不认。
 *             这八样是**骨架**：它们一变，84 个事件、23 条线索、28 个结局就全不算数了。
 *   数值   —— 只准 add/sub，单轮 |Δ| ≤ 8（engine 还会按 bounds 夹取）
 *   条数   —— 单轮 ≤ 3
 *   不静默 —— 被丢掉的逐条记下原因，界面上看得见（这个项目的铁律）
 *
 * 一句话：**让模型动"描写"，不让它动"骨架"。**
 */

export const PROPOSE_LIMIT = 3;
/** 数值（信任/压力之类）的单轮幅度上限 */
export const PROPOSE_MAX_DELTA = 8;
/** 金钱的上限另算 —— 开销动辄上万，用 ±8 卡它等于把这条路径废掉 */
export const PROPOSE_MAX_MONEY = 200000;

/** 提示词里要求的输出形状。改这里必须同时改 extractProposals 的解析。 */
export const PROPOSE_OPEN = '【状态变更】';
export const PROPOSE_CLOSE = '【/状态变更】';

const ALLOW = [
  /^actors\.[A-Za-z0-9_]+\.stats\.[A-Za-z0-9_]+$/,
  // routes / case_stage 只在 wide 档放行 —— 白名单档由 DENY_STRICT 挡回去。
  // 必须出现在这里，否则 wide 档会因为"不在白名单"而被拒，等于 wide 是个空档。
  /^routes\.[A-Za-z0-9_]+$/, /^flags\.case_stage$/,
  /^actors\.[A-Za-z0-9_]+\.(emotion|publicRelation|profile|wearing|bodyState|hiddenIntent)$/,
  /^ledger\.expense$/,
  /^flags\.(mood|weather|ambient|note)_[A-Za-z0-9_]+$/,
];

/** 任何档位都不许碰（引擎自有） */
const DENY_CORE = [
  /^clues/, /^consent/, /^endings/, /^achievements/, /^history/, /^clock/,
  /^actors\.[A-Za-z0-9_]+\.(intimacy|met|bounds|id|name|age)$/,
];

/** 只有 whitelist 档挡、wide 档放开（骨架里"可容忍"的那两样） */
const DENY_STRICT = [/^flags\.case_stage$/, /^routes/];

const NUM_OPS = ['add', 'sub'];

/**
 * 校验一组模型提交的 effects。
 * @returns {{accepted: object[], rejected: Array<{effect:unknown, why:string}>}}
 */
export function validateProposals(list, { limit = PROPOSE_LIMIT, maxDelta = PROPOSE_MAX_DELTA, maxMoney = PROPOSE_MAX_MONEY, tier = 'whitelist' } = {}) {
  const accepted = [];
  const rejected = [];
  const drop = (effect, why) => rejected.push({ effect, why });
  const deny = tier === 'wide' ? DENY_CORE : [...DENY_CORE, ...DENY_STRICT];

  if (!Array.isArray(list)) {
    drop(list, '不是一个数组');
    return { accepted, rejected };
  }

  for (const raw of list) {
    if (accepted.length >= limit) { drop(raw, `超过单轮上限（${limit} 条）`); continue; }
    if (!raw || typeof raw !== 'object') { drop(raw, '不是对象'); continue; }

    const { path, op, value } = raw;
    if (typeof path !== 'string' || !path) { drop(raw, '缺少 path'); continue; }
    if (deny.some(re => re.test(path))) { drop(raw, `碰了骨架（${path} 只由分支 effects 决定）`); continue; }
    if (!ALLOW.some(re => re.test(path))) { drop(raw, `不在白名单里（${path}）`); continue; }

    /* wide 档专属的两条：调查阶段是**数值**、路线是**字符串** ——
       不先把它们拦下来，下面的分支会按"flag 只收布尔/字符串"把它们全丢掉，
       wide 档就变成个空档。 */
    if (tier === 'wide') {
      if (path === 'flags.case_stage') {
        if (!NUM_OPS.includes(op) || !Number.isFinite(value)) { drop(raw, '调查阶段只准小幅增减'); continue; }
        accepted.push({ path, op, value: Math.sign(value) });   // 一次最多一格
        continue;
      }
      if (path.startsWith('routes.')) {
        if (op !== 'set' || typeof value !== 'string') { drop(raw, '路线只准 set 成字符串'); continue; }
        accepted.push({ path, op: 'set', value });
        continue;
      }
    }

    // 描写字段：set 字符串
    if (/^actors\.[A-Za-z0-9_]+\.(emotion|publicRelation|profile|wearing|bodyState|hiddenIntent)$/.test(path)) {
      if (op !== 'set') { drop(raw, '描写字段只准 set'); continue; }
      if (typeof value !== 'string' || value.length > 60) { drop(raw, '描写必须是 ≤60 字的字符串'); continue; }
      accepted.push({ path, op: 'set', value });
      continue;
    }

    // 数值 / 开销：只准 add / sub，且有单轮上限
    if (!NUM_OPS.includes(op)) { drop(raw, `只准 ${NUM_OPS.join(' / ')}，收到 ${String(op)}`); continue; }
    if (!Number.isFinite(value)) { drop(raw, '值不是有限数字'); continue; }
    const delta = Math.abs(value);
    if (delta === 0) { drop(raw, '变化量为 0'); continue; }
    // 钱和数值的上限不是一回事：信任 +8 已经很大，开销 +8 什么都干不了
    const cap = path === 'ledger.expense' ? maxMoney : maxDelta;
    if (delta > cap) { drop(raw, `单轮变化幅度超过 ${cap}（${value}）`); continue; }

    // 氛围 flag：只准 set 布尔/字符串
    if (path.startsWith('flags.')) {
      if (typeof value !== 'boolean' && typeof value !== 'string') { drop(raw, '氛围 flag 只收布尔或字符串'); continue; }
      accepted.push({ path, op: 'set', value });
      continue;
    }

    accepted.push({ path, op, value });
  }

  return { accepted, rejected };
}

/**
 * 从模型输出里把【状态变更】块取出来，并返回**去掉它之后**的正文。
 * 取不出来就当模型没提（不报错、不阻断叙事）。
 */
export function extractProposals(text) {
  const raw = String(text ?? '');
  const i = raw.indexOf(PROPOSE_OPEN);
  if (i < 0) return { clean: raw, list: null };
  const j = raw.indexOf(PROPOSE_CLOSE, i + PROPOSE_OPEN.length);
  const body = j < 0
    ? raw.slice(i + PROPOSE_OPEN.length)
    : raw.slice(i + PROPOSE_OPEN.length, j);
  const clean = (raw.slice(0, i) + (j < 0 ? '' : raw.slice(j + PROPOSE_CLOSE.length)))
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  let list = null;
  try {
    list = JSON.parse(body.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim());
  } catch {
    list = null;   // 格式不对 → 当没提
  }
  return { clean, list };
}
