/**
 * 《雨夜模式》—— 完整模式数据层。
 *
 * 内容口径（重要，改动前先读）：
 *   本模式实现的是**债务 / 调查 / 边界**三条机制线：
 *   深夜投奔 → 共同生活 → 债务真相分阶段揭示 → 收网 → 收束。
 *   不含任何亲密内容，也**不把任何角色设为可推进对象** ——
 *   这是本模式固定口径，不是"暂时没填"。
 *
 * 与「茶馆标准」的差异：
 *   1. 边界 guard 强制启用（当轮意愿 / 撤回 / 重新协商全部生效）
 *   2. UI 切到 mode-rainnight 主题
 *   3. 雨势固定偏高（0.85）
 *   4. 左抽屉出现「当轮意愿与边界」卡
 *
 * 数值与线索口径对齐《雨与夜 V4.1》§4 / §8 / §10 / §19 / §20：
 *   去掉了与亲密相关的数值项；债务线索阶段 0–6 与文档一致，不可跳阶段。
 *
 * 事件不带 `when.day`（只限时段）：引擎的索引按 day 建桶，
 * 不写 day 就落进通配桶，任何一天都能被选中；先后由 require + priority 控制。
 * 这与文档「触发锚点」的写法一致，也避免"某天没有候选事件"把流程卡死。
 */

import { createConsentGuard } from '../src/boundary.js';

/* ------------------------------------------------------------------ *
 * 角色
 * ------------------------------------------------------------------ */

const ACTORS = [
  /* 真名与关系取自《雨与夜 V4.1》§4。
     只取非性机制层的数值 —— 文档里的「性欲望」一项本模式不实现。 */
  {
    id: 'seeker',
    name: '林晚晴',
    stats: [
      { key: 'trust', label: '信任', min: 0, max: 100, init: 35 },
      { key: 'pressure', label: '压力', min: 0, max: 100, init: 88 },
      { key: 'weary', label: '疲惫', min: 0, max: 100, init: 82 },
      { key: 'dignity', label: '自尊', min: 0, max: 100, init: 90 },
    ],
  },
  {
    id: 'kin',
    name: '周若宁',
    stats: [
      { key: 'safety', label: '安全感', min: 0, max: 100, init: 30 },
      { key: 'trust', label: '信任', min: 0, max: 100, init: 45 },
      { key: 'anxiety', label: '未来焦虑', min: 0, max: 100, init: 72 },
      { key: 'anger', label: '对父亲愤怒', min: 0, max: 100, init: 70 },
    ],
  },
  {
    id: 'self',
    name: '你',
    stats: [
      { key: 'pressure', label: '压力', min: 0, max: 100, init: 45 },
      { key: 'weary', label: '疲惫', min: 0, max: 100, init: 30 },
      { key: 'composure', label: '从容', min: 0, max: 100, init: 60 },
    ],
  },
  {
    id: 'lost',
    name: '周世杰',
    stats: [
      // 本人不在场，这两项是「你对他知道多少」的进度，不是他的情绪
      { key: 'trail', label: '行踪知情度', min: 0, max: 100, init: 0 },
      { key: 'blame', label: '责任认定', min: 0, max: 100, init: 0 },
    ],
  },
  {
    id: 'collector',
    name: '催收方',
    stats: [
      { key: 'patience', label: '耐心', min: 0, max: 100, init: 100 },
      { key: 'alertness', label: '警觉', min: 0, max: 100, init: 20 },
    ],
  },
];

/* ------------------------------------------------------------------ *
 * 线索：债务阶段 0–6（不可跳阶段）+ 目击与文书证据
 * ------------------------------------------------------------------ */

const CLUES = {
  D0: '失联：留下「抱歉」便条，手机关机',
  D1: '红色催告单：非正规渠道，带人身威胁',
  D2: '五百万本息：本金加滚息合计',
  D3: '债权人是一家租赁公司，实际指向建材商',
  D4: '失联者副号活动轨迹，指向邻省县城',
  D5: '空壳公司 + 套牌车：他被当成走账的口子',
  D6: '归案：债务可切割、可追回、或彻底悬置',

  S1: '黑色面包车，尾号 842',
  S2: '学校门口 · 对讲机 · 停了很久',
  S3: '账面上的四个名字',
  S4: '一通急于撇清的电话',
  S5: '842 是套牌，真车主另有其人',
  S6: '中间人与主犯同时浮出水面',
  S7: '监控定格：有人从车上下来',
  S8: '医院走廊里的一句软证词',
  S9: '她自己跑出来的那条线',
  S10: '中间人反水，交出了走账记录',
  S11: '邻省边境旅馆的入住记录',
};

/* 地点 */
const PLACES = {
  room: '住处',
  door: '门外',
  kitchen: '厨房',
  study: '书房',
  balcony: '阳台',
  school: '学校门口',
  alley: '学校后巷',
  bank: '银行网点',
  police: '警局',
  firm: '律所',
  hospital: '医院',
  office: '公司',
  oldtown: '平阳老小区',
  court: '法院',
  cemetery: '墓园',
  roadside: '国道边',
};

/* ------------------------------------------------------------------ *
 * 事件
 * ------------------------------------------------------------------ */

const EVENTS = [
  /* ══════════════ 第一幕 · 雨夜投奔 ══════════════ */
  {
    id: 'R01',
    title: '深夜敲门',
    priority: 200,
    actors: ['seeker', 'kin'],
    firstMet: ['seeker', 'kin'],
    require: null,
    fallback: 'A',
    branches: [
      {
        key: 'A',
        label: '直接开门',
        keywords: ['开门', '应门', '看看是谁', '开'],
        cond: null,
        text: '门一开，走廊的声控灯刚好灭了。门外站着两个人，都湿透了 —— '
          + '一个把外套整个罩在身边那个孩子身上，自己只剩一件薄衫。',
        effects: [
          { path: 'actors.seeker.stats.trust', op: 'add', value: 8 },
          { path: 'actors.kin.stats.safety', op: 'add', value: 6 },
          { path: 'where', op: 'set', value: 'door' },
          { path: 'clues', op: 'push', value: 'D0' },
          { path: 'flags.met_seeker', op: 'set', value: true },
          { path: 'flags.path_seeker', op: 'set', value: '暂住' },
          { path: 'flags.path_kin', op: 'set', value: '暂住' },
        ],
      },
      {
        key: 'B',
        label: '隔着门问清楚',
        keywords: ['隔门', '听', '不开门', '问清楚'],
        cond: null,
        text: '你没有立刻开。门内门外隔着两厘米的木板，对方断断续续地说 —— '
          + '说的不是自己的事，是一个失踪了两周的人。',
        effects: [
          { path: 'actors.seeker.stats.trust', op: 'add', value: 4 },
          { path: 'actors.seeker.stats.pressure', op: 'add', value: 6 },
          { path: 'clues', op: 'push', value: 'D0' },
          { path: 'flags.asked_first', op: 'set', value: true },
          { path: 'flags.met_seeker', op: 'set', value: true },
        ],
      },
      {
        key: 'C',
        label: '抱歉，帮不了',
        keywords: ['拒绝', '不帮', '抱歉', '关门'],
        cond: null,
        text: '你说得很客气，也很清楚。对方点头，说打扰了，把话收回去，'
          + '转身的时候先扶了一下身边那个孩子。',
        effects: [
          { path: 'flags.declined', op: 'set', value: true },
          { path: 'actors.self.stats.composure', op: 'add', value: 6 },
        ],
      },
    ],
  },

  {
    id: 'R02',
    title: '讲述债务与 842',
    priority: 190,
    actors: ['seeker'],
    require: { path: 'flags.met_seeker', op: '==', value: true },
    fallback: 'A',
    branches: [
      {
        key: 'A',
        label: '全信，并且记下来',
        keywords: ['信', '记下来', '认真记录', '全信'],
        cond: null,
        text: '你拿了纸笔。高利贷、催告单、还有一辆黑色面包车 —— '
          + '尾号 842，他们说最近总在学校门口停着。',
        effects: [
          { path: 'clues', op: 'push', value: 'D1' },
          { path: 'clues', op: 'push', value: 'D2' },
          { path: 'clues', op: 'push', value: 'S1' },
          { path: 'flags.case_stage', op: 'set', value: 2 },
          { path: 'flags.heard_debt', op: 'set', value: true },
          { path: 'actors.seeker.stats.trust', op: 'add', value: 6 },
        ],
      },
      {
        key: 'B',
        label: '先记下，回头核实',
        keywords: ['核实', '先记', '查证', '半信'],
        cond: null,
        text: '你记了，但没有表态。有些数目字，听一遍就信，是要付代价的。',
        effects: [
          { path: 'clues', op: 'push', value: 'D1' },
          { path: 'flags.case_stage', op: 'set', value: 1 },
          { path: 'flags.verify_first', op: 'set', value: true },
          { path: 'flags.heard_debt', op: 'set', value: true },
        ],
      },
      {
        key: 'C',
        label: '不太信',
        keywords: ['不信', '怀疑', '不一定'],
        cond: null,
        text: '你问了两个细节，对方答得都对，但你还是留了一半。'
          + '旁边那个孩子忽然抬头看了你一眼，又低下去。',
        effects: [
          { path: 'flags.case_stage', op: 'set', value: 1 },
          { path: 'actors.kin.stats.trust', op: 'sub', value: 5 },
          { path: 'flags.doubted', op: 'set', value: true },
        ],
      },
    ],
  },

  {
    id: 'R03',
    title: '第一晚与清晨',
    priority: 180,
    actors: ['seeker', 'kin'],
    require: { path: 'flags.heard_debt', op: '==', value: true },
    fallback: 'A',
    branches: [
      {
        key: 'A',
        label: '让她们住下',
        keywords: ['住下', '留下', '先住', '收留'],
        cond: null,
        text: '你说客房一直空着。第二天清早你出来时，厨房里有一碗隔夜的粥，'
          + '已经热过了 —— 她端着它，手在抖。',
        effects: [
          { path: 'flags.took_them_in', op: 'set', value: true },
          { path: 'actors.seeker.stats.trust', op: 'add', value: 10 },
          { path: 'actors.seeker.stats.dignity', op: 'add', value: 4 },
          { path: 'actors.kin.stats.safety', op: 'add', value: 10 },
          { path: 'where', op: 'set', value: 'kitchen' },
        ],
      },
      {
        key: 'B',
        label: '只留一晚',
        keywords: ['一晚', '只留一晚', '明天走'],
        cond: null,
        text: '你说明天可以帮她问几个地方。天亮以后，她想的是别的。',
        effects: [
          { path: 'flags.one_night', op: 'set', value: true },
          { path: 'actors.seeker.stats.trust', op: 'add', value: 2 },
          { path: 'actors.kin.stats.safety', op: 'sub', value: 6 },
        ],
      },
      {
        key: 'C',
        label: '可以，但有条件',
        keywords: ['条件', '有前提', '先说明'],
        cond: null,
        text: '你把条件一条条摆出来 —— 住多久、做什么、不做什么。'
          + '她都答应了。答应得越快，你越知道她没得选。',
        effects: [
          { path: 'flags.terms_set', op: 'set', value: true },
          { path: 'flags.took_them_in', op: 'set', value: true },
          { path: 'actors.seeker.stats.dignity', op: 'sub', value: 12 },
          { path: 'actors.seeker.stats.trust', op: 'sub', value: 8 },
        ],
      },
    ],
  },

  {
    id: 'R04',
    title: '阳台上的那一夜',
    priority: 170,
    actors: ['kin'],
    require: {
      all: [
        { path: 'flags.took_them_in', op: '==', value: true },
        { path: 'actors.kin.stats.safety', op: '<=', value: 55 },
      ],
    },
    fallback: 'C',
    branches: [
      {
        key: 'A',
        label: '去阳台陪一会儿',
        keywords: ['陪', '阳台', '过去'],
        cond: null,
        text: '她蹲在阳台上，把校服外套垫在膝盖下面。你没问什么，'
          + '就在旁边站了十来分钟。回屋时她说：「我不是怕黑。」',
        effects: [
          { path: 'actors.kin.stats.safety', op: 'add', value: 12 },
          { path: 'actors.kin.stats.trust', op: 'add', value: 8 },
          { path: 'flags.kept_company', op: 'set', value: true },
        ],
      },
      {
        key: 'B',
        label: '在门外停一下就走',
        keywords: ['门外', '停一下', '看一眼'],
        cond: null,
        text: '你在门外听见里面很轻的呼吸声，停了半分钟，走了。'
          + '她不知道你来过。',
        effects: [
          { path: 'actors.kin.stats.safety', op: 'add', value: 4 },
          { path: 'flags.stood_outside', op: 'set', value: true },
        ],
      },
      {
        key: 'C',
        label: '装作没听见',
        keywords: ['不管', '没听见', '回房'],
        cond: null,
        text: '你回了房间。有些门不必推开，但确实会记着。',
        effects: [
          { path: 'actors.kin.stats.safety', op: 'sub', value: 8 },
          { path: 'actors.kin.stats.anxiety', op: 'add', value: 8 },
        ],
      },
    ],
  },

  {
    id: 'R05',
    title: '把资源摆上桌',
    priority: 160,
    actors: ['self'],
    require: { path: 'flags.took_them_in', op: '==', value: true },
    fallback: 'A',
    branches: [
      {
        key: 'A',
        label: '安保和背景调查一起安排',
        keywords: ['全安排', '安保', '调查', '都安排'],
        cond: null,
        text: '电话打完不到两小时，楼下的车换了，物业那边多了一个登记本。'
          + '钱是花了，但你第一次知道「有人盯着」也可以是一种秩序。',
        effects: [
          { path: 'flags.butler_all', op: 'set', value: true },
          { path: 'flags.case_stage', op: 'add', value: 1 },
          { path: 'ledger.expense', op: 'add', value: 120000 },
          { path: 'actors.collector.stats.alertness', op: 'add', value: 10 },
        ],
      },
      {
        key: 'B',
        label: '只安排安保',
        keywords: ['只安保', '先安保', '次要'],
        cond: null,
        text: '先保人。别的慢慢来 —— 这句话说出口的时候，你自己也知道慢意味着什么。',
        effects: [
          { path: 'flags.butler_security', op: 'set', value: true },
          { path: 'ledger.expense', op: 'add', value: 60000 },
        ],
      },
      {
        key: 'C',
        label: '先不安排',
        keywords: ['不安排', '先不', '再说'],
        cond: null,
        text: '你想再等等看。等等看的结果，通常是别人先动。',
        effects: [
          { path: 'flags.butler_none', op: 'set', value: true },
          { path: 'actors.collector.stats.alertness', op: 'add', value: 20 },
        ],
      },
    ],
  },

  {
    id: 'R06',
    title: '租约与校服',
    priority: 150,
    actors: ['seeker', 'kin'],
    require: { path: 'flags.took_them_in', op: '==', value: true },
    fallback: 'B',
    branches: [
      {
        key: 'A',
        label: '我全安排好',
        keywords: ['全安排', '我来办', '包了'],
        cond: null,
        text: '你一个下午办完了所有手续。快是快，她全程只说了三句谢谢。',
        effects: [
          { path: 'actors.seeker.stats.trust', op: 'add', value: 6 },
          { path: 'actors.seeker.stats.dignity', op: 'sub', value: 10 },
          { path: 'flags.arranged_all', op: 'set', value: true },
          { path: 'ledger.expense', op: 'add', value: 45000 },
        ],
      },
      {
        key: 'B',
        label: '只给渠道，让她自己跑',
        keywords: ['渠道', '她自己', '介绍人', '给个门路'],
        cond: null,
        text: '你给了三个电话号码，剩下的让她自己去。三天以后她拿着回执回来，'
          + '签名字迹很用力。',
        effects: [
          { path: 'actors.seeker.stats.dignity', op: 'add', value: 12 },
          { path: 'actors.seeker.stats.trust', op: 'add', value: 8 },
          { path: 'flags.own_route', op: 'set', value: true },
        ],
      },
      {
        key: 'C',
        label: '先问她想要什么',
        keywords: ['问她', '想怎么办', '她的意思'],
        cond: null,
        text: '你问她要什么。她想了很久才开口，说的第一句是：「校服不能断。」',
        effects: [
          { path: 'actors.seeker.stats.dignity', op: 'add', value: 14 },
          { path: 'actors.seeker.stats.trust', op: 'add', value: 10 },
          { path: 'actors.kin.stats.safety', op: 'add', value: 8 },
          { path: 'flags.asked_her', op: 'set', value: true },
        ],
      },
    ],
  },

  {
    id: 'R07',
    title: '校门口的第三辆车',
    priority: 145,
    actors: ['kin', 'collector'],
    require: {
      any: [
        { path: 'flags.own_route', op: '==', value: true },
        { path: 'flags.arranged_all', op: '==', value: true },
      ],
    },
    fallback: 'A',
    branches: [
      {
        key: 'A',
        label: '让安保接回来',
        keywords: ['安保', '接回来', '派人'],
        cond: null,
        text: '车确实在，也确实走了。安保的人只记下一句：'
          + '「副驾有人拿着对讲机。」',
        effects: [
          { path: 'clues', op: 'push', value: 'S2' },
          { path: 'actors.kin.stats.safety', op: 'add', value: 10 },
          { path: 'ledger.expense', op: 'add', value: 8000 },
        ],
      },
      {
        key: 'B',
        label: '报警备案',
        keywords: ['报警', '备案', '警察'],
        cond: null,
        text: '做了一份记录。民警说这类情况「先留痕」，留痕的意思你懂。',
        effects: [
          { path: 'clues', op: 'push', value: 'S2' },
          { path: 'flags.police_record', op: 'set', value: true },
          { path: 'actors.collector.stats.alertness', op: 'add', value: 15 },
        ],
      },
      {
        key: 'C',
        label: '我自己过去',
        keywords: ['自己去', '我过去', '亲自'],
        cond: null,
        text: '你到的时候车已经走了，只剩地上的烟头。她站在校门里没出来，'
          + '隔着栏杆看你，第一次没有立刻低头。',
        effects: [
          { path: 'clues', op: 'push', value: 'S2' },
          { path: 'actors.kin.stats.trust', op: 'add', value: 12 },
          { path: 'actors.kin.stats.safety', op: 'add', value: 8 },
          { path: 'actors.self.stats.weary', op: 'add', value: 15 },
        ],
      },
    ],
  },

  /* ══════════════ 第二幕 · 调查深入 ══════════════ */
  {
    id: 'R08',
    title: '律师首询与归档',
    priority: 140,
    actors: ['seeker'],
    require: { path: 'flags.case_stage', op: '>=', value: 1 },
    fallback: 'C',
    branches: [
      {
        key: 'A',
        label: '律师直接对接她本人',
        keywords: ['她自己对接', '直接找她', '不插手'],
        cond: null,
        text: '你在外面等着。两个小时后她出来，把文件夹抱在胸前，'
          + '说：「原来这些是可以问的。」',
        effects: [
          { path: 'actors.seeker.stats.dignity', op: 'add', value: 12 },
          { path: 'flags.case_stage', op: 'add', value: 1 },
          { path: 'flags.her_lawyer', op: 'set', value: true },
          { path: 'ledger.expense', op: 'add', value: 30000 },
        ],
      },
      {
        key: 'B',
        label: '我全程跟',
        keywords: ['我全程', '我跟着', '陪着'],
        cond: null,
        text: '你全程在场，问得很细。她一直没插上话，最后只补了一句金额。',
        effects: [
          { path: 'flags.case_stage', op: 'add', value: 1 },
          { path: 'actors.seeker.stats.dignity', op: 'sub', value: 8 },
          { path: 'ledger.expense', op: 'add', value: 30000 },
        ],
      },
      {
        key: 'C',
        label: '律师和我一起，话让她说',
        keywords: ['一起', '让她说', '平衡'],
        cond: null,
        text: '你负责递材料，律师负责问，她负责回答 —— 这一次回答的人是她。',
        effects: [
          { path: 'flags.case_stage', op: 'add', value: 1 },
          { path: 'actors.seeker.stats.trust', op: 'add', value: 8 },
          { path: 'actors.seeker.stats.dignity', op: 'add', value: 6 },
          { path: 'ledger.expense', op: 'add', value: 30000 },
        ],
      },
    ],
  },

  {
    id: 'R09',
    title: '账面上的四个名字',
    priority: 135,
    actors: ['seeker', 'self'],
    require: { path: 'flags.case_stage', op: '>=', value: 2 },
    fallback: 'A',
    branches: [
      {
        key: 'A',
        label: '全查',
        keywords: ['全查', '都查', '查到底'],
        cond: null,
        text: '流水拉出来，四个名字：一个建材商、一个中间人、'
          + '一个副号，还有一家工商档案上有人名却查不到人的空壳。',
        effects: [
          { path: 'clues', op: 'push', value: 'S3' },
          { path: 'flags.case_stage', op: 'add', value: 1 },
          { path: 'flags.four_names', op: 'set', value: true },
          { path: 'ledger.expense', op: 'add', value: 80000 },
        ],
      },
      {
        key: 'B',
        label: '只查大额',
        keywords: ['大额', '只看大的', '先查大头'],
        cond: null,
        text: '五十万以上的三笔，全部指向同一个收款账户。小钱不用查了，'
          + '小钱只是掩护。',
        effects: [
          { path: 'clues', op: 'push', value: 'S3' },
          { path: 'flags.case_stage', op: 'add', value: 1 },
          { path: 'flags.partial_flow', op: 'set', value: true },
          { path: 'ledger.expense', op: 'add', value: 30000 },
        ],
      },
      {
        key: 'C',
        label: '让银行按流程代查',
        keywords: ['代查', '流程', '走手续'],
        cond: null,
        text: '走了正式手续。慢，但每一步都留了纸面。',
        effects: [
          { path: 'flags.case_stage', op: 'add', value: 1 },
          { path: 'flags.formal_request', op: 'set', value: true },
          { path: 'ledger.expense', op: 'add', value: 40000 },
        ],
      },
    ],
  },

  {
    id: 'R10',
    title: '为什么帮我',
    priority: 130,
    actors: ['seeker'],
    require: { path: 'actors.seeker.stats.pressure', op: '>=', value: 60 },
    fallback: 'C',
    branches: [
      {
        key: 'A',
        label: '先安抚',
        keywords: ['安抚', '别急', '慢慢说'],
        cond: null,
        text: '你让她先坐下，把要说的话慢慢说。她说了四十分钟，'
          + '中间停了三次。',
        effects: [
          { path: 'actors.seeker.stats.pressure', op: 'sub', value: 15 },
          { path: 'actors.seeker.stats.trust', op: 'add', value: 10 },
        ],
      },
      {
        key: 'B',
        label: '给她具体建议',
        keywords: ['建议', '怎么办', '方法'],
        cond: null,
        text: '你列了三条可执行的。她认真听完，说了一句「好」，'
          + '然后再没说话。',
        effects: [
          { path: 'actors.seeker.stats.pressure', op: 'sub', value: 6 },
          { path: 'actors.self.stats.weary', op: 'add', value: 6 },
        ],
      },
      {
        key: 'C',
        label: '沉默地陪着',
        keywords: ['沉默', '陪着', '不说话'],
        cond: null,
        text: '你没接话。她哭了一会儿，自己停了，去洗了把脸，'
          + '回来的时候像是没发生过。',
        effects: [
          { path: 'actors.seeker.stats.pressure', op: 'sub', value: 10 },
          { path: 'actors.seeker.stats.trust', op: 'add', value: 6 },
        ],
      },
      {
        key: 'D',
        label: '坦诚说清楚',
        keywords: ['坦诚', '说实话', '我为什么'],
        cond: null,
        text: '你把话说明白了：帮她是因为这件事本就该有人管，'
          + '不是因为她欠你什么。她听完，肩膀落下去了一点。',
        effects: [
          { path: 'actors.seeker.stats.trust', op: 'add', value: 14 },
          { path: 'actors.seeker.stats.pressure', op: 'sub', value: 8 },
          { path: 'actors.seeker.stats.dignity', op: 'add', value: 6 },
          { path: 'flags.said_why', op: 'set', value: true },
        ],
      },
    ],
  },

  {
    id: 'R11',
    title: '一通急于撇清的电话',
    priority: 125,
    actors: ['self'],
    require: { path: 'flags.case_stage', op: '>=', value: 2 },
    fallback: 'A',
    branches: [
      {
        key: 'A',
        label: '接，并且录音',
        keywords: ['接', '录音', '接并录音'],
        cond: null,
        text: '对方第一句话就急着划清界限，说得太急了。'
          + '录音笔上是四分十二秒。',
        effects: [
          { path: 'clues', op: 'push', value: 'S4' },
          { path: 'flags.recorded', op: 'set', value: true },
        ],
      },
      {
        key: 'B',
        label: '接，不录音',
        keywords: ['接', '不录', '就接'],
        cond: null,
        text: '你听完了。有些话当场有用，但存不下来。',
        effects: [
          { path: 'clues', op: 'push', value: 'S4' },
          { path: 'flags.no_record', op: 'set', value: true },
        ],
      },
      {
        key: 'C',
        label: '让管家接',
        keywords: ['管家接', '别人接', '转接'],
        cond: null,
        text: '管家按规矩应对。挂了之后他说：「对方确认了咱们有第三方。」',
        effects: [
          { path: 'actors.collector.stats.alertness', op: 'add', value: 15 },
          { path: 'flags.third_party_known', op: 'set', value: true },
        ],
      },
      {
        key: 'D',
        label: '不接',
        keywords: ['不接', '挂掉', '不理'],
        cond: null,
        text: '电话响了六声，停了。当天晚上又来了一次。',
        effects: [
          { path: 'actors.collector.stats.alertness', op: 'add', value: 10 },
          { path: 'actors.collector.stats.patience', op: 'sub', value: 10 },
        ],
      },
    ],
  },

  {
    id: 'R12',
    title: '842 是套牌',
    priority: 120,
    actors: ['self', 'collector'],
    require: { path: 'clues', op: 'contains', value: 'S1' },
    fallback: 'A',
    branches: [
      {
        key: 'A',
        label: '自己继续追',
        keywords: ['继续追', '自己查', '盯下去'],
        cond: null,
        text: '你顺着车牌往下查了两层。牌是真的，车不是 —— '
          + '真车主那辆车，三个月前就报废了。',
        effects: [
          { path: 'clues', op: 'push', value: 'S5' },
          { path: 'flags.plate_fake', op: 'set', value: true },
          { path: 'flags.case_stage', op: 'add', value: 1 },
        ],
      },
      {
        key: 'B',
        label: '交给警方查',
        keywords: ['警方', '交给警察', '报案'],
        cond: null,
        text: '警方系统里跑了一遍，结果比你查得快，也比你查得干净。'
          + '「套牌，同一批至少三辆。」',
        effects: [
          { path: 'clues', op: 'push', value: 'S5' },
          { path: 'flags.plate_fake', op: 'set', value: true },
          { path: 'flags.police_route', op: 'set', value: true },
          { path: 'flags.case_stage', op: 'add', value: 1 },
        ],
      },
      {
        key: 'C',
        label: '先放一放',
        keywords: ['放一放', '暂缓', '先不管'],
        cond: null,
        text: '你把这条线按下去，想等更完整的时候再翻出来。线不会等你。',
        effects: [
          { path: 'actors.collector.stats.patience', op: 'sub', value: 15 },
          { path: 'flags.delayed_track', op: 'set', value: true },
        ],
      },
    ],
  },

  {
    id: 'R13',
    title: '两个人浮出水面',
    priority: 115,
    actors: ['self'],
    require: { path: 'flags.case_stage', op: '>=', value: 3 },
    fallback: 'C',
    branches: [
      {
        key: 'A',
        label: '一次问到底',
        keywords: ['一次问清', '都问', '一次到底'],
        cond: null,
        text: '建材商、中间人，两条线同时摆开。你终于看清这不是'
          + '一笔借贷，是一条走账的通道。',
        effects: [
          { path: 'clues', op: 'push', value: 'S6' },
          { path: 'clues', op: 'push', value: 'D3' },
          { path: 'flags.case_stage', op: 'add', value: 1 },
          { path: 'flags.both_named', op: 'set', value: true },
        ],
      },
      {
        key: 'B',
        label: '先抓主犯',
        keywords: ['主犯', '先抓大的', '先抓建材商'],
        cond: null,
        text: '你锁定建材商。中间人那边没铺垫，后来才知道这笔账要还。',
        effects: [
          { path: 'clues', op: 'push', value: 'S6' },
          { path: 'clues', op: 'push', value: 'D3' },
          { path: 'flags.case_stage', op: 'add', value: 1 },
          { path: 'flags.focus_main', op: 'set', value: true },
        ],
      },
      {
        key: 'C',
        label: '先稳住中间人',
        keywords: ['稳住', '中间人', '先拉拢'],
        cond: null,
        text: '你先找了中间人。她话不多，但每一句都留着后手。',
        effects: [
          { path: 'clues', op: 'push', value: 'S6' },
          { path: 'clues', op: 'push', value: 'D3' },
          { path: 'flags.case_stage', op: 'add', value: 1 },
          { path: 'flags.steadied', op: 'set', value: true },
        ],
      },
      {
        key: 'D',
        label: '整体交给警方',
        keywords: ['交给警方', '全部报警', '移交'],
        cond: null,
        text: '你把整理好的材料交出去。程序接管了这件事，也接管了速度。',
        effects: [
          { path: 'clues', op: 'push', value: 'S6' },
          { path: 'clues', op: 'push', value: 'D3' },
          { path: 'flags.case_stage', op: 'add', value: 1 },
          { path: 'flags.police_route', op: 'set', value: true },
        ],
      },
    ],
  },

  {
    id: 'R14',
    title: '衣柜顶上的旧照片',
    priority: 110,
    actors: ['kin'],
    require: { path: 'actors.kin.stats.safety', op: '<=', value: 60 },
    fallback: 'A',
    branches: [
      {
        key: 'A',
        label: '陪她一起看',
        keywords: ['一起看', '陪她', '看照片'],
        cond: null,
        text: '照片里那个人还很精神。她第一次主动讲起父亲，'
          + '讲了两件事，都是好的。',
        effects: [
          { path: 'actors.kin.stats.trust', op: 'add', value: 10 },
          { path: 'actors.kin.stats.safety', op: 'add', value: 8 },
          { path: 'flags.photo_moment', op: 'set', value: true },
        ],
      },
      {
        key: 'B',
        label: '让她自己待着',
        keywords: ['自己待着', '让她看', '不打扰'],
        cond: null,
        text: '你退了出去。门关上前，她还在看。',
        effects: [
          { path: 'actors.kin.stats.safety', op: 'sub', value: 4 },
          { path: 'actors.kin.stats.anxiety', op: 'add', value: 4 },
        ],
      },
      {
        key: 'C',
        label: '评价她父亲',
        keywords: ['说他', '骂他', '他的不是'],
        cond: null,
        text: '你说了那个人的不好。她点了头，也没有再说话 —— '
          + '认同和被刺痛是可以同时发生的。',
        effects: [
          { path: 'actors.kin.stats.anger', op: 'sub', value: 8 },
          { path: 'actors.kin.stats.trust', op: 'sub', value: 10 },
          { path: 'actors.kin.stats.anxiety', op: 'add', value: 6 },
        ],
      },
      {
        key: 'D',
        label: '把照片收起来',
        keywords: ['收起来', '别看了', '放回去'],
        cond: null,
        text: '你把照片放回了衣柜顶层。有些东西放回去，不等于不要了。',
        effects: [
          { path: 'actors.kin.stats.anxiety', op: 'add', value: 6 },
          { path: 'flags.photo_put_away', op: 'set', value: true },
        ],
      },
    ],
  },

  /* ══════════════ 第三幕 · 债务收网 ══════════════ */
  {
    id: 'R15',
    title: '催收上门',
    priority: 105,
    actors: ['collector', 'seeker'],
    require: { path: 'flags.case_stage', op: '>=', value: 1 },
    fallback: 'A',
    branches: [
      {
        key: 'A',
        label: '挡在门外',
        keywords: ['挡住', '挡在门外', '我来'],
        cond: null,
        text: '你站在门口，把上门的那两个人挡在门框外面。'
          + '催告单是红色的，贴过很多次，边角都卷了。',
        effects: [
          { path: 'clues', op: 'push', value: 'D1' },
          { path: 'actors.seeker.stats.pressure', op: 'sub', value: 8 },
          { path: 'actors.collector.stats.alertness', op: 'add', value: 20 },
          { path: 'flags.faced_collector', op: 'set', value: true },
        ],
      },
      {
        key: 'B',
        label: '让律师接',
        keywords: ['律师接', '走法律', '让律师'],
        cond: null,
        text: '电话接通后，对方换了语气。规矩和规矩对撞的时候，'
          + '先退的往往是没备好的那一边。',
        effects: [
          { path: 'clues', op: 'push', value: 'D1' },
          { path: 'flags.lawyer_front', op: 'set', value: true },
          { path: 'actors.collector.stats.patience', op: 'sub', value: 15 },
          { path: 'ledger.expense', op: 'add', value: 20000 },
        ],
      },
      {
        key: 'C',
        label: '不出面',
        keywords: ['不出面', '躲', '不见'],
        cond: null,
        text: '门里没出声。走廊的灯亮了很久。',
        effects: [
          { path: 'actors.seeker.stats.pressure', op: 'add', value: 12 },
          { path: 'actors.kin.stats.safety', op: 'sub', value: 10 },
          { path: 'flags.hid_from_collector', op: 'set', value: true },
        ],
      },
    ],
  },

  {
    id: 'R16',
    title: '842，第三次',
    priority: 100,
    actors: ['collector', 'kin'],
    require: { path: 'clues', op: 'contains', value: 'S1' },
    fallback: 'B',
    branches: [
      {
        key: 'A',
        label: '当场拦下',
        keywords: ['拦下', '拦住', '当场'],
        cond: null,
        text: '你拦在车前。车窗没开，隔着玻璃能看清副驾那个人'
          + '把对讲机按灭的动作。',
        effects: [
          { path: 'clues', op: 'push', value: 'S7' },
          { path: 'flags.stopped_van', op: 'set', value: true },
          { path: 'actors.kin.stats.safety', op: 'add', value: 6 },
          { path: 'actors.collector.stats.alertness', op: 'add', value: 20 },
        ],
      },
      {
        key: 'B',
        label: '先带她回家',
        keywords: ['回家', '先走', '带她走'],
        cond: null,
        text: '你先把人带回去。线索断了一次，但人完整。',
        effects: [
          { path: 'actors.kin.stats.safety', op: 'add', value: 12 },
          { path: 'flags.van_lost', op: 'set', value: true },
        ],
      },
      {
        key: 'C',
        label: '报警并当场备案',
        keywords: ['报警', '备案', '警察来'],
        cond: null,
        text: '出警记录上写着时间、车牌、在场人数。'
          + '这一次开始，事情有了编号。',
        effects: [
          { path: 'clues', op: 'push', value: 'S7' },
          { path: 'flags.police_record', op: 'set', value: true },
          { path: 'flags.case_stage', op: 'add', value: 1 },
          { path: 'actors.collector.stats.patience', op: 'sub', value: 20 },
        ],
      },
    ],
  },

  {
    id: 'R17',
    title: '律师函与账户保全',
    priority: 95,
    actors: ['self'],
    require: { path: 'flags.case_stage', op: '>=', value: 3 },
    fallback: 'A',
    branches: [
      {
        key: 'A',
        label: '法律和警方同步走',
        keywords: ['同步', '双线', '一起走'],
        cond: null,
        text: '一封函出去，一份申请递上去。两条线同时压过去，'
          + '对方的动作明显慢了。',
        effects: [
          { path: 'flags.dual_track', op: 'set', value: true },
          { path: 'flags.case_stage', op: 'add', value: 1 },
          { path: 'ledger.expense', op: 'add', value: 150000 },
        ],
      },
      {
        key: 'B',
        label: '只走法律程序',
        keywords: ['只走法律', '不打草惊蛇', '只发函'],
        cond: null,
        text: '只发函，不惊动别的。程序慢，但程序上不失分。',
        effects: [
          { path: 'flags.legal_only', op: 'set', value: true },
          { path: 'flags.case_stage', op: 'add', value: 1 },
          { path: 'ledger.expense', op: 'add', value: 100000 },
        ],
      },
      {
        key: 'C',
        label: '暂不启动',
        keywords: ['暂不', '再等', '先不发'],
        cond: null,
        text: '你把文件压了下来。压下去的东西，会在别的地方冒头。',
        effects: [
          { path: 'actors.collector.stats.patience', op: 'sub', value: 20 },
          { path: 'flags.held_back_legal', op: 'set', value: true },
        ],
      },
    ],
  },

  {
    id: 'R18',
    title: '医院走廊里的一句证词',
    priority: 90,
    actors: ['seeker', 'self'],
    require: { path: 'flags.case_stage', op: '>=', value: 3 },
    fallback: 'B',
    branches: [
      {
        key: 'A',
        label: '陪她一起去',
        keywords: ['陪她', '一起去', '我陪着'],
        cond: null,
        text: '走廊很长。那位老人认出了她，拉着她的手说了两句 —— '
          + '不重，但足够算一份软证词。',
        effects: [
          { path: 'clues', op: 'push', value: 'S8' },
          { path: 'actors.seeker.stats.trust', op: 'add', value: 12 },
          { path: 'actors.seeker.stats.dignity', op: 'add', value: 6 },
        ],
      },
      {
        key: 'B',
        label: '让她自己去',
        keywords: ['她自己', '我不去', '让她去'],
        cond: null,
        text: '她一个人去的。回来的时候说了一句：「我可以。」'
          + '这三个字比任何证词都管用。',
        effects: [
          { path: 'clues', op: 'push', value: 'S8' },
          { path: 'actors.seeker.stats.dignity', op: 'add', value: 15 },
          { path: 'actors.seeker.stats.trust', op: 'add', value: 4 },
          { path: 'flags.her_errand', op: 'set', value: true },
        ],
      },
      {
        key: 'C',
        label: '不查了',
        keywords: ['不查了', '算了', '停下'],
        cond: null,
        text: '你说到此为止。她看了你一会儿，没问为什么。',
        effects: [
          { path: 'flags.gave_up', op: 'set', value: true },
          { path: 'actors.seeker.stats.trust', op: 'sub', value: 12 },
          { path: 'actors.kin.stats.anxiety', op: 'add', value: 10 },
        ],
      },
    ],
  },

  {
    id: 'R19',
    title: '体检报告',
    priority: 85,
    actors: ['seeker'],
    require: { path: 'actors.seeker.stats.weary', op: '>=', value: 70 },
    fallback: 'B',
    branches: [
      {
        key: 'A',
        label: '全程陪同',
        keywords: ['陪同', '全程', '我陪'],
        cond: null,
        text: '出结果的时候她先笑了，然后才说「我知道」。'
          + '她第一次承认自己撑不住。',
        effects: [
          { path: 'actors.seeker.stats.trust', op: 'add', value: 10 },
          { path: 'actors.seeker.stats.pressure', op: 'sub', value: 12 },
          { path: 'flags.overwhelmed_admitted', op: 'set', value: true },
        ],
      },
      {
        key: 'B',
        label: '只负责接送',
        keywords: ['接送', '送到', '只送'],
        cond: null,
        text: '你把她送到门口就去停车了。她出来时把报告折好收进了包里。',
        effects: [
          { path: 'actors.seeker.stats.trust', op: 'add', value: 4 },
          { path: 'actors.seeker.stats.dignity', op: 'add', value: 6 },
        ],
      },
      {
        key: 'C',
        label: '不当回事',
        keywords: ['没事', '不至于', '别想太多'],
        cond: null,
        text: '你说这不是大事。她笑了一下，把报告塞得更深了。',
        effects: [
          { path: 'actors.seeker.stats.dignity', op: 'sub', value: 10 },
          { path: 'actors.seeker.stats.trust', op: 'sub', value: 8 },
        ],
      },
    ],
  },

  {
    id: 'R20',
    title: '她一个人走的那条路',
    priority: 80,
    actors: ['kin'],
    require: { path: 'actors.kin.stats.safety', op: '<=', value: 25 },
    fallback: 'C',
    branches: [
      {
        key: 'A',
        label: '暗中跟着',
        keywords: ['跟着', '暗中', '远远跟着'],
        cond: null,
        text: '她问人、抄车牌、在门口站了二十分钟。你一直在三十米外，'
          + '她没回头。',
        effects: [
          { path: 'clues', op: 'push', value: 'S9' },
          { path: 'actors.kin.stats.safety', op: 'add', value: 8 },
          { path: 'actors.kin.stats.trust', op: 'add', value: 6 },
          { path: 'flags.shadowed', op: 'set', value: true },
        ],
      },
      {
        key: 'B',
        label: '提前拦下',
        keywords: ['拦下', '拦住她', '别去'],
        cond: null,
        text: '你在巷口把她拦住了。她挣了一下，没挣开，也没再说话。',
        effects: [
          { path: 'actors.kin.stats.safety', op: 'sub', value: 8 },
          { path: 'actors.kin.stats.anxiety', op: 'add', value: 12 },
          { path: 'flags.blocked_her', op: 'set', value: true },
        ],
      },
      {
        key: 'C',
        label: '不管',
        keywords: ['不管', '随她', '由她'],
        cond: null,
        text: '你没出现。她自己走完了那一段，回来时手上多了一张纸条。',
        effects: [
          { path: 'clues', op: 'push', value: 'S9' },
          { path: 'actors.kin.stats.anxiety', op: 'add', value: 15 },
          { path: 'flags.kin_alone', op: 'set', value: true },
        ],
      },
    ],
  },

  /* ══════════════ 第四幕 · 收网 ══════════════ */
  {
    id: 'R21',
    title: '中间人反水',
    priority: 75,
    actors: ['self'],
    require: { path: 'flags.case_stage', op: '>=', value: 4 },
    fallback: 'A',
    branches: [
      {
        key: 'A',
        label: '接受配合',
        keywords: ['接受', '配合', '答应'],
        cond: null,
        text: '她把走账记录交了出来。三张表，一笔一笔对得上。',
        effects: [
          { path: 'clues', op: 'push', value: 'S10' },
          { path: 'clues', op: 'push', value: 'D5' },
          { path: 'flags.case_stage', op: 'add', value: 1 },
          { path: 'flags.insider_turned', op: 'set', value: true },
        ],
      },
      {
        key: 'B',
        label: '拒绝交换',
        keywords: ['拒绝', '不换', '不谈'],
        cond: null,
        text: '你说不用她配合，按程序走。程序会走完，只是慢。',
        effects: [
          { path: 'clues', op: 'push', value: 'D5' },
          { path: 'flags.case_stage', op: 'add', value: 1 },
          { path: 'flags.refused_deal', op: 'set', value: true },
        ],
      },
      {
        key: 'C',
        label: '施压',
        keywords: ['施压', '逼她', '威胁'],
        cond: null,
        text: '你把话压下去了。她当场给了一个名字 —— 不是真的那个。',
        effects: [
          { path: 'flags.pressed_insider', op: 'set', value: true },
          { path: 'actors.seeker.stats.trust', op: 'sub', value: 10 },
          { path: 'actors.collector.stats.alertness', op: 'add', value: 20 },
        ],
      },
    ],
  },

  {
    id: 'R22',
    title: '失踪者的电话',
    priority: 70,
    actors: ['seeker'],
    require: { path: 'flags.case_stage', op: '>=', value: 5 },
    fallback: 'B',
    branches: [
      {
        key: 'A',
        label: '信他',
        keywords: ['信', '相信他', '听他的'],
        cond: null,
        text: '他在电话里说自己是被人利用了，说想回来当面说清楚。'
          + '你把这个可能留了下来。',
        effects: [
          { path: 'flags.believed_him', op: 'set', value: true },
          { path: 'flags.case_stage', op: 'add', value: 1 },
          { path: 'clues', op: 'push', value: 'D4' },
        ],
      },
      {
        key: 'B',
        label: '不信，但继续查',
        keywords: ['不信', '怀疑', '继续查'],
        cond: null,
        text: '你没表态，把通话时长记了下来。有些重逢要等证据先到。',
        effects: [
          { path: 'flags.doubted_him', op: 'set', value: true },
          { path: 'flags.case_stage', op: 'add', value: 1 },
          { path: 'clues', op: 'push', value: 'D4' },
        ],
      },
      {
        key: 'C',
        label: '假装配合',
        keywords: ['假装', '拖着', '先答应'],
        cond: null,
        text: '你答应得很好。挂了电话，你让律师按另一条路准备。',
        effects: [
          { path: 'flags.played_along', op: 'set', value: true },
          { path: 'flags.case_stage', op: 'add', value: 1 },
          { path: 'flags.dual_track', op: 'set', value: true },
          { path: 'clues', op: 'push', value: 'D4' },
        ],
      },
      {
        key: 'D',
        label: '直接定位',
        keywords: ['定位', '抓他', '花钱'],
        cond: null,
        text: '你没有等他自己回来。预算批下去，第三天就有了地址。',
        effects: [
          { path: 'clues', op: 'push', value: 'S11' },
          { path: 'clues', op: 'push', value: 'D4' },
          { path: 'flags.case_stage', op: 'add', value: 1 },
          { path: 'flags.found_him', op: 'set', value: true },
          { path: 'ledger.expense', op: 'add', value: 500000 },
        ],
      },
    ],
  },

  {
    id: 'R23',
    title: '立案那天',
    priority: 65,
    actors: ['seeker'],
    require: { path: 'flags.case_stage', op: '>=', value: 6 },
    fallback: 'B',
    branches: [
      {
        key: 'A',
        label: '陪她去',
        keywords: ['陪', '一起去', '我陪'],
        cond: null,
        text: '她签字的时候手很稳。出来在台阶上站了一会儿，'
          + '说：「这不是结局。」',
        effects: [
          { path: 'actors.seeker.stats.trust', op: 'add', value: 12 },
          { path: 'actors.seeker.stats.dignity', op: 'add', value: 10 },
          { path: 'clues', op: 'push', value: 'D6' },
          { path: 'flags.divorce_filed', op: 'set', value: true },
        ],
      },
      {
        key: 'B',
        label: '律师全权处理',
        keywords: ['律师', '全权', '不去'],
        cond: null,
        text: '流程走完了。她自己去取的文书，没跟任何人说。',
        effects: [
          { path: 'actors.seeker.stats.dignity', op: 'add', value: 10 },
          { path: 'clues', op: 'push', value: 'D6' },
          { path: 'flags.divorce_filed', op: 'set', value: true },
        ],
      },
      {
        key: 'C',
        label: '劝她再等一等',
        keywords: ['再等', '别急', '缓一缓'],
        cond: null,
        text: '你说再看一年。她把笔放下，说好。那个「好」听得很轻。',
        effects: [
          { path: 'actors.seeker.stats.trust', op: 'sub', value: 10 },
          { path: 'actors.seeker.stats.dignity', op: 'sub', value: 8 },
          { path: 'flags.delayed_filing', op: 'set', value: true },
        ],
      },
    ],
  },

  {
    id: 'R24',
    title: '年前最后一次催收',
    priority: 60,
    actors: ['collector', 'seeker'],
    require: { path: 'flags.case_stage', op: '>=', value: 2 },
    fallback: 'A',
    branches: [
      {
        key: 'A',
        label: '当面谈条件',
        keywords: ['谈条件', '当面谈', '分期'],
        cond: null,
        text: '你把还款拆成十二期。对方同意了 —— 同意代表承认，'
          + '也代表这笔账从此有名有姓。',
        effects: [
          { path: 'flags.negotiated', op: 'set', value: true },
          { path: 'actors.seeker.stats.pressure', op: 'sub', value: 10 },
        ],
      },
      {
        key: 'B',
        label: '再次报警',
        keywords: ['报警', '警察', '再来就报'],
        cond: null,
        text: '第二次出警记录摆在那里。再来，就是第三条。',
        effects: [
          { path: 'flags.police_record', op: 'set', value: true },
          { path: 'actors.collector.stats.patience', op: 'sub', value: 25 },
        ],
      },
      {
        key: 'C',
        label: '全额结清',
        keywords: ['结清', '全还', '一次还完'],
        cond: null,
        text: '钱转出去了。催收的人走了，她站在客厅中间很久没动 —— '
          + '账清了，有些别的东西也一起被结算了。',
        effects: [
          { path: 'ledger.expense', op: 'add', value: 5000000 },
          { path: 'flags.paid_off', op: 'set', value: true },
          { path: 'actors.seeker.stats.dignity', op: 'sub', value: 14 },
          { path: 'actors.seeker.stats.pressure', op: 'sub', value: 20 },
        ],
      },
      {
        key: 'D',
        label: '不见',
        keywords: ['不见', '不出面', '躲'],
        cond: null,
        text: '门没开。年关的这几天，楼道里一直有人来回走。',
        effects: [
          { path: 'actors.seeker.stats.pressure', op: 'add', value: 15 },
          { path: 'actors.kin.stats.safety', op: 'sub', value: 12 },
          { path: 'flags.hid_from_collector', op: 'set', value: true },
        ],
      },
    ],
  },

  /* ══════════════ 第五幕 · 收束 ══════════════ */
  {
    id: 'R25',
    title: '清明，去见他',
    priority: 55,
    actors: ['seeker', 'kin'],
    require: { path: 'flags.case_stage', op: '>=', value: 6 },
    fallback: 'C',
    branches: [
      {
        key: 'A',
        label: '一起去',
        keywords: ['一起去', '三个人', '一起'],
        cond: null,
        text: '山路不好走。谁都没说话，但三个人的步子后来走到了一起。',
        effects: [
          { path: 'flags.together_visit', op: 'set', value: true },
          { path: 'actors.kin.stats.anxiety', op: 'sub', value: 12 },
          { path: 'actors.seeker.stats.pressure', op: 'sub', value: 10 },
        ],
      },
      {
        key: 'B',
        label: '只看，不说话',
        keywords: ['不说话', '站着', '安静'],
        cond: null,
        text: '站了十分钟，各自消化。回头的时候谁也没提这件事。',
        effects: [
          { path: 'flags.silent_visit', op: 'set', value: true },
          { path: 'actors.kin.stats.anxiety', op: 'sub', value: 6 },
        ],
      },
      {
        key: 'C',
        label: '让她们自己决定',
        keywords: ['她们决定', '你们定', '随她们'],
        cond: null,
        text: '你说去不去由她们。她们商量了一路，最后还是去了 —— '
          + '自己决定的去，和被人带去的去，不一样。',
        effects: [
          { path: 'flags.their_choice', op: 'set', value: true },
          { path: 'actors.seeker.stats.dignity', op: 'add', value: 14 },
          { path: 'actors.kin.stats.trust', op: 'add', value: 8 },
        ],
      },
      {
        key: 'D',
        label: '不去',
        keywords: ['不去', '算了', '不去了'],
        cond: null,
        text: '那天没有出门。窗外的雨很小，一整天都在下。',
        effects: [
          { path: 'flags.did_not_go', op: 'set', value: true },
          { path: 'actors.kin.stats.anxiety', op: 'add', value: 8 },
        ],
      },
    ],
  },

  {
    id: 'R26',
    title: '搬家与否',
    priority: 50,
    actors: ['seeker', 'kin'],
    require: { path: 'flags.took_them_in', op: '==', value: true },
    fallback: 'B',
    branches: [
      {
        key: 'A',
        label: '一起搬',
        keywords: ['一起搬', '搬走', '换个地方'],
        cond: null,
        text: '新住处有三间房。搬完最后一箱书的时候，天快亮了。',
        effects: [
          { path: 'flags.moved_together', op: 'set', value: true },
          { path: 'actors.seeker.stats.pressure', op: 'sub', value: 8 },
          { path: 'actors.kin.stats.safety', op: 'add', value: 10 },
        ],
      },
      {
        key: 'B',
        label: '让她们自己选',
        keywords: ['自己选', '她们定', '不干涉'],
        cond: null,
        text: '你把选择权交回去。她们考虑了三天，给了你一个答复，'
          + '答复里有一句「以后」—— 那是她们第一次用这个词。',
        effects: [
          { path: 'flags.they_chose', op: 'set', value: true },
          { path: 'actors.seeker.stats.dignity', op: 'add', value: 15 },
          { path: 'actors.kin.stats.trust', op: 'add', value: 10 },
        ],
      },
      {
        key: 'C',
        label: '维持现状',
        keywords: ['不搬', '维持', '就这样'],
        cond: null,
        text: '没有搬。有些事不动，是因为谁都不想做那个先开口的人。',
        effects: [
          { path: 'flags.stayed', op: 'set', value: true },
          { path: 'actors.kin.stats.anxiety', op: 'add', value: 8 },
        ],
      },
    ],
  },

  /* ══════════════ 边界机制：划界 → 过闸 ══════════════ */
  {
    id: 'R27',
    title: '把能说的和不能说的说清楚',
    priority: 45,
    actors: ['seeker'],
    require: { path: 'flags.took_them_in', op: '==', value: true },
    fallback: 'B',
    branches: [
      {
        key: 'A',
        label: '当场把界限谈明白',
        keywords: ['界限', '说清楚', '谈明白', '能问什么'],
        cond: null,
        text: '你没有绕。哪些事能问、哪些事不归你管、帮到哪一步为止 —— '
          + '一条一条摆出来。她也说了她的。',
        effects: [
          { path: 'routes.seeker', op: 'set', value: 'open' },
          { path: 'flags.boundary_agreed', op: 'set', value: true },
          { path: 'actors.seeker.stats.trust', op: 'add', value: 8 },
          { path: 'actors.kin.stats.safety', op: 'add', value: 8 },
        ],
      },
      {
        key: 'B',
        label: '先不谈这个',
        keywords: ['不谈', '以后再说', '先不提'],
        cond: null,
        text: '你没有把话摊开。有些事留在没说的地方，'
          + '也就没人知道它到底算不算数。',
        effects: [
          { path: 'actors.seeker.stats.pressure', op: 'add', value: 6 },
          { path: 'flags.boundary_deferred', op: 'set', value: true },
        ],
      },
    ],
  },

  {
    id: 'R28',
    title: '按说好的来',
    priority: 40,
    actors: ['seeker'],
    require: { path: 'flags.boundary_agreed', op: '==', value: true },
    fallback: 'B',
    branches: [
      {
        key: 'A',
        label: '照说好的那一步走',
        keywords: ['按说好的', '照说好的', '进一步'],
        cond: null,
        requiresConsent: 'seeker',
        text: '你按说好的那一步往下走 —— 不抢在前面，也不落在后面。'
          + '这一次的推进，是她当轮亲口点的头。',
        effects: [
          { path: 'routes.seeker', op: 'set', value: 'advancing' },
          { path: 'actors.seeker.stats.trust', op: 'add', value: 10 },
          { path: 'flags.advanced_once', op: 'set', value: true },
        ],
      },
      {
        key: 'B',
        label: '就停在这儿',
        keywords: ['停', '不急', '就这样'],
        cond: null,
        text: '你在她自己划的那条线之前就停了。停不是退，只是今天不走。',
        effects: [
          { path: 'actors.seeker.stats.trust', op: 'add', value: 6 },
          { path: 'flags.held_back', op: 'set', value: true },
        ],
      },
    ],
  },

  {
    id: 'R29',
    title: '一年的信',
    priority: 210,
    actors: ['seeker', 'kin'],
    require: { path: 'flags.case_stage', op: '>=', value: 6 },
    fallback: 'B',
    branches: [
      {
        key: 'A',
        label: '回信',
        keywords: ['回信', '回', '写回去'],
        cond: null,
        text: '信不长。你写完之后读了一遍，把最重的那句划掉了，'
          + '换成了日期。',
        effects: [
          { path: 'flags.replied', op: 'set', value: true },
          { path: 'actors.seeker.stats.trust', op: 'add', value: 8 },
        ],
      },
      {
        key: 'B',
        label: '收进抽屉',
        keywords: ['存档', '收着', '放着'],
        cond: null,
        text: '你把信收进了抽屉。有些东西不必回，留着就够了。',
        effects: [{ path: 'flags.archived', op: 'set', value: true }],
      },
      {
        key: 'C',
        label: '烧掉',
        keywords: ['烧', '不看了', '烧掉'],
        cond: null,
        text: '你在阳台上烧了它。灰很轻，一下就散了。',
        effects: [
          { path: 'flags.burned', op: 'set', value: true },
          { path: 'actors.self.stats.composure', op: 'add', value: 8 },
        ],
      },
    ],
  },

  /* ══════════════ 关系路线（非性机制层）══════════════
     路线阶段存在 flags 里 —— createInitialState 的字段是固定白名单，
     加不了新字段；flags 本来就是自由对象，条件系统也能直接读。

     阶段取自文档 §4 的「路线节点」，**剔除其中的「伴侣-共享」节点**
     （成人向，本模式不实现）。剩下的节点是关系结构本身：
       林晚晴：暂住 → 共同生活 → 债务共担 → 情感依赖 → 决裂
       周若宁：暂住 → 依赖 → 共同调查 → 情感依赖 → 独立 → 决裂
     每个事件只推进一格，且必须先处在上一格 —— 路线由玩家自己走，
     不靠亲密度自动跳。 */
  {
    id: 'P01',
    title: '给她一把钥匙',
    priority: 150,
    require: { path: 'flags.took_them_in', op: '==', value: true },
    fallback: 'B',
    branches: [
      {
        key: 'A',
        label: '配一把钥匙给她',
        keywords: ['钥匙', '配一把', '给她'],
        cond: null,
        text: '你把备用钥匙放在桌上，没多说什么。她看了那把钥匙很久，'
          + '才伸手拿起来，收进风衣内袋。\n\n从这一晚起，她不再算「借住」。',
        effects: [
          { path: 'flags.path_seeker', op: 'set', value: '共同生活' },
          { path: 'actors.seeker.stats.trust', op: 'add', value: 6 },
          { path: 'actors.seeker.stats.pressure', op: 'add', value: -4 },
          { path: 'where', op: 'set', value: 'room' },
        ],
      },
      {
        key: 'B',
        label: '先维持客人身份',
        keywords: ['客人', '再说', '不急'],
        cond: null,
        text: '你说不急，住着看。她点头，把包放回门边 —— 没有拆开。',
        effects: [
          { path: 'actors.seeker.stats.pressure', op: 'add', value: 3 },
        ],
      },
    ],
  },
  {
    id: 'P02',
    title: '把账摊开',
    priority: 148,
    require: { all: [
      { path: 'flags.path_seeker', op: '==', value: '共同生活' },
      { path: 'flags.case_stage', op: '>=', value: 2 },
    ] },
    fallback: 'B',
    branches: [
      {
        key: 'A',
        label: '和她一起算这笔账',
        keywords: ['一起算', '摊开', '算账'],
        cond: null,
        text: '你把纸铺开，一项一项写。她没有回避数字，只在写到某个数时停了一下，'
          + '然后把笔接过去，自己往下写。',
        effects: [
          { path: 'flags.path_seeker', op: 'set', value: '债务共担' },
          { path: 'actors.seeker.stats.trust', op: 'add', value: 8 },
          { path: 'actors.seeker.stats.dignity', op: 'add', value: 6 },
          { path: 'flags.shared_ledger', op: 'set', value: true },
        ],
      },
      {
        key: 'B',
        label: '这笔账我自己扛',
        keywords: ['我来', '自己扛', '不用你'],
        cond: null,
        text: '你把纸合上，说这事你来。她没争，只是把手从桌沿收了回去。',
        effects: [
          { path: 'actors.seeker.stats.pressure', op: 'add', value: 6 },
          { path: 'actors.self.stats.pressure', op: 'add', value: 8 },
        ],
      },
    ],
  },
  {
    id: 'P03',
    title: '她开始托付',
    priority: 146,
    require: { all: [
      { path: 'flags.path_seeker', op: '==', value: '债务共担' },
      { path: 'actors.seeker.stats.trust', op: '>=', value: 70 },
    ] },
    fallback: 'B',
    branches: [
      {
        key: 'A',
        label: '接住她递过来的东西',
        keywords: ['接住', '收下', '我来保管'],
        cond: null,
        text: '她把一个旧信封推过来，说这里面是她一直没敢拿出来的东西。'
          + '推过来的时候，她的手是稳的。',
        effects: [
          { path: 'flags.path_seeker', op: 'set', value: '情感依赖' },
          { path: 'actors.seeker.stats.trust', op: 'add', value: 6 },
          { path: 'clues', op: 'push', value: 'S3' },
        ],
      },
      {
        key: 'B',
        label: '先把界限说清楚',
        keywords: ['界限', '说清楚', '不用'],
        cond: null,
        text: '你说东西你自己收着，需要的时候你会帮。她愣了半秒，'
          + '然后把信封收回怀里 —— 表情比刚才松了一点。',
        effects: [
          { path: 'actors.seeker.stats.dignity', op: 'add', value: 8 },
          { path: 'flags.held_back', op: 'set', value: true },
        ],
      },
    ],
  },
  {
    id: 'P04',
    title: '她今晚不太对',
    priority: 144,
    require: { all: [
      { path: 'flags.path_seeker', op: '!=', value: '决裂' },
      { path: 'actors.seeker.stats.dignity', op: '<=', value: 40 },
    ] },
    fallback: 'A',
    branches: [
      {
        key: 'A',
        label: '把话说回来',
        keywords: ['道歉', '说回来', '不是那个意思'],
        cond: null,
        text: '你意识到刚才那句话落下去的重量。你把话收回来，'
          + '重新说了一遍 —— 这次没有替她做决定。',
        effects: [
          { path: 'actors.seeker.stats.dignity', op: 'add', value: 12 },
          { path: 'actors.seeker.stats.trust', op: 'add', value: 4 },
        ],
      },
      {
        key: 'B',
        label: '就这样吧',
        keywords: ['算了', '就这样', '不管'],
        cond: null,
        text: '你没再说什么。第二天早上，她的行李收好了，'
          + '放在门边，摞得很整齐。',
        effects: [
          { path: 'flags.path_seeker', op: 'set', value: '决裂' },
          { path: 'actors.seeker.stats.trust', op: 'add', value: -20 },
        ],
      },
    ],
  },
  {
    id: 'P05',
    title: '给她一个固定位置',
    priority: 142,
    require: { path: 'flags.met_seeker', op: '==', value: true },
    fallback: 'B',
    branches: [
      {
        key: 'A',
        label: '把书桌腾给她',
        keywords: ['书桌', '腾', '位置'],
        cond: null,
        text: '你把靠窗那张桌子清空，说以后这归你。她没道谢，'
          + '第二天桌上多了一摞卷子，边角压得很平。',
        effects: [
          { path: 'flags.path_kin', op: 'set', value: '依赖' },
          { path: 'actors.kin.stats.safety', op: 'add', value: 10 },
          { path: 'actors.kin.stats.anxiety', op: 'add', value: -4 },
        ],
      },
      {
        key: 'B',
        label: '先别动家里的东西',
        keywords: ['别动', '再说', '不方便'],
        cond: null,
        text: '你说东西先别动，住着就好。她「嗯」了一声，'
          + '把书包抱在腿上坐了一晚上。',
        effects: [
          { path: 'actors.kin.stats.safety', op: 'add', value: -5 },
        ],
      },
    ],
  },
  {
    id: 'P06',
    title: '她要跟着去',
    priority: 140,
    require: { all: [
      { path: 'flags.path_kin', op: '==', value: '依赖' },
      { path: 'flags.case_stage', op: '>=', value: 1 },
    ] },
    fallback: 'B',
    branches: [
      {
        key: 'A',
        label: '带上她一起查',
        keywords: ['带上', '一起', '陪我去'],
        cond: null,
        text: '她记得比你清楚 —— 时间、颜色、车牌上的三个数。'
          + '你让她把记得的都写下来，她写得很快，没有停笔。',
        effects: [
          { path: 'flags.path_kin', op: 'set', value: '共同调查' },
          { path: 'actors.kin.stats.anxiety', op: 'add', value: -6 },
          { path: 'actors.kin.stats.safety', op: 'add', value: 6 },
          { path: 'clues', op: 'push', value: 'S2' },
        ],
      },
      {
        key: 'B',
        label: '让她专心念书',
        keywords: ['念书', '考试', '别管'],
        cond: null,
        text: '你说这些事不用她管，把书念好就行。她点头，'
          + '回房间关了门 —— 关得比平时重。',
        effects: [
          { path: 'actors.kin.stats.anxiety', op: 'add', value: -8 },
          { path: 'actors.kin.stats.anger', op: 'add', value: 6 },
        ],
      },
    ],
  },
  {
    id: 'P07',
    title: '她想自己去一趟',
    priority: 138,
    require: { all: [
      { path: 'flags.path_kin', op: '==', value: '共同调查' },
      { path: 'actors.kin.stats.safety', op: '>=', value: 70 },
    ] },
    fallback: 'B',
    branches: [
      {
        key: 'A',
        label: '让她自己走这一趟',
        keywords: ['自己去', '放手', '让她去'],
        cond: null,
        text: '你只问了一句「几点回来」。她说了时间，然后真的按那个时间回来了 —— '
          + '手里多了一张折了两道的纸条。',
        effects: [
          { path: 'flags.path_kin', op: 'set', value: '独立' },
          { path: 'flags.kin_alone', op: 'set', value: true },
          { path: 'actors.kin.stats.safety', op: 'add', value: 8 },
          { path: 'clues', op: 'push', value: 'S4' },
        ],
      },
      {
        key: 'B',
        label: '还是陪着去',
        keywords: ['陪着', '一起去', '不放心'],
        cond: null,
        text: '你说一起去。她没反对，路上一直走在你的后半步。',
        effects: [
          { path: 'flags.path_kin', op: 'set', value: '情感依赖' },
          { path: 'actors.kin.stats.safety', op: 'add', value: 4 },
        ],
      },
    ],
  },
];

/* ------------------------------------------------------------------ *
 * 结局（priority 高者先判）
 * ------------------------------------------------------------------ */

/* 结局判定的共同前提：至少推进过 6 轮。
   不加这一条会出事 —— END_B3 那种「还没查到阶段 3」的兜底条件，
   在开局第一轮就成立，game over 直接拍在玩家脸上。
   这里用 history 的下标存在性当轮次信号，比给 state 新加字段轻。 */
const MIN_TURNS = 6;
const afterTurns = (n) => ({ path: `history[${n - 1}]`, op: 'exists' });

const ENDINGS = [
  {
    id: 'END_A8',
    title: '关上的门',
    priority: 120,
    tier: 'C',
    note: '信任塌到底之后，屋子还在，人散了。',
    cond: {
      all: [
        afterTurns(MIN_TURNS),
        { path: 'actors.seeker.stats.trust', op: '<=', value: 20 },
      ],
    },
  },
  {
    id: 'END_B1',
    title: '整张网',
    priority: 100,
    tier: 'S',
    note: '空壳、走账、套牌 —— 你终于看清了整张网，也包括自己在里面。',
    cond: {
      all: [
        { path: 'flags.case_stage', op: '>=', value: 6 },
        { path: 'clues', op: 'contains', value: 'D5' },
      ],
    },
  },
  {
    id: 'END_B5',
    title: '他自己回来了',
    priority: 90,
    tier: 'A',
    note: '他回来了，并且把该认的都认了。这不算圆满，但算结算。',
    cond: {
      all: [
        { path: 'flags.believed_him', op: '==', value: true },
        { path: 'flags.case_stage', op: '>=', value: 6 },
      ],
    },
  },
  {
    id: 'END_B6',
    title: '第二次被骗',
    priority: 85,
    tier: 'C',
    note: '你在同一个地方，信了同一个人两次。第二次代价更大。',
    cond: {
      all: [
        { path: 'flags.played_along', op: '==', value: true },
        { path: 'flags.case_stage', op: '>=', value: 6 },
      ],
    },
  },
  {
    id: 'END_B7',
    title: '用钱结的账',
    priority: 80,
    tier: 'A',
    note: '账是清了。她要还的，从此变成另一种东西。',
    cond: {
      all: [
        afterTurns(MIN_TURNS),
        { path: 'flags.paid_off', op: '==', value: true },
      ],
    },
  },
  {
    id: 'END_A6',
    title: '一屋子灯火',
    priority: 75,
    tier: 'S',
    note: '没有惊雷。客厅一盏灯，书房一盏灯，都亮着。',
    cond: {
      all: [
        { path: 'flags.took_them_in', op: '==', value: true },
        { path: 'flags.their_choice', op: '==', value: true },
        { path: 'flags.case_stage', op: '>=', value: 6 },
      ],
    },
  },
  {
    id: 'END_A7',
    title: '渡口',
    priority: 70,
    tier: 'A',
    note: '船开走的时候，她站在岸上，没有哭。',
    cond: {
      all: [
        { path: 'flags.they_chose', op: '==', value: true },
        { path: 'flags.case_stage', op: '>=', value: 4 },
      ],
    },
  },
  {
    id: 'END_A9',
    title: '搬家那天',
    priority: 65,
    tier: 'B',
    note: '三间房的钥匙交了，最后一箱书搬上楼，天就亮了。',
    cond: {
      all: [
        afterTurns(MIN_TURNS),
        { path: 'flags.moved_together', op: '==', value: true },
      ],
    },
  },
  {
    id: 'END_B2',
    title: '一部分真相',
    priority: 60,
    tier: 'A',
    note: '你摸到了主干的形状，但没有摸到最后那一节。',
    cond: {
      all: [
        afterTurns(MIN_TURNS),
        { path: 'flags.case_stage', op: '>=', value: 3 },
      ],
    },
  },
  {
    id: 'END_B3',
    title: '悬在那里',
    priority: 40,
    tier: 'B',
    note: '债务没有消失，只是没人再提。它会在别的时候回来。',
    // 用 not 而不是 case_stage<=2：缺失路径一律判 false，
    // 直接写 <= 会在"还没开始查"时反而不成立
    cond: {
      all: [
        afterTurns(MIN_TURNS),
        { not: { path: 'flags.case_stage', op: '>=', value: 3 } },
      ],
    },
  },
  {
    id: 'END_A5',
    title: '这一夜过去了',
    priority: 5,
    tier: 'B',
    note: '雨停了。事情没有解决，但也没有更坏。',
    cond: { path: 'flags.declined', op: '==', value: true },
  },
  /* 关系线结局 —— 同样要带轮次前提，否则开局就成立 */
  {
    id: 'END_P1',
    title: '同住的第一个冬天',
    note: '账摊在同一张纸上，钥匙在同一个抽屉里。',
    tier: 'A',
    cond: {
      all: [
        afterTurns(MIN_TURNS),
        { path: 'flags.path_seeker', op: '==', value: '情感依赖' },
        { path: 'flags.case_stage', op: '>=', value: 4 },
      ],
    },
  },
  {
    id: 'END_P2',
    title: '各自的路',
    note: '她自己去走了一趟，回来的时候比走的时候稳。',
    tier: 'A',
    cond: {
      all: [
        afterTurns(MIN_TURNS),
        { path: 'flags.path_kin', op: '==', value: '独立' },
      ],
    },
  },
  {
    id: 'END_P3',
    title: '门边的行李',
    note: '摞得很整齐。',
    tier: 'C',
    cond: {
      all: [
        afterTurns(MIN_TURNS),
        { path: 'flags.path_seeker', op: '==', value: '决裂' },
      ],
    },
  },
];

/* ------------------------------------------------------------------ *
 * 成就
 * ------------------------------------------------------------------ */

const ACHIEVEMENTS = [
  /* 主体性类 */
  { id: 'A_R01', title: '一碗隔夜的粥', note: '她还端着那碗粥，手在抖。', cond: { path: 'flags.took_them_in', op: '==', value: true } },
  { id: 'A_R02', title: '门里门外', note: '你没有立刻开，但天亮之前，门开了。', cond: { path: 'flags.asked_first', op: '==', value: true } },
  { id: 'A_R03', title: '未曾折损', note: '有些东西碎了能补，她那件不能。', cond: { all: [{ path: 'actors.seeker.stats.dignity', op: '>=', value: 70 }, { path: 'flags.case_stage', op: '>=', value: 4 }] } },
  { id: 'A_R04', title: '未曾越界', note: '你在她自己划的那条线之前就停了。', cond: { path: 'flags.held_back', op: '==', value: true } },
  { id: 'A_R05', title: '她自己走完的', note: '她一个人走完那一段，回来手上多了一张纸条。', cond: { path: 'flags.kin_alone', op: '==', value: true } },
  { id: 'A_R06', title: '她被当成人问过', note: '你先问她想要什么。', cond: { path: 'flags.asked_her', op: '==', value: true } },
  { id: 'A_R07', title: '这是我自己的事', note: '她说：「我可以。」', cond: { path: 'flags.her_errand', op: '==', value: true } },
  { id: 'A_R08', title: '交给她们选', note: '去不去由她们。她们商量了一路。', cond: { path: 'flags.their_choice', op: '==', value: true } },

  /* 调查类 */
  { id: 'A_I01', title: '第一声铃', note: '红色催告单，钉在门上像一枚钉子。', cond: { path: 'clues', op: 'contains', value: 'D1' } },
  { id: 'A_I02', title: '尾号八四二', note: '那三个数字从此跟着你走。', cond: { path: 'clues', op: 'contains', value: 'S1' } },
  { id: 'A_I03', title: '两层皮', note: '牌是真的，车是假的。', cond: { path: 'flags.plate_fake', op: '==', value: true } },
  { id: 'A_I04', title: '画面定格', note: '监控里，有人从车上下来。', cond: { path: 'clues', op: 'contains', value: 'S7' } },
  { id: 'A_I05', title: '水往低处流', note: '钱走了一圈，最后全落进同一个口袋。', cond: { path: 'flags.four_names', op: '==', value: true } },
  { id: 'A_I06', title: '空心公司', note: '工商档案上有人名，没有人。', cond: { path: 'clues', op: 'contains', value: 'D3' } },
  { id: 'A_I07', title: '一纸律师函', note: '信寄出去了，规矩才开始。', cond: { path: 'flags.dual_track', op: '==', value: true } },
  { id: 'A_I08', title: '倒戈', note: '她说出真相那天，风向变了。', cond: { path: 'flags.insider_turned', op: '==', value: true } },
  { id: 'A_I09', title: '归案', note: '那条线终于收回到一个人身上。', cond: { path: 'clues', op: 'contains', value: 'D6' } },
  { id: 'A_I10', title: '割席', note: '立案不是结局，是分界线。', cond: { path: 'flags.divorce_filed', op: '==', value: true } },
  { id: 'A_I11', title: '留痕', note: '有些事第一次有人替她记了编号。', cond: { path: 'flags.police_record', op: '==', value: true } },
  { id: 'A_I12', title: '压在纸上的话', note: '四分十二秒，对方说得太急了。', cond: { path: 'flags.recorded', op: '==', value: true } },

  /* 隐藏类 */
  { id: 'A_H01', title: '两次空手', note: '催收的人来了两次，两次都空手走。', cond: { path: 'flags.faced_collector', op: '==', value: true } },
  { id: 'A_H02', title: '一句软证词', note: '走廊很长，老人拉着她的手说了两句。', cond: { path: 'clues', op: 'contains', value: 'S8' } },
  { id: 'A_H03', title: '三十米', note: '她没回头，但你一直在。', cond: { path: 'flags.shadowed', op: '==', value: true } },
  { id: 'A_H04', title: '阿砚', note: '角落里有个人，一直在替你们记着。', cond: { path: 'flags.met_anyan', op: '==', value: true } },

  /* 关系线（非性机制层）*/
  { id: 'A_P01', title: '一把钥匙', note: '她不再算「借住」。', cond: { path: 'flags.path_seeker', op: '==', value: '共同生活' } },
  { id: 'A_P02', title: '同一张纸上的数字', note: '笔是她自己接过去的。', cond: { path: 'flags.shared_ledger', op: '==', value: true } },
  { id: 'A_P03', title: '她递过来的东西', note: '推过来的时候，她的手是稳的。', cond: { path: 'flags.path_seeker', op: '==', value: '情感依赖' } },
  { id: 'A_P04', title: '靠窗那张桌子', note: '第二天桌上多了一摞卷子。', cond: { path: 'flags.path_kin', op: '==', value: '依赖' } },
  { id: 'A_P05', title: '她写下来的三个数', note: '时间、颜色、车牌。', cond: { path: 'flags.path_kin', op: '==', value: '共同调查' } },
  { id: 'A_P06', title: '她自己去的那一趟', note: '她按说好的时间回来了。', cond: { path: 'flags.path_kin', op: '==', value: '独立' } },
  { id: 'A_P07', title: '账摊开过', note: '数字写在同一张纸上。', cond: { path: 'flags.path_seeker', op: '==', value: '债务共担' } },
];

/* ------------------------------------------------------------------ *
 * 世界书
 * ------------------------------------------------------------------ */

const WORLDBOOK = [
  {
    id: 'RN01',
    heading: '雨夜',
    category: '概要',
    keys: [],
    constant: true,
    order: 100,
    content: '现代都市。这场雨从傍晚下起，到深夜没有停的意思。\n'
      + '求助者带着一个还在读书的家人深夜来投奔 —— 家里有人欠了债，失踪两周了。\n'
      + '基调：克制的都市悬疑。写实、不夸张、不出现超自然解释。'
      + '紧张感来自细节和留白，不靠形容词堆砌。',
  },
  {
    id: 'RN02',
    heading: '失联与债务',
    category: '主线',
    keys: ['债务', '欠', '钱', '借款', '还'],
    order: 90,
    content: '失联者留下「抱歉」便条，手机关机，已经两周。\n'
      + '债权人不是银行，是一家租赁公司；再往上，是一个做建材的。\n'
      + '本息合计五百万，利息滚得快。催告单是红色的，贴过很多次。',
  },
  {
    id: 'RN03',
    heading: '842',
    category: '线索',
    keys: ['842', '面包车', '车牌', '车'],
    order: 85,
    content: '一辆黑色面包车，尾号 842。最近常在学校门口停很久，'
      + '副驾上有人拿着对讲机。\n'
      + '这辆车是套牌 —— 真车主那辆三个月前就报废了。',
  },
  {
    id: 'RN04',
    heading: '走账通道',
    category: '主线',
    keys: ['空壳', '走账', '公司', '账'],
    order: 80,
    content: '建材商以项目为名，让失联者注册了一家空壳公司，'
      + '用这家公司走账、对外借高利贷。\n'
      + '工商档案上有人名，却没有实际经营。842 那辆车，实际是建材商在用。',
  },
  {
    id: 'RN05',
    heading: '共同生活',
    category: '概要',
    keys: ['住下', '暂住', '客房', '搬'],
    order: 70,
    content: '住处有一间一直空着的客房。共同生活的第一周，'
      + '所有规矩都要重新谈一遍：做什么、不做什么、帮到哪一步。',
  },
  {
    id: 'RN06',
    heading: '边界',
    category: '任务',
    keys: ['边界', '意愿', '撤回', '同意'],
    order: 75,
    content: '（机制说明）任何推进都需要对方的**当轮**公开意愿；'
      + '撤回立即生效，路线只冻结不注销；纠缠有代价。\n'
      + '经济帮助、住宿、债务援助 —— 都不构成同意。',
  },
  {
    id: 'RN07',
    heading: '经济账本',
    category: '任务',
    keys: ['花销', '预算', '支出'],
    order: 65,
    content: '每一笔支出都记账：安保、律师、银行调查、以及可能的代偿。'
      + '账本与叙事分离 —— 花了多少、花在哪，必须能查。',
  },
  {
    id: 'RN08',
    heading: '可调用资源',
    category: '任务',
    keys: ['资源', '律师', '警方', '银行', '安保'],
    order: 60,
    content: '四类资源：律师、银行渠道、警方熟人、驻地管家团队。\n'
      + '每次调用都要花时间或钱，并且会改变催收方的警觉度。',
  },
  {
    id: 'RN09',
    heading: '催收方',
    category: '主线',
    keys: ['催收', '上门', '催告'],
    order: 55,
    content: '非正规催收：上门、贴单、人身威胁。\n'
      + '他们的行为由**警觉度**决定 —— 你动得越明显，他们越早转地下。',
  },
  {
    id: 'RN10',
    heading: '同行的人',
    category: '概要',
    keys: ['校服', '学校', '考试', '她'],
    order: 50,
    content: '那个跟着一起来的家人还在读书。她最在意的是「校服不能断」。\n'
      + '她会自己行动 —— 安全感越低，越可能一个人去查。',
  },
  {
    id: 'RN11',
    heading: '主体性',
    category: '任务',
    keys: ['尊严', '自尊', '体面'],
    order: 45,
    content: '对方保有独立人格与选择权，是本模式的核心判据之一。\n'
      + '「我全安排好」效率高但会压低自尊；「给渠道让她自己跑」慢但抬高自尊。',
  },
  {
    id: 'RN12',
    heading: '时效',
    category: '概要',
    keys: ['时间', '拖', '等'],
    order: 40,
    content: '债不等人。连续几轮不推进调查，催收就会自己找上门来。',
  },
  {
    id: 'RN13',
    heading: '林晚晴',
    keys: ['林晚晴', '晚晴', '嫂子'],
    category: '概要',
    content:
      '36 岁。周世杰的妻子，{{user}} 的嫂子。雨夜带着女儿前来投奔。\n'
      + '说话克制、要面子，习惯先把自己收拾整齐再谈事。\n'
      + '对周世杰：疲惫、失望，但仍认这份夫妻责任。\n'
      + '对她自己：不肯白拿 —— 帮忙可以，施舍不行。',
  },
  {
    id: 'RN14',
    heading: '周若宁',
    keys: ['周若宁', '若宁', '侄女'],
    category: '概要',
    content:
      '18 岁。周世杰的女儿，{{user}} 的侄女，与 {{user}} 无血缘关系。\n'
      + '嘴硬、要强，先撑住再谈感受。对父亲是愤怒与羞耻。\n'
      + '在学校门口目击过一辆黑色面包车，尾号 842，停了很久。\n'
      + '她要的是「被当成能商量的人」，不是被保护起来。',
  },
  {
    id: 'RN15',
    heading: '周世杰与那笔债',
    keys: ['周世杰', '世杰', '哥哥', '五百万', '本息'],
    category: '主线',
    content:
      '45 岁。{{user}} 的非血缘兄长，林晚晴的丈夫，周若宁的父亲。\n'
      + '欠高利贷五百万本息，利息滚动快，留下「抱歉」便条后失联约两周。\n'
      + '催收方是非正规放贷集团，手段包括红色催告单、上门、人身威胁、记不良记录。\n'
      + '真相分阶段揭示：债务可切割、可追回，或彻底悬置 —— 取决于你查到哪一步。',
  },
];

/* ------------------------------------------------------------------ *
 * 模式导出
 * ------------------------------------------------------------------ */

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
    opening:
      '雨从傍晚下到现在，没停过。\n'
      + '你在自己的住处，本来已经准备睡了 —— 门被敲响了。\n'
      + '敲得很轻，轻到你怀疑是不是听错了；隔了几秒，又敲了三下。',

    brief:
      '现代都市。深夜的雨夜，有人带着一桩难以开口的事来求助：'
      + '家里有人欠了债、失踪两周，债主开始上门。\n'
      + '接不接、怎么接、帮到哪一步 —— 每一步都要重新确认。\n'
      + '基调：克制的都市悬疑。写实、不夸张。紧张感来自细节和留白。',

    placeLabels: PLACES,
    clueLabels: CLUES,

    actorLabels: Object.fromEntries(ACTORS.map(a => [a.id, a.name])),
    statLabels: Object.fromEntries(
      ACTORS.map(a => [a.id, Object.fromEntries(a.stats.map(s => [s.key, s.label]))]),
    ),

    actors: ACTORS,
    worldbook: WORLDBOOK,
    achievements: ACHIEVEMENTS,
    endings: ENDINGS,
    events: EVENTS,
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
    opening: w.opening,
    brief: w.brief,
    placeLabels: w.placeLabels,
    clueLabels: w.clueLabels,
    actorLabels: w.actorLabels,
    statLabels: w.statLabels,
    worldbook: w.worldbook,
    guards: RAINNIGHT_MODE.guards(),
    loreBudget: 1200,
    maxSkips: 24,
  });
}

/** 用模式定义建初始状态（actors 形状一致） */
export function rainInitialState(createInitialStateFn) {
  return createInitialStateFn({
    actors: RAINNIGHT_MODE.world.actors,
    clock: { day: 1, slot: 'night' },
    where: 'room',
    ledger: { cash: 10000000, income: 15000, expense: 0 },
  });
}
