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
 * 组装自由对话的 messages。
 * history 里每条记录：said = 玩家当时说的话，text = 当时看到的正文。
 */
export function buildFreeMessages({
  brief = '', situation = '', history = [], playerText = '',
  persona = null, group = false, actors = [], lore = '',
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
  } else if (names.length > 0) {
    rules.push(`当前场景里的角色：${names.join('、')}。用第二人称叙述。`);
  }

  const system = [
    brief,
    situation,
    personaLines(persona),
    rules.join('\n'),
    lore,
  ].filter(s => s && String(s).trim()).join('\n\n');

  const messages = [{ role: 'system', content: system }];
  for (const rec of history) {
    if (rec?.said) messages.push({ role: 'user', content: String(rec.said) });
    if (rec?.text) messages.push({ role: 'assistant', content: String(rec.text) });
  }
  messages.push({ role: 'user', content: String(playerText ?? '') });
  return messages;
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

/** 段落合成一条纯文本（存档与上下文裁剪都读 text） */
export function segmentsToText(segments) {
  return (segments ?? [])
    .map(s => (s.speaker ? `【${s.speaker}】${s.text}` : s.text))
    .join('\n\n');
}
