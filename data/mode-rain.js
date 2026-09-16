/**
 * 《雨夜模式》模式 —— 独特机制层 + 专属 UI。
 *
 * 现在是**可运行骨架**：机制开关、数据形状、UI 钩子都已就位，
 * 具体的角色名、事件文本、结局条件按用户文档填充（内容层不由引擎侧编写，
 * 文中标注「待填」的都是占位）。
 *
 * 与「茶馆标准」模式的差异：
 *   1. 边界 guard 强制启用（当轮意愿 / 撤回 / 冷静期全部生效）
 *   2. UI 切到 mode-rainnight 主题（更暗、偏靛蓝、红色警示点缀）
 *   3. 雨势固定偏高（0.85），氛围压着剧情走
 *   4. 主界面出现「当轮意愿与边界」卡（雨夜专属 UI）
 */

import { createConsentGuard } from '../src/boundary.js';

export const RAINNIGHT_MODE = {
  id: 'rainnight',
  label: '雨夜模式',
  bodyClass: 'mode-rainnight',
  rainLevel: 0.85,
  rules: {
    consentEnforced: true,
    turnOnlyConsent: true,
  },

  world: {
    brief:
      '（雨夜模式 · 世界观骨架，待按文档填充）\n' +
      '现代都市的雨夜。有人带着一桩难以开口的事来求助，' +
      '接不接、怎么接、接住之后边界在哪里 —— 每一步都在被双方重新确认。',

    placeLabels: {
      room: '住处',
      door: '门外',
      street: '雨夜街头',
    },

    clueLabels: {
      R01: '求助者留下的伞',
      R02: '没说完的半句话',
    },

    actors: [
      {
        id: 'seeker',
        name: '求助者（待定名）',
        stats: [
          { key: 'trust', label: '信任', min: 0, max: 100, init: 15 },
          { key: 'safety', label: '安全感', min: 0, max: 100, init: 30 },
          { key: 'anxiety', label: '未来焦虑', min: 0, max: 100, init: 60 },
        ],
      },
      {
        id: 'self',
        name: '你',
        stats: [
          { key: 'pressure', label: '压力', min: 0, max: 100, init: 40 },
          { key: 'weary', label: '疲惫', min: 0, max: 100, init: 30 },
          { key: 'dignity', label: '自尊', min: 0, max: 100, init: 65 },
        ],
      },
    ],

    worldbook: [
      {
        id: 'RN01',
        heading: '雨夜',
        category: '概要',
        keys: [],
        constant: true,
        order: 10,
        content: '（待填）这场雨从傍晚下起，到深夜没有停的意思。',
      },
      {
        id: 'RN02',
        heading: '委托',
        category: '主线',
        keys: ['委托', '求助'],
        order: 60,
        content: '（待填）求助者带来的事情本身，以及它为什么偏偏找上你。',
      },
      {
        id: 'RN03',
        heading: '边界',
        category: '任务',
        keys: ['边界', '意愿', '撤回'],
        order: 50,
        content: '（机制说明）任何推进都需要对方的当轮意愿；撤回立即生效，纠缠有代价。',
      },
    ],

    achievements: [
      { id: 'RN_A1', title: '先听完整句话', cond: { path: 'flags.listened', op: '==', value: true } },
      { id: 'RN_A2', title: '守住了边界', cond: { path: 'flags.boundary_held', op: '==', value: true } },
    ],

    endings: [
      {
        id: 'END_R1',
        title: '接住了',
        priority: 30,
        note: '（待填）你把这件事接了下来 —— 以及随之而来的一切。',
        cond: { path: 'flags.took_case', op: '==', value: true },
      },
      {
        id: 'END_R2',
        title: '这次没有',
        priority: 20,
        note: '（待填）你没有接。雨还在下，日子各自继续。',
        cond: { path: 'flags.declined', op: '==', value: true },
      },
    ],

    events: [
      {
        id: 'R01',
        title: '深夜来客',
        when: { day: 1, slot: 'night' },
        where: 'room',
        priority: 100,
        actors: ['seeker'],
        firstMet: ['seeker'],
        require: null,
        fallback: 'A',
        branches: [
          {
            key: 'A',
            label: '开门',
            keywords: ['开门', '应门', '看看是谁'],
            cond: null,
            text: '（待填）门外站着一个被雨浇透的人，手里攥着什么东西。',
            effects: [
              { path: 'actors.seeker.stats.trust', op: 'add', value: 8 },
              { path: 'where', op: 'set', value: 'door' },
              { path: 'clues', op: 'push', value: 'R01' },
              { path: 'flags.met_seeker', op: 'set', value: true },
            ],
          },
          {
            key: 'B',
            label: '隔门听他说完',
            keywords: ['听', '不开门', '隔着门'],
            cond: null,
            text: '（待填）你没有开门，但也没有走开。对方断断续续说了一半。',
            effects: [
              { path: 'clues', op: 'push', value: 'R02' },
              { path: 'flags.listened', op: 'set', value: true },
            ],
          },
        ],
      },
      {
        id: 'R02',
        title: '委托摆在桌上',
        when: { day: 1, slot: 'night' },
        where: 'door',
        priority: 90,
        actors: ['seeker'],
        require: { path: 'flags.met_seeker', op: '==', value: true },
        fallback: 'A',
        branches: [
          {
            key: 'A',
            label: '让对方把话说完',
            keywords: ['听完', '让他说完', '不打断'],
            cond: null,
            text: '（待填）你把话说完的机会留给了对方 —— 有些细节只有听完才知道。',
            effects: [
              { path: 'actors.seeker.stats.trust', op: 'add', value: 12 },
              { path: 'flags.listened', op: 'set', value: true },
            ],
          },
          {
            key: 'B',
            label: '直接问关键处',
            keywords: ['问', '关键', '直接问'],
            cond: null,
            text: '（待填）你打断了铺垫，直接问要害。对方愣了一下，还是答了。',
            effects: [
              { path: 'actors.seeker.stats.anxiety', op: 'add', value: 8 },
              { path: 'flags.asked_direct', op: 'set', value: true },
            ],
          },
        ],
      },
      {
        id: 'R03',
        title: '抉择',
        when: { day: 2, slot: 'night' },
        priority: 200,
        actors: ['seeker'],
        require: null,
        fallback: 'C',
        branches: [
          {
            key: 'A',
            label: '接下委托',
            keywords: ['接', '帮', '接下'],
            cond: null,
            text: '（待填）你点了头。从这一刻起，这事就有一部分压在你肩上了。',
            effects: [
              { path: 'flags.took_case', op: 'set', value: true },
              { path: 'actors.self.stats.pressure', op: 'add', value: 15 },
            ],
          },
          {
            key: 'B',
            label: '再想想',
            cond: { path: 'clues[1]', op: 'exists' },
            text: '（待填）你要求再给一晚。对方看了你很久，说好。',
            effects: [{ path: 'flags.delayed', op: 'set', value: true }],
          },
          {
            key: 'C',
            label: '婉拒',
            keywords: ['婉拒', '不接', '拒绝'],
            cond: null,
            text: '（待填）你说了抱歉。对方点头，把伞留在了门口。',
            effects: [
              { path: 'flags.declined', op: 'set', value: true },
              { path: 'actors.self.stats.dignity', op: 'add', value: 5 },
            ],
          },
        ],
      },
      {
        /* 机制演示：秘密揭露 —— 线索集齐 + 关键行为 → 对方交出隐藏信息 */
        id: 'R04',
        title: '她没说的事',
        when: { day: 2, slot: 'morning' },
        priority: 70,
        actors: ['seeker'],
        require: {
          all: [
            { path: 'clues', op: 'contains', value: 'R01' },
            { path: 'flags.asked_direct', op: '==', value: true },
          ],
        },
        fallback: 'A',
        branches: [
          {
            key: 'A',
            label: '戳破那个矛盾',
            keywords: ['矛盾', '戳破', '说清楚'],
            cond: null,
            text: '（待填）你指出她话里对不上的地方。她沉默了很久，说出了藏起来的那一半。',
            effects: [
              { path: 'clues', op: 'push', value: 'R02' },
              { path: 'actors.seeker.stats.trust', op: 'add', value: 10 },
              { path: 'actors.seeker.stats.anxiety', op: 'add', value: 12 },
              { path: 'flags.secret_revealed', op: 'set', value: true },
            ],
          },
          {
            key: 'B',
            label: '等她自己说',
            keywords: ['等', '不逼', '等她说'],
            cond: null,
            text: '（待填）你没有逼。她会自己开口 —— 按她自己的时间。',
            effects: [{ path: 'flags.waited', op: 'set', value: true }],
          },
        ],
      },
      {
        /* 机制演示：NPC 自主 —— 玩家不在场时 NPC 按自己的意志行动，
           玩家只能在事后得知（when/require 调度已由引擎支持） */
        id: 'R05',
        title: '她自己去过了那个地方',
        when: { day: 2, slot: 'afternoon' },
        priority: 60,
        actors: ['seeker'],
        require: { path: 'flags.waited', op: '==', value: true },
        fallback: 'A',
        branches: [
          {
            key: 'A',
            label: '听她讲经过',
            cond: null,
            text: '（待填 · NPC 自主演示）你没在场 —— 她按自己的意思先行动了，回来才告诉你。',
            effects: [{ path: 'actors.seeker.stats.safety', op: 'sub', value: 10 }],
          },
        ],
      },
      {
        /* 机制演示：经济账本 + 债务线索 —— 帮助落账，但账不是筹码 */
        id: 'R06',
        title: '钱的事',
        when: { day: 2, slot: 'evening' },
        priority: 65,
        require: { path: 'flags.took_case', op: '==', value: true },
        fallback: 'B',
        branches: [
          {
            key: 'A',
            label: '垫上那笔钱',
            keywords: ['垫钱', '给钱', '先垫'],
            cond: null,
            text: '（待填 · 经济账本演示）你把钱垫上了。帮助落了账 —— 但账不是筹码，更不是同意。',
            effects: [
              { path: 'ledger.expense', op: 'add', value: 800 },
              { path: 'actors.seeker.stats.trust', op: 'add', value: 8 },
              { path: 'flags.debt_created', op: 'set', value: true },
            ],
          },
          {
            key: 'B',
            label: '只陪她跑流程',
            keywords: ['陪', '跑流程', '陪着'],
            cond: null,
            text: '（待填）钱让她自己想办法，你出的是时间和腿。',
            effects: [{ path: 'actors.self.stats.weary', op: 'add', value: 10 }],
          },
        ],
      },
    ],
  },

  /** 边界 guard：雨夜模式的推进全部要过当轮同意 */
  guards() {
    return [createConsentGuard()];
  },
};

/** 用模式定义建世界（events/worldbook/… 形状与茶馆标准一致） */
export function createRainWorld(createWorldFn) {
  const w = RAINNIGHT_MODE.world;
  return createWorldFn({
    events: w.events,
    achievements: w.achievements,
    endings: w.endings,
    brief: w.brief,
    placeLabels: w.placeLabels,
    clueLabels: w.clueLabels,
    worldbook: w.worldbook,
    guards: RAINNIGHT_MODE.guards(),
    loreBudget: 900,
    maxSkips: 24,
  });
}

/** 用模式定义建初始状态（actors 形状一致） */
export function rainInitialState(createInitialStateFn) {
  return createInitialStateFn({
    actors: w(RAINNIGHT_MODE).actors,
    clock: { day: 1, slot: 'night' },
    where: 'room',
    ledger: { cash: 3000, income: 0, expense: 0 },
  });
}

function w(mode) {
  return mode.world;
}
