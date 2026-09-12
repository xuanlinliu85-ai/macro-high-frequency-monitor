# 中国宏观高频监测（Macro High-Frequency Monitor）

把中国宏观的**高频数据**变成可复核的**每日结论**：69 项宏观指标 + 61 个期货品种，
经纯代码算出六维评分、异常、背离与**当日显著偏离**，输出一份规则化的每日汇报和一个可离线打开的可视工作台。

这是一个**独立仓库**，不依赖任何其它项目。克隆下来即可运行，也可以直接作为 agent 技能加载。

**仓库地址**：<https://github.com/xuanlinliu85-ai/macro-high-frequency-monitor>

> 让 ChatGPT / Codex 读懂并改进本方案 → 读 [`docs/USING_WITH_AI.md`](docs/USING_WITH_AI.md)（含可直接照抄的开场白）。

---

## 30 秒看懂

```text
iFinD (THS_EDB / THS_HQ)
   ↓  scripts/macro-collect.mjs    → work/macro/observations.json     全量观测（不落库）
   ↓  scripts/macro-snapshot.mjs   → public/macro-snapshot.json       快照（含 futures 块）
   ↓  scripts/macro-report.mjs     → public/macro-daily-report.md     21 章节日报（纯规则拼装）
   ↓  scripts/macro-workbench.mjs  → public/macro-workbench.html      自包含工作台（离线可开）
```

**唯一的铁律**：`zscore` / `percentile` / `change` / 维度分 / 异常判定**全部由代码计算**，
模型只负责解释已经算好的 signal。**任何在解释层重算数字的改动都是破坏性改动。**

---

## 这个仓库怎么读（给模型 / 接手的人）

| 顺序 | 文件 | 为什么读它 |
|---|---|---|
| 1 | `MANIFEST.md` | **先读这页**：方案由什么组成、数据流、代码文件地图、待完善清单 |
| 2 | `SKILL.md` | 技能定义：触发场景、调用契约、解释框架、口径纪律（agent 靠 frontmatter 路由到它） |
| 3 | `references/indicator_registry.yaml` | 指标语义、频率、iFinD 码、方向、图表配置（**配置真源**） |
| 4 | `references/signal_rules.yaml` | 标准化阈值、方向 polarity、六维权重、异常与背离规则、新鲜度 |
| 5 | `references/futures_chains.yaml` | 期货产业链分层、7 条链、交易所后缀勘误（**不参与评分**） |
| 6 | `references/interpretation_framework.md` | 解释框架与输出范式 |
| 7 | `docs/ARCHITECTURE.md` | 架构与不变量（读代码前先看这个） |
| 8 | `docs/DATA_CONTRACT.md` | 数据流、字段契约、增量合并语义 |
| 9 | `docs/DEVIATION_RULES.md` | **「今日显著偏离」的判定口径**（阈值、词表、去重规则） |
| 10 | `docs/IFIND_FIELD_MAPPING.md` | iFinD 字段实测证据与踩坑记录（改采集前必读） |
| 11 | `docs/IMPLEMENTATION_REPORT.md` | 完整实施报告与四轮缺陷修复记录 |
| 12 | `docs/CHANGELOG.md` | 版本变更 |

> 只想了解「日报有什么内容」→ 读 `docs/DEVIATION_RULES.md` + `SKILL.md` 的日报章节结构。
> 想改代码 → 读 `docs/ARCHITECTURE.md` + `MANIFEST.md` 的文件地图。

---

## 运行

要求 Node ≥ 22，**零第三方 npm 依赖**（自带最小 YAML 子集解析器）。

```bash
# 1) 配置 iFinD 凭据（密钥来自环境变量，仓库内不存任何密钥）
export IFIND_API_KEY="<你的 iFinD API Key>"
export IFIND_MCP_BASE_URL="http://219.141.246.230:5223/sse"

# 2) 采集 → 评分 → 日报 → 工作台
npm run collect      # MACRO_MODE=daily | release | full（默认 full）
npm run snapshot
npm run report
npm run workbench

# 或一把梭
npm run run

# 3) 自检（只读，不改文件）
npm run verify
```

> **Windows / Git Bash 注意**：git bash 读不到 Windows「用户级」环境变量。
> 若 `IFIND_API_KEY` 是用 `setx` 设的用户级变量，需先落盘再读：
> ```bash
> powershell.exe -NoProfile -Command "[System.IO.File]::WriteAllText('macro_key.tmp',[Environment]::GetEnvironmentVariable('IFIND_API_KEY','User'))"
> export IFIND_API_KEY=$(cat macro_key.tmp | tr -d '\r\n')
> ```

三种采集模式（不要每天无脑全量拉）：

| 模式 | 用途 | 覆盖 |
|---|---|---|
| `daily` | 每个交易日盘后 | 日频 ~33 项（利率/汇率/商品/指数） |
| `release` | 官方数据发布窗口 | 月频/季频 ~36 项，无新数据则空跑 |
| `full` | 手动补历史 | 全部 69 项（约 6 年窗口） |

增量模式带**合并语义**：只拉一层时另一层沿用上轮结果，不会覆盖丢历史。

---

## 安装成 agent 技能

```bash
npm run check-skill      # 装配体检：清单齐备、无死路径、注册表可解析
npm run install-skill    # 装到 ~/.codex/skills/macro-high-frequency-monitor
```

也可以把整个仓库目录复制进你自己的 skills 目录 —— 布局保持不变，脚本的相对路径关系就成立。

---

## 产出物

| 文件 | 内容 |
|---|---|
| `public/macro-daily-report.md` | 21 章节日报。**第 2 章「今日显著偏离」**：先结论、再涨/跌榜、月频季频单列、末尾给口径 |
| `public/macro-workbench.html` | 自包含工作台：20 张 ECharts 图 + 115 条迷你走势 + 全指标总表，ECharts 与数据全内联，可离线双击打开 |
| `public/macro-snapshot.json` | 快照契约（`MACRO_SNAPSHOT`），前端与模型的**唯一数据入口** |
| `work/macro/observations.json` | 全量观测（`work/` 是产物区，已在 `.gitignore` 中） |

---

## 已知边界（改之前先看）

- **六维权重是 DRAFT**，未经回测 —— 综合分只能用于观察宏观方向，**不得作为下注依据**。解除 DRAFT 需要在 `work/macro/snapshots/` 累积每日分数序列后走「字段可用性 → 历史覆盖 → 高相关处理 → 回测」四关。
- **4 项总量指标 ID 待补**：固定资产投资 / 制造业投资 / 基建投资 / 新增人民币贷款（见注册表 `pending_lookup`）。
- **6 项第三方高频数据 iFinD 不覆盖**（高炉开工率、轮胎开工率、30 城成交、土地成交、票房、地铁客运）。
- **「预期差」不可用**：iFinD 一致预期接口返回 `-209`，不得作为设计前提。
- `HF_THERMAL_COAL`（动力煤主力）已停更，系统自动判 `DISCONTINUED` 并排除评分。
- **落库通道未接**：当前数据源是快照文件，不是数据库。

---

## 改动约定

1. **不要重算数字**。要新增统计量，就在 `macro-snapshot.mjs` 里算好、写进快照，模型只读。
2. **不要新建第二套前端 / 第二个图表库 / 第二个 scheduler**。工作台是单文件自包含 HTML。
3. **不要写死绝对路径**。`npm run verify` 第 04 项会扫描死路径。
4. **源码不要放 `work/`**。那里是产物区且被 gitignore。
5. **不要提交动态数据与密钥**。「最新快照」按需保留，大体积历史不进 git。

---

## 目录

```text
.
├── SKILL.md                 技能定义（agent 入口）
├── MANIFEST.md              方案组成地图（先读这个）
├── README.md                本文件
├── references/              配置真源：指标注册表 / 信号规则 / 产业链分层 / 解释框架
├── scripts/                 采集 → 评分 → 日报 → 工作台
├── templates/macro/         工作台模板（源码，不是产物）
├── docs/                    架构、数据契约、口径、字段踩坑、实施报告
└── public/vendor/           ECharts 5.6.0（Apache-2.0）
```
