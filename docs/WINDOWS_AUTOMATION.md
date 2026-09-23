# Windows Auto Runner、AI Handoff 与 Parity

## 单一流水线

Windows runner 复用 package scripts：

```text
collect → snapshot → report → workbench → handoff → check-handoff → verify → publish
```

runner 不实现采集、统计、信号、日报或工作台逻辑。任何步骤返回非零即停止，日志位于 `work/logs/daily-YYYY-MM-DD.log`。

生产 runner 固定要求源码分支为 `main`，发布 worktree 分支为 `ai-runtime`。启动时先检查 `ai-runtime` 是否存在领先远端的本地提交；存在时先执行 pending publish retry，确保旧产物获得完整发布机会，然后再进入新一日采集。

## 手工运行

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\run-daily.ps1 `
  -ExpectedCommit <full-40-character-sha> `
  -IfindLocalHome <external-capability-root> `
  -AiRuntimeDir <ai-runtime-worktree> `
  -AllowLegacyInsecureUpstream `
  -PublishHandoff
```

分别通过 `-NodeCommand` 和 `-NpmCommand` 固定 runtime。`NpmCommand` 支持 `npm.cmd` 或明确的 `npm-cli.js` 路径；runner 将 Node 目录加入当前任务进程 PATH，使 package scripts 使用同一个 Node。路径只保存在本机任务定义，不进入 Git，也不修改 User/Machine 环境变量。

runner 明确使用 `IFIND_PROVIDER=local`，要求 external capability root 下存在 `scripts/ifind-mcp-client.mjs`，并要求二次授权。该显式授权同时传递为外部 capability 的 `IFIND_ALLOW_INSECURE_HTTP=1` 进程变量，使两层安全策略表达同一项用户授权；变量不写入系统环境。该路径的安全分类始终是 `LEGACY_INSECURE_UPSTREAM`。

## Task Scheduler

手工 runner 验收通过后注册工作日 15:20 任务：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\install-windows-task.ps1 `
  -ExpectedCommit <full-40-character-sha> `
  -IfindLocalHome <external-capability-root> `
  -AiRuntimeDir <ai-runtime-worktree>
```

默认任务名为 `MacroHighFrequencyMonitorDaily`。任务以当前 Windows 用户的 Interactive logon type 运行，开启 StartWhenAvailable，允许电池供电，最长运行两小时。任务定义不包含 API key。卸载使用 `scripts/uninstall-windows-task.ps1`。两个脚本支持 `-WhatIf`。

## AI handoff

`npm run handoff` 从 `public/macro-snapshot.json` 生成 `dist/ai-handoff-latest.json`。它保留 headline、六维、偏离、异常、背离、聚合、新鲜度、期货当前状态、signals 与 `futures.graph.edges`，并移除 observations、history、series、trends 与 spread points。

handoff contract 固定为 `AI_MACRO_HANDOFF 1.0.0`。`npm run check-handoff` 检查 contract/version、snapshot contract/version、asOf、generatedAt、snapshot SHA-256、source commit/clean、六维、headline、freshness、summary blocks、期货当前状态、graph lineage、raw series、secret 与 credential key。

## 两份 snapshot parity

```bash
npm run parity -- --left <snapshot-a> --right <snapshot-b> --output work/parity/<date>.json
```

输出包含文件 SHA-256、`BYTE_EXACT_MATCH` 和 `SEMANTIC_PARITY`。semantic projection 忽略生成时间与历史 raw series，比较 headline、dimensions、deviations、anomalies、divergences、aggregates 与 futures current state。三天 parity 使用同一 canonical commit 独立生成的两份 snapshot。

## 生产 ai-runtime 发布

预先创建独立 ai-runtime worktree 并切换到 `ai-runtime` 分支。runner 先生成 `handoff-check-result.json` 与 `verify-result.json`，发布器核对两份 PASS receipt、sourceCommit、snapshot SHA 和 dateQuality coverage，再发布：

```text
AI_HANDOFF_META.json
ai-handoff-latest.json
macro-daily-report.md
macro-snapshot.json
macro-workbench.html
history/<tradingDataAsOf>/...
```

`AI_HANDOFF_META.json` 是 ChatGPT 唯一入口，包含 `tradingDataAsOf / generatedAt / runDate / dateQuality / sourceCommit / sourceDirty / snapshotSha256 / handoffSha256 / reportSha256 / validationStatus / remotePublishCommit`。`remotePublishCommit` 指向承载当日产物内容的 artifact commit；随后 metadata receipt commit 成为远端分支 HEAD。

发布器首次 push 失败后按 30 / 60 / 120 / 240 / 480 秒退避重试。重试耗尽时，本地提交保持完整；下一次 runner 启动先执行 `publish-handoff -- --retry-pending-only`。新的采集始终在 pending publish 处理完成后启动。

## 凭据与恢复

- API key 只来自进程环境；runner 日志对 Bearer 和 query credential 执行脱敏。
- Task Scheduler 参数只包含 repo、external capability、runtime 路径与 commit。
- runner 用完整 commit 和 tracked source 状态固定 canonical source。
- 正式发布前保留现有 Skill、backup、V2 worktree 与 feature branch；回滚使用现有安装器 backup 机制。
