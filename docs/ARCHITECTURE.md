# Architecture — V2 Macro Cockpit

## 单向数据流

```text
iFinD → collect → observations → snapshot → report → workbench
```

`macro-collect.mjs` 负责网络采集、原始质量处理和增量合并。`macro-snapshot.mjs` 在离线环境读取 observations，完成全部统计与信号计算。report 和 workbench 只消费 snapshot。

## 真源

- indicator registry：指标定义、频率、方向、transform、chart metadata、六维 score axis。
- signal rules：统计窗口、样本要求、评分映射、异常、偏离、背离、新鲜度和产业链信号参数。
- futures chains：品种、层级、spread operation 与 coefficient。
- snapshot：所有进入结论、标签、告警、排序语义的数值与判定。

## 统计边界

宏观指标、期货品种和 spread 均调用 `macro-snapshot.mjs` 的同一 `computeStats`。`macro-futures.mjs` 接收品种状态，只执行链级 median / breadth 聚合和 raw spread series 生成。受支持的 spread operation 为 `linear_combination` 与 `ratio`；未知 operation 直接失败。

## 契约与前端

主契约保持 `MACRO_SNAPSHOT`，V2 additive migration 使用 1.1.0。工作台继续使用 `templates/macro/workbench.template.html`、ECharts 和 `scripts/macro-workbench.mjs`，输出单一自包含 HTML。

## 非回归不变量

- 真实主力月份解析与换月等比复权。
- HQ 零价格哨兵转换为缺失。
- EDB observation time 与 release time 分离。
- daily / release / full 增量合并。
- `DISCONTINUED` 排除评分与活跃统计。
- DRAFT 权重提示。
- canvas 像素诊断、重画登记、尺寸/可见性恢复和单图异常隔离。

## 运行产物

`work/` 保存 observations、历史轻量快照、结构化日报和归档。`public/macro-*` 保存可交付的动态产物。源码保持在 git 跟踪目录。
