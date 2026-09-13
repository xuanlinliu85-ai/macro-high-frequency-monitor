# 中国宏观高频监测 V2 · Macro Cockpit

独立仓库：`xuanlinliu85-ai/macro-high-frequency-monitor`。

V2 把 69 项宏观指标与 61 个期货品种统一收口到 snapshot 统计引擎，生成频率原生变化、六维语义状态、显著偏离、结构化背离、产业链传导、完整日报和可离线打开的 Macro Cockpit。

## 架构

```text
collect → observations.json → snapshot → MACRO_SNAPSHOT 1.1.0 → report → workbench
```

- YAML 是指标语义、阈值、evaluator 和 spread 系数真源。
- `macro-snapshot.mjs` 是信号与统计计算真源。
- `macro-report.mjs` 是 render-only 层。
- `workbench.template.html` 是唯一前端，图表库为 ECharts。

## 运行

要求 Node 22+。仓库依赖由 `package-lock.json` 锁定，首次运行先执行 `npm ci`。

```bash
npm run collect
npm run snapshot
npm run report
npm run workbench
npm run run
npm run run:offline
npm run verify
npm run check-skill
```

采集模式通过 `MACRO_MODE=daily|release|full` 设置。生产默认使用 `IFIND_PROVIDER=local`，并通过 `IFIND_LOCAL_HOME` 指向已安装、已验证的本地 iFinD 能力根目录；Macro Monitor 动态 import 该目录下的 `scripts/ifind-mcp-client.mjs`，仅复用其 `listTools()`、`callTool()`、`close()` 接口，不复制或重写 THS 调用实现。

当前本地模块的 upstream 是公网 HTTP，并通过 query credential 鉴权，安全分类为 `LEGACY_INSECURE_UPSTREAM`。该 provider 用于恢复既有生产兼容性，运行环境应采用可信网络隔离。官方 HTTPS MCP 完成验证后，可显式设置 `IFIND_PROVIDER=https-mcp`，同时提供 `IFIND_API_KEY` 与 `IFIND_MCP_BASE_URL`；API key 通过 `Authorization` header 传输，endpoint 中保持无凭据状态。可信内网/VPN 的 HTTP endpoint 还要求 `IFIND_MCP_ALLOW_INSECURE_HTTP=1`。

## Macro Cockpit

第一屏展示数据截止、综合状态、较前快照变化、新鲜度、显著偏离、背离触发、六维状态卡、变化极端度 × 历史位置散点和四类结构化背离。

后续页面依次提供跨资产同步时间轴、基本面、增长 × 通胀象限、期货产业链 graph、价差、链内信号，以及单指标、单品种、国债曲线、期限结构、全指标表、完整日报和 Lineage。

颜色语义：原始市场涨跌使用红涨绿跌；宏观改善、恶化和中性使用蓝、橙、灰。

## 安装 Codex Skill

```bash
npm run install-skill
npm run check-installed
```

安装器先在 `~/.codex/.skill-staging/` 执行 `npm ci --omit=dev`，再完成 runtime import smoke、配置、verify 与 source SHA 检查；全部通过后将现有版本移动到 `~/.codex/skill-backups/`，并切换到 `~/.codex/skills/macro-high-frequency-monitor`。依赖安装失败时 staging 保留供排查，正式 Skill 保持原版本。`--check-installed` 校验 `package-lock.json` 与全部 source SHA，并运行同一 import smoke；`node_modules` 由 lockfile 重建，不进入 SHA manifest。

`--with-data` 仅附带允许分发的最新 snapshot 与 Markdown 日报，用于离线阅读。完整离线 pipeline 使用 `work/macro/observations.json`。

## 目录

```text
SKILL.md
MANIFEST.md
README.md
package.json
package-lock.json
references/
scripts/
templates/
docs/
public/vendor/
```

升级前审计见 `docs/CURRENT_STATE_AUDIT.md`，数据契约见 `docs/DATA_CONTRACT.md`，架构不变量见 `docs/ARCHITECTURE.md`。
