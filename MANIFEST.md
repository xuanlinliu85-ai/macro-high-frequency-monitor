# MANIFEST — Macro High-Frequency Monitor V2

## 系统身份

本仓库是独立、自包含的 Macro Cockpit。它继续使用一条单向链路、一份 `MACRO_SNAPSHOT` 契约、一个 ECharts 工作台模板和一个安装器。

```text
iFinD
  → scripts/macro-collect.mjs
  → work/macro/observations.json
  → scripts/macro-snapshot.mjs
  → public/macro-snapshot.json
  → scripts/macro-report.mjs
  → public/macro-daily-report.md + work/macro/report.json
  → scripts/macro-workbench.mjs
  → public/macro-workbench.html
```

## 源码地图

| 位置 | 职责 |
|---|---|
| `SKILL.md` | Skill 触发、读取、解释与运行纪律 |
| `references/indicator_registry.yaml` | 指标与六维显示语义真源 |
| `references/signal_rules.yaml` | 全部生产阈值与 evaluator 参数真源 |
| `references/futures_chains.yaml` | 期货链、价差 operation 与系数真源 |
| `scripts/macro-config.mjs` | 包内配置定位与 YAML 子集解析 |
| `scripts/macro-collect.mjs` | 网络采集、零哨兵处理、增量合并 |
| `scripts/macro-main-contract.mjs` | 真实主力解析与换月复权 |
| `scripts/macro-snapshot.mjs` | 统计、评分、异常、偏离、背离与结论级聚合 |
| `scripts/macro-futures.mjs` | 已算品种状态的链级聚合与 raw spread series |
| `scripts/macro-report.mjs` | render-only 日报 |
| `scripts/run-daily.ps1` | Windows fail-fast 编排、source gate 与脱敏日志 |
| `scripts/macro-ai-handoff.mjs` | 从 canonical snapshot 生成精简 AI handoff |
| `scripts/macro-check-handoff.mjs` | handoff contract、lineage、序列与 secret gate |
| `scripts/macro-parity-check.mjs` | 两份 snapshot 的 byte/semantic parity |
| `scripts/install-windows-task.ps1` | 工作日 15:20 Task Scheduler 注册 |
| `templates/macro/workbench.template.html` | 唯一 Macro Cockpit 模板 |
| `scripts/verify.mjs` | 20 项静态与契约 gate |
| `scripts/macro-install-skill.mjs` | staging npm ci、runtime import smoke、备份、原子切换与 source SHA 校验 |

## 命令

真实命令以 `package.json` 为准：

```bash
npm run collect
npm run snapshot
npm run report
npm run workbench
npm run handoff
npm run check-handoff
npm run parity -- --left <snapshot-a> --right <snapshot-b>
npm run run
npm run run:offline
npm run verify
npm run check-skill
npm run install-skill
npm run check-installed
```

## 分发清单

默认安装递归包含 `references/`、`scripts/`、`templates/`、`docs/`、`public/vendor/`，并包含 `SKILL.md`、`MANIFEST.md`、`README.md`、`package.json`、`package-lock.json`。动态产物由 `--with-data` 显式选择。

## 状态

- package：2.0.2
- snapshot contract：`MACRO_SNAPSHOT` 1.1.0
- 六维权重：DRAFT
- 工作台：浅色 V2 Macro Cockpit，单一 ECharts，自包含离线文件
- Current State Audit：`docs/CURRENT_STATE_AUDIT.md`
