# Data contract

## 全链路字段流

```text
iFinD 原始返回
  → observations.json     { id, rows:[{ d, v, obs?, rel? }], meta }
  → macro-snapshot.json   { asOf, headline, dimensions, indicators, categories, trends, futures, ... }
  → report.json / .md     { sections:[{ id, order, title, tag, blocks[] }] }
  → workbench.html        内联 snapshot + report + echarts
```

## `work/macro/observations.json`（采集层产物）

聚合所有指标的**观测流水**，不参与评分，是评分层唯一输入。

```jsonc
{
  "generatedAt": "…",
  "series": {
    "CN_CPI_YOY": {
      "id": "CN_CPI_YOY",
      "rows": [
        // d = 观测期（数据所属期间）；rel = 发布时刻（月频/季频才有）
        { "d": "2026-08-31", "v": 0.6, "obs": "2026-08", "rel": "2026-09-09" }
      ]
    }
  }
}
```

**两条硬约束**：

1. **观测期与发布期必须分开存**（`d`/`obs` vs `rel`）。合并了就无法判断"数据没发布"与"数据陈旧"。
2. **价格序列里的 `0` 是「当日无成交」哨兵，不是价格**，必须按缺失处理。
   否则已停更的合约（如动力煤主力，2022-12 起全为 0）会被算成 `FRESH` 并污染 zscore。

## `public/macro-snapshot.json`（评分层产物）

**前端与模型的唯一数据入口。** 所有数值都是代码算好的，读它即用，不得重算。

```jsonc
{
  "contract": "MACRO_SNAPSHOT", "version": "1.0.0",
  "asOf": "2026-09-10",              // 数据截止日
  "generatedAt": "…",

  "headline": { "composite": 47.2, "label": "中性震荡", "anomalyCount": 22, "highSeverityCount": 17 },

  "dimensions": [ { "key": "growth", "name_cn": "增长", "score": 53.4, "zMean": 0.17 } ],

  "indicators": [
    {
      "id": "CN_CPI_YOY", "name_cn": "CPI:当月同比",
      "layer": "official",          // official | highfreq | market
      "category": "inflation",      // 11 组：growth/sentiment/consumption/property/inflation/
                                    //        credit/liquidity/rates/fx/risk/external
      "frequency": "monthly",
      "polarity": 1,
      "status": "OK",               // OK | STALE | EXPECTED | DISCONTINUED | EMPTY
      "latest": { "date": "2026-08-31", "value": 0.6 },
      "changes": { "chg1": 0.3, "chg5": null, "chg20": null, "chg12": 0.1 },
      "pctChg1": 0.01, "pctChg5": null, "pctChg20": null,
      "z1y": -0.66,                 // 原始 z（说明位置高低）
      "dirZ": 0.66,                 // 方向校正后 z（说明好坏）—— 与 z1y 不可混用
      "pct1y": 0.31, "pct3y": 0.28, "pct5y": 0.00,
      "moveExtreme": 0.42,          // |5 期变化| 在自身近 3 年单期变化分布中的分位
      "chg1Extreme": 0.35           // |1 期变化| 在自身近 3 年单期变化分布中的分位  ← 「今日显著偏离」核心量
    }
  ],

  "categories": { "inflation": ["CN_CPI_YOY", "…"] },   // 分组索引（11 组）
  "trends": { "CN_CPI_YOY": [ { "d": "…", "v": 0.6 } ] },

  "futures": {
    "chains":    [ { "key": "black", "name_cn": "黑色·煤焦钢", "metrics": { "d5": -0.001, "breadth": 0.25 } } ],
    "varieties": [ { "id": "FUT_I", "name_cn": "铁矿石", "chain_cn": "黑色·煤焦钢", "value": 769,
                     "d1": -0.008, "z1y": -1.55, "pct1y": 0.42, "oiChg5": 0.11,
                     "chg1Extreme": 0.86, "status": "OK" } ],
    "spreads":   [ { "id": "RB-I", "name_cn": "螺纹-铁矿价差", "available": true, "pct1y": 0.54,
                     "points": [ { "d": "…", "v": 1977.2 } ] } ],   // 近 300 个共同交易日，采集层算好
    "signals":   [ { "tier": "medium", "implication": "…" } ],
    "movers":    { "up": [], "down": [] }
  },

  "divergences": [ { "key": "…", "hit": true, "severity": "high" } ],
  "anomalies": [ { "id": "…", "severity": "high" } ],
  "scoringModel": { "unknownDirections": [] }   // 非空 = 有标签未登记，会被静默排除出评分
}
```

### 派生量定义（都在 `macro-snapshot.mjs` 里算）

| 字段 | 定义 | 回答什么问题 |
|---|---|---|
| `chg1` / `chg5` / `chg20` | 1 / 5 / 20 期变化（**按指标性质决定单位**） | 变了多少 |
| `z1y` | 当前值在近 1 年窗口的 z 分数 | 位置高不高 |
| `dirZ` | `z1y × polarity`（方向校正） | 对宏观是好是坏 |
| `pct1y` / `pct3y` / `pct5y` | 当前值在对应窗口的历史分位 | 排到第几 |
| `moveExtreme` | `\|5 期变化\|` 在自身近 3 年单期变化分布中的分位 | 这 5 天动得离不离谱 |
| `chg1Extreme` | `\|1 期变化\|` 在自身近 3 年单期变化分布中的分位 | **今天这一下动得离不离谱** |

### 变化单位按指标性质分流（不可混用）

| 指标性质 | 单位 | 例 |
|---|---|---|
| 收益率、资金利率（`rates` / `liquidity`） | **bp（基点）** | 10Y `-2.4bp` |
| 其他百分比类（CPI / PPI / M2 / 同比） | **pp（百分点）** | CPI `+0.30pp` |
| 股指（`risk`） | **%** | 沪深300 `-2.48%` |
| 其他指数（PMI / BDI / 景气） | **点** | PMI `+0.6点` |
| 价格、金额 | **%** | 铜 `+0.55%` |

否则会把"收益率上行 2bp"写成"+1.2%"。

## `work/macro/report.json`（汇报层产物）

```jsonc
{
  "title": "宏观高频 × 期货产业链 · 每日汇报",
  "asOf": "2026-09-10", "composite": 47.2, "tone": "中性震荡",
  "sections": [
    { "id": "summary", "order": 1, "title": "一、摘要", "tag": "…",
      "blocks": [ { "type": "p", "text": "…" }, { "type": "table", "head": [], "rows": [], "align": [] } ] }
  ]
}
```

`blocks` 支持 `p` / `ul` / `table` / `note` 四种类型，工作台「每日汇报」面板直接渲染它，
因此**日报与工作台永远同源**。章节 `id` 是稳定的机器标识（如 `deviations`），标题文案可改。

## 增量合并语义

采集时只拉一层（例如 `daily`），另一层（月频/季频）**沿用上轮结果**，不会整体覆盖丢历史。
实现要点：合并以 `(id, d)` 为键做 upsert，而非按 series 整体替换。
