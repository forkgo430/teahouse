/**
 * 快捷动作（用户点名的「按你说的高效做法」）。
 *
 * 为什么不做 STscript 那套语言：我们已经有**茶馆小二**——一个跑真 JavaScript 的沙箱，
 * 它能做的比 STscript 多。STscript 唯一还有个价值的是 **Quick Reply 的交互形态**：
 * 「把一段常用操作绑成按钮」。所以我们只抄**按钮**，不抄**语言**。
 *
 * 一条动作就是一行声明（不写解析器，只按 ` | ` 切三段）：
 *
 *     标签 | 类型 | 内容
 *     先喝口茶 | say    | 他去厨房烧了壶水，回来时手里多了一杯。
 *     松一口气 | effect | actors.seeker.stats.pressure sub 5
 *     存个档   | builtin| save
 *
 * 类型：`say`（替他发一句话）/ `effect`（直接改状态）/ `builtin`（存档那几样）。
 * 多条 effect 用 `;` 分隔。
 *
 * 这个模块是**纯函数**，不碰 DOM、不碰存储 —— 解析与执行分离，方便测。
 */

export const ACTION_KINDS = Object.freeze(['say', 'effect', 'builtin']);

/** 内置动作：直接映射到 UI 里已有的那几个函数 */
export const BUILTIN_ACTIONS = Object.freeze({
  save: '存档',
  load: '读档',
  undo: '回退一步',
  restart: '重新开始',
});

/** 引擎支持的运算（和 src/state.js 的 applyEffectInPlace 对齐） */
const OPS = Object.freeze(['set', 'add', 'sub', 'mul', 'push', 'pull', 'clamp']);

function coerce(raw) {
  const t = String(raw).trim();
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t === 'null') return null;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  return t;
}

/**
 * 解析一条 `path op value` 的 effect 声明。
 * value 允许带空格（取剩下全部），所以只按前两个空白切。
 */
export function parseEffectSpec(spec) {
  const m = String(spec ?? '').trim().match(/^(\S+)\s+(\S+)\s+([\s\S]*)$/);
  if (!m) {
    return { ok: false, why: `effect 要写成「路径 运算 值」，收到：${String(spec ?? '').trim() || '(空)'}` };
  }
  const [, path, op, rest] = m;
  if (!OPS.includes(op)) {
    return { ok: false, why: `不认识的运算「${op}」（可用：${OPS.join(' / ')}）` };
  }
  if (op === 'clamp') {
    return { ok: false, why: 'clamp 需要 {min,max} 结构，这里不开放 —— 请用 set/add/sub' };
  }
  if (!path.includes('.')) {
    return { ok: false, why: `路径要带点，例如 actors.seeker.stats.trust，收到「${path}」` };
  }
  return { ok: true, effect: { path, op, value: coerce(rest) } };
}

/**
 * 解析一整份动作表（每行一条）。**非法行不静默**：逐条带行号报出来。
 * @returns {{actions: object[], issues: Array<{line:number, why:string, text:string}>}}
 */
export function parseActions(text) {
  const actions = [];
  const issues = [];
  const lines = String(text ?? '').split('\n');
  const seen = new Set();

  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;         // 空行与注释
    const parts = line.split('|').map(s => s.trim());
    if (parts.length < 3) {
      issues.push({ line: i + 1, text: line, why: '要写成「标签 | 类型 | 内容」三段' });
      return;
    }
    const [label, kind, ...restParts] = parts;
    const body = restParts.join('|').trim();            // 内容里允许出现 |

    if (!label) { issues.push({ line: i + 1, text: line, why: '标签不能为空' }); return; }
    if (!ACTION_KINDS.includes(kind)) {
      issues.push({ line: i + 1, text: line, why: `类型只能是 ${ACTION_KINDS.join(' / ')}，收到「${kind}」` });
      return;
    }
    if (seen.has(label)) {
      issues.push({ line: i + 1, text: line, why: `标签「${label}」重复了` });
      return;
    }
    if (!body) { issues.push({ line: i + 1, text: line, why: '内容不能为空' }); return; }

    if (kind === 'effect') {
      const effects = [];
      let bad = null;
      for (const spec of body.split(';').map(s => s.trim()).filter(Boolean)) {
        const r = parseEffectSpec(spec);
        if (!r.ok) { bad = r.why; break; }
        effects.push(r.effect);
      }
      if (bad) { issues.push({ line: i + 1, text: line, why: bad }); return; }
      seen.add(label);
      actions.push({ label, kind, effects });
      return;
    }

    if (kind === 'builtin') {
      if (!Object.keys(BUILTIN_ACTIONS).includes(body)) {
        issues.push({
          line: i + 1, text: line,
          why: `没有这个内置动作「${body}」（可用：${Object.keys(BUILTIN_ACTIONS).join(' / ')}）`,
        });
        return;
      }
      seen.add(label);
      actions.push({ label, kind, builtin: body });
      return;
    }

    seen.add(label);
    actions.push({ label, kind, text: body });
  });

  return { actions, issues };
}

/** 把动作表还原成文本（设置里编辑用）。 */
export function formatActions(actions) {
  return (actions ?? []).map((a) => {
    if (a.kind === 'effect') {
      const body = a.effects.map(e => `${e.path} ${e.op} ${e.value}`).join('; ');
      return `${a.label} | effect | ${body}`;
    }
    if (a.kind === 'builtin') return `${a.label} | builtin | ${a.builtin}`;
    return `${a.label} | say | ${a.text}`;
  }).join('\n');
}

/** 出厂自带几条，既是示例也是真能用的。 */
export const DEFAULT_ACTIONS_TEXT = [
  '# 一行一条：标签 | 类型 | 内容',
  '# 类型：say（替他发一句话）/ effect（直接改状态）/ builtin（存档那几样）',
  '存个档 | builtin | save',
  '回退一步 | builtin | undo',
  '喝口热水 | say | 他去厨房烧了壶水，回来时手里多了一杯。',
  '松一口气 | effect | actors.seeker.stats.pressure sub 5',
].join('\n');
