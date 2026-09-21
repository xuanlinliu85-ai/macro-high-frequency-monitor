# Data Contract — MACRO_SNAPSHOT 1.1.0

V2 保持契约名 `MACRO_SNAPSHOT`，以兼容新增字段完成迁移。

## 顶层结构

```text
contract / version / generatedAt / asOf / window / source
tradingDataAsOf / runDate / sourceWindowEnd / dateQuality
scoringModel / headline / dimensions / movers
anomalies / deviations / divergences / indicators / categories
aggregates / trends / futures / yieldCurve / regime / dataQuality
```

日期字段具有固定语义：

- `asOf` 与 `tradingDataAsOf` 是本轮已刷新且质量为 `OK` 的日频观测日期众数。
- `runDate` 与 `sourceWindowEnd` 记录采集请求窗口结束日，freshness 相对该日期计算。
- `generatedAt` 记录实际生成 UTC timestamp。
- `dateQuality` 记录众数覆盖率、配置门槛、有效日频数量与日期分布；覆盖率不足时 snapshot 与发布流程 fail closed。

## 市场价格身份

`HF_CRUDE` 是 INE 原油连续序列的宏观评分 view，`FUT_SC` 是真实主力合约解析与换月等比复权后的产业链 view。二者共享 INE/SC instrument identity，并通过不同 `seriesRole` 与显示名明确区分。当前保留双 view 以保持评分历史连续，迁移为单一 canonical series 前需要独立影响评估。

`HF_BRENT` 是 iFinD 提供的 ICE Brent continuous series。Reuters front-month settlement 属于独立 external verification source identity，不覆盖或拼接该序列。

## frequency-native `changeView`

每个 indicator 带：

```json
{
  "frequency": "monthly",
  "changeView": {
    "items": [{ "key": "yoy_level", "label": "YoY", "value": 0.8, "status": "available" }],
    "legacy": { "deprecated": true, "field": "changes" }
  }
}
```

frequency 约束允许窗口，registry transforms 与序列名称约束实际语义，数据存在性决定 `available`。本身已经是同比的序列使用 `yoy_level` 展示当前同比值；统计引擎保持一次同比语义。

legacy `changes` 继续保留给过渡消费者，report 与 workbench 主路径使用 `changeView`。

## dimensions

每个维度包含 `scoreAxis`、高/中/低语义标签、`semanticLabel`、score、相对上一有效快照 delta、coverage 与历史趋势。综合分定义见 `scoringModel.compositeDefinition`。

## deviations / divergences

`deviations` 保存今日入选结果与按侧榜单；indicator、futures variety 和 spread 保存 `isNotable`、`deviationLevel`、`tags`。

每条 divergence 保存 evaluator、valueField、minimum usable、side A/B 成员摘要、hit、severity、解释与可证伪问题。消费者直接渲染这些结果。

## futures

`futures.varieties[]` 保存品种级状态；`chains[]` 保存已算变化的链级 median/breadth；`spreads[]` 保存 YAML definition 解释后的 raw series 统计；`signals[]` 保存上下游传导判定。

## 增量语义

observations 以 `(indicator id, observation date)` 合并。daily 更新保留 release 层历史，release 更新保留日频层历史。`r` 字段保存发布时间，与 `d` 观测期分离。
