# Deviation Rules

生产阈值统一位于 `references/signal_rules.yaml` 的 `deviation`。本文件说明语义与数据流。

## 两个互补维度

- `chg1Extreme`：本期一步变化在自身历史一步变化中的位置，回答“这次变化是否罕见”。
- `z1y`：当前水平在一年窗口中的标准化位置，回答“当前位置是否极端”。

snapshot 综合变化极端度、位置、历史分位与持仓变化，产出固定 tags、`isNotable` 和 `deviationLevel`。report 与 workbench 展示这些字段。

## 原始方向

今日上涨侧与下跌侧使用原始 change。宏观改善与恶化使用 snapshot 已计算的 `dirZ`。这两套颜色和语言在工作台中分开表达。

## 频率

日频进入“今日变化”榜。月频与季频在发布观察表单列，并保留观测期提示。

## 去重

同一标的同时出现在宏观期货代理与全品种期货层时，snapshot 的消费层优先展示信息更完整的期货品种状态。去重键来自稳定 id/linked metadata，名称只用于显示。

## 可复核性

阈值、样本要求和榜单长度来自 YAML；snapshot 保存命中的标签与结构化证据；报告层不执行比较表达式。
