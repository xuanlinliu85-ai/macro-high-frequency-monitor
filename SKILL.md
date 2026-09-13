---
name: macro-high-frequency-monitor
description: >-
  Use this skill for China macro monitoring, macro regime assessment, high-frequency
  nowcasting, liquidity and rates tracking, property-cycle reads, inflation and external-demand
  tracking, futures transmission, and macro-vs-market divergence questions. Triggers include
  宏观监测、宏观高频、宏观六维、增长、消费、地产、通胀、流动性、外需、资金面、利率、
  期限利差、信用利差、汇率、宏观与市场背离、今天中国宏观边际变化。
---

# Macro High-Frequency Monitor V2

本 Skill 是独立、自包含的中国宏观高频监测系统。配置、采集、统计、日报、Macro Cockpit 与安装工具均位于同一目录。

## 核心职责

- `references/indicator_registry.yaml` 定义指标语义、频率、方向、合法 transform 与六维显示轴。
- `references/signal_rules.yaml` 定义标准化、评分、异常、偏离、背离、新鲜度与升级规则。
- `references/futures_chains.yaml` 定义期货品种、产业链层级、价差 operation 与行业系数。
- `scripts/macro-snapshot.mjs` 是统计与信号计算唯一入口。
- `scripts/macro-report.mjs` 与工作台只解释、排序和格式化 snapshot 已生成的结构化结果。

## 使用顺序

1. 优先读取 `public/macro-snapshot.json`。
2. 需要刷新时读取 `work/macro/observations.json` 并运行离线链路。
3. 环境已经提供 iFinD 凭据时运行采集。

```bash
npm run collect
npm run snapshot
npm run report
npm run workbench
npm run run
npm run run:offline
npm run verify
npm run check-skill
npm run install-skill
npm run check-installed
```

## 频率纪律

- 日频展示 1D / 5D / 20D。
- 周频展示 WoW / 4W / 13W。
- 月频展示 registry 明确允许且数据真实存在的 MoM / YoY / 3M trend。
- 季频展示 registry 明确允许且数据真实存在的 QoQ / YoY。
- `changeView.items[].status = unavailable` 表示该 transform 当前缺少合法语义或真实数据。

## 解释纪律

- 直接引用 snapshot 的 `headline`、`dimensions`、`deviations`、`anomalies`、`divergences`、`aggregates` 与 `futures`。
- `dirZ` 已统一为宏观支持度方向；原始涨跌继续使用原始 change。
- 增长、消费、地产、通胀、流动性与外需各自使用 registry 中的 semantic label。
- 综合分表示“宏观支持度 / 扩张友好度的规则化观察指标”。六维权重保持 DRAFT。
- 事实层引用数值与标签；判断层说明传导、验证、反证问题与数据缺口。

## 数据与安全

- `macro-collect.mjs` 保存 EDB 观测期 `time` 与发布时间 `rtime`。
- HQ 零价格哨兵按缺失值处理。
- 期货层解析真实主力月份并进行换月等比复权。
- daily / release / full 使用增量合并。
- 源码和配置位于 git 跟踪目录；`work/` 保存运行产物。
- API 凭据来自环境变量，安装包排除 `.env`、授权历史与动态数据。
- iFinD provider 默认 fail closed；必须显式选择 `IFIND_PROVIDER=local` 或 `IFIND_PROVIDER=https-mcp`。
- 兼容既有生产链路必须同时配置 `IFIND_PROVIDER=local`、`IFIND_LOCAL_HOME=<external capability root>`、`IFIND_ALLOW_LEGACY_INSECURE_UPSTREAM=1`。Macro Monitor 动态 import capability root 下的 `scripts/ifind-mcp-client.mjs`，只调用其 `listTools()`、`callTool()`、`close()`，既有 THS 实现保持单一真源。当前本地模块属于 `LEGACY_INSECURE_UPSTREAM`（公网 HTTP + query credential）；授权变量只表示用户接受当前兼容风险，不改变底层 transport，也不构成安全连接。
- 官方 HTTPS MCP 验证完成后可显式使用 `IFIND_PROVIDER=https-mcp`，同时配置 `IFIND_API_KEY` 与 `IFIND_MCP_BASE_URL`。HTTPS endpoint 直接使用；可信内网/VPN 的 HTTP endpoint 由 `IFIND_MCP_ALLOW_INSECURE_HTTP=1` 显式授权。API key 通过 `Authorization` header 传输。

## 输出

- `public/macro-snapshot.json`：`MACRO_SNAPSHOT` 1.1.0。
- `public/macro-daily-report.md`：规则渲染的完整日报。
- `public/macro-workbench.html`：自包含、离线可开的 V2 Macro Cockpit。
- `work/macro/report.json`：日报结构化区块。

## 安装

安装器在 Skill discovery root 外复制 source 与 `package-lock.json`，执行 `npm ci --omit=dev` 和 `scripts/ifind-mcp-client.mjs` runtime import smoke，再完成 verify 与 SHA manifest。staging 全部通过后备份现有正式版本并以 rename 切换；依赖安装失败时正式版本保持原状。正式安装后重复 import smoke。`--check-installed` 只读比较 lockfile 与全部 source SHA-256，并复核 runtime import；`node_modules` 由 lockfile 重建，不纳入 SHA manifest。
