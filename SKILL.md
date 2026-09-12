---
name: macro-high-frequency-monitor
description: >-
  Use this skill for China macro monitoring, macro regime assessment, high-frequency
  nowcasting, liquidity and rates tracking, property-cycle reads, inflation and external-demand
  tracking, and macro-vs-market divergence questions. Triggers include 宏观监测、宏观高频、
  宏观六维、增长/消费/地产/通胀/流动性/外需、资金面、利率、期限利差、信用利差、汇率、
  宏观与市场背离、今天中国宏观边际变化。This skill is a configuration-and-interpretation
  layer only: it must not reimplement the scheduler, MCP client, database, dashboard, chart
  engine, or Research Artifact protocol, and it must never compute zscore / percentile /
  change by itself.
---

# China Macro High-Frequency Monitor — 配置与解释层

## 职责边界

本 Skill **不拥有**（Spec §2 / §44）：

- Scheduler —— 归现有定时任务
- MCP Client —— 归 `每日复盘更新/scripts/ifind-mcp-client.mjs`
- 数据库底层 —— 归现有 drizzle + SQLite/D1
- Dashboard 框架 —— 归现有 Next.js 站点
- Chart Engine —— 归项目既有 ECharts 引入
- Research Artifact 协议 —— 归现有 1.0.0 契约
- iFinD 字段字典 —— 归 `lookup_field_reference`

本 Skill **只拥有**：

```text
宏观指标体系语义
指标方向与频率
数据新鲜度判定
标准化与变化的规则定义
宏观信号阈值
异常识别规则
宏观状态解释框架
```

**配置与代码分离铁律**：字段在 `references/indicator_registry.yaml`，阈值在 `references/signal_rules.yaml`。SKILL.md 内**不得**出现字段代码清单或数值阈值。

---

## 何时触发

| 触发场景 | 示例问法 |
|---|---|
| 宏观状态 | 「今天中国宏观边际上发生了什么」「宏观六维怎么样」 |
| 单一维度 | 「地产到底见底没有」「外需还行吗」「资金面紧不紧」 |
| 高频跟踪 | 「铜价和螺纹钢最近怎么样」「猪价走势」 |
| 利率汇率 | 「期限利差什么水平」「人民币汇率分位」 |
| 背离诊断 | 「为什么经济数据在改善但债市不认」 |
| 专题研究 | 「地产是否出现信用周期反转」 |

**不触发**（避免误路由，Spec §50 TEST 12）：

- 个股行情、个股财报 → `earnings-analysis` / `fundamental-review`
- 大盘复盘与板块轮动 → `market-daily-review`
- 单一叙事判断 → `urmylucky-narrative-judgment`

---

## 数据读取顺序（Spec §36）

```text
1. 优先读当日快照 每日复盘更新/public/macro-snapshot.json
      ↓ 缺失或 asOf 落后
2. 读全量观测    每日复盘更新/work/macro/observations.json
      ↓ 缺失
3. 才调用 iFinD（THS_EDB / THS_HQ），且必须按接口批量
```

**禁止**：对每个指标逐个发起独立调用。按 `indicators: "ID1;ID2;..."` 批量（实测单次可承载 60+ 个 ID）。

### 运行方式（已落地，可直接执行）

```bash
cd "C:/Users/urmylucky/Documents/每日复盘更新"

# 密钥：git bash 的 env 读不到 Windows 用户级变量，必须先经 PowerShell 落盘
powershell.exe -NoProfile -Command "[System.IO.File]::WriteAllText('C:\Users\urmylucky\WorkBuddy\macro_key.tmp',[Environment]::GetEnvironmentVariable('IFIND_API_KEY','User'))"
export IFIND_API_KEY=$(cat "C:/Users/urmylucky/WorkBuddy/macro_key.tmp" | tr -d '\r\n')
export IFIND_MCP_BASE_URL="http://219.141.246.230:5223/sse"

MACRO_MODE=daily node scripts/macro-collect.mjs   # daily / release / full
node scripts/macro-snapshot.mjs                   # 评分 / 异常 / 背离 / 期货产业链分析
node scripts/macro-report.mjs                     # 每日汇报（Markdown + 结构化区块）
node scripts/macro-workbench.mjs                  # 自包含工作台（内联汇报 + 数据 + ECharts）
node scripts/macro-smoke-test.mjs                 # 19 项验收（含汇报、显著偏离与可视化面板）
npm run macro:install-skill --check               # 技能包装配体检（不写盘）
```

或一条命令跑完前三步之后的所有环节：`npm run macro:run`（collect → snapshot → report → workbench）。

**配置真源位置**：`references/*.yaml` 随仓库分发在 `.agents/skills/macro-high-frequency-monitor/references/`。
`macro-config.mjs` 按「就近优先」自动定位（`MACRO_SKILL_DIR` 环境变量 → 脚本上级的
`references/` → 仓库内 `.agents/skills/…`），因此**不依赖任何写死的绝对路径，也不依赖 DeerFlow**
（按治理约定 DeerFlow 已 deferred）。装到 Codex 用 `npm run macro:install-skill`，
装完后 `macro-config.mjs` 会就近读到同包内的 `references/`。

产出：
- `public/macro-snapshot.json` —— 快照契约（含 `futures` 块）
- `public/macro-daily-report.md` —— 当日汇报 Markdown（另存 `work/macro/reports/<日期>.md`）
- `work/macro/report.json` —— 汇报的结构化区块，供工作台渲染
- `public/macro-workbench.html` —— 自包含工作台，可离线打开

站点入口：`app/monitor/macro/page.tsx` 以 iframe 嵌入工作台，工具栏提供汇报 Markdown 与原始快照下载。

---

## iFinD 调用契约（实测确认，勿改）

```text
THS_EDB   { indicators: "M002043802;S002808932", begintime, endtime }
THS_HQ    { thscode, jsonIndicator: "close;volume", jsonparam: "CPS:1,Days:Tradedays,Fill:Blank", begintime, endtime }
```

关键坑（详见 `docs/IFIND_FIELD_MAPPING.md`）：

- 郑商所期货后缀是 **`.CZC`**，不是手册写的 `.ZCE`
- 广期所手册未记载，实测后缀是 **`.GFE`**（`GFEX` / `GF` / `GZ` 全部 `-4210`）
- 期货主力**连续合约 `XX00.交易所` 不复权**：`SH00.CZC` 曾卡在持仓量为个位数的僵尸合约，
  且换月当日会产生假跳空（甲醇实测 +11.75% 全是换月价差）。**必须**用
  `scripts/macro-main-contract.mjs` 的 `detectMainContract()` 解析真实主力月份合约，
  再用 `rollAdjust()` 以重叠段中位数比值等比复权拼接。宏观层沿用 `RB00` 等连续保持六维口径，
  期货层一律 `alwaysResolve: true`
- `lookup_field_reference` 对 `THS_HQ` 返回**字段名**而非证券代码，不能用来找标的
- EDB 返回值自带 `time`（观测期）与 `rtime`（发布时刻），**必须分别落库**，不得合并
- 错误码 `-4001` / `-209` / `-4210` 均**不可用相同参数重试**
- **HQ 价格序列里的 `0` 是「当日无成交」哨兵，不是价格**。必须按缺失处理，
  否则已停更的合约（如动力煤主力，2022-12 起全为 0）会被算成 `FRESH` 并污染 zscore

### 方向标签必须与 signal_rules 同步登记

`indicator_registry.yaml` 里每个指标写的 `signal.direction`，**必须在 `signal_rules.yaml → direction_semantics` 有对应 `polarity`**。
未登记的标签会被降级为 `contextual` 并**静默排除出评分**（曾因此丢掉 M2 / 社融整条线）。
`macro-snapshot.mjs` 现会在 `scoringModel.unknownDirections` 中显式上报未登记标签。

**找新字段的方法**（本次最重要的经验）：`lookup_field_reference` 模糊检索召回质量差。正确姿势是**区段扫描**——先用模糊检索锁定一个同族锚点 ID，再对该 ID 所在区段做区间批量实测，用返回的 `index_name` 反查。

---

## Freshness 判定（Spec §13）

按 `signal_rules.yaml → freshness` 执行。核心规则：

> **月频指标在其下一个发布窗口到来前，一律 `EXPECTED`，不得判为 `STALE`。**

例：CPI 最新观测 `2026-08`、频率 monthly → `EXPECTED`。因为 9 月 CPI 还没发布，不是数据陈旧。

日频指标连续多个交易日无更新 → `STALE`。

---

## 解释框架

详见 `references/interpretation_framework.md`。核心约束：

1. **不自己算数**。`zscore` / `percentile` / `d1` / `d5` / `d20` / `WoW` / `MoM` / `YoY` 全部由代码算好，本 Skill 只解释已算好的 signal。
2. **方向由 registry 决定**，不靠模型判断。`lower_is_looser`（DR007）和 `higher_is_tighter`（CPI）语义不同。
3. **频率不可混算**（Spec §16）：日频只用 1D/5D/20D；周频用 WoW/4W/13W；月频用 MoM/YoY/3M trend；季频用 QoQ/YoY。
4. **事实与推断分离**（沿用现有 Research Artifact 约定）。

---

## 输出格式（Spec §40）

写入**仓库内唯一的跨项目契约** `contracts/research-artifact/research-artifact.schema.json`，**不新建协议**。

宏观产物的固定约定（治理层已固化，改这些会让 `npm run macro:test` 失败）：

| 字段 | 取值 | 说明 |
|---|---|---|
| `artifact_type` | `macro_research` | 不是 `macro_high_frequency_monitor`（旧写法已废弃） |
| `provenance.orchestration_mode` | `direct_research_os` | V1.1 直接由 Research OS 生产，无外部编排器 |
| `provenance.orchestrator` | `null` | DeerFlow 已 deferred，不得作为运行时依赖 |
| `provenance.project_owners` | 含 `analyst-dream-team` | 宏观路由归属 |

必填字段还包括 `artifact_id / title / as_of / generated_at / subject / request / facts /
conclusions / sources / quality / provenance`，完整清单见 schema。

```bash
npm run macro:test           # 离线契约校验（contracts/research-artifact/examples/macro.json）
npm run artifact:validate    # 校验实际产出的 artifact
```

参考实现：`contracts/research-artifact/examples/macro.json`。

Daily Brief 控制在 **300~600 中文字**，结构固定为：

```text
今日变化 → 主要驱动 → 跨资产验证 → 潜在矛盾 → 明日/本周关注
```

### 每日汇报（规则生成，不由模型写）

`scripts/macro-report.mjs` 已把快照编排成 21 个章节的固定结构汇报，输出
`public/macro-daily-report.md`（另有归档 `work/macro/reports/<日期>.md`）与
`work/macro/report.json`（工作台「每日汇报」面板消费）。它是**纯规则拼装**：
筛选、排序、四舍五入、措辞模板全部由代码完成，阈值集中在该文件顶部的 `THRESH` 常量里，
不含任何模型生成内容。

章节结构（宏观市场层在前、期货层在后）：

```text
摘要 → 今日显著偏离
  → 宏观六维状态
  → 利率与资金面 / 权益与汇率 / 货币与信用 / 增长与景气 / 通胀 / 地产 / 消费与外需
  → 指标极值 → 跨资产背离 → 重点异常
  → 期货产业链总览 / 领涨领跌 / 产业链深读 / 主力价差 / 链内传导信号
  → 全指标总表（附录）→ 观察清单 → 数据质量与口径
```

### 「今日显著偏离」章（回答「今天什么变了、变得离不离谱」）

排在第 2 章（紧随摘要），先给**结论句**，再分**上涨侧 / 下跌侧**两张榜（各 6 项），
其后**月频 / 季频单独成表**（标注「观测期不一定是今天」），末尾给**加注口径说明**。

判定的核心量是 `chg1Extreme`（在快照层算好）：本期 `|1 期变化|` 落在**该指标自身近 3 年
全部单期 `|变化|` 分布**中的分位。**为什么不用 `z1y`**：`z1y` 说明的是「现在位置高不高」，
回答不了「今天这一下变化大不大」—— 一个指标可以位置很中性、今天却跳一记大变化。

| 判定 | 阈值 | 措辞 |
|---|---|---|
| 当日偏离 | `chg1Extreme ≥ 0.90`（前 10%） | `变化显著` |
| 极端 | `chg1Extreme ≥ 0.97`（前 3%） | `变化极端` |
| 双极端 | `chg1Extreme ≥ 0.90` 且 `|z1y| ≥ 2` | `变化+位置双极端` |
| 位置 | `pct1y ≥ 99%` / `≤ 1%` | `刷一年新高` / `刷一年新低` |
| 期货持仓 | `|oiChg5| ≥ 30%` | `持仓放大` |

**两条口径纪律**：

1. **涨跌按原始方向**标注，不做方向校正 —— 这一章回答的是「涨跌」，不是「好坏」。
2. **双层去重**：宏观层有一批「XX主力」期货收盘价指标（沪铜主力 / 原油主力 / 铁矿石主力…），
   与期货层是同一标的。归一化（去掉末尾「主力」后比对品种名）后**只保留期货层**
   （它带持仓量与产业链分组），避免同一行情上榜两次。

**加注口径**：所有阈值集中在 `macro-report.mjs` 顶部的 `THRESH` 常量
（`chgExtreme` / `chgExtremeStrong` / `deviationTop`），改口径只改这一处。

**宏观市场层**是按注册表 `category` 分板块的逐指标表，回答「每个具体指标现在什么水平、过去一年怎么走的」，
与六维的「经济方向好不好」互补。每张表包含：最新值、1/5/20 期变化（**自带单位**）、
近一年 Unicode 迷你走势、1 年分位、z 与方向校正后 z。

变化单位按指标性质分流，不可混用（否则会把「收益率上行 2bp」写成「+1.2%」）：

| 指标性质 | 变化单位 | 例 |
|---|---|---|
| 收益率、资金利率（`rates`/`liquidity`） | **bp** | 10Y `-2.4bp` |
| 其他百分比类（CPI/PPI/M2/同比） | **pp** | CPI `+0.30pp` |
| 股指（`risk`） | **%** | 沪深300 `-2.48%` |
| 其他指数（PMI/BDI/景气） | **点** | PMI `+0.6点` |
| 价格、金额 | **%** | 铜 `+0.55%` |

**边界**：汇报是可复核的「事实层」。模型的职责是在其上做 `今日变化 → 驱动 → 验证 → 矛盾 → 关注`
的解释（即上面的 Daily Brief），**不得改写或重算汇报里的数字**。

### 快照的 `indicators` / `categories` 块

`macro-snapshot.mjs` 除评分外，还输出全指标总表供报告与工作台共用（Spec §37：不在前端重算）：

- `indicators[]` —— 全部 72 项指标的 `latest / changes{chg1,chg5,chg20,chg12} / pctChg* / z1y / dirZ / pct1y / pct3y / status`，
  以及 `layer`（official / highfreq / market）、`category`、`polarity`
- `categories{}` —— 按注册表 `category` 的分组索引（11 组：growth / sentiment / consumption / property /
  inflation / credit / liquidity / rates / fx / risk / external）
- `trends[]` —— 新增 `category`、`pct1y`、`importance` 字段

### 工作台的图表面板

`public/macro-workbench.html` 现有 **20 张 ECharts 图 + 115 条 SVG 迷你走势**，全部离线内联。
模板真源是 `templates/macro/workbench.template.html`（**源码，受 git 跟踪**；早前放在
gitignore 的 `work/` 里，导致新克隆只能看到 2 MB 的生成结果、改不动也看不懂 —— 已迁出）。

**走势类（支持滚轮缩放 / 滑块平移 / 图例开关 / 右上角存图）：**

| 面板 | 内容 |
|---|---|
| 宏观市场走势 | 资金利率（原始值）、权益指数（归一化）、人民币汇率、大宗与高频商品（归一化）；区间 3M/6M/1Y/2Y |
| 宏观基本面走势 | 通胀、货币与信用、景气调查、地产、消费与外需、工业与利润 6 张月频折线；区间 2/3/5 年/全部 |
| 国债收益率曲线 | 1Y/3Y/10Y/30Y 近 260 个交易日 |
| 单品种走势 / 单指标趋势 | 下拉切换 + MA20 + 缩放 |
| 主力价差走势 | 6 条价差（快照 `futures.spreads[].points`，近 300 个共同交易日） |
| 异动一览 | 方向校正后 z 的背离条形图（右红=扩张有利，左绿=不利），条数可切 |

另有「宏观指标总表」（72 项，板块/维度筛选 + 4 种排序 + 行内迷你走势）。

**点击联动（跨面板跳转）：**
- 点异动榜 / 指标总表 / 异常清单任意一行 → 自动滚到「单指标趋势」并画出该序列
- 点期货领涨领跌任意一行 → 跳到「单品种走势」
- 点主力价差列表任意一行 → 切换上方价差走势图

迷你走势一律只取**近一年**（日频 250 点），与「1 年分位」口径对齐；着色只表示首尾方向
（涨红跌绿），不表示对宏观的利弊；悬停有原生 `<title>` 显示区间起止与涨跌幅。

图表图例使用 `LABELS` 硬编码短名 —— 注册表里大量指标名以「当月同比/累计同比」结尾，
直接截取末段会让同一张图出现 4 个相同的图例。

### 工作台的两个渲染级大坑（都会表现为「一堆面板里没有图」）

1. **`var` 提升陷阱**：JS 的 `var` 声明会提升、**赋值不会**。`PALETTE` / `MKT_CHARTS`
   原本声明在文件中部，而「主力价差图」在更早的位置就调用了折线绘制函数 →
   读到 `undefined` 抛 TypeError → **整个渲染脚本被中断**，后面 12 个面板的图全部画不出来，
   且页面不报任何可见错误。**修法**：这两个声明已提到脚本最顶部（`var CATS` 之后）。
   Smoke Test **Check 17** 会对「依赖变量赋值必须早于第一次折线绘制调用」做静态复检。
2. **ECharts 在 0×0 容器里初始化**：容器尺寸为 0 时初始化会画出 0×0 的 canvas，
   之后容器变大也不会自己重画（iframe / 折叠面板 / 预览面板 / 窄屏下最常见）。
   **修法（三层防御，不要再打单点补丁）**：
   - **自检必须查 canvas 像素**，不能只查容器。`chartDiag()` 读 `canvas.width/height`，
     按 `devicePixelRatio` 折算后与容器比对，`< 0.9×` 即判废图 —— 只看容器尺寸
     根本抓不到「容器有宽高、canvas 却是 0×0」这个 case。
   - **每个图登记重画入口**：`RENDERERS[nodeId]` 表，`drawLine()` / `mk()` 均登记；
     `window.__macroRedraw__()` 一键重画全部；`mk()` 重画前先 `dispose` 旧实例，避免重复 init 泄漏。
     两个绘制函数都包 `try/catch`，**单图失败不再中断整页**。
   - **四重触发兜底**：`ResizeObserver` + `IntersectionObserver` + `visibilitychange`
     + `[400, 900, 1800, 3200]` 多时间点 `resize()`。顶部徽标常显自检结果，右下角可展开完整诊断面板。

   实测（`scripts/macro-diag-render.mjs`，Edge 无头）：`normal` 与 `hidden`
   （先 `display:none` 1.5 秒再显示，复现预览/折叠场景）两种场景均 **20/20 有 canvas、0 个 JS 错误**。

   **不要用 `var` 在脚本中部声明依赖变量**：`var` 声明提升、**赋值不提升**，
   依赖它的函数在更早位置调用就会读到 `undefined` 抛 TypeError，并**中断整页渲染**，
   而页面不报任何可见错误（空面板是唯一症状）。Smoke Test **Check 17** 做静态复检。

### 站点入口与构建产物

- 首页侧边栏有「**宏观高频监测**」入口（`<a class="modLink" href="/monitor/macro">`），
  `globals.css` 已把 `aside>a.modLink` 并入原有 `aside>button` 选择器组，三个主题块与移动端断点都适配。
- **`npm run build` 在 Windows cmd 下会直接失败**（脚本带 `WRANGLER_LOG_PATH=... ` Unix 环境变量前缀）。
  Windows 上请用：`WRANGLER_LOG_PATH=.wrangler/wrangler.log npx vinext build`
- `build/sites-vite-plugin.ts` 已改为**内容比对 + 覆盖写入**：原实现每次构建都对
  `dist/.openai`（60+ 个 drizzle 迁移）先整目录递归删除再拷贝，在带批量删除保护的
  沙箱里会触发 `SAFE_DELETE_BULK_CONFIRM_REQUIRED`，而且 `closeBundle` 对每个构建
  环境各跑一次，必然触发 —— 此时 `dist/client` 已被清空，等于把线上产物砸掉。
  **遇到该报错不要去手删 `dist/.openai`**，先确认插件版本已更新。

---

## 何时交给 DeerFlow 深度研究（Spec §38）

```text
常态：Data Pipeline → Dashboard            （不调用 LLM）
异常：Data Pipeline → RESEARCH_CANDIDATE → DeerFlow → 研究解释
```

触发条件见 `signal_rules.yaml → escalation`。**不是每个数据点都找 LLM。**

Sub-Agent **默认不用**（Spec §35）：V1 走 `Lead Agent + 数据 Artifact + 一次综合解释`。仅专题研究（如「地产信用周期反转」）才启用多 Agent 并行验证。

---

## 当前已知边界

- **盈利预测一致预期不可用**：手册明示 `ths_west_*` / `ths_pred_*` 均返回 `-209`。因此「预期差」类分析**不得作为 V1 设计前提**。
- **核心 CPI 未检索到**，以 `CN_CPI_NONFOOD` 代理。
- **固定资产投资 / 制造业投资 / 基建投资 / 新增贷款** 4 项总量指标 ID 待补（见 registry `pending_lookup`）。
- **6 项第三方高频数据**（高炉开工率、轮胎开工率、30 城成交、土地成交、票房、地铁客运）iFinD EDB 不覆盖，判定 `NO_FIELD`。
- **`HF_THERMAL_COAL`（动力煤主力 `ZC00.CZC`）已停更**：最后有效观测 2022-12-30，之后全为 0 哨兵值。
  系统自动判定为 `DISCONTINUED` 并排除出评分，无需人工干预。
- **六维权重为 DRAFT**，未回测，不得用于下注决策。解除 DRAFT 需要先在 `work/macro/snapshots/` 累积足够的每日分数序列。

---

## 与其他模块的边界

- **不改** `scripts/update-snapshots.mjs`（63 KB 的 A 股收盘主链路）。宏观采集单独成脚本，
  避免把故障域放大一倍。Smoke Test 12 专门校验这条边界。
- 时序表 `macro_observations` 的 schema 已建（`db/schema.ts` + `drizzle/0002_slow_viper.sql`），
  但 D1 绑定仅在 Cloudflare 运行时可用，**本地落库通道尚未接通**，当前数据源是 `public/macro-snapshot.json`。

---

## 分发与安装（这份方案怎么被别人读到 / 装到别的 agent 里）

本方案由两半组成，在仓库里分开放：

| 层 | 位置 | 谁读 |
|---|---|---|
| 知识层 | `.agents/skills/macro-high-frequency-monitor/`（SKILL.md + references/*.yaml） | 模型（ChatGPT / Codex） |
| 代码层 | `scripts/macro-*.mjs` + `templates/macro/workbench.template.html` | 人 / npm / 定时任务 |

```bash
npm run macro:check-skill     # 装配体检：清单齐备、无死路径、注册表可解析
npm run macro:install-skill   # 装到 ~/.codex/skills/macro-high-frequency-monitor
node scripts/macro-install-skill.mjs --with-data    # 附带最新快照与日报，离线可答
node scripts/macro-install-skill.mjs --target <dir> # 装到别处
```

安装后 `macro-config.mjs` 按「就近优先」自动读到同包内的 `references/`，**无需改任何路径**。

**要在仓库里改动本方案**：按 `docs/DEVELOPMENT_WORKFLOW.md` 走
（`git switch -c codex/<task>` → 改 → `npm test` / `npm run lint` / `npm run governance:validate`
→ PR → 合并），GitHub 是 Skills 与治理文档的规范来源。

---

## 参考文件

| 文件 | 内容 |
|---|---|
| `.agents/skills/macro-high-frequency-monitor/MANIFEST.md` | 方案组成地图 + 数据流 + 待完善清单（**接手先读这页**） |
| `references/indicator_registry.yaml` | 指标语义、频率、iFinD 码、变换、方向、图表配置（参与六维评分） |
| `references/futures_chains.yaml` | 期货全品种产业链分层、7 条链 61 个品种、交易所后缀勘误（**不参与评分**） |
| `references/signal_rules.yaml` | 标准化阈值、方向 polarity、六维权重、异常触发、背离规则、新鲜度 |
| `references/interpretation_framework.md` | 解释框架与输出范式 |
| `docs/IFIND_FIELD_MAPPING.md` | 字段实测证据与踩坑记录 |
| `docs/MACRO_REUSE_INVENTORY.md` | 复用盘点与改动清单 |
| `docs/MACRO_IMPLEMENTATION_REPORT.md` | 实施报告（含四轮缺陷修复记录） |
| `docs/MACRO_TO_CODEX.md` | 方案进仓库 → ChatGPT 读 → 装到 Codex 的操作手册 |
| `scripts/macro-collect.mjs` | 采集层（full/daily/release 三模式 + 增量合并 + 期货层） |
| `scripts/macro-main-contract.mjs` | 主力合约解析与换月等比复权 |
| `scripts/macro-snapshot.mjs` | 评分与信号层（纯代码算数，含 `chg1Extreme`） |
| `scripts/macro-futures.mjs` | 期货产业链分析（链级中位数 / 价差 / 传导信号） |
| `scripts/macro-report.mjs` | 每日汇报生成器（21 章节，纯规则拼装，阈值在 `THRESH`） |
| `scripts/macro-workbench.mjs` | 工作台构建器（数据与 ECharts 内联） |
| `scripts/macro-smoke-test.mjs` | 19 项验收（含汇报、显著偏离与可视化面板） |
| `scripts/macro-install-skill.mjs` | 技能包装配与安装 |
