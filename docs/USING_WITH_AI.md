# Using Macro Cockpit with AI

让模型先读 `MANIFEST.md`、`SKILL.md`、`README.md`，再读三份 YAML 与架构/契约文档。

分析时直接读取 `public/macro-snapshot.json`：

1. 用 `headline` 定位总体状态、今日变化数量和背离数量。
2. 用 `dimensions[].semanticLabel` 解释六维，保留各自 score axis。
3. 用 `deviations` 区分新变化与旧极端。
4. 用 `divergences[].question` 形成可证伪研究问题。
5. 用 `futures.chains/spreads/signals` 追踪产业链传导。
6. 用 `dataQuality` 说明覆盖、新鲜度与数据缺口。

数值与标签保持 snapshot 原值。解释层组织“变化 → 驱动 → 市场确认 → 矛盾 → 关注点”。
