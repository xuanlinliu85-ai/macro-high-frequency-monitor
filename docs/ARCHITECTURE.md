# Architecture

## 一句话

一条**单向**的、可断点重跑的流水线：采集 → 评分 → 汇报 → 工作台。
每一层的输出都是下一层唯一的输入，层与层之间没有反向依赖，也没有隐藏状态。

```text
iFinD MCP (THS_EDB / THS_HQ)
   ↓
[采集层] macro-collect.mjs  ──► work/macro/observations.json
         仅取数落盘，一行统计都不算
   ↓
[评分层] macro-snapshot.mjs ──► public/macro-snapshot.json
         只算不取数；z / 分位 / 变化 / chg1Extreme / 维度分 / 异常 / 背离
   ├─ macro-futures.mjs（期货产业链：链级中位数、广度、价差、传导信号）
   ↓
[汇报层] macro-report.mjs   ──► public/macro-daily-report.md + work/macro/report.json
         纯规则拼装，阈值集中在文件顶部 THRESH，零模型生成
   ↓
[呈现层] macro-workbench.mjs ─► public/macro-workbench.html
         数据 / 汇报 / ECharts 全部内联，离线可开
```

## 五条不变量（改代码前必须确认没破坏）

### 1. 计算与解释分离

`zscore` / `percentile` / `change` / 维度分 / 异常判定**只能由代码算**。
模型读 `public/macro-snapshot.json` 里已经算好的数值，**不得在解释层重算**。

这条不是风格偏好：一旦模型参与计算，同一份数据两次问会给出两个数，整套结论就失去可复核性。

### 2. 采集层与评分层严格分离

`macro-collect.mjs` 碰网络但不算统计量；`macro-snapshot.mjs` 算统计量但不碰网络。
副作用是：只要 `observations.json` 还在，就能离线重跑评分、汇报与工作台（`npm run run:offline`）。

### 3. 配置与代码分离

指标语义、阈值、权重、产业链分层全部在 `references/*.yaml`（配置真源）。
`SKILL.md` 内**不得**出现字段代码清单或数值阈值 —— 否则改口径要改两处，必然漂移。

`macro-config.mjs` 按「就近优先」定位配置目录：
`MACRO_SKILL_DIR` 环境变量 → 脚本上一级 → 包内 `references/`。
找不到时抛**带指引的错误**，而不是静默用一个死路径。

### 4. 方向由注册表决定，不靠模型判断

每个指标的 `signal.direction` 必须在 `signal_rules.yaml → direction_semantics` 有对应 `polarity`。
未登记的标签会被降级为 `contextual` 并**静默排除出评分** —— 这是曾经真实丢过整条数据线的原因，
因此 `macro-snapshot.mjs` 会在 `scoringModel.unknownDirections` 里显式上报未登记标签。

注意 `lower_is_looser`（DR007 越低越宽松）与 `higher_is_tighter`（CPI 越高越收紧）语义不同，
**方向校正后的 z（`dirZ`）与原始 z（`z1y`）不可混用**：判断"好坏"用 `dirZ`，判断"涨跌"用原始变化。

### 5. 频率不可混算

| 频率 | 允许的变化窗口 |
|---|---|
| 日频 | 1D / 5D / 20D |
| 周频 | WoW / 4W / 13W |
| 月频 | MoM / YoY / 3M trend |
| 季频 | QoQ / YoY |

月频指标在其下一个发布窗口到来前一律 `EXPECTED`，**不得判为 `STALE`**（9 月 CPI 还没发布，不是数据陈旧）。

## 关键设计决策

### 工作台是「一个自包含 HTML」，不是一套前端

`public/macro-workbench.html` 里 ECharts 与数据全部内联（约 2 MB），可离线双击打开，也可以直接发给别人。
好处是**没有"两份需要同步维护的可视化代码"**，因此不会有漂移。

### 工作台模板放在 `templates/`，不放 `work/`

模板是**源码**，产物是 `public/macro-workbench.html`。
`work/` 是产物区且在 `.gitignore` 中 —— 模板放进去会让新克隆看不到产出它的源码。

### 三种采集模式，而不是每天全量拉

日频盘后拉、月频发布窗口拉、全量手动补。增量模式带**合并语义**：只拉一层时另一层沿用上轮结果。

## 前端渲染的两个坑（都会表现为「一堆面板里没有图」）

### 坑 1：`var` 声明提升但赋值不提升

依赖变量若声明在脚本中部，而使用它的函数在更早位置被调用，会读到 `undefined` 抛 TypeError，
**整页渲染中断**，且页面不报任何可见错误 —— 空面板是唯一症状。
**纪律：依赖变量必须在脚本顶部赋值。**

### 坑 2：ECharts 在 0×0 容器里初始化后不会自己重画

容器尺寸为 0 时（`display:none` / iframe 首帧 / 折叠面板 / 预览面板）初始化会画出 0×0 canvas，
之后容器变大也不会重画。防御分三层，缺一不可：

1. **自检必须查 canvas 像素**，不能只查容器 —— 容器有宽高而 canvas 为 0×0 是最阴的失败形态。
   `chartDiag()` 读 `canvas.width/height`，按 `devicePixelRatio` 折算后与容器比对，`< 0.9×` 即判废图。
2. **每个图登记重画入口** `RENDERERS[nodeId]`，`window.__macroRedraw__()` 一键重画；
   重画前 `dispose` 旧实例避免泄漏；绘制函数包 `try/catch`，**单图失败不中断整页**。
3. **四重触发兜底**：`ResizeObserver` + `IntersectionObserver` + `visibilitychange` + 多时间点 `resize()`。

## 目录职责

| 路径 | 是源码还是产物 | 说明 |
|---|---|---|
| `scripts/` | 源码 | 四个阶段 + 安装器 + 自检 |
| `references/` | **源码（配置真源）** | 指标注册表 / 信号规则 / 产业链分层 / 解释框架 |
| `templates/macro/` | 源码 | 工作台模板 |
| `SKILL.md` `MANIFEST.md` `README.md` `docs/` | 源码 | 技能定义与文档 |
| `public/vendor/echarts.min.js` | 第三方 | ECharts 5.6.0（Apache-2.0），内联进工作台 |
| `work/` | **产物** | 全量观测、快照留档、结构化汇报（gitignore） |
| `public/macro-*.json\|md\|html` | **产物** | 快照、日报、工作台（gitignore，内含授权行情数据） |
