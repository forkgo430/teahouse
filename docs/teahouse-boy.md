# 茶馆小二 · 自由模式下的脚本沙箱

> 状态：**方案（待落地）** —— 2026-09-18。
> 依据：`N0VI028/JS-Slash-Runner` 源码实读（`src/iframe/*`、`src/function/variables.ts`、
> `src/function/event.ts`、`src/function/script.ts`）。
> **改动前先读这一页。**
>
> 合规：酒馆与 JS-Slash-Runner 均为 **AGPL-3.0**。赢容明确表示自用不公开、
> 不必顾虑传染性；本文按「**移植机制、代码自写**」推进，出处一律注明。

---

## 1. 一句话

茶馆小二 = **在自由对话模式下开一个 iframe，把引擎的读写能力做成一层白名单 API 桥进去**，
让玩家自己写的脚本能读状态、能画界面、能在被允许时反过来推动引擎。

**不是沙箱。** 上游源码已证明：桥了 API 就挡不住脚本（见 §4）。
所以本方案不在「防」上做文章，而在**开关**上做文章 ——
**关掉时零能力、打开时能力有清单**。这是赢容第 3 条要的「开关」，
也是第 2 条要的「硬约束开关」。

---

## 2. 三个开关（不是两个）

起初想的是「只读 / 可写」两档。实读上游后发现不够，因为**读**本身就分两级：

| 开关 | 取值 | 关掉时 | 打开时 |
|---|---|---|---|
| **小二总开关** | 开 / 关 | iframe 不加载，面板整块不出现 | 加载脚本、执行、渲染 |
| **读写档** | 只读 / 可写 | 桥里没有写通道，`teahouse.set()` 直接抛 | 桥里挂上写通道 |
| **硬约束开关** | 锁 / 松 | 写通道只收**常量**（见 §5） | 写通道收常量 + 表达式 |

默认：**总开关关 · 只读 · 锁**。

### 为什么「硬约束」是独立一档

赢容的原话是「加个硬约束开关」。它锁的是**写通道能接受什么形状的值**：

- **锁（硬约束）** —— `set` 的值只能是**字面常量**（数字 / 布尔 / 字符串），
  键只能是**引擎已声明的路径**（`state.actors.linwan.stats.信任` 这种）。
  这等价于「脚本能做的，正是玩家手点一次按钮能做的」——
  引擎仍然完全持有判定权，脚本只是个更快的输入设备。
- **松（自由）** —— 值可以是**表达式**，可以新建**未声明的键**（落到 `flags.*`）。

差别不是安全，是**可判定性**：锁上时，每个写入都能在存档层被静态枚举；
松开时，`flags` 会变成一锅谁都能往里扔东西的汤。
项目第一条硬约束是「所有条件可判定」，所以**锁是默认值**。

---

## 3. iframe 的两种加载模式（赢容第 3 条要的「两种方式」）

| 模式 | 实现 | 何时用 |
|---|---|---|
| **`srcdoc`** | 直接注入 HTML 字符串 | 脚本是自包含的单个 HTML。默认走这条 |
| **blob URL** | `URL.createObjectURL(new Blob([...], {type:'text/html'}))` | 脚本要 `<script src>` 引外部模块、或者要能 `import` |

上游走的是 blob URL（`src/iframe/script_url.ts` 的 `createObjectURLFromScript`），
原因是它注入了 5 个 `.js` 预置脚本，`srcdoc` 下相对路径会解析到宿主。
**茶馆也走 blob**，理由一样：预置桥接脚本要能被 `<script src>` 引到，
且 `import` 在 `srcdoc` 里会因 opaque origin 失败。

> ⚠️ 零外部请求不变式：blob URL 是**本地**的，不产生网络请求。
> 小二面板里**不允许填远程 URL**（那是宿主的事，不是脚本的事）。

---

## 4. 上游到底怎么做的（实读结论）

这一节是**事实**，不是评价。要把 §5 的桥设计讲清楚，必须先知道上游桥了什么。

### 4.1 它不是沙箱，是**能力桥接**

⚠️ **先纠正一个曾写错的说法。** 上一版本文写「上游用 `_bind` + postMessage 做 RPC」——
**错的**。实读全仓库后确认：**它根本没有命令协议。**

`src/iframe/predefine.js`（1852 B）在 iframe 内执行：

```js
window._ = window.parent._;
let result = _(window);
result = result.merge(_.pick(window.parent, ['EjsTemplate','TavernHelper','YAML','showdown','toastr','z']));
result = result.merge(_.omit(_.get(window.parent,'TavernHelper'), '_bind'));
result = result.merge(...Object.entries(_.get(window.parent,'TavernHelper')._bind)
  .map(([k, v]) => ({ [k.replace('_','')]: v.bind(window) })));
result.value();
Object.defineProperty(window, 'SillyTavern', { get: () => ... });
```

三件事：
1. **整包搬运** —— `TavernHelper`（**约 200 个成员**）的非 `_bind` 属性直接 merge 进 iframe 的 `window`。
2. **`_bind` 逐个绑桥** —— 去名字开头的 `_` 再 `bind(window)` 挂上去。
   注意：**这不是 RPC，是"手动纠正跨窗口调用的 `this`"**。
   宿主函数的签名是 `function _getVariables(this: Window, ...)`，
   同源跨窗口调用时 `this` 会是宿主 window，脚本调用会找错自己的 iframe；
   `bind(window)` 是把这个 `this` 掰回 iframe。
3. **活体 getter** —— `SillyTavern` 用 `defineProperty` + `get`，每次都从父窗口现取。

**关键事实：主通道是「同源共享 window 引用 + 直接跨窗口函数调用」** ——
同步、无序列化、无往返、无 ack。
全仓库 `src/iframe/` 下**唯一的 `postMessage`** 是 `adjust_viewport.js` 里
一条 `{type:'TH_UPDATE_VIEWPORT_HEIGHT'}` 的视口高度通知。

### 4.1b 因此茶馆**不是"移植"这一层，而是分道**

上游那条路的前提是**同源**。同源的代价是脚本能碰宿主 DOM，
于是要 `cleanup_protector.js` 那 316 行来擦地 —— 而它的总开关
`use_cleanup_protector` **默认是 `false`**（作者自己也没默认开）。

茶馆走 `sandbox="allow-scripts"`（**不带** `allow-same-origin`）+ postMessage
请求/响应。代价是 API 全变异步（脚本要 `await`）；
收益是**真隔离**：`window.parent` 是个被隔离的壳，脚本碰不到宿主任何东西。

**这不是"更安全"的自夸，是能力形状的取舍**：同步调用换不成异步，
所以脚本接口从头就是 Promise 形状（见 §5.1）。


### 4.2 变量作用域是**七层**（不是五层）

`src/function/variables.ts` 的 `VariableOption` 联合类型给出全部七种：

| 作用域 | 取值方式 | 茶馆对应物 |
|---|---|---|
| `global` | 扩展设置 | 无 |
| `preset` | 预设设置 | 无 |
| `character` | 角色卡 | 无 |
| `chat` | 当前聊天 | ≈ 茶馆的 `state`（**最接近的一层**） |
| `message` | 按楼层 id（`'latest'` 或数字） | ≈ `history[i]`，但茶馆的 history 是事件记录不是变量袋 |
| `script` | 按脚本 id | 无 |
| `extension` | 按扩展 id | 无 |

API 形状（每个都有对应的 `_` 前缀 iframe 版）：
`getVariables` / `replaceVariables` / `updateVariablesWith` /
`insertOrAssignVariables` / `insertVariables` / `deleteVariable`。
`registerVariableSchema(schema, {type})` 用 **zod** 做校验。

**两处要记住的**：
1. **它没有变更通知。** 宿主变量变了，脚本不会收到事件 ——
   上游的同步模型是「**重建整个 iframe**」，不是推送。
   茶馆的 `state:changed` 事件正好补上这个洞。
2. **`getVariables` 与 `get_variables_without_clone` 是两个函数** ——
   前者克隆、后者给引用。给引用是为了让脚本"改了就生效"，
   但这也意味着脚本能绕过 `replaceVariables` 直接改。
   茶馆**不提供这条路**：读通道一律给深拷贝（`snapshotFor` / `structuredClone`）。

### 4.2b `_bind` 的命名约定（要不要抄）

上游用 `_` 前缀标记「这个是给 iframe 调的」，挂载时剥掉下划线：
父窗口叫 `_getVariables`，iframe 里看到的是 `getVariables`。

**茶馆的处理**：不抄。理由是茶馆的桥**没有一个统一的 `TavernHelper` 对象可挂**，
而是按通道分家（`teahouse.read` / `teahouse.write`，见 §5）。
用**命名空间**代替**前缀**，读起来直白，也不需要 `bind(window)` 那套 `this` 纠正。


### 4.3 `cleanup_protector.js`（316 行）在防什么

它防的**不是恶意**，是**泄漏**：iframe 被销毁后，它往父窗口写的东西还在。
手段清单（实读）：

| 手段 | 目的 |
|---|---|
| `Proxy` 包 `window.parent.document`，劫持 `createElement` / `createElementNS` | 给每个父窗口新建元素打 `data-th-iframe-id="<iframeId>"` |
| 给 `Node.prototype.cloneNode` 打补丁 | 深克隆也继承标记 |
| `Proxy` 包 `window.parent`，记录**每一次 set / delete** 到 `recordedWrites` | `pagehide` 时按记录回滚 |
| `Proxy` 的 `get` 里把 `parent`/`window`/`self`/`top`/`globalThis` 都指回自己 | 让 iframe 以为自己是顶层，避免脚本乱窜 |
| 包 jQuery 原型，补丁 `append`/`prepend`/`before`/`after`/`html` | HTML 字符串插进 DOM 也要被打标 |
| `MutationObserver` 观察 iframe 自身 document | 捕获 `innerHTML` 塞进来的节点 |
| `pagehide` 时：回滚 `recordedWrites` → 删掉所有带本 iframe 标记的元素 → 断开 observer | 善后 |

**这套东西的成本是 316 行，为的是「脚本在父窗口留下的垃圾能收干净」。**

**茶馆要不要抄**：**要，但只抄一半**。理由见 §5.3。

### 4.4 上游的事件类型清单（可对照，不照抄）

`src/function/event.ts` 里两大组：
- `iframe_events`（7 个）：渲染开始/结束、生成请求/开始/结束、流式 token 收到。
- `tavern_events`（约 80 个）：消息增删改、生成生命周期、设置变更、世界书扫描、
  角色增删改、预设变更、密钥轮换…… 极其细。

**茶馆的处理**：只取**我们自己有对应物的那些**，砍掉 80% 的噪音。
详见 §6 的事件表。

---

## 5. 桥的设计

### 5.1 名字与形状

iframe 内注入一个 `window.teahouse`（不是 `TavernHelper`，也不叫 `Mvu`）：
**单一命名空间，四个子对象，能力全在清单里。**

```js
window.teahouse = {
  // ── 只读：任何档位都有 ──────────────────────────────
  read: {
    snapshot(),        // → 引擎 buildView(state, world) 的深拷贝（已冻结）
    state(),           // → 原始 state 的深拷贝
    world(),           // → 世界定义（标签表 / 数值上下限 / 事件 id 清单，不含正文）
    turn(),            // → 当前轮号 / 天 / 时段 / 地点
    actors(),          // → 已met 的角色数组
    vars(),            // → 宏变量当前值（{{getvar}} 的那一份）
    books(),           // → 书架三本书的元信息（不含条目正文）
  },

  // ── 写：仅「可写」档 ────────────────────────────────
  write: {
    set(path, value),       // 笔直改一个已声明路径 / 或 flags.*
    addStat(actorId, key, delta),
    addClue(clueId),
    say(text),              // 往消息流塞一条【系统】发言（不动引擎状态）
    request(text),          // 替玩家提交一次输入（走和真人一样的那条路）
  },

  // ── 事件：任何档位都有（订阅不产生写入） ──────────────
  on(type, fn),           // → () => void（取消订阅）
  once(type, fn),
  emit(type, payload),    // 只能发「小二事件」，发不到引擎事件

  // ── 渲染：任何档位都有 ───────────────────────────────
  render: {
    card(markup),         // 把声明式标记渲染成卡片（复用 src/card.js）
    toast(msg),           // 右下角提示
  },

  // ── 元信息：脚本自省 ─────────────────────────────────
  meta: { scriptId, scriptName, mode: 'readonly'|'write', strict: true|false, version },
};
```

**四个子对象的分法不是为了好看**，是为了**能在关掉时整块不挂**：
关掉可写档 → `delete teahouse.write`，脚本一碰就是 `undefined`，
报错位置精确落在 `teahouse.write.set`，比 "没有权限" 的运行时告警好排查得多。

### 5.2 写通道的形状（硬约束的核心）

写通道**不是** `applyEffects` 的裸透传，中间隔一道**声明表**：

```js
/** 声明表：允许脚本碰的每一个路径，以及它的取值形状。锁档下只收常量。 */
const WRITABLE = Object.freeze({
  'state.actors.*.stats.*': { kind: 'number', min: -100, max: 200 },
  'state.flags.*':          { kind: 'any' },            // 仅松档
  'state.clues':            { kind: 'addOnly' },        // 只能加，不能删
  'state.where':            { kind: 'enum', of: 'world.places' },
});
```

判定顺序（**任何一步不过就抛，不静默跳过**）：

1. 路径匹配声明表？不匹配 → 抛 `小二写通道不认识这个路径：<path>`
2. 档位是「锁」时，值是字面常量？是表达式（含 `?`/`(`/`,`）→ 抛
3. 类型对得上 `kind`？`enum` 的值在 `of` 指的表里？越界 → 抛
4. 全部过了 → 组一个 effect，**走 `applyEffects`**，再由 `store.commit` 落地

**关键：脚本永远不直接改 `state`。** 它走的是和引擎自身事件一模一样的那条写入路径，
所以留痕（`changes`）、clamp、成就检查、结局判定全都照常触发。
这样「脚本改的」和「事件改的」在存档里长得一样 —— 不搞两套。

### 5.3 清理（抄一半的意思）

上游 316 行清理是在防「脚本往**宿主 DOM** 里拉屎」。茶馆**不需要抄这一半**，
因为我们**不给 iframe 宿主 DOM 的引用**：

- 不给 `window.parent.document`
- 不给 jQuery
- 不给 `querySelector` / `appendChild` 之类的任何 DOM 入口
- 脚本只能在**自己的 iframe 内**画东西

代价：脚本画不出「浮在茶馆界面上的悬浮窗」。
收益：**不需要 316 行 Proxy/MutationObserver 善后**，
也不需要防「脚本把宿主页面清空」。

要保留的那一半是**生命周期**：`pagehide` 时断开所有 `teahouse.on` 订阅、
`URL.revokeObjectURL` 掉 blob、把 iframe 从 DOM 摘掉。
**这一半只有十几行。**

> 这是本方案与上游最本质的取舍：**它给 DOM、然后花 316 行擦地；
> 我们不给 DOM，因此地一直是干净的。**

---

## 6. 事件表（只取我们有对应物的）

对照上游 `iframe_events` + `tavern_events`，茶馆小二**只挂这些**：

| 小二事件 | 触发时机 | 载荷 | 上游对应 |
|---|---|---|---|
| `turn:ready` | 新一轮开始、选项已渲染 | `{turn, clock, where, options}` | `MESSAGE_IFRAME_RENDER_ENDED`（近似） |
| `turn:finished` | 分支已选、effects 已落库 | `{turn, eventId, branchKey, changes}` | `MESSAGE_UPDATED` |
| `free:submitted` | 自由对话玩家发言已入库 | `{turn, text}` | `MESSAGE_SENT` |
| `free:replied` | 自由对话模型回复已入库 | `{turn, text, segments}` | `MESSAGE_RECEIVED` |
| `stream:delta` | 流式输出每片 | `{turn, delta}` | `STREAM_TOKEN_RECEIVED` |
| `state:changed` | 状态被改（含脚本自己改的） | `{changed: [path...]}` | 无（这是我们多的） |
| `achievement:unlocked` | 成就解锁 | `{id, name}` | 无 |
| `ending:reached` | 走到结局 | `{id, name}` | 无 |

**砍掉的理由**（避免造出永远匹配不到的开关）：
上游那 80 个 `tavern_events` 里，绝大多数对应「酒馆这个应用自身的状态」
（密钥轮换、连接配置文件、扩展设置加载…）—— 茶馆没有这些对象，
挂上去就是**永远不触发的死事件**。本项目栽过静默降级的坑，宁可少而实。

---

## 7. 与第 4 条的关系（提示词栈 / 人称语言字数）

赢容第 4 条要的「提示词栈可修改，可关闭；人称 / 语言 / 字数 / 叙述者」**已落地**
（`src/style.js` + 设置面板「叙述文风」折），涉及 **甲 的开关** =
`style.locked`（引擎系统提示词那一条的锁）。

小二与它的关系只有一处：**`teahouse.write.say()` 不经过文风管线**。
理由 —— 文风管线是给**模型**的话做包装的（人称、字数、叙述者口吻）；
脚本写的是**系统提示**，本来就该是脚本自己的语气。
硬塞进去会让「小二：天气已更新」被改写成第二人称叙述，那是错的。

---

## 8. 分期（实施顺序）

- **期 1｜骨架与只读** —— `src/boy.js`（桥的宿主侧）+ `ui` 里的面板 + blob iframe。
  只挂 `read` / `on` / `render`，`write` 不挂。总开关 + 读写档 + 硬约束三个开关到位。
  **验收**：脚本能画出一张读引擎真值的卡片。
- **期 2｜写通道** —— 声明表 + 四步判定 + 走 `applyEffects` 落地。
  **验收**：脚本改一个数值，`changes` 里出现它，`render()` 跟上，存档里长得和事件改的一样。
- **期 3｜事件** —— 引擎侧在这些时点 `emit`，`stream:delta` 接上 SSE。
  **验收**：脚本订阅 `turn:finished` 能拿到 changes。
- **期 4｜脚本管理** —— 多脚本、启停、示例脚本、导入导出。

---

## 9. 已知不做（写下来免得下次重复讨论）

| 不做 | 为什么 |
|---|---|
| 沙箱 / CSP / 权限弹窗 | 上游已证明挡不住；茶馆改为「关掉时零能力 + 打开时清单可见」 |
| **同源共享 window（上游主通道）** | 同源就得给宿主 DOM，就得写 316 行擦地；茶馆走 `sandbox="allow-scripts"` + postMessage |
| 给 iframe 宿主 DOM 引用 | 会给就得写 316 行 Proxy/MutationObserver（见 §5.3） |
| jQuery / Vue / tailwind 预置 | 上游从 CDN 拉一堆；我们不给脚本引任何外部请求 |
| 抄 `_bind` 下划线前缀约定 | 用命名空间代替前缀，更直白（见 §4.2b） |
| 抄 80 个 `tavern_events` | 大半在茶馆没有对应物，会变成死事件（见 §6） |
| 抄七层变量作用域 | 茶馆只有一层（引擎 state）；`message` 级 ≈ history 记录，但那不是变量袋 |
| 「重建 iframe」式同步 | 会丢脚本内的临时状态；茶馆用 `state:changed` 推送 |
| 小程序式组件市场 | 不在本期范围 |

---

## 10. 源码调研记录（可复查）

| 事项 | 来源 | 结论 |
|---|---|---|
| iframe 加载方式 | `src/iframe/script_url.ts` | 全部走 `URL.createObjectURL(new Blob([...]))`；无 `srcdoc` 路径 |
| **通信协议** | `src/iframe/` 全目录 | **没有命令协议**。主通道 = 同源共享 `window.parent` 引用 + 直接跨窗口调用。全目录唯一 `postMessage` 是 `adjust_viewport.js` 的视口高度通知 |
| `_bind` 的真实作用 | `src/iframe/predefine.js` | **不是 RPC** —— 是纠正跨窗口调用的 `this`（宿主函数签名为 `function _x(this: Window, ...)`） |
| 桥的面 | `src/iframe/predefine.js` | `TavernHelper`（约 200 成员）整包 merge + 7 个预置库 + 活体 `SillyTavern` getter |
| 变量作用域 | `src/function/variables.ts` | **七层**：global / preset / character / chat / message / script / extension；`registerVariableSchema` 用 zod |
| 变量变更通知 | 同上 | **完全没有**。同步模型是「重建 iframe」 |
| 变量读的两个版本 | 同上 | `getVariables`（克隆）/ `get_variables_without_clone`（给引用） |
| 变量 API 形状 | 同上 | `getVariables` / `replaceVariables` / `updateVariablesWith` / `insertOrAssignVariables` / `insertVariables` / `deleteVariable`，每个都有 `_` 前缀的 iframe 版 |
| **权限系统** | 全仓库 | **不存在**。只有"整个扩展开/关"一个粒度；无按脚本、按能力的权限 |
| 清理保护器默认值 | `src/store/settings.ts` | `use_cleanup_protector` **默认 `false`** —— 作者自己也没默认开 |
| 事件类型 | `src/function/event.ts` | `iframe_events` 7 个 + `tavern_events` 约 80 个 |
| 事件 API | 同上 | `eventOn` / `eventOnce` / `eventMakeLast` / `eventMakeFirst` / `eventEmitAndWait` / `eventRemoveListener` / `eventClear*` |
| 脚本按钮 | `src/function/script.ts` | 脚本可注册按钮（`{name, visible}`），父窗口侧用 `button_map` 聚合 |
| 高度自适应 | `src/iframe/adjust_iframe_height.js` | `ResizeObserver` 观察 body + `frameElement.style.height = scrollHeight`，500ms 节流 |
| 第三方库 | `src/iframe/third_party_message.html` | jQuery / jQuery-UI / touch-punch / Vue / Vue-Router / FontAwesome / tailwind —— **全部从 CDN 拉**；茶馆一律不引入（要就脚本自己引） |
| 世界书 API | `src/function/lorebook.ts` / `worldbook.ts` | 读/建/改/删四条通道；茶馆不开放给脚本（脚本只读结构，见 §5.1 `read.world`） |


**取文件的方法**（本机实测）：
`raw.githubusercontent.com` **可用且不占 API 配额**，优先级高于 `api.github.com`
（未认证只有 60 次/小时，本轮已撞过限额）。
只有**列目录**时才必须用 `api.github.com/repos/<o>/<r>/contents/<path>`。
