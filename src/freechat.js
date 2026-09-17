/**
 * 自由对话驱动 —— 与「事件驱动」并列的第二种玩法。
 *
 * 事件驱动：引擎先从事件池选事件与分支（发生什么），模型只决定这一轮怎么写。
 * 自由对话：玩家直接说话，模型直接回；引擎不选分支、不推进事件。
 *          状态改动仍由**模型提出申请、引擎审核后应用** ——
 *          自由的是"怎么说"，不是"谁持有权威状态"。
 *
 * 群聊：在场角色可以各自开口，模型按【角色名】分段，解析后每条带 speaker。
 *
 * 与酒馆（SillyTavern, 33.5k★）的关系：做法参考它的群聊与人物设定，
 * **代码全部自写** —— 酒馆是 AGPL-3.0，传染性强，不能直接搬。
 */

/** 发言者标记：形如「【林晚晴】……」或「[林晚晴]……」 */
const SPEAKER_RE = /^\s*[【\[]([^】\]]{1,16})[】\]]\s*/;

/** 玩家设定（persona）拼成提示词的一行；没填就返回空串 */
export function personaLines(persona) {
  if (!persona) return '';
  const name = String(persona.name ?? '').trim();
  const desc = String(persona.desc ?? '').trim();
  if (!name && !desc) return '';
  const who = name ? `玩家扮演：${name}` : '玩家扮演的角色（未命名）';
  return desc ? `${who}。设定：${desc}` : `${who}。`;
}

/**
 * 把玩家设定放到指定位置。
 *
 * 做法参考酒馆 persona 的 `position` / `depth` / `role`
 * （SillyTavern，AGPL-3.0，只取思路、代码自写）：
 *
 *   in-prompt（默认）—— 拼进 system 提示
 *   top              —— 单独一条，放在最前
 *   bottom           —— 单独一条，紧贴玩家这句话之前
 *   at-depth         —— 插在距末尾 depth 条处（depth 0 = 紧贴末尾）
 *
 * 为什么要能换位置：设定放 system 里最省事，但离当前这句太远时，
 * 模型对「你是谁」的注意力会掉；放在末尾（bottom / at-depth）能把它拉回来。
 * role 也可选 user / assistant —— 有些模型对 system 里的「第一人称设定」反应更好。
 */
export function placePersona(messages, persona) {
  const line = personaLines(persona);
  if (!line) return messages;

  const position = String(persona?.position ?? 'in-prompt');
  const role = ['system', 'user', 'assistant'].includes(persona?.role)
    ? persona.role : 'system';
  const rawDepth = Number(persona?.depth);
  const depth = Number.isFinite(rawDepth) && rawDepth >= 0 ? Math.floor(rawDepth) : 4;

  // 默认：拼进 system（最省 token，也是原来的行为）
  if (position === 'in-prompt') {
    const head = messages[0] ?? { role: 'system', content: '' };
    return [{ role: 'system', content: `${head.content}\n\n${line}` }, ...messages.slice(1)];
  }

  if (position === 'top') return [{ role, content: line }, ...messages];

  if (position === 'bottom') {
    const out = messages.slice();
    out.splice(Math.max(1, out.length - 1), 0, { role, content: line });
    return out;
  }

  // at-depth：从末尾往上数 depth 条。下限 1 —— system 不能被挤到后面去。
  const at = Math.max(1, messages.length - depth);
  const out = messages.slice();
  out.splice(at, 0, { role, content: line });
  return out;
}

/**
 * 组装自由对话的 messages。
 * history 里每条记录：said = 玩家当时说的话，text = 当时看到的正文。
 */
export function buildFreeMessages({
  brief = '', situation = '', history = [], playerText = '',
  persona = null, group = false, actors = [], lore = '', speakers = [],
} = {}) {
  const names = actors.map(a => a?.name).filter(Boolean);

  const rules = [
    '这是即兴的角色扮演。玩家说什么，你就答什么 —— 不要推进预设的剧情节点，只用对话与场景回应。',
    '不要替玩家发言、不要替玩家做决定、不要写玩家没做过的动作。',
  ];
  if (group && names.length > 0) {
    rules.push(`当前场景里可能有这些角色在场：${names.join('、')}。`);
    rules.push(
      '每次回复按发言者分段，每段以【角色名】开头（例如「【' + names[0] + '】……」）。'
      + '只有确实开口或行动的角色才分段；纯场景描写单独成段，不加标记。',
    );
    // 这一轮谁开口：不提这一句，模型容易让全部角色各说一句，像排队发言
    if (speakers.length > 0 && speakers.length < names.length) {
      rules.push(`这一轮请让这些角色回应：${speakers.join('、')}。其余人可以不说话。`);
    }
  } else if (names.length > 0) {
    rules.push(`当前场景里的角色：${names.join('、')}。用第二人称叙述。`);
  }

  const system = [
    brief,
    situation,
    rules.join('\n'),
    lore,
  ].filter(s => s && String(s).trim()).join('\n\n');

  const messages = [{ role: 'system', content: system }];
  for (const rec of history) {
    if (rec?.said) messages.push({ role: 'user', content: String(rec.said) });
    if (rec?.text) messages.push({ role: 'assistant', content: String(rec.text) });
  }
  messages.push({ role: 'user', content: String(playerText ?? '') });

  // 玩家设定最后放 —— 位置由 persona.position 决定
  return placePersona(messages, persona);
}

/**
 * 把模型输出切成若干段。
 * 带【名字】的行开新段；其余行并进当前段。
 * 整段都没有标记时 → 单段（speaker 为 null），照样能显示。
 * known 给了就只认名单里的名字，免得把「【旁白】」这类当角色。
 */
export function parseSegments(raw, { known = [] } = {}) {
  const text = String(raw ?? '').trim();
  if (!text) return [];

  const out = [];
  let cur = null;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (cur) cur.text += '\n';
      continue;
    }
    const hit = SPEAKER_RE.exec(trimmed);
    if (hit) {
      const name = hit[1].trim();
      if (known.length === 0 || known.includes(name)) {
        if (cur) out.push(cur);
        cur = { speaker: name, text: trimmed.slice(hit[0].length).trim() };
        continue;
      }
    }
    if (!cur) cur = { speaker: null, text: trimmed };
    else cur.text += (cur.text ? '\n' : '') + trimmed;
  }
  if (cur) out.push(cur);

  return out
    .map(s => ({ speaker: s.speaker, text: s.text.trim() }))
    .filter(s => s.text);
}

/**
 * 这一轮谁开口。
 *
 * 做法参考酒馆的 `activation_strategy`（SillyTavern，AGPL-3.0，只取设计思路、
 * 代码自写）：
 *   natural —— 玩家这句话里点到谁的名字，就激活谁；一个都没点到则在场全体
 *   list    —— 在场全体都激活（让模型自己挑谁说）
 *   manual  —— 随机挑一个
 *
 * 另外学它一条：**上一条的发言者默认不再接话**（除非 allowSelf），
 * 否则同一个角色容易连说两段，像自言自语。
 */
export function pickSpeakers({
  actors = [], playerText = '', strategy = 'natural',
  lastSpeaker = null, allowSelf = false,
} = {}) {
  const alive = actors.filter(a => a && a.name && !a.disabled);
  if (alive.length === 0) return [];

  const notLast = alive.filter(a => allowSelf || a.name !== lastSpeaker);
  const pool = notLast.length > 0 ? notLast : alive;

  if (strategy === 'list') return alive;
  if (strategy === 'manual') {
    return [pool[Math.floor(Math.random() * pool.length)]];
  }

  // natural：按名字命中（点名谁，谁答）
  const text = String(playerText ?? '');
  const hit = alive.filter(a => text.includes(a.name));
  return hit.length > 0 ? hit : pool;
}

/** 段落合成一条纯文本（存档与上下文裁剪都读 text） */
export function segmentsToText(segments) {
  return (segments ?? [])
    .map(s => (s.speaker ? `【${s.speaker}】${s.text}` : s.text))
    .join('\n\n');
}
