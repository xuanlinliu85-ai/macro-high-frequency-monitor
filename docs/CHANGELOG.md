# Changelog

## 2.0.1 — 2026-09-13

- 用 `package-lock.json`、staging `npm ci --omit=dev`、安装前后 runtime import smoke 完成 Node 依赖闭环。
- 产业链 graph 改为 YAML 显式 edges，snapshot 输出 `futures.graph`，workbench 仅渲染主契约。
- iFinD endpoint 改为显式配置，凭据通过 Authorization header 传输，HTTP 仅由可信内网/VPN开关启用。
- FIVE_DAY 异常限定日频；freshness 支持 indicator release window；频率语义与 metadata 完成校验。

## 2.0.0 — 2026-09-13

- 升级 V2 Macro Cockpit 第一屏与四层 drill-down。
- 发布 `MACRO_SNAPSHOT` 1.1.0 additive contract。
- YAML 成为全部语义、阈值、evaluator 与 spread 定义真源。
- snapshot 成为宏观指标、期货品种、spread 与结论级聚合的唯一计算入口。
- report 转为 render-only。
- 新增 frequency-native `changeView` 与六维 score-axis labels。
- 新增 18 项 verify gate、安全 staging 安装、备份、SHA manifest 与 drift check。
