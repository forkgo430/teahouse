/**
 * 示例数据 —— 题材：都市旧公寓的一夜。
 *
 * 用途：验证引擎闭环
 *
 * 数据形状即教材：
 *   · 事件怎么写、条件怎么判、数值怎么影响分支，全在这一个文件里；
 *   · branch.keywords 是自由输入的匹配词（纯规则解析，不依赖模型）；
 *   · WORLD_BRIEF 只在接入模型时作为背景注入，玩家看不到。
 */

import { createInitialState } from '../src/schema.js';
import { createWorld } from '../src/engine.js';

/* ------------------------------------------------------------------ *
 * 世界观（给模型用的简短背景）
 * ------------------------------------------------------------------ */

export const OPENING = '你刚搬进这栋旧楼的第一夜。行李还没拆完，窗外的雨一直没停，门外传来脚步声。';

export const WORLD_BRIEF = `现代都市，一栋建了三十多年的旧公寓楼。
玩家是刚搬进来的住户，第一夜就发现这栋楼不太对劲：深夜有脚步声、门上被贴过通知、配电箱的检修记录被人用铅笔改过。
楼里目前只认识两个人：管理员老陈（五十多岁，话少，知道的事比说的多）、楼上住户苏黎（三十岁上下，警觉，最近睡不好）。
基调：克制的都市悬疑。写实、不夸张、不出现超自然解释。紧张感来自细节和留白，不靠形容词堆砌。`;

/* ------------------------------------------------------------------ *
 * 角色与数值
 * ------------------------------------------------------------------ */

export const ACTORS = [
  {
    id: 'keeper',
    name: '老陈（管理员）',
    stats: [
      { key: 'trust', label: '信任', min: 0, max: 100, init: 20 },
      { key: 'guard', label: '戒备', min: 0, max: 100, init: 60 },
    ],
  },
  {
    id: 'neighbor',
    name: '苏黎（楼上住户）',
    stats: [
      { key: 'trust', label: '信任', min: 0, max: 100, init: 10 },
      { key: 'fear', label: '不安', min: 0, max: 100, init: 50 },
    ],
  },
];

/* ------------------------------------------------------------------ *
 * 线索
 * ------------------------------------------------------------------ */

export const CLUES = {
  C01: '深夜的脚步声',
  C02: '门上的通知',
  C03: '配电箱的检修记录',
  C04: '一张旧照片',
};

/* ------------------------------------------------------------------ *
 * 事件
 * ------------------------------------------------------------------ */

export const EVENTS = [
  {
    id: 'E01',
    title: '门外有人',
    when: { day: 1, slot: 'night' },
    where: 'room',
    priority: 100,
    actors: ['keeper'],
    firstMet: ['keeper'],
    require: null,
    fallback: 'A',
    branches: [
      {
        key: 'A',
        label: '开门',
        keywords: ['开门', '打开门', '让他进来', '见见他', '应门'],
        cond: null,
        text: '你拧开锁。门外站着管理员老陈，手里捏着一串钥匙。他上下打量你一眼，说这栋楼夜里不太平，让你把门锁好。',
        effects: [
          { path: 'actors.keeper.stats.trust', op: 'add', value: 10 },
          { path: 'actors.keeper.stats.guard', op: 'sub', value: 5 },
          { path: 'where', op: 'set', value: 'corridor' },
          { path: 'clues', op: 'push', value: 'C01' },
          { path: 'flags.met_keeper', op: 'set', value: true },
        ],
        unlock: { route: { actor: 'keeper', state: 'open' } },
      },
      {
        key: 'B',
        label: '装作没听见',
        keywords: ['装没听见', '不理', '假装', '不出声', '安静待着'],
        cond: null,
        text: '你没有出声。脚步声在门口停了很久，然后是钥匙串轻碰的响动，再之后是拖鞋声沿走廊远去。',
        effects: [
          { path: 'actors.keeper.stats.guard', op: 'add', value: 10 },
          { path: 'clues', op: 'push', value: 'C01' },
          { path: 'flags.ignored', op: 'set', value: true },
        ],
      },
      {
        key: 'C',
        label: '从猫眼往外看',
        keywords: ['猫眼', '看看是谁', '看一眼', '偷看', '瞄一眼'],
        cond: { path: 'flags.met_keeper', op: '!=', value: true },
        text: '你凑到猫眼前。走廊的灯坏了一半，一个人影背对着你在墙上贴什么，贴完就走了。',
        effects: [
          { path: 'clues', op: 'push', value: 'C02' },
          { path: 'flags.saw_notice', op: 'set', value: true },
        ],
      },
    ],
  },

  {
    id: 'E02',
    title: '走廊尽头',
    when: { day: 1, slot: 'night' },
    where: 'corridor',
    priority: 90,
    actors: ['keeper', 'neighbor'],
    require: { path: 'flags.met_keeper', op: '==', value: true },
    fallback: 'A',
    branches: [
      {
        key: 'A',
        label: '跟上去问两句',
        keywords: ['跟上去', '问问', '问他', '搭话', '聊两句'],
        cond: null,
        text: '你跟上去。老陈停在楼梯口，说这栋楼前几年改过线路，配电箱一直没换。他让你别去天台。',
        effects: [
          { path: 'actors.keeper.stats.trust', op: 'add', value: 15 },
          { path: 'clues', op: 'push', value: 'C03' },
          { path: 'flags.asked_about_building', op: 'set', value: true },
        ],
      },
      {
        key: 'B',
        label: '回房间把门反锁',
        keywords: ['回房间', '回屋', '反锁', '回去睡', '不聊了'],
        cond: null,
        text: '你回了房间，把门反锁，把钥匙插在锁孔里。',
        effects: [{ path: 'where', op: 'set', value: 'room' }],
      },
      {
        key: 'C',
        label: '不跟了，自己上顶层看看',
        keywords: ['上顶层', '上天台', '上楼顶', '自己上去', '上楼看看'],
        cond: null,
        text: '你没跟上去，转身往楼上走。楼梯比想象中长，声控灯一层层亮起来又灭掉。顶层有一扇铁门，门缝里透出天光。',
        effects: [{ path: 'where', op: 'set', value: 'roof' }],
      },
    ],
  },

  {
    id: 'E03',
    title: '窗玻璃上的动静',
    when: { day: 1, slot: 'night' },
    where: 'room',
    priority: 50,
    require: { path: 'flags.ignored', op: '==', value: true },
    fallback: 'A',
    branches: [
      {
        key: 'A',
        label: '贴着墙听',
        keywords: ['贴墙', '贴着墙', '仔细听', '听声音', '听听'],
        cond: null,
        text: '你把耳朵贴上墙。楼上有拖动家具的声音，一下，又一下，中间隔得很均匀。不像人走路的节奏。',
        effects: [
          { path: 'clues', op: 'push', value: 'C01' },
          { path: 'flags.heard_upstairs', op: 'set', value: true },
        ],
      },
      {
        key: 'B',
        label: '蒙头睡觉',
        keywords: ['睡觉', '蒙头', '不管了', '休息', '躺下'],
        cond: null,
        text: '你把被子拉到头顶。声音持续了半夜，后来你也不知道自己是什么时候睡着的。',
        effects: [{ path: 'flags.slept', op: 'set', value: true }],
      },
    ],
  },

  {
    id: 'E04',
    title: '配电箱',
    when: { day: 2, slot: ['dawn', 'morning'] },
    where: 'corridor',
    priority: 80,
    require: { path: 'flags.asked_about_building', op: '==', value: true },
    fallback: 'A',
    branches: [
      {
        key: 'A',
        label: '打开配电箱看一眼',
        keywords: ['配电箱', '打开箱子', '检修', '看看箱子', '查看记录'],
        cond: null,
        text: '箱门是虚掩的。里面贴着一张检修单，最近一次签名是三年前，之后被人用铅笔补了几个日期。',
        effects: [
          { path: 'clues', op: 'push', value: 'C03' },
          { path: 'flags.opened_box', op: 'set', value: true },
        ],
      },
      {
        key: 'B',
        label: '路过就算了',
        keywords: ['路过', '算了', '不管', '走开', '没兴趣'],
        cond: null,
        text: '你没有停。箱门在你身后弹了一下，又合上了。',
        effects: [],
      },
      {
        key: 'C',
        label: '顺着楼梯上顶层',
        keywords: ['上楼顶', '上顶层', '上天台', '上楼看看'],
        cond: null,
        text: '你没管配电箱，顺着楼梯往上走。三层之上还有一段更窄的楼梯，尽头是一扇铁门。',
        effects: [{ path: 'where', op: 'set', value: 'roof' }],
      },
    ],
  },

  {
    id: 'E05',
    title: '天台的门',
    when: { day: 2, slot: ['morning', 'afternoon'] },
    where: 'roof',
    priority: 70,
    actors: ['neighbor'],
    firstMet: ['neighbor'],
    require: null,
    fallback: 'A',
    branches: [
      {
        key: 'A',
        label: '推开门',
        keywords: ['推门', '推开', '进去', '打开门', '上天台'],
        cond: null,
        text: '门没锁。天台上晾着几件衣服，风把它们吹得很直。一个年轻女人背对你站在栏杆边，听见声音回过头。她说她叫苏黎，住你楼上。',
        effects: [
          { path: 'actors.neighbor.stats.trust', op: 'add', value: 15 },
          { path: 'actors.neighbor.stats.fear', op: 'sub', value: 10 },
          { path: 'clues', op: 'push', value: 'C04' },
          { path: 'flags.met_neighbor', op: 'set', value: true },
        ],
        unlock: { route: { actor: 'neighbor', state: 'open' } },
      },
      {
        key: 'B',
        label: '转身下楼',
        keywords: ['下楼', '转身', '回去', '不下去'],
        cond: null,
        text: '你没上去。楼梯间的声控灯在你走到三楼时灭了。',
        effects: [{ path: 'where', op: 'set', value: 'room' }],
      },
    ],
  },

  {
    id: 'E06',
    title: '旧照片',
    when: { day: 2, slot: 'afternoon' },
    priority: 60,
    require: { path: 'clues', op: 'contains', value: 'C04' },
    fallback: 'A',
    branches: [
      {
        key: 'A',
        label: '仔细看',
        keywords: ['仔细看', '看照片', '细看', '研究', '看看照片'],
        cond: null,
        text: '照片是在这天台上拍的，背景里的栏杆和现在一样。照片右下角有个日期，比这栋楼建成的年份还早一年。',
        effects: [
          { path: 'actors.neighbor.stats.trust', op: 'add', value: 10 },
          { path: 'flags.examined_photo', op: 'set', value: true },
        ],
      },
      {
        key: 'B',
        label: '先收起来',
        keywords: ['收起来', '收起', '收好', '放好', '先放着'],
        cond: null,
        text: '你把照片夹进书里，顺手记下了日期。',
        effects: [{ path: 'flags.kept_photo', op: 'set', value: true }],
      },
    ],
  },

  {
    id: 'E07',
    title: '第三天夜里',
    when: { day: [3, 4, 5], slot: 'night' },
    priority: 200,
    actors: ['keeper', 'neighbor'],
    require: null,
    fallback: 'B',
    branches: [
      {
        key: 'A',
        label: '报警',
        keywords: ['报警', '打电话', '叫警察', '通知警察'],
        cond: null,
        text: '你拨了电话。接线员问清地址，说会派人过来。你把手机放在桌上，开了免提。',
        effects: [{ path: 'flags.called_police', op: 'set', value: true }],
      },
      {
        key: 'B',
        label: '留下，把事查清楚',
        keywords: ['留下', '查清楚', '自己查', '查明白', '不走'],
        cond: { path: 'clues[2]', op: 'exists' },
        text: '你把知道的几件事按顺序写在纸上，贴在门背后。明天去问老陈配电箱的事。',
        effects: [{ path: 'flags.stayed', op: 'set', value: true }],
      },
      {
        key: 'C',
        label: '天亮就搬走',
        keywords: ['搬走', '搬家', '走人', '离开这里', '不租了'],
        cond: null,
        text: '你打开手机找房子，把定金付了。这一夜剩下的时间你用来收拾行李。',
        effects: [{ path: 'flags.moved_out', op: 'set', value: true }],
      },
    ],
  },
];

/* ------------------------------------------------------------------ *
 * 成就与结局
 * ------------------------------------------------------------------ */

export const ACHIEVEMENTS = [
  { id: 'A01', title: '初次照面', cond: { path: 'actors.keeper.met', op: '==', value: true } },
  { id: 'A02', title: '楼上的人', cond: { path: 'actors.neighbor.met', op: '==', value: true } },
  { id: 'A03', title: '拼图完整', cond: { path: 'clues[3]', op: 'exists' } },
  { id: 'A04', title: '信任的代价', cond: { path: 'actors.keeper.stats.trust', op: '>=', value: 40 } },
];

export const ENDINGS = [
  {
    id: 'END01',
    title: '交给别人处理',
    priority: 30,
    note: '你报了警，剩下的事不再属于你。',
    cond: { path: 'flags.called_police', op: '==', value: true },
  },
  {
    id: 'END02',
    title: '留下来查清楚',
    priority: 20,
    note: '你决定把这一夜当成一个需要解开的结。',
    cond: {
      all: [
        { path: 'flags.stayed', op: '==', value: true },
        { path: 'clues[2]', op: 'exists' },
      ],
    },
  },
  {
    id: 'END03',
    title: '搬走',
    priority: 10,
    note: '你搬走了。有些事不知道答案也能过下去。',
    cond: { path: 'flags.moved_out', op: '==', value: true },
  },
];

/* ------------------------------------------------------------------ *
 * 工厂
 * ------------------------------------------------------------------ */

export const SLOT_LABELS = {
  dawn: '清晨',
  morning: '上午',
  afternoon: '午后',
  evening: '傍晚',
  night: '深夜',
};

export const PLACES = {
  room: '你的房间',
  corridor: '三楼走廊',
  roof: '天台',
};

/* ------------------------------------------------------------------ *
 * 世界书 —— 按关键词触发注入，而不是整段塞进上下文
 *
 * 格式与 SillyTavern / CharacterBook V2 对齐，社区里现成的世界书
 * 可以直接导入（见 src/importers.js）。
 * ------------------------------------------------------------------ */

export const WORLDBOOK = [
  {
    id: 'W01',
    heading: '旧楼',
    category: '概要',
    keys: [],
    constant: true,
    order: 10,
    content: '这栋楼建了三十多年，砖混结构，共六层，没有电梯。三楼以上走廊的声控灯常年坏着。',
  },
  {
    id: 'W02',
    heading: '配电箱',
    category: '主线',
    keys: ['配电箱', '电闸', '线路'],
    order: 60,
    content: '配电箱在三楼楼梯口，箱门虚掩。里面贴着一张检修单，最近一次签名是三年前，之后有人用铅笔补过几个日期。',
  },
  {
    id: 'W03',
    heading: '天台',
    category: '概要',
    keys: ['天台', '楼顶', '铁门'],
    order: 55,
    content: '通往天台的铁门从来没锁过。天台上拉着晾衣绳，风大的时候衣服会被吹得笔直。',
  },
  {
    id: 'W04',
    heading: '老陈',
    category: '主线',
    keys: ['老陈', '管理员'],
    order: 50,
    content: '老陈五十多岁，在这栋楼管了十几年。话少，知道的比说出来的多。那串钥匙从不离手。',
  },
  {
    id: 'W05',
    heading: '苏黎',
    category: '主线',
    keys: ['苏黎', '楼上住户'],
    order: 45,
    content: '苏黎住四楼，三十岁上下。最近几周一直睡不好，白天会在天台站很久。',
  },
  {
    id: 'W06',
    heading: '待办：检修单',
    category: '任务',
    keys: ['检修单', '任务', '要查'],
    order: 40,
    content: '你给自己列的事：找老陈核对检修单上的铅笔日期，弄清楚是谁补的、为什么补。',
  },
];

export function createDemoWorld(extra = {}) {
  return createWorld({
    events: EVENTS,
    achievements: ACHIEVEMENTS,
    endings: ENDINGS,
    slotLabels: SLOT_LABELS,
    opening: OPENING,
    brief: WORLD_BRIEF,
    placeLabels: PLACES,
    clueLabels: CLUES,
    worldbook: WORLDBOOK,
    loreBudget: 900,
    actorLabels: Object.fromEntries(ACTORS.map(a => [a.id, a.name])),
    statLabels: Object.fromEntries(
      ACTORS.map(a => [a.id, Object.fromEntries(a.stats.map(s => [s.key, s.label ?? s.key]))]),
    ),
    maxSkips: 24,
    ...extra,
  });
}

export function createDemoState() {
  return createInitialState({
    actors: ACTORS,
    clock: { day: 1, slot: 'night' },
    where: 'room',
    ledger: { cash: 12000, income: 0, expense: 0 },
  });
}

export function placeName(id, world) {
  return (world?.placeLabels ?? PLACES)[id] ?? id ?? '未知';
}
