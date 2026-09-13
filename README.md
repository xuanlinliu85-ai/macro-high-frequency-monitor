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
npm run handoff
npm run check-handoff
npm run parity -- --left <snapshot-a> --right <snapshot-b>
npm run run
npm run run:offline
npm run verify
npm run check-skill
```

## Windows 自动运行与 AI handoff

Windows runner 只编排现有 `collect → snapshot → report → workbench` 主链，并追加 `handoff → check-handoff`。它要求完整 `ExpectedCommit`、干净的 tracked source、可定位的 Node/npm，以及对 `LEGACY_INSECURE_UPSTREAM` 的显式授权；日志写入 `work/logs/`并执行凭据脱敏。

`npm run handoff` 从 `MACRO_SNAPSHOT 1.1.0` 生成 `dist/ai-handoff-latest.json`，保留 headline、六维状态、异常、背离、聚合、新鲜度与期货当前状态，并移除历史序列、observations 与 spread points。`npm run check-handoff` 校验 contract、source SHA/commit/clean、六维、产业链 edges 真源、raw series 与凭据隔离。

Task Scheduler 注册、手工 runner 验证、parity 与可选 `ai-runtime` 发布命令见 `docs/WINDOWS_AUTOMATION.md`。发布器只接受预先存在且位于指定 `ai-runtime` 分支的 worktree，发布失败不改变本地主链产物。

采集模式通过 `MACRO_MODE=daily|release|full` 设置。iFinD provider 默认 fail closed：`IFIND_PROVIDER` 必须显式设置为 `local` 或 `https-mcp`，系统不会隐式选择连接路径。

兼容既有生产链路必须同时显式设置 `IFIND_PROVIDER=local`、`IFIND_LOCAL_HOME=<external capability root>`、`IFIND_ALLOW_LEGACY_INSECURE_UPSTREAM=1`。Macro Monitor 动态 import capability root 下的 `scripts/ifind-mcp-client.mjs`，仅复用其 `listTools()`、`callTool()`、`close()` 接口，不复制或重写 THS 调用实现。当前本地模块的 upstream 是公网 HTTP，并通过 query credential 鉴权，安全分类为 `LEGACY_INSECURE_UPSTREAM`；授权变量只表示用户接受当前兼容风险，不改变底层 transport，也不构成安全连接。

官方 HTTPS MCP 完成验证后，可显式设置 `IFIND_PROVIDER=https-mcp`，同时提供 `IFIND_API_KEY` 与 `IFIND_MCP_BASE_URL`；API key 通过 `Authorization` header 传输，endpoint 中保持无凭据状态。可信内网/VPN 的 HTTP endpoint 还要求 `IFIND_MCP_ALLOW_INSECURE_HTTP=1`。

## Macro Cockpit

第一屏展示数据截止、综合状态、较前快照变化、新鲜度、显著偏离、背离触发、六维状态卡、变化极端度 × 历史位置散点和四类结构化背离。

后续页面依次提供跨资产同步时间轴、基本面、增长 × 通胀象限、期货产业链 graph、价差、链内信号，以及单指标、单品种、国债曲线、期限结构、全指标表、完整日报和 Lineage。

颜色语义：原始市场涨跌使用红涨绿跌；宏观改善、恶化和中性使用蓝、橙、灰。

## 安装 Codex Skill

```bash
npm run install-skill
npm run check-installed
```

安装器把 `.gitignore`、源码与 lockfile 纳入 source manifest，先在 `~/.codex/.skill-staging/` 执行 `npm ci --omit=dev`，再完成 runtime import smoke、配置、verify 与 source SHA 检查；全部通过后将现有版本移动到 `~/.codex/skill-backups/`，并切换到 `~/.codex/skills/macro-high-frequency-monitor`。依赖安装失败时 staging 保留供排查，正式 Skill 保持原版本。`--check-installed` 校验 `package-lock.json` 与全部 source SHA，并运行同一 import smoke；`node_modules` 由 lockfile 重建，不进入 SHA manifest。

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

升级前与 Windows runner 审计见 `docs/CURRENT_STATE_AUDIT.md`，数据契约见 `docs/DATA_CONTRACT.md`，架构不变量见 `docs/ARCHITECTURE.md`，自动运行说明见 `docs/WINDOWS_AUTOMATION.md`。
