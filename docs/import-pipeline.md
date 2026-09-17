# 导入链路分层说明

> 用途：回答一个具体问题 —— **导入到底是"三合一接口"还是"分接口到不同层"？**
> 结论：**一个解析入口、三条互不相同的落地通道**。分类在**解析时**就生效，
> 不是事后过滤。下面把每一层写清楚，改动前先读这一页。

---

## 1. 两个入口

| 入口 | 位置 | 分区/步骤 |
|---|---|---|
| 启动页 → 立即开始 | `openWizard`（ui/app.js） | ① 导入世界书 · ② 导入角色卡 · ③ 配置环境 |
| 主界面顶栏 → 导入 | `openImport`（ui/app.js） | 世界书 / 角色卡 / 模式（预设） |

两个入口共用同一个解析函数与同一套落地逻辑，差别只在 UI 形状：
向导是线性三步（每步只接受一种分类），导入面板是三个可切换分区。

---

## 2. 三层结构

```
① 取内容      parseImportFile(file, expect)         ui/app.js
                  ├─ PNG  → importPngCard()          src/importers.js
                  └─ JSON → importAs(raw, kind)      src/importers.js
                                    └─ detectKind()  →  CHARACTER / WORLDBOOK / PRESET / UNKNOWN

② 解析        importCharacterCard() / importWorldbook() / importPreset()
              统一产出 { kind, ..., warnings[] }

③ 落地        applyCharacterImport() / applyWorldbookImport() / applyPresetImport()
              （主界面导入面板）
              或 createRainWorld/startMain 的 bootImports 循环（向导）
```

**关键点：分类是解析层的入参，不是事后过滤器。**

`importAs(raw, expect, expectLabel)` 先 `detectKind(raw)` 拿到真实分类，
与 `expect` 不一致就直接返回 `{ kind: UNKNOWN, warnings: ['当前分类是「角色卡」，
但这份内容是「世界书」—— 切到对应分类再导入'] }`，**不返回一份"能用"的结果**。

这条是硬约束（见项目 MEMORY「校验不静默通过」）：曾经向导三步共用一个
`importAny`，粘错类型会显示"已读到"，然后被 `commit()` 静默丢弃。

---

## 3. 三条落地通道：落到哪个字段、谁消费

| 分类 | 解析函数 | 落到哪一层 | 谁消费 |
|---|---|---|---|
| **世界书** | `importWorldbook` | `world.book`（`createWorldbook(entries)` 重新过一遍校验） | `director.loreFor()` → `scanWorldbook()` 按关键词命中注入；右侧书架「世界书」 |
| **角色卡** | `importCharacterCard` | `state.actors[id]`（`store.commit`）+ `world.actorLabels` / `world.statLabels`；内嵌 `character_book` 一并进 `world.book` | 引擎侧：`actors[id].stats` 参与条件判定与 effects；UI 侧：左抽屉人物卡、右书架「人物书」 |
| **预设** | `importPreset` | `presetOverrides`（模块级，采样参数）+ `presetSystemPrompt` + `world.presetSystemPrompt` | `createClient({ ...config, ...presetOverrides })` 覆盖采样参数；`director` 把 `world.presetSystemPrompt` 拼在系统提示词**最前面** |

三者**互不覆盖**：世界书进 lore 池，角色卡进状态层，预设进模型调用参数。
这就是"分接口到不同层"的含义 —— 它们从来不是同一件事的三种写法。

### 3.1 向导的暂存与落库

向导不直接写 `world` / `store`（那时还没建世界）：

```js
const imports = { worldbook: [], characters: [] };   // 暂存
btnNext / btnSkip → commit();                        // 按当前步的分类收进 imports
onDone() → startMain(host, { bootImports: imports }) // 建世界之后统一落库
```

`startMain` 里的落库与 `apply*Import` 是**同一套语义**，只是时机不同。

---

## 4. 分类判定规则（`detectKind`）

按顺序，先命中先返回：

1. `prompts` 是数组 **且** 有 `temperature` / `openai_max_tokens` → **预设**
2. 有 `entries` → **世界书**（放前面，否则带 name 的世界书会被角色卡抢走）
3. `spec === 'chara_card_v2'` 或 `data` 是对象 → **角色卡**
4. 有 `name` 且有 `first_mes` / `description` → **角色卡**（V1）
5. `prompts` 是数组，或有 `system_prompt` 字符串 → **预设**（次级判定）
6. 其余 → **未知**（如实报"认不出"，不猜）

PNG 只可能是角色卡；分类不是角色卡时直接提示"切到「角色卡」再导入"。

---

## 5. 认不出与读不动的东西

- 不认识的顶层字段 → 原样留在 `meta.extensions` / `meta.extra`，**不丢**
- 空正文的世界书条目 → 跳过，但在 `warnings` 里逐个报 id
- 压缩的 iTXt 角色卡 → 明确报"当前不支持解压，请改用 JSON 导出"
- `warnings` 一律显示在预览区，不吞

---

## 6. 常见误判与排查

| 现象 | 原因 |
|---|---|
| 「模式（预设）」分区报"认不出这是什么格式" | `importAny` 漏 PRESET 分支（已修，见 commit `596d3a6`） |
| 向导某一步粘了内容、下一步却什么都没发生 | 粘的分类与当前步不符 —— 预览区会有一行提示，别忽略 |
| 世界书导进去了，但模型没读到 | 世界书是**按关键词命中**注入的：`keys` 没被最近的发言/正文提到就不会进上下文。常驻条目要设 `constant: true` |
| 角色卡导入后数值是"信任/情绪/戒备"三项 | 角色卡本身不带数值系统，这是 `DEFAULT_STATS` 的兜底，可在数据里改 |
| 预设导入后系统提示词没变化 | 预设里只有 `enabled: true` 且 `role: system` 的段会被取用；其它段会被跳过并报"跳过 N 段" |
