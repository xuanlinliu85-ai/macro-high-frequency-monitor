# Current State Audit — Macro Cockpit V2

审计日期：2026-09-12  
目标仓库：`xuanlinliu85-ai/macro-high-frequency-monitor`  
基线提交：`4d7f6e5bef9b85ab801bfcf156959b4998e9f1c0`  
基线分支：`main`  
基线工作树：干净

## 基线验证

- `node scripts/verify.mjs`：7/7 通过。
- `node scripts/macro-install-skill.mjs --check`：26 个文件齐备。
- 基线 gate 只覆盖 V1 自洽性，尚未覆盖 FINAL 要求的治理、频率、安装与 Macro Cockpit gate。

## 已确认的问题

1. `scripts/macro-report.mjs` 定义 `THRESH`，并据此判断显著偏离、极端、观察项与价差高低位。
2. `scripts/macro-snapshot.mjs` 硬编码标准化窗口、评分映射、综合分档、异常阈值、聚集阈值、背离阈值、新鲜度和停更阈值，并保留 `POLARITY_FALLBACK`。
3. `scripts/macro-futures.mjs` 复制 `std`、`percentileOf`、`pctChange`，计算品种级统计；spread 定义、系数和统计也位于该文件。
4. 指标主展示统一使用 `changes.chg1/chg5/chg20`，月频和季频仍被标成 1 日 / 5 日 / 20 日。
5. `references/signal_rules.yaml` 的 divergence 规则以自然语言描述执行逻辑；snapshot 对全部规则使用同一套 raw-z majority 算法。
6. report 读取历史轻量快照并计算 composite / dimension delta，也计算板块中位数后写入结论。
7. 六维 registry 仅定义名称与成员，缺少 `score_axis`、`high_label`、`neutral_label`、`low_label`。
8. MANIFEST、SKILL 与实施文档保留 `.agents/skills/...`、`app/monitor/macro/page.tsx`、`contracts/`、`db/`、`drizzle/`、`macro:test` 等独立仓库中不存在的身份描述。
9. 安装器使用存在性过滤构建清单，缺文件会被静默剔除；缺少包外 staging、旧版备份、SHA manifest、原子切换和 `--check-installed`。
10. 工作台保留单模板与 ECharts，但第一屏仍以日报/全景/传统面板为中心，缺少变化极端度 × 历史位置散点和结构化背离驾驶舱。

## 已确认并纳入非回归保护的能力

- `macro-collect.mjs` 仅采集和增量落盘，保留 daily / release / full 合并语义。
- EDB 的 `time` 与 `rtime` 分别保存为观测期与发布时间。
- HQ `0` 价格哨兵按缺失处理。
- `.CZC` / `.GFE` 后缀、真实主力月份解析与换月等比复权已经实现。
- `DISCONTINUED` 品种从评分与活跃统计排除。
- 六维权重维持 DRAFT。
- 工作台使用单一 ECharts、单一模板、自包含离线文件。
- `RENDERERS`、canvas 像素诊断、Resize/Intersection/visibility 恢复和单图异常隔离已经实现。

## 本次升级边界

继续使用现有 `collect → snapshot → report → workbench` 链路、同一份 `MACRO_SNAPSHOT`、同一个模板、同一个 ECharts 和同一个安装器。升级直接修改现有文件，不引入并行实现。

## Windows Auto Runner 审计（2026-09-13）

- canonical repo：现有独立仓库；基线 `main` 为 `e4ffa942cdf54734953e70557906004d39d387f2`，工作树干净。
- package 2.0.2 已提供 `collect`、`snapshot`、`report`、`workbench`、verify 与安全安装闭环。
- 仓库此前没有 Windows unattended runner、Task Scheduler 安装器、AI handoff contract、parity checker 或 ai-runtime publisher。
- `.gitignore` 已隔离 `work/` 与三类 public runtime artifact；本次将 `dist/` 纳入相同运行期隔离。
- installer 递归包含 `scripts/` 与 `docs/`，新增薄编排文件会进入 Skill source manifest，无需建立第二套安装系统。
- iFinD local provider 继续动态 import 外部 capability；runner 只显式设置既有 provider 环境并保留 `LEGACY_INSECURE_UPSTREAM` 分类。
- 实施分支：`codex/windows-auto-runner`。Task Scheduler 注册将在 runner 手工验收和分支合并后执行，确保注册任务指向 canonical commit。
