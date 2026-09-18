# 茶馆 × 酒馆（SillyTavern）机制对位与差距

> 用途：回答「我们跟酒馆差在哪、哪些已对齐、哪些是空白」。
> 依据：酒馆官方文档、`N0VI028/JS-Slash-Runner`（1027★，酒馆前端渲染的实际依赖）、
> DeepWiki 对 regex 扩展的源码级拆解。**改动前先读这一页。**
>
> 状态：**2026-09-18 更新** —— 第 2、3 节的缺口已落地，见第 6 节分期与状态。
>
> 合规前提：酒馆是 **AGPL-3.0（传染性强）**，本项目**只取设计思路，代码全部自写**，
> 任何一处参考都在注释里写明出处。

---

## 1. 已对齐酒馆的部分

| 能力 | 茶馆实现 | 对齐程度 |
|---|---|---|
| 世界书关键词触发注入 | `src/worldbook.js` | 字段对齐 CharacterBook V2 |
| 副键四套逻辑 | `secondaryLogic`：and-any / and-all / not-any / not-all | ✅ 与酒馆同名同义 |
| 注入位置 | `position`：before-char / after-char / top-an / bottom-an / at-depth | ✅ 对齐 |
| 注意力度 | `depth`（越小越靠后越受注意）+ `order`（越大越靠下） | ✅ 对齐 |
| 触发概率 | `probability` 0–100 | ✅ |
| 递归触发 | `recursive` | ✅ |
| 提示词栈 | `src/prompts.js`：{id,name,role,content,enabled,order}，preset 可导入 | ✅ 对齐 Prompt Manager |
| 上下文预算 | `src/context.js`：token 估算 + 摘要 + 裁剪 | ✅ |
| 群聊发言者策略 | `src/freechat.js`：natural / list / manual + 上一位不再接话 | ✅ 对齐 activation_strategy |
| persona 位置 | `src/freechat.js`：in-prompt / top / bottom / at-depth + role | ✅ 对齐 |

---

## 2. 缺口一：正则作用点 —— **已补齐（2026-09-18）**

> ⚠️ **本节曾被两次写错，最后以 GitHub 源码为准。**
> 社区教程（含博主视频）普遍讲成"四个作用点选一"，读源码才知道**不是**。

读 `JS-Slash-Runner/src/function/tavern_regex.ts` 得到酒馆正则的**真实数据模型**：
它是 **source × destination 的二维矩阵**，两个维度正交、各自可多选：

```
source（这段文本从哪来）      destination（结果送去哪）
  user_input  玩家输入          display  只改渲染
  ai_output   模型输出          prompt   进提示词
  slash_command / world_info / reasoning
```

- `destination.display = true` → 走渲染层，**不进上下文**（格式显示的真身）
- `destination.prompt  = true` → 进提示词，**改模型看到的东西**

**关键**：一条规则可以同时挂 `display` 与 `prompt`，也可只挂其一。
「格式显示」不是第四个"作用点"，而是 **destination 维度上的一个取值**。
社区说的 `editdisplay`，源码里是 `destination: { display: true }`。

**前端卡 token 安全的根本**就是：**只开 `display`、不开 `prompt`**。
博主警告的"选错导致 HTML 塞进上下文"，根因是把 `prompt` 也打开了。

**茶馆现状（已实现）**：`src/regex.js` 已改为同构的二维：
`source: { input, output }` × `destination: { display, prompt }`，
四个出口 `applyOutbound / applyInbound / applyDisplayOutbound / applyDisplayInbound`。
旧数据（`scope: 'in' | 'out' | 'both'`）走**读时映射**，不硬迁移；
设置面板给出两个复选框组（「作用」/「送往」），玩家能直接勾出
"只改渲染、不进提示"的规则。

### 与酒馆的**有意差异**

酒馆的 source 维度还有 `slash_command / world_info / reasoning` 三项。
茶馆**不实现**：这三者在茶馆没有对应物 ——
引擎不把世界书文本交给正则改，也没有 slash 命令层。
硬加会造出永远匹配不到的开关（本项目栽过"静默降级"的坑，宁可少而实）。

### 源码里的完整规则字段（`TavernRegex` 类型）

```ts
{ id, script_name, enabled,
  find_regex, trim_strings[], replace_string,
  source: { user_input, ai_output, slash_command, world_info, reasoning },
  destination: { display, prompt },
  run_on_edit, min_depth, max_depth }
```

还注意到两处细节：
- **`formatAsTavernRegexedString(text, source, destination, {depth})`** —— 
  公开 API 也是 source/destination 两个参数，印证二维模型。
- `trim_strings` 是**在替换前先从匹配内容里剔掉**的字符串数组（酒馆 UI 的 "Trim Out"）。
- `destination === 'display'` 时传 `isMarkdown: true`，`'prompt'` 时传 `isPrompt: true` ——
  同一个正则**在两个目标下行为可以不同**。
- 另有 **scope 三档**：Global（存 settings）/ Character（存角色卡 extensions）/
  Preset（存预设）。茶馆导入器已支持这三种来源的解析，但只落一处（全局 settings）。

---

## 3. 缺口二：前端卡渲染层（完全没有）

酒馆的「前端卡」不是正则单打独斗，它还依赖一个独立扩展
**JS-Slash-Runner（酒馆助手）**，由它提供：

| 它提供的能力 | 源码位置 | 说明 |
|---|---|---|
| iframe 渲染 | `src/iframe/`、`src/function/displayed_message.ts` | 原生楼层不支持 `<button>` 等，靠 iframe 渲染完整 HTML/CSS/JS |
| 前端判定 | `src/util/is_frontend.ts` | **只认三个字符串**：内容含 `html>` / `<head>` / `<body` 即当界面渲染 |
| 变量系统 | `src/function/variables.ts` | 五层作用域 + zod schema |
| 世界书操作 | `src/function/lorebook.ts`、`worldbook.ts` | 读 / 建 / 改 / 删 |
| 提示词注入 | `src/function/inject.ts` | 覆盖或追加 |
| 正则对位 | `src/function/tavern_regex.ts` | 即上文的 source×destination |

### ⚠️ 纠正："iframe 沙箱"是误读，它其实是**能力桥接**

我原先写"用 iframe 隔离以降低风险"——**读 `src/iframe/predefine.js` 后确认恰恰相反**。
它在 iframe 内执行：

```js
_.merge(window, _.pick(window.parent, ['EjsTemplate','TavernHelper','YAML','showdown','z']));
_.merge(window, _.omit(window.parent.TavernHelper, '_bind'));
Object.defineProperty(window, 'SillyTavern', { get: () => window.parent.SillyTavern });
```

即**主动把父窗口的整套 API 桥进 iframe**：`SillyTavern.getContext()`、`TavernHelper`
（含世界书 / 变量 / 注入 / 事件 / 音频的全部函数）都能直接调。
iframe 在这里的作用是**让 iframe 里的脚本能反过来操作酒馆**，不是把它关起来。

对茶馆的启示：**想靠"嵌套一个 iframe"来防住 AI 产出的脚本，是防不住的** ——
只要桥了 API，脚本就能拿到一切；不桥 API，前端卡也就没有能力（读不到状态）。
**安全边界不在沙箱，在"允不允许任意 JS"这个决策上**。

### 茶馆的选择：不跑模型产出的代码，只渲染模型产出的**值**

茶馆**没有**渲染层 / 变量系统 / 模板引擎，而且**有意不要**。
它走的是另一条路（`src/card.js`，2026-09-18 落地）：

```
模型产出                    引擎行为
────────────────────────────────────────────────
[状态栏]
好感 = 34                   → 渲染成 .ne-card.ne-card-stats
信任 = 1 / 10                 分数自动拆成当前/上限，画成进度条
[/状态栏]

[签:疲惫]                    → 渲染成 .ne-tag
[条:精神|6|10]               → 渲染成 .ne-inline-bar（60% 宽）

[注意]…[/注意]               → 不认识的区块，**原样当文字**（绝不吞）
```

**为什么不做 HTML 渲染**：茶馆的第一条硬约束是「所有条件可判定」。
把执行权交给模型产出的 JS，等于引擎放弃判定 ——
而这个项目的状态是引擎持有的，模型只提申请。
**声明式渲染下，模型能表达的只是"这些数值"，怎么画由引擎定。**

**边界要说清**：这是**能力形状**上的差异，不是"更安全"的自夸。
模型不能画任意界面（酒馆能），换来的是一张可以写测试、可以静态检查的渲染层
（`test/card.test.js` 15 项，含"未知标记必须原样保留"）。

---

## 4. 缺口三：拟人化「保障」层

酒馆博主（蓝色微笑）讲的方法论 —— 一语双关的时机、用「低头/脸红」等动作
引导害羞而非直写 —— **本质是内容层写法，不是引擎机制**。

茶馆的落地位置是：写成**世界书条目 / 角色卡文案**，引擎负责在关键词命中时
把那条注入上下文。**引擎不生产、不保障、也不判断「此刻该不该用双关」** ——
那由模型在自由对话里自行决定。

结论：这不是「缺功能」，是「职责边界不同」。要补也应补**模板与规范文档**，
而不是引擎规则。

---

## 5. 架构差异（根本原因）

| 维度 | 酒馆 | 茶馆 |
|---|---|---|
| 状态权威 | 无，全在模型与 prompt | **引擎持有权威状态**，模型只能申请 |
| 主线推进 | 模型自由生成 | 事件驱动：local → auto → model 三源 |
| UI 数据来源 | 正则反解析 AI 文本 | **引擎状态直驱**（确定性） |
| 前端卡 | 核心玩法之一 | 只在自由对话下才有意义 |
| 确定性 | 不确定（同输入不同输出） | 可判定、可测试、可回归 |

**关键推论**：因为茶馆 UI 由引擎状态直驱，事件驱动模式下**不需要**
「AI 输出结构化文本 → 正则反解析 → 渲染」这条链，前端卡在那里是重复造轮子。
只有在**自由对话 / 群聊**（模型主生成）下，反解析才有存在理由。

---

## 6. 分期与落地状态（**2026-09-18 更新**）

- **✅ 阶段 0**｜`src/regex.js` 补 **`destination` 维度**（不是"四作用点"）。
  已实现：`source { input, output }` × `destination { display, prompt }`，
  旧 `scope` 读时映射。设置面板给出两个复选框组。
- **✅ 阶段 1**｜卡片渲染层：落在 **`src/card.js`**（不是 `ui/cardrender.js`）。
  实现与建议不同的一点：**不用 HTML 模板 + sanitize，改用 `createElement` + `textContent`**
  —— 全程不碰 `innerHTML`，从根上不存在"注入"这个面。声明式组件见第 3 节。
- **✅ 阶段 2**｜安全模型**已决策**：走**声明式白名单**（原推荐项），
  不桥 API、不跑模型产出的 JS。源码已证明"用 iframe 就安全"是假的。
- **⏳ 阶段 3**｜变量系统：酒馆是五层作用域 + zod 校验。
  茶馆的对应物是**暴露引擎 state 只读快照** —— 比从文本反解析可靠得多，
  但**尚未实现**：目前卡片只能显示模型自己写出的值，不能读引擎真值。
  这是卡片能力上最大的一块空白。
- **✅ 阶段 4**｜卡片只在自由对话 / 群聊路径落地（`freeNode` / `narratorNode`），
  事件驱动主线不碰 —— 与建议一致。

**还没做的**：没有任何内容层产出卡片标记（`data/` 里搜不到 `[状态栏]`）。
也就是说渲染层就绪，但**喂给它的数据源还不存在**；
现阶段卡片只会在模型自发输出结构化值时出现。

**另记一条可借鉴的实现细节**：酒馆助手的"这段是不是前端界面"判定**极简** ——
`is_frontend.ts` 只检查内容里有没有 `html>` / `<head>` / `<body` 三个字符串之一。
不做解析、不要求完整 HTML。这比想象中粗糙，但够用，代价是误判风险。

---

## 7. 一句话总结

**世界书与提示栈：已对齐酒馆。正则：已补上 `destination` 维度
（`display` / `prompt` 双目标），前端卡的 token 安全前提成立。
前端卡渲染层：已落地，走声明式组件（不跑模型产出的 JS），
但**还没有内容层喂数据**、也还不能读引擎真值（阶段 3 未做）。
拟人化：属内容职责，不做成引擎规则。**

---

## 8. 源码调研记录（可复查）

| 事项 | 来源 | 结论 |
|---|---|---|
| 正则真实模型 | `JS-Slash-Runner/src/function/tavern_regex.ts` | **source × destination 二维**，非"四作用点" |
| 公开 API 签名 | 同上 `formatAsTavernRegexedString(text, source, destination, opts)` | 两参数印证二维 |
| 规则字段 | 同上 `type TavernRegex` | 含 `trim_strings` / `run_on_edit` / `min_depth` / `max_depth` |
| 变量作用域 | `src/function/variables.ts` | 五层：global / preset / character / chat / message |
| 变量校验 | 同上 `registerVariableSchema` | **zod schema**，按作用域注册 |
| iframe 真相 | `src/iframe/predefine.js` | **桥接父窗口 API**，不是隔离 |
| 前端判定 | `src/util/is_frontend.ts` | 只查 `html>` / `<head>` / `<body` 三串 |
| iframe 预置库 | `src/iframe/third_party_message.html` | jQuery / jQuery-UI / Vue / Vue-Router / tailwind / FontAwesome |

**方法**：`api.github.com` 列目录（`/contents/<path>`）+ `raw.githubusercontent.com`
取文件。两者均直连可用，不必走连接器 MCP 绕道。

**合规**：酒馆与 JS-Slash-Runner 均为 **AGPL-3.0**。本页只记**设计思路与接口形状**，
不含其源码实现；本项目任何相关改动须自写。
