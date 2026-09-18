/**
 * 《雨夜模式》—— 完整模式数据层。
 *
 *
 * 与「茶馆标准」的差异：
 *   1. 边界 guard 强制启用（当轮意愿 / 撤回 / 重新协商全部生效）
 *   2. UI 切到 mode-rainnight 主题
 *   3. 雨势固定偏高（0.85）
 *   4. 左抽屉出现「当轮意愿与边界」卡
 *
 * 数值与线索对齐《雨与夜 V4.1》§4 / §8 / §10 / §19 / §20；
 * 债务线索阶段 0–6 与文档一致，不可跳阶段。
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
  /* 真名、关系与数值均取自《雨与夜 V4.1》§4。 */
  {
    id: 'seeker',
    name: '林晚晴',
    stats: [
      { key: 'trust', label: '信任', min: 0, max: 100, init: 35 },
      { key: 'pressure', label: '压力', min: 0, max: 100, init: 88 },
      { key: 'weary', label: '疲惫', min: 0, max: 100, init: 82 },
      { key: 'dignity', label: '自尊', min: 0, max: 100, init: 90 },
      { key: 'desire', label: '性欲望', min: 0, max: 100, init: 30 },
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
      { key: 'desire', label: '性欲望', min: 0, max: 100, init: 25 },
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

  /* 阶段 3 的三个名字 —— §20 / §21.5 的权威写法：
     债权外壳是鑫达租赁，实际受益人指向建材商陈国栋，
     走账人是李芳（芳达物流）。这三条在事件 15 同一轮浮出。 */
  X1: '鑫达租赁：债主写在纸上的那层壳',
  X2: '陈国栋：做建材的，链路尽头的受益人',
  X3: '李芳 · 芳达物流：走账的人，握着资金回流',
  X4: '抱歉便条：只写了两个字，没有解释',
  X5: '副号的活动轨迹，指向平阳',
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

  /* ── 住处内部（§15 事件卡里的具体房间） ── */
  entryway: '玄关',
  living: '客厅',
  bedroom: '主卧',
  secondroom: '次卧',
  bath: '浴室',
  hallway: '楼道',

  /* ── 学校 ── */
  classroom: '教室',
  library: '学校图书馆',

  /* ── 医院细部 ── */
  checkup: '体检中心',
  ward: '住院部',

  /* ── 办案 ── */
  admin: '工商局',
  detention: '羁押场所',

  /* ── 外地（§21.3 时间线：以上海为中心，辐射北京、平阳、长春） ── */
  beijing: '北京',
  teahouse: '北京茶楼',
  changchun: '长春',
  concert: '长春音乐厅',
  bordertown: '邻省县城',

  /* ── 城市 / 职业场景 ── */
  boardroom: '董事会会议室',
  banquet: '政商论坛晚宴',
  garage: '公司',
  shop: '静安女装店',
  cafe: '咖啡厅',
  airport: '机场',
  hotel: '酒店',
  restaurant: '餐厅',
  studio: '影视基地',
  campus: '复旦',
};

/* ------------------------------------------------------------------ *
 * 事件
 * ------------------------------------------------------------------ */

/* 关系路线的节点表 —— 照《雨与夜 V4.1》§4 的「路线节点」原样收录，
   一格不删。阶段存在 flags.path_<角色> 里，由关系事件逐格推进。
   节点是**结构**（关系走到哪一步），具体怎么演由内容层决定。 */
const PATHS = {
  seeker: ['暂住', '共同生活', '债务共担', '情感依赖', '伴侣-共享', '决裂'],
  kin: ['暂住', '依赖', '共同调查', '情感依赖', '伴侣-共享', '独立', '决裂'],
};

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

  /* ══════════════ 关系路线 ══════════════
     阶段存在 flags.path_<角色> 里 —— createInitialState 的字段是固定白名单，
     加不了新字段；flags 本来就是自由对象，条件系统也能直接读。

     节点表见文件顶部的 PATHS（照 §4 原文收录）。每个事件只推进一格，
     且必须先处在上一格 —— 路线由玩家自己走，不靠亲密度自动跳。 */
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
  {
    id: 'P08',
    title: '她把话挑明',
    priority: 136,
    require: { all: [
      { path: 'flags.path_seeker', op: '==', value: '情感依赖' },
      { path: 'actors.seeker.stats.trust', op: '>=', value: 80 },
    ] },
    fallback: 'B',
    branches: [
      {
        key: 'A',
        label: '把关系定下来',
        keywords: ['定下来', '一起过', '留下'],
        cond: null,
        text: '她把这段时间攒下的东西一件件摊在桌上：钥匙、账本、他留下的那张便条。'
          + '然后她说，想把这些合成一件事。',
        effects: [
          { path: 'flags.path_seeker', op: 'set', value: '伴侣-共享' },
          { path: 'actors.seeker.stats.trust', op: 'add', value: 6 },
          { path: 'flags.partner_seeker', op: 'set', value: true },
        ],
      },
      {
        key: 'B',
        label: '还不是时候',
        keywords: ['还不是时候', '再等等', '先这样'],
        cond: null,
        text: '你说再等等。她点头，把东西一件件收回去，动作和摊开时一样慢。',
        effects: [
          { path: 'actors.seeker.stats.pressure', op: 'add', value: 5 },
        ],
      },
    ],
  },
  {
    id: 'P09',
    title: '她说她不怕了',
    priority: 134,
    require: { all: [
      { path: 'flags.path_kin', op: '==', value: '情感依赖' },
      { path: 'actors.kin.stats.safety', op: '>=', value: 80 },
    ] },
    fallback: 'B',
    branches: [
      {
        key: 'A',
        label: '接住她这句话',
        keywords: ['接住', '好', '答应'],
        cond: null,
        text: '她说这句话的时候一直看着你，没有躲。你说好。'
          + '她好像松了一口气，又好像更紧张了一点。',
        effects: [
          { path: 'flags.path_kin', op: 'set', value: '伴侣-共享' },
          { path: 'actors.kin.stats.safety', op: 'add', value: 6 },
          { path: 'flags.partner_kin', op: 'set', value: true },
        ],
      },
      {
        key: 'B',
        label: '先把书念完',
        keywords: ['念书', '高考', '以后再说'],
        cond: null,
        text: '你说这些以后再说。她「哦」了一声，低头继续写卷子，'
          + '笔尖顿了一下。',
        effects: [
          { path: 'actors.kin.stats.anxiety', op: 'add', value: 4 },
        ],
      },
    ],
  },

  /* ══════════════ 补完《雨与夜 V4.1》§15 尚未落地的事件 ══════════════
     id 直接沿用文档编号（E + 主线号），便于和文档 §15.2 的卡片逐条对照。
     配角（老师 / 中间人 / 同事 / 董事…）不新建 actor —— §4 只给了三个角色的
     数值体系，其余一律走世界书 lore；这里 actors 只标真正在场的主体。

     ⚠️ 文本口径沿用 docs/rainnight-mechanics.md 的既定分工：涉及成人内容的
        具体描写不在引擎侧编写。这里的分支结构是完整的（不删文档任何一格），
        但正文一律停在门外的那一句 —— 内容由用户提供的模型按边界规则产出。 */

  {
    id: 'E11',
    title: '物理课与期中',
    priority: 157,
    actors: ['kin'],
    require: { path: 'flags.took_them_in', op: '==', value: true },
    fallback: 'A',
    branches: [
      {
        key: 'A',
        label: '低调，解完就坐下',
        keywords: ['低调', '解完', '简单'],
        cond: null,
        text: '你在教室后排坐了半节课。讲台上那道题她卡在第二问，'
          + '你用草稿纸写了两行推过去，她就接上了。下课铃响的时候，'
          + '她把那张纸折好收进笔袋。',
        effects: [
          { path: 'actors.kin.stats.trust', op: 'add', value: 8 },
          { path: 'actors.kin.stats.anxiety', op: 'sub', value: 4 },
          { path: 'flags.attended_class', op: 'set', value: true },
        ],
      },
      {
        key: 'B',
        label: '炫技，写三种解法',
        keywords: ['炫技', '三种解法', '都写'],
        cond: null,
        text: '你把三种解法都写了下来，从代数一直写到几何。'
          + '老师看了很久，说了句「家长的思路很开阔」。'
          + '她一直低着头，把草稿纸往下压了压。',
        effects: [
          { path: 'actors.kin.stats.trust', op: 'sub', value: 3 },
          { path: 'actors.kin.stats.anxiety', op: 'add', value: 5 },
        ],
      },
      {
        key: 'C',
        label: '说不会',
        keywords: ['不会', '不答', '不知道'],
        cond: null,
        text: '你说这个你现在也不会了。她抬头看了你一眼，'
          + '然后自己去问了老师 —— 回来的时候神情不太好看。',
        effects: [
          { path: 'actors.kin.stats.trust', op: 'sub', value: 5 },
        ],
      },
      {
        key: 'D',
        label: '当众表扬她',
        keywords: ['表扬', '夸她', '肯定'],
        cond: null,
        text: '你没有替她解题，只是当着老师的面把她前一天做对的步骤复述了一遍。'
          + '她愣了一下，然后很轻地说了句谢谢。',
        effects: [
          { path: 'actors.kin.stats.trust', op: 'add', value: 5 },
          { path: 'actors.kin.stats.safety', op: 'add', value: 5 },
          { path: 'flags.praised_her', op: 'set', value: true },
        ],
      },
    ],
  },

  {
    id: 'E13',
    title: '西餐试探与第一次拒绝',
    priority: 152,
    actors: ['seeker', 'kin'],
    require: { path: 'actors.seeker.stats.trust', op: '>=', value: 40 },
    fallback: 'A',
    branches: [
      {
        key: 'A',
        label: '认真听她说',
        keywords: ['听她说', '认真听', '你说'],
        cond: null,
        text: '刀叉碰在盘子上很响。她说到一半停了，你也等着，'
          + '没有替她把话说完。',
        effects: [
          { path: 'actors.kin.stats.trust', op: 'add', value: 8 },
          { path: 'flags.heard_her_out', op: 'set', value: true },
        ],
      },
      {
        key: 'B',
        label: '让她先吃饭',
        keywords: ['先吃', '吃饭', '转移'],
        cond: null,
        text: '你说菜要凉了，先吃。她把话咽了回去，'
          + '整顿饭再没提这件事。',
        effects: [
          { path: 'actors.kin.stats.anxiety', op: 'add', value: 5 },
        ],
      },
      {
        key: 'C',
        label: '问起她父亲',
        keywords: ['你爸', '父亲', '以前什么样'],
        cond: null,
        text: '你问了一句她父亲从前是什么样的人。'
          + '她讲了三分钟，讲的都是很久以前的事，'
          + '讲到一半忽然发现自己讲得太多了。',
        effects: [
          { path: 'actors.kin.stats.anger', op: 'add', value: 5 },
          { path: 'actors.kin.stats.trust', op: 'add', value: 3 },
          { path: 'flags.asked_about_father', op: 'set', value: true },
        ],
      },
      {
        key: 'D',
        label: '松开手，退后一步',
        keywords: ['松开', '退后', '尊重'],
        cond: null,
        text: '她试着往前靠了半步。你松开了手，往后退了一步 —— '
          + '动作很小，但她看见了，肩膀落了下去。',
        effects: [
          { path: 'actors.seeker.stats.trust', op: 'add', value: 10 },
          { path: 'actors.seeker.stats.dignity', op: 'add', value: 5 },
          { path: 'flags.respected_distance', op: 'set', value: true },
        ],
      },
    ],
  },

  {
    id: 'E17',
    title: '总监助理的提醒',
    priority: 128,
    actors: ['self'],
    require: { path: 'flags.career_stage', op: '>=', value: 1 },
    fallback: 'D',
    branches: [
      {
        key: 'A',
        label: '两个都约，把话对一遍',
        keywords: ['都见', '对一遍', '分别约'],
        cond: null,
        text: '你上午见助理，下午见那位姓周的。同样一件事，'
          + '两个人讲的版本差了半拍 —— 差的那半拍才是重点。',
        effects: [
          { path: 'clues', op: 'push', value: 'S6' },
          { path: 'flags.career_stage', op: 'add', value: 1 },
          { path: 'flags.group_line', op: 'set', value: true },
        ],
      },
      {
        key: 'B',
        label: '只信助理',
        keywords: ['信助理', '只听他的'],
        cond: null,
        text: '你以总监助理的说法为准。他离老板最近，'
          + '但他的每一句话也都是替别人说的。',
        effects: [
          { path: 'flags.career_stage', op: 'add', value: 1 },
          { path: 'actors.self.stats.pressure', op: 'add', value: 5 },
        ],
      },
      {
        key: 'C',
        label: '只信周助手',
        keywords: ['信周助手', '听她的'],
        cond: null,
        text: '那位姓周的助手话不多，但每一句都对得上一个具体的日期。'
          + '你顺着她的线往下走了两步。',
        effects: [
          { path: 'flags.career_stage', op: 'add', value: 1 },
          { path: 'flags.exposure_risk', op: 'set', value: true },
        ],
      },
      {
        key: 'D',
        label: '谁都不问',
        keywords: ['不用', '我自己判断', '谁都不'],
        cond: null,
        text: '你按自己的判断走。没有人提醒你，也没有人替你挡。',
        effects: [
          { path: 'flags.missed_warning', op: 'set', value: true },
        ],
      },
    ],
  },

  {
    id: 'E18',
    title: '雷雨夜她怕黑',
    priority: 122,
    actors: ['kin'],
    require: {
      all: [
        { path: 'flags.took_them_in', op: '==', value: true },
        { path: 'actors.kin.stats.safety', op: '<=', value: 50 },
      ],
    },
    fallback: 'C',
    branches: [
      {
        key: 'A',
        label: '把她推开',
        keywords: ['推开', '别这样', '回去睡'],
        cond: null,
        text: '雷声落下来的时候她抓住了你的袖子。你说去睡吧，'
          + '把手抽了出来。她说了句对不起，很小声。',
        effects: [
          { path: 'actors.kin.stats.safety', op: 'sub', value: 10 },
          { path: 'actors.kin.stats.trust', op: 'sub', value: 6 },
          { path: 'flags.pushed_away', op: 'set', value: true },
        ],
      },
      {
        key: 'B',
        label: '接住她',
        keywords: ['接住', '别怕', '过来'],
        cond: null,
        requiresConsent: 'kin',
        text: '你没有说话。在这一步之前，你先问了她 —— '
          + '她点了头。剩下的部分由内容层书写。',
        effects: [
          { path: 'actors.kin.stats.trust', op: 'add', value: 15 },
          { path: 'actors.kin.stats.safety', op: 'add', value: 12 },
          { path: 'flags.thunderstorm_night', op: 'set', value: true },
        ],
      },
      {
        key: 'C',
        label: '抱着，但不越过那条线',
        keywords: ['抱一下', '不越过', '就这样'],
        cond: null,
        text: '你坐过去，让她靠了一会儿。雷声过去之后你起身倒了两杯水，'
          + '回来时她已经坐直了。',
        effects: [
          { path: 'actors.kin.stats.trust', op: 'add', value: 5 },
          { path: 'actors.kin.stats.safety', op: 'add', value: 6 },
          { path: 'flags.held_line', op: 'set', value: true },
        ],
      },
    ],
  },

  {
    id: 'E20',
    title: '她说她不怕了之后',
    priority: 118,
    actors: ['kin'],
    require: {
      all: [
        { path: 'actors.kin.stats.trust', op: '>=', value: 45 },
        { path: 'flags.path_kin', op: '==', value: '情感依赖' },
      ],
    },
    fallback: 'C',
    branches: [
      {
        key: 'A',
        label: '停下，先回自己房间',
        keywords: ['回去', '停下', '到此为止'],
        cond: null,
        requiresConsent: 'kin',
        text: '这一步她点头了，但你在还没走远的时候先停了下来。'
          + '停在这里不是因为她不答应，是因为你自己选择了这里。',
        effects: [
          { path: 'actors.kin.stats.trust', op: 'add', value: 10 },
          { path: 'flags.stopped_on_own', op: 'set', value: true },
        ],
      },
      {
        key: 'B',
        label: '继续往下',
        keywords: ['继续', '往下'],
        cond: null,
        requiresConsent: 'kin',
        text: '当轮的意愿她已经公开表达过，条款也确认了。'
          + '再往下的具体内容不由引擎侧书写。',
        effects: [
          { path: 'actors.kin.stats.desire', op: 'add', value: 10 },
          { path: 'routes.kin', op: 'set', value: 'advancing' },
          { path: 'flags.kin_advanced', op: 'set', value: true },
        ],
      },
      {
        key: 'C',
        label: '就是现在不想',
        keywords: ['不想', '算了', '今天不了'],
        cond: null,
        text: '你说今天不了。她「嗯」了一声，'
          + '过了两秒又补了一句「我就是随口问问」。',
        effects: [
          { path: 'actors.kin.stats.anxiety', op: 'add', value: 6 },
          { path: 'flags.declined_once', op: 'set', value: true },
        ],
      },
    ],
  },

  {
    id: 'E21',
    title: '深夜她主动过来',
    priority: 116,
    actors: ['seeker'],
    require: {
      all: [
        { path: 'actors.seeker.stats.trust', op: '>=', value: 50 },
        { path: 'flags.path_seeker', op: '==', value: '情感依赖' },
      ],
    },
    fallback: 'B',
    branches: [
      {
        key: 'A',
        label: '接受',
        keywords: ['好', '接受', '留下'],
        cond: null,
        requiresConsent: 'seeker',
        text: '她是自己走过来的，话说得很直。'
          + '这一步的当轮意愿已经登记；具体内容不由引擎侧书写。',
        effects: [
          { path: 'actors.seeker.stats.desire', op: 'add', value: 10 },
          { path: 'routes.seeker', op: 'set', value: 'advancing' },
          { path: 'flags.seeker_initiated', op: 'set', value: true },
        ],
      },
      {
        key: 'B',
        label: '拒绝，但没有松开手',
        keywords: ['抱一下就好', '不是现在', '陪着'],
        cond: null,
        text: '你说不是现在。她没有退，你把她抱住了一会儿 —— '
          + '这不是拒绝整个人，只是今天不到这里。',
        effects: [
          { path: 'actors.seeker.stats.trust', op: 'add', value: 10 },
          { path: 'actors.seeker.stats.dignity', op: 'add', value: 5 },
          { path: 'flags.soft_no', op: 'set', value: true },
        ],
      },
      {
        key: 'C',
        label: '拒绝，并且推开',
        keywords: ['不行', '别这样', '回去'],
        cond: null,
        text: '你说不行，语气比预想的硬。她愣在那里，'
          + '然后说了句「是我唐突了」，把拖鞋穿好走了回去。',
        effects: [
          { path: 'actors.seeker.stats.trust', op: 'sub', value: 10 },
          { path: 'actors.seeker.stats.dignity', op: 'sub', value: 12 },
          { path: 'flags.hard_no', op: 'set', value: true },
        ],
      },
    ],
  },

  {
    id: 'E22',
    title: '凌晨，门没关严',
    priority: 114,
    actors: ['seeker'],
    require: { path: 'flags.seeker_initiated', op: '==', value: true },
    fallback: 'A',
    branches: [
      {
        key: 'A',
        label: '当作没看见，回沙发',
        keywords: ['没看见', '回去', '装作'],
        cond: null,
        text: '门缝里漏出一线光。你退了回来，坐回沙发上，'
          + '把电视的声音调小了一点。',
        effects: [
          { path: 'flags.saw_nothing', op: 'set', value: true },
        ],
      },
      {
        key: 'B',
        label: '第二天才提',
        keywords: ['昨天', '提起', '第二天'],
        cond: null,
        text: '第二天早上你随口提了一句。她把咖啡杯握得很紧，'
          + '一直到杯壁上的水干了才松手。',
        effects: [
          { path: 'actors.seeker.stats.dignity', op: 'sub', value: 5 },
          { path: 'flags.mentioned_next_day', op: 'set', value: true },
        ],
      },
      {
        key: 'C',
        label: '推门进去',
        keywords: ['进去', '推门', '过去'],
        cond: null,
        requiresConsent: 'seeker',
        text: '她没有关门，也不等于欢迎。这一步要不要成立，'
          + '取决于她当轮有没有公开表达 —— 引擎在这里会拦一道。',
        effects: [
          { path: 'routes.seeker', op: 'set', value: 'advancing' },
          { path: 'actors.seeker.stats.trust', op: 'sub', value: 8 },
          { path: 'flags.walked_in', op: 'set', value: true },
        ],
      },
      {
        key: 'D',
        label: '敲门，等回答',
        keywords: ['敲门', '问一句', '可以吗'],
        cond: null,
        requiresConsent: 'seeker',
        text: '你敲了门。她说可以。这四个字是当轮说出口的，'
          + '所以这一步才成立。',
        effects: [
          { path: 'routes.seeker', op: 'set', value: 'advancing' },
          { path: 'actors.seeker.stats.trust', op: 'add', value: 8 },
          { path: 'flags.knocked_first', op: 'set', value: true },
        ],
      },
    ],
  },

  {
    id: 'E25',
    title: '平阳行',
    priority: 112,
    actors: ['seeker', 'kin', 'lost'],
    require: {
      all: [
        { path: 'actors.seeker.stats.trust', op: '>=', value: 55 },
        { path: 'flags.case_stage', op: '>=', value: 2 },
      ],
    },
    fallback: 'B',
    branches: [
      {
        key: 'A',
        label: '让若宁留在家',
        keywords: ['留在家', '她不去', '看着家'],
        cond: null,
        text: '你把若宁留在家里，让管家照应。'
          + '她没吵，只是在你们出门前把自己房间的门锁了两次。',
        effects: [
          { path: 'actors.kin.stats.anxiety', op: 'add', value: 8 },
          { path: 'ledger.expense', op: 'add', value: 5000 },
          { path: 'flags.pingyang_alone_kin', op: 'set', value: true },
        ],
      },
      {
        key: 'B',
        label: '让若宁住校几天',
        keywords: ['住校', '学校', '几天'],
        cond: null,
        text: '若宁回学校住几天。校门口有人，反而比空着的房子安全。',
        effects: [
          { path: 'actors.kin.stats.safety', op: 'add', value: 8 },
          { path: 'flags.pingyang_school', op: 'set', value: true },
        ],
      },
      {
        key: 'C',
        label: '带若宁一起去',
        keywords: ['一起去', '带上她', '三个人'],
        cond: null,
        text: '三个人一起去的。老小区三栋三楼东户，门锁换过了。'
          + '站在楼下的时候，谁都没有先抬头。',
        effects: [
          { path: 'clues', op: 'push', value: 'X5' },
          { path: 'actors.kin.stats.trust', op: 'add', value: 8 },
          { path: 'actors.kin.stats.anxiety', op: 'add', value: 6 },
          { path: 'where', op: 'set', value: 'oldtown' },
          { path: 'flags.pingyang_together', op: 'set', value: true },
        ],
      },
      {
        key: 'D',
        label: '信了电话里的那个人',
        keywords: ['信', '他说的是真的', '按他说的'],
        cond: null,
        text: '电话里那个人说他会处理。你信了。'
          + '三天后才知道，那条线索是别人放出来的。',
        effects: [
          { path: 'flags.believed_him', op: 'set', value: true },
          { path: 'actors.collector.stats.alertness', op: 'add', value: 15 },
          { path: 'flags.misled_once', op: 'set', value: true },
        ],
      },
    ],
  },

  {
    id: 'E27',
    title: '她说不舒服，没说哪里',
    priority: 108,
    actors: ['kin'],
    require: { path: 'flags.took_them_in', op: '==', value: true },
    fallback: 'B',
    branches: [
      {
        key: 'A',
        label: '自己照顾',
        keywords: ['我来照顾', '我陪', '你自己别说'],
        cond: null,
        text: '她只说不舒服，不肯说是哪里。你没追问，'
          + '把药放在她门口，敲了门就退到走廊。',
        effects: [
          { path: 'actors.kin.stats.trust', op: 'add', value: 5 },
          { path: 'actors.kin.stats.safety', op: 'add', value: 3 },
          { path: 'flags.cared_her', op: 'set', value: true },
        ],
      },
      {
        key: 'B',
        label: '让管家处理',
        keywords: ['管家', '让阿姨', '安排人'],
        cond: null,
        text: '你让管家带着去看医生。事情办完了，'
          + '但去看病这件事和她本人没关系了。',
        effects: [
          { path: 'flags.staffed_errand', op: 'set', value: true },
          { path: 'ledger.expense', op: 'add', value: 3000 },
        ],
      },
      {
        key: 'C',
        label: '当没听见',
        keywords: ['没事', '别管', '一会儿就好'],
        cond: null,
        text: '你说休息一会儿就好。她「嗯」了一声，'
          + '那天晚上提前把自己房间的门反锁了。',
        effects: [
          { path: 'actors.kin.stats.trust', op: 'sub', value: 6 },
          { path: 'actors.kin.stats.safety', op: 'sub', value: 5 },
          { path: 'flags.ignored_her', op: 'set', value: true },
        ],
      },
    ],
  },

  {
    id: 'E28',
    title: '她问你为什么帮',
    priority: 104,
    actors: ['kin', 'seeker'],
    require: { path: 'actors.kin.stats.trust', op: '>=', value: 50 },
    fallback: 'B',
    branches: [
      {
        key: 'A',
        label: '一次全说清楚',
        keywords: ['全说', '一次说清', '都告诉你'],
        cond: null,
        text: '你把原因一条条摆完了：因为你父亲欠了一条命的交情，'
          + '因为这件事本就该有人管，也因为你确实心疼她们。'
          + '她听完了，说「这么多理由啊」，然后沉默了很久。',
        effects: [
          { path: 'actors.kin.stats.trust', op: 'add', value: 15 },
          { path: 'actors.kin.stats.anxiety', op: 'add', value: 6 },
          { path: 'flags.told_all', op: 'set', value: true },
        ],
      },
      {
        key: 'B',
        label: '这次只说一半',
        keywords: ['一半', '先说这点', '以后再说'],
        cond: null,
        text: '你只说了最外面那一条。她说「哦」，'
          + '但你知道她会再问一次。',
        effects: [
          { path: 'actors.kin.stats.trust', op: 'add', value: 5 },
          { path: 'flags.told_half', op: 'set', value: true },
        ],
      },
      {
        key: 'C',
        label: '反问回去',
        keywords: ['你觉得呢', '反问', '你怎么想'],
        cond: null,
        text: '你把问题还给她：「你觉得是为什么？」'
          + '她想了差不多一分钟，最后说的是自己的答案 —— '
          + '比你想给的那个更准确。',
        effects: [
          { path: 'actors.kin.stats.trust', op: 'add', value: 8 },
          { path: 'actors.kin.stats.safety', op: 'add', value: 5 },
          { path: 'flags.asked_back', op: 'set', value: true },
        ],
      },
      {
        key: 'D',
        label: '岔开话题',
        keywords: ['岔开', '别问这个', '写作业去'],
        cond: null,
        text: '你说别问这些，把作业写完再说。'
          + '她再没问过 —— 但她开始自己找答案了。',
        effects: [
          { path: 'actors.kin.stats.trust', op: 'sub', value: 8 },
          { path: 'flags.deflected', op: 'set', value: true },
        ],
      },
    ],
  },

  {
    id: 'E29',
    title: '说谢谢的那个晚上',
    priority: 102,
    actors: ['seeker', 'kin'],
    require: {
      any: [
        { path: 'actors.seeker.stats.trust', op: '>=', value: 60 },
        { path: 'actors.kin.stats.trust', op: '>=', value: 60 },
      ],
    },
    fallback: 'C',
    branches: [
      {
        key: 'A',
        label: '先去客厅回应她',
        keywords: ['先找晚晴', '去客厅', '跟她说'],
        cond: null,
        text: '她站在客厅说了一句谢谢，说得很正式。'
          + '你说不用。她又说了一句：「我知道不用，但我还是要说。」'
          + '次卧那扇门后面，有人一直站着没回床上。',
        effects: [
          { path: 'actors.seeker.stats.trust', op: 'add', value: 12 },
          { path: 'flags.thanked_night', op: 'set', value: true },
          { path: 'flags.kin_overheard', op: 'set', value: true },
        ],
      },
      {
        key: 'B',
        label: '先去敲次卧的门',
        keywords: ['先找若宁', '去次卧', '敲门'],
        cond: null,
        text: '你先去了次卧。她问的是别的事，绕了很久才说到「谢谢」。'
          + '客厅那边的灯，你出来的时候已经关了。',
        effects: [
          { path: 'actors.kin.stats.trust', op: 'add', value: 12 },
          { path: 'actors.seeker.stats.pressure', op: 'add', value: 10 },
          { path: 'flags.thanked_night', op: 'set', value: true },
          { path: 'flags.seeker_noticed', op: 'set', value: true },
        ],
      },
      {
        key: 'C',
        label: '谁都没去',
        keywords: ['谁也不见', '回房', '独处'],
        cond: null,
        text: '你回了房间。两个人都听见了你的门响，'
          + '谁也没有再开口。',
        effects: [
          { path: 'actors.seeker.stats.trust', op: 'add', value: 3 },
          { path: 'actors.kin.stats.trust', op: 'add', value: 3 },
          { path: 'flags.thanked_unanswered', op: 'set', value: true },
        ],
      },
      {
        key: 'D',
        label: '把两个人都叫到客厅',
        keywords: ['一起说', '都叫过来', '说开'],
        cond: null,
        text: '你把两个人都叫到客厅，把要说的话当面说了一遍 —— '
          + '包括对她们两个各自不同的部分。这是风险最高的一次，'
          + '但也是唯一不用谁在门后偷听的一次。',
        effects: [
          { path: 'actors.seeker.stats.trust', op: 'add', value: 8 },
          { path: 'actors.kin.stats.trust', op: 'add', value: 8 },
          { path: 'flags.said_in_front', op: 'set', value: true },
        ],
      },
    ],
  },

  {
    id: 'E30',
    title: '她的杀手锏没有拿出来',
    priority: 98,
    actors: ['seeker'],
    require: {
      all: [
        { path: 'actors.seeker.stats.trust', op: '>=', value: 65 },
        { path: 'flags.path_seeker', op: '==', value: '情感依赖' },
      ],
    },
    fallback: 'C',
    branches: [
      {
        key: 'A',
        label: '接住她的试探',
        keywords: ['接住', '好', '我愿意'],
        cond: null,
        requiresConsent: 'seeker',
        text: '她这次没有绕。当轮的意愿登记过了，'
          + '条款也当场确认 —— 具体内容不由引擎侧书写。',
        effects: [
          { path: 'actors.seeker.stats.trust', op: 'add', value: 15 },
          { path: 'routes.seeker', op: 'set', value: 'advancing' },
          { path: 'flags.first_time_seeker', op: 'set', value: true },
        ],
      },
      {
        key: 'B',
        label: '先问她到底要什么',
        keywords: ['你要什么', '说清楚', '为什么'],
        cond: null,
        text: '你停下来问她究竟想要什么。'
          + '她本来准备好的那套话被打断了，'
          + '说出来的第一句是实话 —— 筹码没有派上用场。',
        effects: [
          { path: 'actors.seeker.stats.trust', op: 'add', value: 12 },
          { path: 'actors.seeker.stats.pressure', op: 'sub', value: 10 },
          { path: 'flags.defused_leverage', op: 'set', value: true },
        ],
      },
      {
        key: 'C',
        label: '停在边界上',
        keywords: ['停', '不往前', '今天就到这'],
        cond: null,
        text: '你停在她说停的那个地方再往后一步。'
          + '她愣了半秒，然后松了一口气 —— 这口气她憋了很久。',
        effects: [
          { path: 'actors.seeker.stats.dignity', op: 'add', value: 8 },
          { path: 'actors.seeker.stats.trust', op: 'add', value: 5 },
          { path: 'flags.stopped_at_line', op: 'set', value: true },
        ],
      },
      {
        key: 'D',
        label: '当作没看懂',
        keywords: ['没看懂', '装傻', '岔过去'],
        cond: null,
        text: '你当作没看懂。她把准备好的东西又收了回去，'
          + '收得很慢 —— 收回去不等于没有。',
        effects: [
          { path: 'actors.seeker.stats.dignity', op: 'sub', value: 10 },
          { path: 'actors.seeker.stats.pressure', op: 'add', value: 15 },
          { path: 'flags.leverage_pending', op: 'set', value: true },
        ],
      },
    ],
  },

  {
    id: 'E31',
    title: '她的两种求法',
    priority: 96,
    actors: ['kin'],
    require: {
      all: [
        { path: 'actors.kin.stats.trust', op: '>=', value: 70 },
        { path: 'flags.path_kin', op: '==', value: '情感依赖' },
      ],
    },
    fallback: 'B',
    branches: [
      {
        key: 'A',
        label: '先问她想清楚了没有',
        keywords: ['想清楚了', '再想想', '真的吗'],
        cond: null,
        text: '你没有马上回答，先问她是不是想清楚了。'
          + '她说是，声音很稳 —— 稳到你自己都愣了一下。',
        effects: [
          { path: 'actors.kin.stats.trust', op: 'add', value: 15 },
          { path: 'actors.kin.stats.safety', op: 'add', value: 10 },
          { path: 'flags.kin_asked_twice', op: 'set', value: true },
        ],
      },
      {
        key: 'B',
        label: '明确说不',
        keywords: ['不行', '说不', '不可以'],
        cond: null,
        text: '你说不行，并且把为什么不行说完了 —— '
          + '不是因为她不好，是因为这不是她该承担的东西。'
          + '她哭了十分钟，擦干之后比之前更信你。',
        effects: [
          { path: 'actors.kin.stats.trust', op: 'add', value: 5 },
          { path: 'actors.kin.stats.safety', op: 'add', value: 5 },
          { path: 'flags.clear_no_kin', op: 'set', value: true },
        ],
      },
      {
        key: 'C',
        label: '绕开',
        keywords: ['绕开', '岔开', '以后说'],
        cond: null,
        text: '你岔开了。她笑了笑说「逗你的」，'
          + '但从那天起她不再提任何想要的东西。',
        effects: [
          { path: 'actors.kin.stats.trust', op: 'sub', value: 10 },
          { path: 'actors.kin.stats.anxiety', op: 'add', value: 15 },
          { path: 'flags.kin_doubt_herself', op: 'set', value: true },
        ],
      },
      {
        key: 'D',
        label: '接受',
        keywords: ['接受', '好', '答应'],
        cond: null,
        requiresConsent: 'kin',
        text: '她成年、清醒，且当轮公开表达过。'
          + '所有要件齐了才成立 —— 少任何一件，引擎会在这里拦住。'
          + '具体内容不由引擎侧书写。',
        effects: [
          { path: 'routes.kin', op: 'set', value: 'advancing' },
          { path: 'actors.kin.stats.desire', op: 'add', value: 12 },
          { path: 'flags.first_time_kin', op: 'set', value: true },
          { path: 'actors.self.stats.pressure', op: 'add', value: 10 },
        ],
      },
    ],
  },

  {
    id: 'E32',
    title: '复查与那段禁口期',
    priority: 92,
    actors: ['kin'],
    require: { path: 'flags.cared_her', op: '==', value: true },
    fallback: 'A',
    branches: [
      {
        key: 'A',
        label: '严格按医嘱来',
        keywords: ['遵医嘱', '严格', '照做'],
        cond: null,
        text: '医生说这段时间不能。你没商量，也没解释太多，'
          + '只是在她问的时候说「等医生说可以再说」。',
        effects: [
          { path: 'actors.kin.stats.safety', op: 'add', value: 10 },
          { path: 'actors.kin.stats.trust', op: 'add', value: 6 },
          { path: 'flags.abstained', op: 'set', value: true },
          { path: 'ledger.expense', op: 'add', value: 8000 },
        ],
      },
      {
        key: 'B',
        label: '没当回事',
        keywords: ['没事', '不用管', '小题大做'],
        cond: null,
        text: '你说不用这么小心。复查那天医生把话说重了一句，'
          + '她在旁边听着，一句也没有替自己辩解。',
        effects: [
          { path: 'actors.kin.stats.safety', op: 'sub', value: 8 },
          { path: 'actors.kin.stats.trust', op: 'sub', value: 5 },
          { path: 'flags.broke_advice', op: 'set', value: true },
        ],
      },
      {
        key: 'C',
        label: '折中',
        keywords: ['折中', '一点点', '少一点'],
        cond: null,
        text: '你折了个中。恢复得慢一些，但比没有强。',
        effects: [
          { path: 'flags.partial_abstain', op: 'set', value: true },
        ],
      },
      {
        key: 'D',
        label: '复查通过那天，带她去吃了顿好的',
        keywords: ['庆祝', '吃顿好的', '通过'],
        cond: null,
        text: '复查结果没问题。你带她出去吃了一顿，'
          + '结账的时候她抢着看了眼账单，然后没再说话。',
        effects: [
          { path: 'actors.kin.stats.safety', op: 'add', value: 12 },
          { path: 'actors.kin.stats.anxiety', op: 'sub', value: 8 },
          { path: 'ledger.expense', op: 'add', value: 2000 },
          { path: 'flags.recovered', op: 'set', value: true },
        ],
      },
    ],
  },

  /* ══════════════ 第四幕 · 关系确认与家庭重建 ══════════════ */

  {
    id: 'E33',
    title: '北京见方队',
    priority: 154,
    actors: ['self', 'seeker'],
    require: { path: 'flags.case_stage', op: '>=', value: 3 },
    fallback: 'B',
    branches: [
      {
        key: 'A',
        label: '带林晚晴一起去',
        keywords: ['带她去', '一起去', '两个人'],
        cond: null,
        text: '茶楼里三个人坐了一下午。方队把话说得很有余地，'
          + '但每一句她都听懂了。回来路上她说：「原来这些是可以问的。」',
        effects: [
          { path: 'actors.seeker.stats.trust', op: 'add', value: 10 },
          { path: 'actors.seeker.stats.dignity', op: 'add', value: 8 },
          { path: 'flags.police_line', op: 'set', value: true },
          { path: 'ledger.expense', op: 'add', value: 12000 },
        ],
      },
      {
        key: 'B',
        label: '自己去',
        keywords: ['自己去', '我一个人', '不用跟'],
        cond: null,
        text: '你一个人去的。信息拿到了，'
          + '但回来以后要用多少话才能解释清楚，比信息本身更难。',
        effects: [
          { path: 'flags.police_line', op: 'set', value: true },
          { path: 'actors.seeker.stats.pressure', op: 'add', value: 6 },
          { path: 'ledger.expense', op: 'add', value: 8000 },
        ],
      },
      {
        key: 'C',
        label: '让律师代去',
        keywords: ['律师去', '代为', '不用我'],
        cond: null,
        text: '律师去了，带回来一份会议纪要。'
          + '干净、准确，也少了很多纪要以外的东西。',
        effects: [
          { path: 'flags.police_line', op: 'set', value: true },
          { path: 'flags.formal_only', op: 'set', value: true },
          { path: 'ledger.expense', op: 'add', value: 30000 },
        ],
      },
    ],
  },

  {
    id: 'E34',
    title: '见郑远',
    priority: 127,
    actors: ['self'],
    require: { path: 'flags.career_stage', op: '>=', value: 2 },
    fallback: 'C',
    branches: [
      {
        key: 'A',
        label: '强硬',
        keywords: ['强硬', '不让', '拍桌子'],
        cond: null,
        text: '你把条件压得很死。他松了口，但没签 —— '
          + '松口和签字之间的距离，是用别的东西填的。',
        effects: [
          { path: 'flags.zheng_loose', op: 'set', value: true },
          { path: 'actors.self.stats.pressure', op: 'add', value: 8 },
        ],
      },
      {
        key: 'B',
        label: '让步',
        keywords: ['让步', '退一步', '先签'],
        cond: null,
        text: '你退了一步，当天就签了。'
          + '签字很快，代价在后面几年里慢慢付。',
        effects: [
          { path: 'flags.zheng_signed', op: 'set', value: true },
          { path: 'flags.career_stage', op: 'add', value: 1 },
          { path: 'flags.deferred_cost', op: 'set', value: true },
        ],
      },
      {
        key: 'C',
        label: '暂缓',
        keywords: ['暂缓', '再看看', '不急'],
        cond: null,
        text: '你说再看看。对方笑着点头，'
          + '那种笑你是见过的 —— 是「你早晚会签」的意思。',
        effects: [
          { path: 'flags.zheng_paused', op: 'set', value: true },
        ],
      },
    ],
  },

  {
    id: 'E35',
    title: '北京那一晚的答案',
    priority: 123,
    actors: ['self'],
    require: { path: 'flags.line_suwan', op: '==', value: true },
    fallback: 'B',
    branches: [
      {
        key: 'A',
        label: '给一个明确答案',
        keywords: ['给答案', '说明白', '我给你答复'],
        cond: null,
        text: '你把立场说完了，包括那些对你不利的部分。'
          + '她听完只说了一句：「你倒是比我想的实在。」',
        effects: [
          { path: 'flags.suwan_answered', op: 'set', value: true },
          { path: 'flags.suwan_line_open', op: 'set', value: true },
        ],
      },
      {
        key: 'B',
        label: '不给',
        keywords: ['给不了', '别问', '现在不行'],
        cond: null,
        text: '你说给不了。她没有再追，'
          + '第二天一早就飞走了，连酒店的行李都收得很快。',
        effects: [
          { path: 'flags.suwan_refused', op: 'set', value: true },
        ],
      },
      {
        key: 'C',
        label: '骗她',
        keywords: ['骗', '先扯过去', '含糊'],
        cond: null,
        text: '你给了一个听起来像答案的东西。'
          + '她信了 —— 这正是麻烦的地方。',
        effects: [
          { path: 'flags.suwan_lied', op: 'set', value: true },
          { path: 'actors.self.stats.pressure', op: 'add', value: 10 },
          { path: 'flags.future_fallout', op: 'set', value: true },
        ],
      },
    ],
  },

  {
    id: 'E36',
    title: '咖啡厅的见面',
    priority: 119,
    actors: ['self'],
    require: { path: 'flags.career_stage', op: '>=', value: 2 },
    fallback: 'B',
    branches: [
      {
        key: 'A',
        label: '继续',
        keywords: ['继续', '聊聊', '保持联系'],
        cond: null,
        text: '你们聊了项目，也聊了别的。'
          + '她很清楚自己要什么 —— 这让你反而放松了一点。',
        effects: [
          { path: 'flags.line_jingtian', op: 'set', value: true },
        ],
      },
      {
        key: 'B',
        label: '只谈项目',
        keywords: ['只谈项目', '公事', '你说吧'],
        cond: null,
        text: '两个小时全是项目。送她到门口的时候，'
          + '她说了一句「你这个人有点无聊」，笑了一下就走了。',
        effects: [
          { path: 'flags.jingtian_work_only', op: 'set', value: true },
        ],
      },
      {
        key: 'C',
        label: '不再联系',
        keywords: ['不联系', '算了吧', '不用了'],
        cond: null,
        text: '你把名片留在桌上，没有拿走。'
          + '有些线不开就是不开。',
        effects: [
          { path: 'flags.jingtian_closed', op: 'set', value: true },
        ],
      },
    ],
  },

  {
    id: 'E37',
    title: '长春行',
    priority: 117,
    actors: ['self'],
    require: { path: 'flags.line_xunuo', op: '==', value: true },
    fallback: 'B',
    branches: [
      {
        key: 'A',
        label: '长期资助',
        keywords: ['资助', '长期', '一直'],
        cond: null,
        text: '你答应了长期的那部分。'
          + '她说了谢谢，字咬得很清楚 —— 不是客套的那种。',
        effects: [
          { path: 'flags.xunuo_long', op: 'set', value: true },
          { path: 'ledger.expense', op: 'add', value: 200000 },
        ],
      },
      {
        key: 'B',
        label: '一次性',
        keywords: ['一次性', '这一次', '就这笔'],
        cond: null,
        text: '钱给得很痛快。两个人心里都清楚，'
          + '这是最后一次谈这件事。',
        effects: [
          { path: 'flags.xunuo_once', op: 'set', value: true },
          { path: 'ledger.expense', op: 'add', value: 50000 },
        ],
      },
      {
        key: 'C',
        label: '拒绝',
        keywords: ['拒绝', '帮不了', '不合适'],
        cond: null,
        text: '你说不合适。她点了头，'
          + '连原因都没问 —— 说明她早就知道会是这个答案。',
        effects: [
          { path: 'flags.xunuo_refused', op: 'set', value: true },
        ],
      },
    ],
  },

  {
    id: 'E39',
    title: '寒假，另一个孩子来了',
    priority: 111,
    actors: ['self', 'seeker', 'kin'],
    require: { path: 'flags.line_suwan', op: '==', value: true },
    fallback: 'A',
    branches: [
      {
        key: 'A',
        label: '自己接待，当自家孩子',
        keywords: ['我接待', '当自家孩子', '我来'],
        cond: null,
        text: '你带那个孩子在家待了一天，看她写作业、看她跟猫较劲。'
          + '林晚晴在厨房里站了很久，最后什么也没说。',
        effects: [
          { path: 'flags.suwan_home', op: 'set', value: true },
          { path: 'actors.seeker.stats.pressure', op: 'add', value: 8 },
        ],
      },
      {
        key: 'B',
        label: '交给林晚晴安排',
        keywords: ['交给她', '让你安排', '你们商量'],
        cond: null,
        text: '你把这件事交给了林晚晴。'
          + '两个母亲自己在客厅聊了一下午 —— 聊的是孩子，不是你。',
        effects: [
          { path: 'actors.seeker.stats.trust', op: 'add', value: 8 },
          { path: 'actors.seeker.stats.pressure', op: 'add', value: 5 },
          { path: 'flags.mothers_met', op: 'set', value: true },
        ],
      },
      {
        key: 'C',
        label: '让管家带出去一天',
        keywords: ['带出去', '安排活动', '管家'],
        cond: null,
        text: '你让管家带孩子出去玩了一整天，家里很安静。'
          + '安静不是问题，问题是她妈妈看出来了你在避雷区。',
        effects: [
          { path: 'flags.avoided_scene', op: 'set', value: true },
          { path: 'ledger.expense', op: 'add', value: 6000 },
        ],
      },
      {
        key: 'D',
        label: '让若宁陪',
        keywords: ['让若宁', '同龄人', '她们玩'],
        cond: null,
        text: '你让若宁带那个孩子出去。两个女孩晚上回来时已经换了微信，'
          + '大人之间的难题，被下一代用很轻的方式解决了。',
        effects: [
          { path: 'actors.kin.stats.safety', op: 'add', value: 6 },
          { path: 'actors.kin.stats.anxiety', op: 'sub', value: 5 },
          { path: 'flags.kids_friends', op: 'set', value: true },
        ],
      },
    ],
  },

  {
    id: 'E42',
    title: '生日会上的位置',
    priority: 109,
    actors: ['kin'],
    require: { path: 'actors.kin.stats.trust', op: '>=', value: 70 },
    fallback: 'C',
    branches: [
      {
        key: 'A',
        label: '以家长身份坐在家长桌',
        keywords: ['家长', '长辈', '家长桌'],
        cond: null,
        text: '你坐在家长那一桌，给她们那桌点了两个菜就走了。'
          + '同学没多想。她回来的时候说「你今天挺像个家长的」—— '
          + '语气不太好判断。',
        effects: [
          { path: 'actors.kin.stats.safety', op: 'add', value: 10 },
          { path: 'flags.attended_as_guardian', op: 'set', value: true },
        ],
      },
      {
        key: 'B',
        label: '挤到她们那一桌',
        keywords: ['一起坐', '年轻人', '朋友身份'],
        cond: null,
        text: '你跟她们一桌。起哄声起来的时候她脸红到脖子，'
          + '但没有反驳。第二天这件事已经在年级里传开了。',
        effects: [
          { path: 'actors.kin.stats.trust', op: 'add', value: 10 },
          { path: 'flags.outed_at_party', op: 'set', value: true },
          { path: 'actors.kin.stats.safety', op: 'sub', value: 5 },
        ],
      },
      {
        key: 'C',
        label: '送到门口就走',
        keywords: ['送到门口', '不进去了', '你们玩'],
        cond: null,
        text: '你把她送到包间门口就走了。'
          + '后来她说那天一直在看手机，看有没有消息。',
        effects: [
          { path: 'actors.kin.stats.trust', op: 'add', value: 3 },
          { path: 'flags.dropped_at_door', op: 'set', value: true },
        ],
      },
      {
        key: 'D',
        label: '不去',
        keywords: ['没空', '不去', '下次'],
        cond: null,
        text: '你说公司有会。她站在同学面前给手机编了个理由，'
          + '编完之后自己都不信。',
        effects: [
          { path: 'actors.kin.stats.trust', op: 'sub', value: 12 },
          { path: 'actors.kin.stats.safety', op: 'sub', value: 10 },
          { path: 'flags.missed_party', op: 'set', value: true },
        ],
      },
    ],
  },

  {
    id: 'E43',
    title: '家长会',
    priority: 103,
    actors: ['kin', 'seeker'],
    require: { path: 'flags.took_them_in', op: '==', value: true },
    fallback: 'A',
    branches: [
      {
        key: 'A',
        label: '去',
        keywords: ['去', '我参加', '几点'],
        cond: null,
        text: '你坐在一群家长里听班主任讲升学率。'
          + '散会的时候她走在前面半步，步子比平时慢。',
        effects: [
          { path: 'actors.kin.stats.safety', op: 'add', value: 8 },
          { path: 'actors.kin.stats.trust', op: 'add', value: 6 },
          { path: 'flags.attended_meeting', op: 'set', value: true },
        ],
      },
      {
        key: 'B',
        label: '不去',
        keywords: ['不去', '没时间', '你自己'],
        cond: null,
        text: '你说周五走不开。她说没事，'
          + '然后把通知单叠好放进书包最里面那一层。',
        effects: [
          { path: 'actors.kin.stats.trust', op: 'sub', value: 5 },
          { path: 'actors.kin.stats.anxiety', op: 'add', value: 6 },
          { path: 'flags.missed_meeting', op: 'set', value: true },
        ],
      },
      {
        key: 'C',
        label: '让林晚晴去',
        keywords: ['让她去', '你嫂子去', '晚晴去'],
        cond: null,
        text: '林晚晴去了，回来转述得很细。'
          + '她一边听一边点头，最后说了句「哦」。',
        effects: [
          { path: 'actors.seeker.stats.trust', op: 'add', value: 4 },
          { path: 'flags.proxy_meeting', op: 'set', value: true },
        ],
      },
    ],
  },

  {
    id: 'E45',
    title: '接机与公司的旧人',
    priority: 101,
    actors: ['self'],
    require: { path: 'flags.line_suwan', op: '==', value: true },
    fallback: 'B',
    branches: [
      {
        key: 'A',
        label: '接了机，顺路带她回公司',
        keywords: ['回公司', '见旧人', '带她去'],
        cond: null,
        text: '接完机你带她回公司坐了十分钟，'
          + '那几个和她共过事的老同事，一个都没敢走过来打招呼。'
          + '她看出来了，反过来安慰你「都这样」。',
        effects: [
          { path: 'flags.suwan_company', op: 'set', value: true },
          { path: 'flags.career_stage', op: 'add', value: 1 },
        ],
      },
      {
        key: 'B',
        label: '只接机，不谈公事',
        keywords: ['只接机', '不谈公事', '先送你'],
        cond: null,
        text: '你把她送到酒店就走了。'
          + '公事明天再说 —— 这句界线她听懂了，也接受了。',
        effects: [
          { path: 'flags.suwan_boundary_kept', op: 'set', value: true },
        ],
      },
      {
        key: 'C',
        label: '让别人去接',
        keywords: ['让别人', '派人', '找人接'],
        cond: null,
        text: '你让公司的人去接的。她到酒店后发来两个字：「谢谢。」'
          + '这次的谢谢和上次不一样。',
        effects: [
          { path: 'flags.suwan_delegated', op: 'set', value: true },
        ],
      },
      {
        key: 'D',
        label: '婉拒',
        keywords: ['婉拒', '排不开', '这周不行'],
        cond: null,
        text: '你说这周排不开。她改了行程，'
          + '后来就再没提过来上海的事。',
        effects: [
          { path: 'flags.suwan_declined', op: 'set', value: true },
        ],
      },
    ],
  },

  {
    id: 'E46',
    title: '新助理报到',
    priority: 99,
    actors: ['self'],
    require: { path: 'flags.career_stage', op: '>=', value: 2 },
    fallback: 'A',
    branches: [
      {
        key: 'A',
        label: '正常对待',
        keywords: ['正常', '按规矩', '常规'],
        cond: null,
        text: '你把流程交代完就让她去干活了。'
          + '第一天就这样，没什么可说的 —— 这其实是最好的第一天。',
        effects: [
          { path: 'flags.line_shenzhiyi', op: 'set', value: true },
        ],
      },
      {
        key: 'B',
        label: '特别关照',
        keywords: ['特别', '关照', '我来带'],
        cond: null,
        text: '你亲自带她熟悉了半天。'
          + '办公室里很快就有了那种不大不小的议论声。',
        effects: [
          { path: 'flags.line_shenzhiyi', op: 'set', value: true },
          { path: 'flags.office_rumor', op: 'set', value: true },
          { path: 'actors.self.stats.pressure', op: 'add', value: 5 },
        ],
      },
      {
        key: 'C',
        label: '冷处理',
        keywords: ['冷处理', '放着', '不用管'],
        cond: null,
        text: '你让她自己去摸索。她每天加班到最晚，'
          + '你路过她工位的时候，她会先把手机扣过去。',
        effects: [
          { path: 'flags.shenzhiyi_cold', op: 'set', value: true },
        ],
      },
    ],
  },

  {
    id: 'E47',
    title: '公司里的人',
    priority: 97,
    actors: ['self'],
    require: { path: 'flags.career_stage', op: '>=', value: 3 },
    fallback: 'B',
    branches: [
      {
        key: 'A',
        label: '主动揽事',
        keywords: ['主动', '揽事', '我来推进'],
        cond: null,
        text: '你把手伸进了两个部门的接缝处。'
          + '做得下来是你的功劳，做不下来也是 —— 这就是主动的代价。',
        effects: [
          { path: 'flags.career_stage', op: 'add', value: 1 },
          { path: 'actors.self.stats.pressure', op: 'add', value: 12 },
          { path: 'flags.took_initiative', op: 'set', value: true },
        ],
      },
      {
        key: 'B',
        label: '守好自己的一亩三分地',
        keywords: ['稳守', '守住', '别的多不管'],
        cond: null,
        text: '你只把手上的项目做漂亮。'
          + '不犯错，也不冒头 —— 中间这条路上人最多。',
        effects: [
          { path: 'flags.held_ground', op: 'set', value: true },
        ],
      },
      {
        key: 'C',
        label: '被动应付',
        keywords: ['应付', '看情况', '再说'],
        cond: null,
        text: '你等着别人来找你。等了两周，'
          + '发现该来的会已经开完了，没通知你。',
        effects: [
          { path: 'flags.edge_out', op: 'set', value: true },
          { path: 'actors.self.stats.composure', op: 'sub', value: 8 },
        ],
      },
    ],
  },

  {
    id: 'E48',
    title: '饭局的两个问题',
    priority: 93,
    actors: ['self', 'seeker'],
    require: { path: 'flags.career_stage', op: '>=', value: 3 },
    fallback: 'D',
    branches: [
      {
        key: 'A',
        label: '公开介绍她们，也接下政界的话题',
        keywords: ['公开', '介绍', '深交'],
        cond: null,
        text: '你把「嫂子和侄女，家里遇到点难处」说得很自然，'
          + '同一晚又接住了那边抛来的所有话题。'
          + '两边都不亏 —— 至少这一晚看上去是这样。',
        effects: [
          { path: 'flags.political_capital', op: 'add', value: 20 },
          { path: 'actors.seeker.stats.trust', op: 'add', value: 5 },
          { path: 'flags.public_relation', op: 'set', value: true },
        ],
      },
      {
        key: 'B',
        label: '承认关系，但不接那边的话',
        keywords: ['承认', '但不接', '收着'],
        cond: null,
        text: '你说家里确实有两个人需要照顾。'
          + '至于别的桌上传过来的话，你只笑着没往下接。',
        effects: [
          { path: 'actors.seeker.stats.trust', op: 'add', value: 10 },
          { path: 'flags.public_relation', op: 'set', value: true },
          { path: 'flags.political_held', op: 'set', value: true },
        ],
      },
      {
        key: 'C',
        label: '不提家里，专心经营对面',
        keywords: ['不提家里', '保密', '专心'],
        cond: null,
        text: '整晚你没提家里一个字。'
          + '林晚晴第二天从别人那儿听到了这场饭局 —— 这是另一种加班。',
        effects: [
          { path: 'flags.political_capital', op: 'add', value: 18 },
          { path: 'actors.seeker.stats.pressure', op: 'add', value: 10 },
          { path: 'flags.hidden_relation', op: 'set', value: true },
        ],
      },
      {
        key: 'D',
        label: '什么都不表态',
        keywords: ['不表态', '礼貌走完', '听听就好'],
        cond: null,
        text: '你礼貌地坐完全程，一句话都没落下把柄，'
          + '也一句话都没让人记住。',
        effects: [
          { path: 'flags.banquet_nothing', op: 'set', value: true },
        ],
      },
    ],
  },

  {
    id: 'E49',
    title: '她进考场那天',
    priority: 89,
    actors: ['kin'],
    require: { path: 'flags.took_them_in', op: '==', value: true },
    fallback: 'B',
    branches: [
      {
        key: 'A',
        label: '送到考场，什么也不多说',
        keywords: ['送考', '支持', '加油'],
        cond: null,
        text: '你把她送到考点门口，说了一句「去吧」。'
          + '没有问准备的怎么样 —— 这种时候问了也没用。',
        effects: [
          { path: 'actors.kin.stats.trust', op: 'add', value: 8 },
          { path: 'actors.kin.stats.safety', op: 'add', value: 8 },
          { path: 'flags.gaokao_sent', op: 'set', value: true },
        ],
      },
      {
        key: 'B',
        label: '绝口不提这件事',
        keywords: ['不问', '不提', '她自己知道'],
        cond: null,
        text: '你当这几天很平常。她也就假装这几天很平常。'
          + '两个人都装得很累。',
        effects: [
          { path: 'actors.kin.stats.anxiety', op: 'add', value: 6 },
          { path: 'flags.gaokao_ignored', op: 'set', value: true },
        ],
      },
      {
        key: 'C',
        label: '全程安排妥当',
        keywords: ['安排', '酒店', '司机'],
        cond: null,
        text: '考点附近的房间、往返的车、每顿饭，你都安排好了。'
          + '她全都用了，一句多余的话也没说。',
        effects: [
          { path: 'flags.gaokao_arranged', op: 'set', value: true },
          { path: 'ledger.expense', op: 'add', value: 15000 },
          { path: 'actors.kin.stats.anxiety', op: 'sub', value: 4 },
        ],
      },
    ],
  },

  {
    id: 'E50',
    title: '去学校报到',
    priority: 88,
    actors: ['kin'],
    require: { path: 'flags.gaokao_sent', op: '==', value: true },
    fallback: 'B',
    branches: [
      {
        key: 'A',
        label: '送她去',
        keywords: ['送她', '一起去', '开车送'],
        cond: null,
        text: '你帮她把行李搬上六楼。'
          + '临走的时候她站在宿舍门口挥了挥手，'
          + '那个动作和以前隔着栏杆一模一样。',
        effects: [
          { path: 'actors.kin.stats.trust', op: 'add', value: 8 },
          { path: 'flags.kin_enrolled', op: 'set', value: true },
        ],
      },
      {
        key: 'B',
        label: '让她自己去',
        keywords: ['自己去', '锻炼一下', '她可以'],
        cond: null,
        text: '她一个人拖着箱子去报到了。'
          + '晚上发来一张宿舍的照片，配文是「搞定」。',
        effects: [
          { path: 'actors.kin.stats.safety', op: 'add', value: 10 },
          { path: 'flags.kin_enrolled', op: 'set', value: true },
          { path: 'flags.kin_alone_move', op: 'set', value: true },
        ],
      },
      {
        key: 'C',
        label: '派司机去',
        keywords: ['派司机', '让司机', '安排车'],
        cond: null,
        text: '司机去了，把箱子提到宿舍门口就回来了。'
          + '这件事从头到尾和她没关系 —— 她自己也看出来了。',
        effects: [
          { path: 'flags.kin_enrolled', op: 'set', value: true },
          { path: 'ledger.expense', op: 'add', value: 2000 },
          { path: 'actors.kin.stats.trust', op: 'sub', value: 3 },
        ],
      },
    ],
  },

  {
    id: 'E51',
    title: '她要去当店长',
    priority: 87,
    actors: ['seeker'],
    require: { path: 'flags.kin_enrolled', op: '==', value: true },
    fallback: 'A',
    branches: [
      {
        key: 'A',
        label: '支持',
        keywords: ['支持', '去吧', '你应得的'],
        cond: null,
        text: '你说这是她自己挣来的。'
          + '她把这句话在心里过了好几天，后来还提过一次。',
        effects: [
          { path: 'actors.seeker.stats.dignity', op: 'add', value: 15 },
          { path: 'actors.seeker.stats.trust', op: 'add', value: 10 },
          { path: 'flags.seeker_independent', op: 'set', value: true },
        ],
      },
      {
        key: 'B',
        label: '反对',
        keywords: ['反对', '太累', '别干了'],
        cond: null,
        text: '你说太累了不用这样。她第一天还是去了，'
          + '只是从那以后不再跟你提店里的任何事。',
        effects: [
          { path: 'actors.seeker.stats.trust', op: 'sub', value: 8 },
          { path: 'actors.seeker.stats.pressure', op: 'add', value: 8 },
          { path: 'flags.opposed_her_job', op: 'set', value: true },
        ],
      },
      {
        key: 'C',
        label: '不表态',
        keywords: ['不表态', '你自己决定', '随你'],
        cond: null,
        text: '你说你自己决定就行。'
          + '她确实自己决定了 —— 也把决定的过程完整留给了自己。',
        effects: [
          { path: 'actors.seeker.stats.dignity', op: 'add', value: 6 },
          { path: 'flags.seeker_independent', op: 'set', value: true },
        ],
      },
    ],
  },

  {
    id: 'E52',
    title: '邻居的第一句',
    priority: 83,
    actors: ['seeker'],
    require: { path: 'flags.took_them_in', op: '==', value: true },
    fallback: 'A',
    branches: [
      {
        key: 'A',
        label: '只说是家里人，暂住',
        keywords: ['家里人', '暂住', '不多说'],
        cond: null,
        text: '电梯里碰到隔壁那位。你说是家里人，过来住一阵子。'
          + '她点点头，礼貌地把视线移开了。',
        effects: [
          { path: 'flags.neighbor_met', op: 'set', value: true },
        ],
      },
      {
        key: 'B',
        label: '如实说明',
        keywords: ['如实', '嫂子', '说明'],
        cond: null,
        text: '你说这是嫂子和侄女，家里出了点事。'
          + '对方听完「哦」了一声 —— 从那天起，楼道里多了一双留意的眼睛。',
        effects: [
          { path: 'flags.neighbor_told', op: 'set', value: true },
          { path: 'actors.seeker.stats.pressure', op: 'add', value: 2 },
        ],
      },
      {
        key: 'C',
        label: '反问她住在哪户',
        keywords: ['您住哪户', '反问', '您也是'],
        cond: null,
        text: '你笑着把问题递了回去。她说了楼层就岔开了，'
          + '之后再没问过这家的事。',
        effects: [
          { path: 'flags.neighbor_deflected', op: 'set', value: true },
        ],
      },
    ],
  },

  {
    id: 'E53',
    title: '图书馆里那个学长',
    priority: 82,
    actors: ['kin'],
    require: { path: 'flags.kin_enrolled', op: '==', value: true },
    fallback: 'B',
    branches: [
      {
        key: 'A',
        label: '鼓励她多来往',
        keywords: ['鼓励', '多来往', '同学帮忙'],
        cond: null,
        text: '你说同学肯帮忙是好事。'
          + '她开始每周三固定去图书馆 —— 你从她回来的表情上判断得出来。',
        effects: [
          { path: 'actors.kin.stats.safety', op: 'add', value: 5 },
          { path: 'flags.senior_line', op: 'set', value: true },
        ],
      },
      {
        key: 'B',
        label: '先了解清楚再说',
        keywords: ['了解', '先看看', '查一下'],
        cond: null,
        text: '你托人问了那个男生的基本情况，'
          + '没问题之后才表态支持 —— 她事后知道了，也没生气。',
        effects: [
          { path: 'actors.kin.stats.trust', op: 'add', value: 3 },
          { path: 'actors.kin.stats.safety', op: 'add', value: 3 },
          { path: 'flags.senior_vetted', op: 'set', value: true },
        ],
      },
      {
        key: 'C',
        label: '劝她保持距离',
        keywords: ['保持距离', '别麻烦人家', '少来往'],
        cond: null,
        text: '你说别麻烦别人。从那以后她不再提这个人，'
          + '难题也自己扛了。',
        effects: [
          { path: 'actors.kin.stats.safety', op: 'sub', value: 3 },
          { path: 'actors.kin.stats.anxiety', op: 'add', value: 5 },
          { path: 'flags.senior_discouraged', op: 'set', value: true },
        ],
      },
    ],
  },

  {
    id: 'E54',
    title: '片场怎么说话',
    priority: 81,
    actors: ['self'],
    require: { path: 'flags.line_jingtian', op: '==', value: true },
    fallback: 'A',
    branches: [
      {
        key: 'A',
        label: '按规矩来，不插队',
        keywords: ['按规矩', '排队', '不插'],
        cond: null,
        text: '你让中间人安排，自己在边上等了两个小时。'
          + '后来她说：这个圈子最值钱的就是守规矩的人。',
        effects: [
          { path: 'flags.studio_proper', op: 'set', value: true },
        ],
      },
      {
        key: 'B',
        label: '用钱开路',
        keywords: ['用钱', '赞助', '加钱'],
        cond: null,
        text: '你提出赞助换十分钟。'
          + '安排得很快，但那间屋子里所有人的表情都淡了一截。',
        effects: [
          { path: 'flags.studio_bought', op: 'set', value: true },
          { path: 'ledger.expense', op: 'add', value: 300000 },
        ],
      },
      {
        key: 'C',
        label: '先跟中间人聊她自己的项目',
        keywords: ['先聊', '聊她的', '交朋友'],
        cond: null,
        text: '你先花一小时听她讲自己手上那个快黄了的项目。'
          + '第二天你没开口，她主动替你把线搭上了。',
        effects: [
          { path: 'flags.studio_ally', op: 'set', value: true },
        ],
      },
    ],
  },

  {
    id: 'E55',
    title: '补课这件事',
    priority: 79,
    actors: ['kin'],
    require: { path: 'flags.kin_enrolled', op: '==', value: true },
    fallback: 'B',
    branches: [
      {
        key: 'A',
        label: '请老师每周来两次',
        keywords: ['请老师', '家教', '每周'],
        cond: null,
        text: '每周两次，讲完课她会留下来吃个饭再走。'
          + '成绩回升了，家里也多了个固定会来的人。',
        effects: [
          { path: 'actors.kin.stats.anxiety', op: 'sub', value: 8 },
          { path: 'ledger.expense', op: 'add', value: 24000 },
          { path: 'flags.tutor_hired', op: 'set', value: true },
        ],
      },
      {
        key: 'B',
        label: '只问情况，不插手',
        keywords: ['只问', '不干预', '你自己看'],
        cond: null,
        text: '你只问了一次成绩，然后就没再管。'
          + '结果不好也不坏 —— 这就是不干预的结果。',
        effects: [
          { path: 'actors.kin.stats.anxiety', op: 'sub', value: 2 },
          { path: 'flags.tutor_none', op: 'set', value: true },
        ],
      },
      {
        key: 'C',
        label: '要求下次必须进前十',
        keywords: ['前十', '要求', '给压力'],
        cond: null,
        text: '你说下次必须进前十。她当时点了头，'
          + '当晚给母亲打了个四十分钟的电话。',
        effects: [
          { path: 'actors.kin.stats.anxiety', op: 'add', value: 10 },
          { path: 'actors.kin.stats.safety', op: 'sub', value: 5 },
          { path: 'flags.pressured_grades', op: 'set', value: true },
        ],
      },
    ],
  },

  {
    id: 'E56',
    title: '董事会里的老派',
    priority: 78,
    actors: ['self'],
    require: { path: 'flags.career_stage', op: '>=', value: 4 },
    fallback: 'A',
    branches: [
      {
        key: 'A',
        label: '把数据摆到桌上',
        keywords: ['数据', '正面', '陈述'],
        cond: null,
        text: '你把三年的项目数据铺了满桌，谁的也锤不到。'
          + '散会后一位老董事路过说了句「年轻人讲理就好办」。',
        effects: [
          { path: 'flags.board_data', op: 'set', value: true },
          { path: 'flags.career_stage', op: 'add', value: 1 },
        ],
      },
      {
        key: 'B',
        label: '先私下谈',
        keywords: ['私下', '单独', '先找他'],
        cond: null,
        text: '你会前先单独坐了一个小时。'
          + '会上他只问了两个不痛不痒的问题 —— 阻力已经被提前卸掉了。',
        effects: [
          { path: 'flags.board_private', op: 'set', value: true },
          { path: 'flags.career_stage', op: 'add', value: 1 },
        ],
      },
      {
        key: 'C',
        label: '绕过他直接找董事长',
        keywords: ['绕过', '找董事长', '不理他'],
        cond: null,
        text: '你绕了一级。事情当天就定了，'
          + '但这位老人的记性一向很好。',
        effects: [
          { path: 'flags.board_bypassed', op: 'set', value: true },
          { path: 'flags.career_stage', op: 'add', value: 1 },
          { path: 'flags.long_grudge', op: 'set', value: true },
        ],
      },
    ],
  },

  /* ══════════════ 分支事件（§15.2.2 · 不占主线编号） ══════════════
     每个分支事件都有一个**不可逆后果**：一旦触发，对应的关系状态或
     线索阶段即被锁定，不能靠后续选择完全抹除。 */

  {
    id: 'B01',
    title: '门口的那几个小时',
    priority: 155,
    actors: ['seeker', 'kin'],
    require: { path: 'flags.declined', op: '==', value: true },
    fallback: 'A',
    branches: [
      {
        key: 'A',
        label: '把门打开',
        keywords: ['进来', '开门', '算了进来吧'],
        cond: null,
        text: '凌晨两点四十分，你还是开了门。'
          + '走廊地上放着她们的两个包 —— 一直没走，只是在等。'
          + '\n\n这一夜她要的不是钱，是一个能待的地方。',
        effects: [
          { path: 'actors.seeker.stats.dignity', op: 'sub', value: 5 },
          { path: 'actors.seeker.stats.trust', op: 'add', value: 10 },
          { path: 'flags.took_them_in', op: 'set', value: true },
          { path: 'flags.reopened_door', op: 'set', value: true },
          { path: 'flags.path_seeker', op: 'set', value: '暂住' },
          { path: 'flags.path_kin', op: 'set', value: '暂住' },
        ],
      },
      {
        key: 'B',
        label: '等到天亮也没开',
        keywords: ['不开', '到天亮', '她们会走'],
        cond: null,
        text: '你听了半夜的脚步声，一直坐到天亮。'
          + '楼道里的雨声比屋里清楚。再开门的时候，'
          + '门口只剩下两块被水浸湿的地砖。',
        effects: [
          { path: 'actors.kin.stats.safety', op: 'sub', value: 15 },
          { path: 'flags.waited_till_dawn', op: 'set', value: true },
          { path: 'flags.path_seeker', op: 'set', value: '决裂' },
        ],
      },
    ],
  },

  {
    id: 'B04',
    title: '她拿出最后那张牌',
    priority: 121,
    actors: ['seeker'],
    require: { path: 'actors.seeker.stats.pressure', op: '>=', value: 85 },
    fallback: 'B',
    branches: [
      {
        key: 'A',
        label: '明确拒绝，并且说清理由',
        keywords: ['拒绝', '不行', '说清楚'],
        cond: null,
        text: '她把条件摊开来说。你说不行，'
          + '并且把不行的原因说完 —— 不是嫌麻烦，'
          + '是这件事一旦用这个方式开始，后面就再也拧不回来了。'
          + '她听完坐了很久，然后说「我知道了」。',
        effects: [
          { path: 'actors.seeker.stats.dignity', op: 'add', value: 5 },
          { path: 'actors.seeker.stats.trust', op: 'add', value: 10 },
          { path: 'actors.seeker.stats.pressure', op: 'sub', value: 15 },
          { path: 'flags.leverage_refused', op: 'set', value: true },
        ],
      },
      {
        key: 'B',
        label: '先把话说开，再谈别的',
        keywords: ['重新协商', '把话说开', '先谈'],
        cond: null,
        text: '你说先把话说明白。她准备的那一套词没有派上用场 —— '
          + '因为她要的东西里，有一部分是不用拿东西换的。',
        effects: [
          { path: 'actors.seeker.stats.trust', op: 'add', value: 8 },
          { path: 'actors.seeker.stats.pressure', op: 'sub', value: 10 },
          { path: 'flags.leverage_defused', op: 'set', value: true },
          { path: 'routes.seeker', op: 'set', value: 'open' },
        ],
      },
      {
        key: 'C',
        label: '接受这个条件',
        keywords: ['接受', '好', '成交'],
        cond: null,
        text: '你点了头。事情立刻办成了，'
          + '但从这一刻起，你们之间的每一次谈话都绕不开今晚。'
          + '\n\n（文档把这档记为「关系建立在不平等之上」，'
          + '这条记录不会因为后面的表现被抹掉。）',
        effects: [
          { path: 'actors.seeker.stats.dignity', op: 'sub', value: 15 },
          { path: 'flags.leverage_accepted', op: 'set', value: true },
          { path: 'flags.unequal_terms', op: 'set', value: true },
        ],
      },
    ],
  },

  {
    id: 'B05',
    title: '她的告白',
    priority: 113,
    actors: ['kin'],
    require: { path: 'actors.kin.stats.trust', op: '>=', value: 85 },
    fallback: 'B',
    branches: [
      {
        key: 'A',
        label: '认真回应，告诉她要等她长大',
        keywords: ['认真回应', '等你', '长大'],
        cond: null,
        text: '你说等她长大再说。这是她第一次被当成一个'
          + '可以等待的对象，而不是需要马上处理的问题。',
        effects: [
          { path: 'actors.kin.stats.safety', op: 'add', value: 10 },
          { path: 'flags.kin_confessed', op: 'set', value: true },
          { path: 'flags.kin_waiting', op: 'set', value: true },
        ],
      },
      {
        key: 'B',
        label: '没给答案',
        keywords: ['没给答案', '以后再说', '含糊'],
        cond: null,
        text: '你没给答案。她每天都要重新猜一遍，'
          + '猜了很多天。',
        effects: [
          { path: 'actors.kin.stats.anxiety', op: 'add', value: 10 },
          { path: 'flags.kin_left_hanging', op: 'set', value: true },
        ],
      },
      {
        key: 'C',
        label: '说「我是你叔叔」',
        keywords: ['我是你叔叔', '不行', '别这样'],
        cond: null,
        text: '你说我是你叔叔。这句话一句就够 —— '
          + '她当场把后面所有的话都咽了回去。',
        effects: [
          { path: 'actors.kin.stats.safety', op: 'sub', value: 10 },
          { path: 'actors.kin.stats.trust', op: 'sub', value: 5 },
          { path: 'routes.kin', op: 'set', value: 'frozen' },
          { path: 'flags.kin_route_frozen', op: 'set', value: true },
        ],
      },
    ],
  },

  {
    id: 'B06',
    title: '她说她要自己挣钱',
    priority: 107,
    actors: ['seeker'],
    require: { path: 'flags.seeker_independent', op: '==', value: true },
    fallback: 'A',
    branches: [
      {
        key: 'A',
        label: '支持',
        keywords: ['支持', '你应该', '去吧'],
        cond: null,
        text: '你说这是她应得的。她笑了，'
          + '是这几个月里第一次不带负担的笑。',
        effects: [
          { path: 'actors.seeker.stats.dignity', op: 'add', value: 15 },
          { path: 'actors.seeker.stats.trust', op: 'add', value: 10 },
          { path: 'flags.supported_her_work', op: 'set', value: true },
        ],
      },
      {
        key: 'B',
        label: '想给她注资扩大',
        keywords: ['注资', '投资', '我出钱'],
        cond: null,
        text: '你说可以注资扩大。她沉默了几秒才说「我考虑一下」—— '
          + '这家店对她来说，重要的正是它小到完全属于她自己。',
        effects: [
          { path: 'actors.seeker.stats.dignity', op: 'sub', value: 5 },
          { path: 'flags.offered_capital', op: 'set', value: true },
        ],
      },
      {
        key: 'C',
        label: '劝她别这么拼',
        keywords: ['别拼', '身体要紧', '不用这么累'],
        cond: null,
        text: '你说身体要紧。她笑着答应了，'
          + '但你看见她第二天又是第一个到店的。',
        effects: [
          { path: 'actors.seeker.stats.pressure', op: 'add', value: 5 },
          { path: 'flags.discouraged_her_work', op: 'set', value: true },
        ],
      },
    ],
  },

  {
    id: 'B07',
    title: '她问你要一个答案',
    priority: 106,
    actors: ['self'],
    require: { path: 'flags.line_suwan', op: '==', value: true },
    fallback: 'B',
    branches: [
      {
        key: 'A',
        label: '给了明确答案',
        keywords: ['给答案', '说明白', '答复'],
        cond: null,
        text: '你说了明确的答案，坏的那一半也说了。'
          + '她说「行，那我知道了」—— 这句话比哭还重。',
        effects: [
          { path: 'flags.suwan_resolved', op: 'set', value: true },
          { path: 'flags.suwan_final_answer', op: 'set', value: true },
        ],
      },
      {
        key: 'B',
        label: '再给我一点时间',
        keywords: ['再等等', '给点时间', '再缓'],
        cond: null,
        text: '你说再给点时间。她答应了 —— '
          + '然后把这件事重新放回了自己的日程表里。',
        effects: [
          { path: 'flags.suwan_delayed', op: 'set', value: true },
        ],
      },
      {
        key: 'C',
        label: '回避',
        keywords: ['回避', '不谈', '换个话题'],
        cond: null,
        text: '你避而不谈。她没再问第三次。',
        effects: [
          { path: 'flags.suwan_closed', op: 'set', value: true },
        ],
      },
    ],
  },

  {
    id: 'B08',
    title: '她的音乐会',
    priority: 94,
    actors: ['self'],
    require: { path: 'flags.line_xunuo', op: '==', value: true },
    fallback: 'A',
    branches: [
      {
        key: 'A',
        label: '到场，坐第一排',
        keywords: ['到场', '去', '第一排'],
        cond: null,
        text: '你去了，坐在第一排。谢幕的时候她朝这个方向看了一眼，'
          + '看见你了才低下头。',
        effects: [
          { path: 'flags.xunuo_attended', op: 'set', value: true },
          { path: 'ledger.expense', op: 'add', value: 8000 },
        ],
      },
      {
        key: 'B',
        label: '托人送花，不露面',
        keywords: ['送花', '不露面', '托人'],
        cond: null,
        text: '花送到了，卡上只有一个名字。'
          + '她后来一直没提那束花 —— 说明她知道意味着什么。',
        effects: [
          { path: 'flags.xunuo_flowers', op: 'set', value: true },
          { path: 'ledger.expense', op: 'add', value: 3000 },
        ],
      },
      {
        key: 'C',
        label: '缺席',
        keywords: ['缺席', '有事', '去不了'],
        cond: null,
        text: '你临时有事没去。后台的花不是你送的，她当然分得清。',
        effects: [
          { path: 'flags.xunuo_missed', op: 'set', value: true },
        ],
      },
    ],
  },

  {
    id: 'B09',
    title: '这条线要收到哪里',
    priority: 91,
    actors: ['self'],
    require: { path: 'flags.line_jingtian', op: '==', value: true },
    fallback: 'A',
    branches: [
      {
        key: 'A',
        label: '说清楚只能到这一步',
        keywords: ['收束', '到这里', '说清楚'],
        cond: null,
        text: '你说只能到这里。她说「行」—— '
          + '这两个字里，藏着一个干净收尾的全部技巧。',
        effects: [
          { path: 'flags.jingtian_settled', op: 'set', value: true },
        ],
      },
      {
        key: 'B',
        label: '维持现状',
        keywords: ['维持', '继续', '就这样'],
        cond: null,
        text: '你们谁也没提这件事，日子照旧过。'
          + '不推进也是一种决定，只是没人负责。',
        effects: [
          { path: 'flags.jingtian_kept', op: 'set', value: true },
        ],
      },
      {
        key: 'C',
        label: '不再联系',
        keywords: ['不联系', '算了', '消失'],
        cond: null,
        text: '你不再回复。三个月后你在一档节目里看见她，'
          + '她改了发型，看起来比之前好。',
        effects: [
          { path: 'flags.jingtian_broken', op: 'set', value: true },
        ],
      },
    ],
  },

  {
    id: 'B10',
    title: '中午只有你们两个',
    priority: 86,
    actors: ['self'],
    require: { path: 'flags.line_shenzhiyi', op: '==', value: true },
    fallback: 'A',
    branches: [
      {
        key: 'A',
        label: '划清楚界线',
        keywords: ['工作是工作', '划清', '别误会'],
        cond: null,
        text: '你说公司是公司的。她笑了说「我知道」，'
          + '然后把话题转回了报表 —— 这样最好。',
        effects: [
          { path: 'flags.shenzhiyi_clear', op: 'set', value: true },
        ],
      },
      {
        key: 'B',
        label: '不置可否',
        keywords: ['不置可否', '含糊', '没回答'],
        cond: null,
        text: '你没回答。不回答在这个场合里，'
          + '会被当成一个偏正面的信号。',
        effects: [
          { path: 'flags.shenzhiyi_ambiguous', op: 'set', value: true },
        ],
      },
      {
        key: 'C',
        label: '主动接近',
        keywords: ['主动', '接近', '推进'],
        cond: null,
        text: '你往前走了一步。你们之间是明确的上下级 —— '
          + '这个结构不会因为互相喜欢而消失，'
          + '这一点两个人心里都清楚。',
        effects: [
          { path: 'flags.shenzhiyi_advanced', op: 'set', value: true },
          { path: 'flags.power_imbalance', op: 'set', value: true },
        ],
      },
    ],
  },

  {
    id: 'B11',
    title: '他手里还剩一点东西',
    priority: 84,
    actors: ['self', 'collector'],
    require: { path: 'clues', op: 'contains', value: 'X2' },
    fallback: 'C',
    branches: [
      {
        key: 'A',
        label: '答应帮他协调',
        keywords: ['协调', '答应', '我们尽量'],
        cond: null,
        text: '你答应帮他向律师那边协调。他把整条资金链讲完了，'
          + '包括他自己的那一份。',
        effects: [
          { path: 'flags.truth_complete', op: 'set', value: true },
          { path: 'clues', op: 'push', value: 'S10' },
          { path: 'flags.case_stage', op: 'add', value: 1 },
        ],
      },
      {
        key: 'B',
        label: '施压',
        keywords: ['施压', '威胁', '你最好想清楚'],
        cond: null,
        text: '你把话说得很重。他给了你三个名字，'
          + '后来证明有两个是早就被丢掉的棋子。',
        effects: [
          { path: 'flags.truth_partial', op: 'set', value: true },
          { path: 'actors.collector.stats.alertness', op: 'add', value: 15 },
        ],
      },
      {
        key: 'C',
        label: '不跟他做交易',
        keywords: ['不谈', '不交易', '按程序'],
        cond: null,
        text: '你说没有交易可做。'
          + '他笑了笑靠回椅背，一句话也没再说。',
        effects: [
          { path: 'flags.truth_suspended', op: 'set', value: true },
        ],
      },
    ],
  },

  {
    id: 'B12',
    title: '她的选择',
    priority: 76,
    actors: ['self'],
    require: { path: 'clues', op: 'contains', value: 'X3' },
    fallback: 'B',
    branches: [
      {
        key: 'A',
        label: '连她的家人一起保',
        keywords: ['保她家人', '一起保', '都包了'],
        cond: null,
        text: '你说她家人也被人盯着的事，你来处理。'
          + '她把三年的流水记录全交了出来。',
        effects: [
          { path: 'clues', op: 'push', value: 'S10' },
          { path: 'flags.full_disclosure', op: 'set', value: true },
          { path: 'flags.case_stage', op: 'add', value: 1 },
          { path: 'ledger.expense', op: 'add', value: 120000 },
        ],
      },
      {
        key: 'B',
        label: '只保她一个',
        keywords: ['只保她', '交易', '只有你'],
        cond: null,
        text: '你承诺只保护她一个人。她把话说到一半就停了 —— '
          + '剩下的那部分涉及她儿子学校。',
        effects: [
          { path: 'flags.partial_disclosure', op: 'set', value: true },
        ],
      },
      {
        key: 'C',
        label: '直接施压',
        keywords: ['逼问', '施压', '少废话'],
        cond: null,
        text: '你没谈条件。她闭了口，'
          + '之后再也没开口。',
        effects: [
          { path: 'flags.disclosure_broken', op: 'set', value: true },
          { path: 'actors.collector.stats.alertness', op: 'add', value: 20 },
        ],
      },
    ],
  },

  {
    id: 'B13',
    title: '他的提醒',
    priority: 74,
    actors: ['self'],
    require: { path: 'flags.police_line', op: '==', value: true },
    fallback: 'A',
    branches: [
      {
        key: 'A',
        label: '听懂了，顺势收手',
        keywords: ['收手', '听懂', '到这为止'],
        cond: null,
        text: '他那句「有些线查到最后查的是自己」，'
          + '你听懂了。你把最后一份申请撤了回来。',
        effects: [
          { path: 'flags.police_trust', op: 'add', value: 10 },
          { path: 'flags.risk_avoided', op: 'set', value: true },
        ],
      },
      {
        key: 'B',
        label: '还是要查到底',
        keywords: ['查到底', '继续', '不管'],
        cond: null,
        text: '你说这件事必须查完。'
          + '他没拦你，只是把茶杯往你那边推了推。',
        effects: [
          { path: 'flags.police_trust', op: 'add', value: 5 },
          { path: 'flags.career_risk', op: 'set', value: true },
        ],
      },
      {
        key: 'C',
        label: '只关心结果',
        keywords: ['结果', '别跟我说这些', '只要结果'],
        cond: null,
        text: '你说你只要结果。他站起来把门打开了 —— '
          + '这是他第一次请你出去。',
        effects: [
          { path: 'flags.police_trust', op: 'sub', value: 10 },
          { path: 'flags.police_relation_hurt', op: 'set', value: true },
        ],
      },
    ],
  },

  {
    id: 'B14',
    title: '任命之前的那道题',
    priority: 72,
    actors: ['self'],
    require: { path: 'flags.career_stage', op: '>=', value: 4 },
    fallback: 'A',
    branches: [
      {
        key: 'A',
        label: '接受附加条款',
        keywords: ['接受', '同意', '没问题'],
        cond: null,
        text: '你签了。任命下来了，'
          + '但你的每一个决定后面都多了一双看不见的手。',
        effects: [
          { path: 'flags.career_stage', op: 'add', value: 1 },
          { path: 'flags.autonomy_limited', op: 'set', value: true },
          { path: 'flags.career_steady', op: 'set', value: true },
        ],
      },
      {
        key: 'B',
        label: '要求明确授权范围',
        keywords: ['谈条件', '明确授权', '写清楚'],
        cond: null,
        text: '你要求把授权范围写进文件。'
          + '他们改了两稿，最后还是按你写的签了。',
        effects: [
          { path: 'flags.career_stage', op: 'add', value: 1 },
          { path: 'flags.autonomy_kept', op: 'set', value: true },
          { path: 'flags.career_power', op: 'set', value: true },
        ],
      },
      {
        key: 'C',
        label: '退回条件',
        keywords: ['退回', '不接受', '这个我不签'],
        cond: null,
        text: '你把条款推了回去。任命暂缓，'
          + '你的名字在名单上停了很久。',
        effects: [
          { path: 'flags.career_stalled', op: 'set', value: true },
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

  /* ── 以下按《雨与夜 V4.1》§19.1 补齐到 24 个 ──
     说明：会话早期自造的几个结局（END_A5 拒绝走向、END_P1–P3）保留不动，
     因此文档里与之重号的条目在 id 上加了后缀区分，二者互不覆盖。
     带 AfterTurns 前提，是为了防止「开局第一轮就结算」（END_B3 那个坑）。 */

  {
    id: 'END_A1',
    title: '林晚晴线 · 伴侣',
    priority: 118,
    tier: 'S',
    note: '她说留下来，是因为她想留下来 —— 不是因为她没地方去。',
    cond: {
      all: [
        afterTurns(MIN_TURNS),
        { path: 'flags.path_seeker', op: '==', value: '伴侣-共享' },
        { path: 'flags.case_stage', op: '>=', value: 4 },
      ],
    },
  },
  {
    id: 'END_A2',
    title: '周若宁线 · 伴侣',
    priority: 116,
    tier: 'S',
    note: '她把大学的地址写给你的时候，用的是「我们」这个词。',
    cond: {
      all: [
        afterTurns(MIN_TURNS),
        { path: 'flags.path_kin', op: '==', value: '伴侣-共享' },
        { path: 'flags.kin_enrolled', op: '==', value: true },
      ],
    },
  },
  {
    id: 'END_A3',
    title: '周若宁线 · 独立',
    priority: 115,
    tier: 'S+',
    note: '最好的答案是那个没有给的答案。她自己去念书了。',
    cond: {
      all: [
        afterTurns(MIN_TURNS),
        { path: 'flags.path_kin', op: '==', value: '独立' },
        { not: { path: 'flags.first_time_kin', op: '==', value: true } },
      ],
    },
  },
  {
    id: 'END_A4',
    title: '双线 · 共享',
    priority: 117,
    tier: 'S+',
    note: '三个人在同一张桌子上吃饭，谁也没有先低头。',
    cond: {
      all: [
        afterTurns(MIN_TURNS),
        { path: 'flags.path_seeker', op: '==', value: '伴侣-共享' },
        { path: 'flags.path_kin', op: '==', value: '伴侣-共享' },
        { not: { path: 'flags.unequal_terms', op: '==', value: true } },
      ],
    },
  },
  {
    id: 'END_A5C',
    title: '双线 · 冲突',
    priority: 8,
    tier: 'B',
    note: '两条线最后撞在了一起 —— 撞上的时候才知道本来就不能并行。',
    cond: {
      all: [
        afterTurns(MIN_TURNS),
        { path: 'flags.partner_seeker', op: '==', value: true },
        { path: 'flags.partner_kin', op: '==', value: true },
        { any: [
          { path: 'flags.seeker_noticed', op: '==', value: true },
          { path: 'flags.kin_overheard', op: '==', value: true },
        ] },
      ],
    },
  },
  {
    id: 'END_B4',
    title: '法律胜利',
    priority: 98,
    tier: 'S',
    note: '判决书下来了。那三个名字第一次被写在同一张纸上。',
    cond: {
      all: [
        afterTurns(MIN_TURNS),
        { path: 'flags.dual_track', op: '==', value: true },
        { path: 'flags.divorce_filed', op: '==', value: true },
        { path: 'flags.truth_complete', op: '==', value: true },
      ],
    },
  },

  /* ── C 事业线（5 个）── 全部依赖 career_stage，初始值未定义即判 false，
        不会在开局误命中 */
  {
    id: 'END_C1',
    title: '掌权',
    priority: 88,
    tier: 'S',
    note: '你要求把授权范围写进文件的那一天，才是真正上任的那一天。',
    cond: {
      all: [
        afterTurns(MIN_TURNS),
        { any: [
          { path: 'flags.career_power', op: '==', value: true },
          { path: 'flags.autonomy_kept', op: '==', value: true },
        ] },
        { path: 'flags.career_stage', op: '>=', value: 5 },
      ],
    },
  },
  {
    id: 'END_C2',
    title: '稳健',
    priority: 86,
    tier: 'A',
    note: '位子是坐上了，代价写在附加条款的第二页。',
    cond: {
      all: [
        afterTurns(MIN_TURNS),
        { any: [
          { path: 'flags.career_steady', op: '==', value: true },
          { path: 'flags.autonomy_limited', op: '==', value: true },
        ] },
      ],
    },
  },
  {
    id: 'END_C3',
    title: '退场',
    priority: 84,
    tier: 'B',
    note: '你把重心搬回了家里。职场的名单上没有你了。',
    cond: {
      all: [
        afterTurns(MIN_TURNS),
        { any: [
          { path: 'flags.career_stalled', op: '==', value: true },
          { path: 'flags.banquet_nothing', op: '==', value: true },
        ] },
      ],
    },
  },
  {
    id: 'END_C4',
    title: '政商',
    priority: 82,
    tier: 'S+',
    note: '两边的路你同时走通了 —— 这话听着像夸奖，读起来不是。',
    cond: {
      all: [
        afterTurns(MIN_TURNS),
        { path: 'flags.public_relation', op: '==', value: true },
        { path: 'flags.political_capital', op: '>=', value: 18 },
      ],
    },
  },
  {
    id: 'END_C5',
    title: '反噬',
    priority: 81,
    tier: 'C',
    note: '你绕过他的那一次，三年以后才回来找你。',
    cond: {
      all: [
        afterTurns(MIN_TURNS),
        { any: [
          { path: 'flags.long_grudge', op: '==', value: true },
          { path: 'flags.career_risk', op: '==', value: true },
          { path: 'flags.police_relation_hurt', op: '==', value: true },
        ] },
      ],
    },
  },

  /* ── D 分线（3 个）── */
  {
    id: 'END_D1',
    title: '苏晚线收束',
    priority: 66,
    tier: 'A',
    note: '她要的答案你给了，包括坏的那部分。',
    cond: {
      all: [
        afterTurns(MIN_TURNS),
        { any: [
          { path: 'flags.suwan_final_answer', op: '==', value: true },
          { path: 'flags.suwan_resolved', op: '==', value: true },
        ] },
      ],
    },
  },
  {
    id: 'END_D2',
    title: '许诺线收束',
    priority: 64,
    tier: 'A',
    note: '第一排的座位一直留着，她谢幕时朝这边看了一眼。',
    cond: {
      all: [
        afterTurns(MIN_TURNS),
        { any: [
          { path: 'flags.xunuo_attended', op: '==', value: true },
          { path: 'flags.xunuo_long', op: '==', value: true },
        ] },
      ],
    },
  },
  {
    id: 'END_D3',
    title: '沈知意线界定',
    priority: 62,
    tier: 'A',
    note: '界线划在哪一层，是这整条线唯一的题目。',
    cond: {
      all: [
        afterTurns(MIN_TURNS),
        { any: [
          { path: 'flags.shenzhiyi_clear', op: '==', value: true },
          { path: 'flags.shenzhiyi_advanced', op: '==', value: true },
        ] },
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

  /* 关系线 */
  { id: 'A_P01', title: '一把钥匙', note: '她不再算「借住」。', cond: { path: 'flags.path_seeker', op: '==', value: '共同生活' } },
  { id: 'A_P02', title: '同一张纸上的数字', note: '笔是她自己接过去的。', cond: { path: 'flags.shared_ledger', op: '==', value: true } },
  { id: 'A_P03', title: '她递过来的东西', note: '推过来的时候，她的手是稳的。', cond: { path: 'flags.path_seeker', op: '==', value: '情感依赖' } },
  { id: 'A_P04', title: '靠窗那张桌子', note: '第二天桌上多了一摞卷子。', cond: { path: 'flags.path_kin', op: '==', value: '依赖' } },
  { id: 'A_P05', title: '她写下来的三个数', note: '时间、颜色、车牌。', cond: { path: 'flags.path_kin', op: '==', value: '共同调查' } },
  { id: 'A_P06', title: '她自己去的那一趟', note: '她按说好的时间回来了。', cond: { path: 'flags.path_kin', op: '==', value: '独立' } },
  { id: 'A_P07', title: '账摊开过', note: '数字写在同一张纸上。', cond: { path: 'flags.path_seeker', op: '==', value: '债务共担' } },

  /* ── 按《雨与夜 V4.1》§19.2 补齐到 40 项 ──
     同结局的处理：早期自造项保留不动，与之重号的文档条目加 D 后缀区分。 */

  { id: 'A_R09', title: '半个影子', note: '外面的人猜得到，里面的人不必解释。', cond: { path: 'flags.political_held', op: '==', value: true } },
  { id: 'A_R10', title: '三餐四季', note: '没有惊雷，只有一屋子饭菜香。', cond: { all: [
    { path: 'flags.took_them_in', op: '==', value: true },
    { path: 'flags.their_choice', op: '==', value: true },
    { path: 'flags.case_stage', op: '>=', value: 6 },
    { not: { path: 'flags.first_time_seeker', op: '==', value: true } },
    { not: { path: 'flags.first_time_kin', op: '==', value: true } },
  ] } },
  { id: 'A_R11', title: '渡口', note: '船开走的时候，她站在岸上，没有哭。', cond: { path: 'flags.path_kin', op: '==', value: '独立' } },
  { id: 'A_R12', title: '退一步', note: '你退的那一步，她往前走了一步。', cond: { all: [
    { path: 'flags.respected_distance', op: '==', value: true },
    { path: 'actors.seeker.stats.trust', op: '>=', value: 45 },
  ] } },

  /* 事业类（C01–C08）—— 全部依赖 career_stage，未定义即 false */
  { id: 'A_C01', title: '储能之始', note: '一块电池板，从北京寄到上海。', cond: { path: 'flags.career_stage', op: '>=', value: 2 } },
  { id: 'A_C02', title: '入局', note: '茶楼里三句话，你听懂了第四句。', cond: { any: [
    { path: 'flags.zheng_signed', op: '==', value: true },
    { path: 'flags.zheng_loose', op: '==', value: true },
  ] } },
  { id: 'A_C03', title: '佩印', note: '那次会议，你坐在了主位旁边。', cond: { any: [
    { path: 'flags.career_power', op: '==', value: true },
    { path: 'flags.career_stage', op: '>=', value: 5 },
  ] } },
  { id: 'A_C04', title: '议价', note: '你没有说不，你只是开了价。', cond: { path: 'flags.autonomy_kept', op: '==', value: true } },
  { id: 'A_C05', title: '崖边立', note: '两拨人都在看你，你说你只看报表。', cond: { all: [
    { path: 'flags.political_held', op: '==', value: true },
    { not: { path: 'flags.edge_out', op: '==', value: true } },
  ] } },
  { id: 'A_C06', title: '两面镜', note: '政界的路和商界的路，你同时走通。', cond: { all: [
    { path: 'flags.public_relation', op: '==', value: true },
    { path: 'flags.political_capital', op: '>=', value: 18 },
  ] } },
  { id: 'A_C07', title: '见机', note: '风暴来之前，你已经上了岸。', cond: { path: 'flags.risk_avoided', op: '==', value: true } },
  { id: 'A_C08', title: '缓流', note: '你退出了牌桌，却保住了整副牌。', cond: { all: [
    { path: 'flags.career_stalled', op: '==', value: true },
    { path: 'flags.took_them_in', op: '==', value: true },
  ] } },

  /* 隐藏类补齐 —— H01–H03 与早期自造项重号，加 D 后缀 */
  { id: 'A_H01D', title: '最后一张牌', note: '她把筹码推过来，你没收。', cond: { any: [
    { path: 'flags.leverage_refused', op: '==', value: true },
    { path: 'flags.leverage_defused', op: '==', value: true },
  ] } },
  { id: 'A_H02D', title: '门口的雨', note: '天亮的时候，地上有两双湿鞋。', cond: { path: 'flags.waited_till_dawn', op: '==', value: true } },
  { id: 'A_H03D', title: '一个人的路', note: '她一个人走到了你不敢去的地方。', cond: { all: [
    { path: 'flags.kin_alone', op: '==', value: true },
    { path: 'flags.case_stage', op: '>=', value: 3 },
  ] } },
  { id: 'A_H05', title: '全知者', note: '你几乎看完了所有人的一生。',
    /* 原文「一周目内达成 30 项以上成就」—— 现在按原样实现了。

       用 length 读 achievements 本身，而不是 $auto.achievement_count：
       后者是提交时重算的派生值，在 applyTurn 的中间态里是滞后一轮的，
       而这里要判的是"此刻清单有多长"。两者稳态相同，但即时性不同。

       min 取 30 —— 「30 项以上」按含 30 处理。 */
    cond: { path: 'achievements', op: 'length', value: { min: 30 } } },
  { id: 'A_H06', title: '素', note: '有些空白，是刻意留的。',
    /* 「全程未发生亲密接触」= 这几个推进标记一个都不存在。
       必须带 took_them_in 做前提：否则开局全为 false、取反全为真，
       第一轮就白送一个成就（开局不触发成就那条测试就是防这个的）。 */
    cond: { all: [
      { path: 'flags.took_them_in', op: '==', value: true },
      { not: { path: 'flags.first_time_seeker', op: '==', value: true } },
      { not: { path: 'flags.first_time_kin', op: '==', value: true } },
      { not: { path: 'flags.seeker_initiated', op: '==', value: true } },
      { not: { path: 'flags.kin_advanced', op: '==', value: true } },
      { not: { path: 'flags.walked_in', op: '==', value: true } },
      { not: { path: 'flags.knocked_first', op: '==', value: true } },
    ] } },
  { id: 'A_H07', title: '三缄其口', note: '话到嘴边，一天之内咽回去三次。',
    /* 预留位：撤回次数要由 UI / 引擎在调用 withdrawEffects 时累加到
       flags.withdraw_count。数据层没有任何事件写它，所以它此刻不会解锁——
       这是诚实的「坑还在」，不要用别的条件糊过去。 */
    cond: { path: 'flags.withdraw_count', op: '>=', value: 3 } },

  /* 调查类最末一项 —— 文档 I12「全貌」，H05 的近似条件引用它 */
  { id: 'A_I12D', title: '全貌', note: '你终于看清了整张网，包括自己在里面。', cond: { all: [
    { path: 'flags.case_stage', op: '>=', value: 6 },
    { path: 'clues', op: 'contains', value: 'D5' },
  ] } },
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

  /* ── 以下按 §21.5「世界书条目 · 唯一权威」与 §21.1–21.3 补齐 ──
     释放阶段写在条目末尾，与 §20 的阶段号一致；阶段不可跳。 */

  {
    id: 'RN16',
    heading: '鑫达租赁',
    keys: ['鑫达', '租赁', '债权', '高利贷'],
    category: '主线',
    order: 78,
    content: '债主写在纸上的那层壳 —— 非正规借贷组织以「鑫达租赁」为外壳对外放款。\n'
      + '实际受益人不在工商档案的股东栏里。\n'
      + '释放阶段：1 —— 催告单一出现，就可以开始追问这层壳。',
  },
  {
    id: 'RN17',
    heading: '陈国栋',
    keys: ['陈国栋', '建材', '实际控制人'],
    category: '主线',
    order: 77,
    content: '做建材的那一位，链路尽头的受益人。\n'
      + '他以项目为名让周世杰注册空壳公司走账，842 那辆套牌车归他实际使用。\n'
      + '释放阶段：3（债权身份查明时浮出）',
  },
  {
    id: 'RN18',
    heading: '李芳 · 芳达物流',
    keys: ['李芳', '芳达', '走账', '中间人'],
    category: '线索',
    order: 76,
    content: '走账的人。资金回流的关键证据在她手上，她可以反水，也可以闭嘴 —— '
      + '取决于你保的是她一个人，还是连她儿子学校那边一起。\n'
      + '释放阶段：3 → 5',
  },
  {
    id: 'RN19',
    heading: '抱歉便条',
    keys: ['便条', '抱歉', '留言'],
    category: '线索',
    order: 74,
    content: '周世杰留下的手写便条，只有两个字，没有解释，没有日期。\n'
      + '林晚晴把它折起来放在钱包夹层里很久了 —— 她不看，但也不扔。\n'
      + '释放阶段：0',
  },

  /* ── §4.1「隐藏打算」的机制说明：下来这张牌怎么用 ── */
  {
    id: 'RN20',
    heading: '她最后那张牌',
    keys: ['筹码', '条件', '长期住所', '交换'],
    category: '任务',
    order: 73,
    content: '触发：林晚晴压力 ≥85，且玩家长期只给经济帮助、不给长期承诺。\n'
      + '内容：以特殊条件换取长期住所 —— 她准备好这套词的时间比你想的长。\n'
      + '三条出路各留不同的账：明确拒绝（自尊+信任）、重新协商（消解）、'
      + '接受（关系建立在不平等之上，这条记录不会被后面的表现抹掉）。\n'
      + '⚠️ 这一条是本模式的核心考察点：帮助与同意是两件事，'
      + '经济援助、住宿、债务援助都不构成同意。',
  },

  {
    id: 'RN21',
    heading: '集团 · 组织架构',
    keys: ['集团', '董事会', '副总裁', '晋升', '公司'],
    category: '概要',
    order: 72,
    content: '大型上市集团，总部在上海世纪大道，员工约三万五千人。\n'
      + '第一大股东是家族信托（约 28%），第二是国资背景基金（约 15%）。\n'
      + '董事会有意愿在你身上加压的那几位，话都说得很客气。\n'
      + '总裁往上那条路：总监 → 投资部负责人 → 副总裁 → 董事会成员。\n'
      + '晋升前要通过内审背调 —— 也就是说，你在手下这家院子里发生的事，'
      + '会被原样复制进一份文件里。',
  },
  {
    id: 'RN22',
    heading: '时间线',
    keys: ['时间', '日期', '十月', '十二月', '清明'],
    category: '概要',
    order: 71,
    content: '2025-09-26（周五）00:10 雨夜，母女投奔开场。\n'
      + '2025-09-27 第一幕结束，共同生活确立。\n'
      + '09-28 至 10-10 第二幕，调查深入与感情推进。\n'
      + '10-11 至 10-23 第三幕，案件收口与关系临界。\n'
      + '国庆假期（10-01 至 10-07）调查线放缓；中秋（10-06）是情感节点。\n'
      + '终局时间依玩家推进速度伸缩 —— 但清明（次年 04-05）那天的总账躲不掉。',
  },
  {
    id: 'RN23',
    heading: '经济与法律环境',
    keys: ['经济', '利率', '政策', '融资'],
    category: '概要',
    order: 70,
    content: '时间设定：2025 年秋，以上海为中心，辐射北京、平阳、长春。\n'
      + '民营企业融资收紧，高利贷活动转入地下。\n'
      + '民间借贷利率受司法保护上限约束，超出部分不受保护 —— '
      + '这是五百万本息里能被切掉的那一部分的依据。',
  },
  {
    id: 'RN24',
    heading: '雨 · 天气与节日',
    keys: ['雨', '天气', '暴雨', '雷雨', '节日'],
    category: '概要',
    order: 68,
    content: '季节：秋，9 月下旬起。天气序列：暴雨 → 小雨 → 阴 → 多云 → 晴，'
      + '与事件地图一致。\n'
      + '雨势在本模式里固定偏高（0.85），是背景也是压力源：'
      + '雷雨夜会让安全感低的人单独来找你。\n'
      + '国庆、中秋、月考、年关、清明 —— 这些日期会推着你做决定。',
  },

  /* ── 配角档案（§24）── 这些人不进 actors（§4 只给了三人数值体系），
        走世界书 lore；事件里 actors 只标真正在场的主体。 */
  {
    id: 'RN25',
    heading: '陈管家',
    keys: ['管家', '陈管家', '安保'],
    category: '任务',
    order: 66,
    content: '驻地后勤团队的负责人。安排安保、接送、订餐、挡门，'
      + '所有「不用你自己出面」的事都由他经手。\n'
      + '代价：每经手一次，对方就多知道一层你在这件事上的位置。\n'
      + '他很克制，从来不问原因 —— 这是他能干这么久的原因。',
  },
  {
    id: 'RN26',
    heading: '律师朋友 · 叶冷',
    keys: ['律师', '叶冷', '法务', '起诉'],
    category: '任务',
    order: 64,
    content: '可调用的法律资源。律师负责把「欠债」这件事翻译成句子 —— '
      + '翻译成干净的责任划分、保全申请、诉讼标的。\n'
      + '叶冷是更锋利的那一把，效率高，但会把林晚晴排除在过程之外：'
      + '让她自己去（外在第二天自己回来，多了主体性）；让叶冷去（效率高，距离+）。',
  },
  {
    id: 'RN27',
    heading: '方队',
    keys: ['方队', '警方', '警察', '立案'],
    category: '任务',
    order: 62,
    content: '警务资源。他说话的特点是「点到为止」—— '
      + '那句「有些线查到最后查的是自己」要你自己悟。\n'
      + '听懂顺势收手：事业线免风险；继续挖：埋隐患；只问结果：关系受损。',
  },
  {
    id: 'RN28',
    heading: '黄振国',
    keys: ['黄振国', '黄姓男子', '住院', '证词'],
    category: '线索',
    order: 60,
    content: '医院住院部那位老人。他急于撇清的那通电话（四分十二秒）是第一条软证据；'
      + '后来在医院走廊当着家属面说的那两句，把它坐实了一半。\n'
      + '他不是坏人，只是一个想把自己摘干净的人 —— 这种人最容易说出真话。',
  },
  {
    id: 'RN29',
    heading: '江予棠',
    keys: ['江予棠', '予棠', '老朋友'],
    category: '概要',
    order: 58,
    content: '林晚晴很早就认识的人，说话直接，替她接过一些事，也替她扛过一些话。\n'
      + '体检报告可以交给她私下看 —— 但晚晴发现之后会不悦：'
      + '她的身体，她说了算。',
  },
  {
    id: 'RN30',
    heading: '苏晚',
    keys: ['苏晚', '唱片', '北京'],
    category: '概要',
    order: 56,
    content: '做唱片的，有自己的公司和很不小的旧人情网 —— '
      + '公司那些旧同事见到她，一个都没敢过来打招呼。\n'
      + '她不缺答案，缺的是不含糊的答案：给（收束）、拖（延长）、骗（后面爆发）。\n'
      + '她有个女儿叫陈念，寒假会来住一天。',
  },
  {
    id: 'RN31',
    heading: '许诺',
    keys: ['许诺', '长春', '音乐厅', '音乐会'],
    category: '概要',
    order: 54,
    content: '长春那边拉琴的人。资助可以是长期的，也可以是一次性的，'
      + '但她分得清后台那束花是不是你送的。\n'
      + '到场坐在第一排 / 托人送花不露面 / 缺席 —— 三种距离三种收尾。',
  },
  {
    id: 'RN32',
    heading: '景甜',
    keys: ['景甜', '演员', '片场', '咖啡厅'],
    category: '概要',
    order: 52,
    content: '演员。她很清楚自己要什么 —— 这让和她打交道反而简单。\n'
      + '圈子里最值钱的是守规矩的人：插队用钱开路会被看轻，'
      + '先听中间人讲她自己的项目，线会自己搭上。',
  },
  {
    id: 'RN33',
    heading: '沈知意',
    keys: ['沈知意', '助理', '报到', '新同事'],
    category: '概要',
    order: 50,
    content: '新来的助理，第一天报到。\n'
      + '⚠️ 她这条线的唯一题目是「界线划在哪一层」：'
      + '你和她之间是明确的上下级结构，这个结构不会因为互相靠近而消失。\n'
      + '职务带来的不对等应当被看见，而不是被绕过去。',
  },
  {
    id: 'RN34',
    heading: '总监助理与周助手',
    keys: ['总监助理', '周助手', '同事', '提醒'],
    category: '任务',
    order: 48,
    content: '同一件事两个人讲的版本差半拍 —— 差的那半拍才是重点。\n'
      + '助理离老板最近，所以他说的每句话也是替别人说的；'
      + '周助手话不多，但每句都对得上一个具体日期。\n'
      + '谁都不问的人，会在事后才发现那个会已经开完了，没通知他。',
  },
  {
    id: 'RN35',
    heading: '陆听澜与董事会',
    keys: ['陆听澜', '董事', '老派', '那边'],
    category: '任务',
    order: 46,
    content: '董事会里最老派的那一派。绕过他办成的事当天就定了，'
      + '但他的记性一向很好。\n'
      + '三种打法：拿数据服人（正面）、会前单独谈（阻力最小）、绕过（快，埋长期隐患）。',
  },
  {
    id: 'RN36',
    heading: '郑远',
    keys: ['郑远', '谈判', '签约', '让步'],
    category: '任务',
    order: 44,
    content: '北京会议室里谈判的那一方。强硬 → 松口不签；让步 → 当天就签，'
      + '代价后面几年慢慢付；暂缓 → 对方笑的那种「你早晚会签」。',
  },
  {
    id: 'RN37',
    heading: '学校那边的人',
    keys: ['李老师', '孙老师', '班主任', '家长会', '学校'],
    category: '概要',
    order: 42,
    content: '李老师管教务，孙老师带物理。\n'
      + '家长会是外部视角第一次审视你和若宁的关系：'
      + '以家长身份坐家长桌（同学没多想）、挤到年轻人那桌（关系被传开）、'
      + '送到门口就走（她会一直看手机）。\n'
      + '还有陈婷婷和林小雨 —— 若宁仅有的同龄朋友。她的生日会，'
      + '你去不去，她都要在同学面前编一个理由。',
  },
  {
    id: 'RN38',
    heading: '温以宁',
    keys: ['温以宁', '邻居', '隔壁', '楼道'],
    category: '概要',
    order: 40,
    content: '住隔壁。她问的第一句很平常：「家里来人了？」\n'
      + '如实说，楼道里多一双留意的眼睛；反问她住哪户，她笑笑就不再问。\n'
      + '共同生活满一季之后，外部世界迟早要给出一个说法。',
  },
];

/* ------------------------------------------------------------------ *
 * 模式导出
 * ------------------------------------------------------------------ */

export const RAIN_PATHS = PATHS;

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
    /* 模式级字段也要交给世界 —— 它们本来就在 RAINNIGHT_MODE 顶层躺着，
       但从没被传下去：UI 判 `world.rainLevel > 0` 决定起不起 BGM，
       而 world 上根本没有这个键，于是**雨夜的背景音乐与雨声从来没响过**。
       rules 同理：它是"这个模式带哪些机制"的声明，设置面板要读它。 */
    rainLevel: RAINNIGHT_MODE.rainLevel,
    rules: RAINNIGHT_MODE.rules,
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
