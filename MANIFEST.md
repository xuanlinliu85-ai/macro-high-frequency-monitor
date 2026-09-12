# MANIFEST — 这个方案由什么组成

> 给读这份仓库的模型（ChatGPT / Codex / Claude）看的定位文件。
> 先读这一页，再读 `SKILL.md`，最后按需读 `references/`。

## 一句话

`macro-high-frequency-monitor` 是「中国宏观高频监测」这套系统的**配置与解释层**：
把 69 项宏观指标 + 61 个期货品种的原始数据，经**纯代码**算成六维评分、异常、背离、
当日显著偏离，再渲染成一份规则化的每日汇报与一个可离线打开的工作台。

**核心铁律**：`zscore` / `percentile` / `change` **全部由代码算**，模型只解释已算好的 signal。
任何在解释层里重算数字的改动，都是破坏性改动（Implementation Spec §37）。

## 方案由两半组成

| 层 | 位置 | 谁来读 | 为什么这么放 |
|---|---|---|---|
| **知识层** | `.agents/skills/macro-high-frequency-monitor/`（本目录） | 模型（ChatGPT / Codex） | 指标语义、阈值、产业链分层、解释框架 —— 可被当作技能直接加载 |
| **代码层** | 仓库根目录的 `scripts/`、`templates/`、`app/` | 人 / npm / 定时任务 | 采集→评分→汇报→工作台的可执行链路 |

**为什么不分家会出问题**：知识层的 YAML 是代码层 `macro-config.mjs` 的输入。
`macro-config.mjs` 按「就近优先」定位配置目录（环境变量 → 脚本上级 → 仓库内 `.agents/skills/`），
所以两半可以分开放，也可以被 `macro-install-skill.mjs` 装配成一个自包含技能包。

## 代码层文件地图（仓库相对路径）

| 阶段 | 文件 | 职责 |
|---|---|---|
| 配置 | `scripts/macro-config.mjs` | 最小 YAML 子集解析器 + 加载注册表（零额外依赖） |
| 采集 | `scripts/macro-collect.mjs` | `full` / `daily` / `release` 三模式 + 增量合并 + 期货层 |
| 采集 | `scripts/macro-main-contract.mjs` | 真实主力月份合约解析 + 换月等比复权拼接 |
| 评分 | `scripts/macro-snapshot.mjs` | z / 分位 / 变化率 / `chg1Extreme` / 维度分 / 异常 / 背离 |
| 分析 | `scripts/macro-futures.mjs` | 产业链链级中位数、广度、主力价差、链内传导信号 |
| 汇报 | `scripts/macro-report.mjs` | 21 章节 Markdown + 结构化区块（**纯规则拼装，阈值集中在文件顶部 `THRESH`**） |
| 构建 | `scripts/macro-workbench.mjs` | 把数据 / 汇报 / ECharts 内联进单文件工作台 |
| 模板 | `templates/macro/workbench.template.html` | 工作台**源码**（受 git 跟踪；不在 gitignore 的 `work/` 下） |
| 验收 | `scripts/macro-smoke-test.mjs` | 19 项端到端验收（`npm run macro:test`） |
| 装配 | `scripts/macro-install-skill.mjs` | 把本方案装成自包含技能包 / 同步知识层 |
| 入口 | `app/monitor/macro/page.tsx` | 站点入口，iframe 嵌入同一份工作台 HTML |

## 数据流（单向，可断点重跑）

```text
iFinD (THS_EDB / THS_HQ)
   ↓  macro-collect.mjs            work/macro/observations.json      （全量观测，不落库）
   ↓  macro-snapshot.mjs           public/macro-snapshot.json        （快照契约，含 futures 块）
   ↓  macro-report.mjs             public/macro-daily-report.md      （21 章节汇报）
   │                               work/macro/report.json            （结构化区块）
   ↓  macro-workbench.mjs          public/macro-workbench.html       （自包含工作台，离线可开）
```

`work/` 与 `dist/` 在 `.gitignore` 里（构建产物区）；**源码一律不放 `work/`**。

## 怎么跑

```bash
cd "C:/Users/urmylucky/Documents/每日复盘更新"

# 密钥：git bash 读不到 Windows 用户级变量，必须先经 PowerShell 落盘
powershell.exe -NoProfile -Command "[System.IO.File]::WriteAllText('C:\Users\urmylucky\WorkBuddy\macro_key.tmp',[Environment]::GetEnvironmentVariable('IFIND_API_KEY','User'))"
export IFIND_API_KEY=$(cat "C:/Users/urmylucky/WorkBuddy/macro_key.tmp" | tr -d '\r\n')
export IFIND_MCP_BASE_URL="http://219.141.246.230:5223/sse"

npm run macro:collect     # 或 MACRO_MODE=daily / release
npm run macro:snapshot
npm run macro:report
npm run macro:workbench
npm run macro:test        # 19 项验收

npm run macro:run           # collect → snapshot → report → workbench 一把梭
npm run macro:install-skill # 装到 ~/.codex/skills/macro-high-frequency-monitor
node scripts/macro-install-skill.mjs --check   # 只体检装配完整性
```

## 当前验收状态

- `npm run macro:test` → **19/19 通过**
- 工作台 21 个章节、20 张 ECharts 图、115 条 SVG 迷你走势，Edge 无头渲染 **20/20 有 canvas、0 个 JS 错误**

## 值得继续完善的地方（给下一步接手的人）

1. **六维权重仍是 DRAFT**，未回测。解除 DRAFT 需要在 `work/macro/snapshots/` 累积每日分数序列后做「字段可用性 → 历史覆盖 → 高相关处理 → 回测」四关。
2. **4 项总量指标 ID 待补**（固定资产投资 / 制造业投资 / 基建投资 / 新增人民币贷款），见 `references/indicator_registry.yaml` 的 `pending_lookup`。
3. **落库通道未接**：`macro_observations` 表 schema 已建，但 D1 绑定仅 Cloudflare 运行时可用，当前数据源仍是 `public/macro-snapshot.json`。
4. **「预期差」不可用**：iFinD 一致预期接口返回 `-209`，不得作为设计前提。
5. **当日显著偏离的口径**可再细化：目前以「本期 |1 期变化| 在自身近 3 年单期变化分布中的分位 ≥ 0.9」判定，未来可考虑对高波动品种（如农产品）做波动率归一化。

## 改动约定

- **不要在解释层重算数字**。要新增统计量，就在 `macro-snapshot.mjs` 里算好、写进快照，模型只读。
- **不要新建第二套前端 / 第二个图表库 / 第二个 scheduler**（Spec §49）。工作台是单文件自包含 HTML。
- **不要在脚本里写死绝对路径**。`macro-install-skill.mjs --check` 会做死路径体检。
- **源码不要放 `work/`**。那是产物区，且被 gitignore。
