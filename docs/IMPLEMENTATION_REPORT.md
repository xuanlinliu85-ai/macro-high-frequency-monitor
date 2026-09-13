# V2 Implementation Report

V2 在原独立仓库上完成治理、频率与可视化升级。Current State Audit 见 `CURRENT_STATE_AUDIT.md`。

## 完成范围

- 全部生产阈值、标准化窗口、评分映射、新鲜度、divergence 参数与 spread 系数迁移到 YAML。
- 宏观指标、期货品种和 spread 统一使用 snapshot 统计引擎。
- divergence 使用显式 evaluator、value field、side 和 minimum usable schema。
- indicator 使用 frequency-native `changeView`，legacy changes 仅作兼容。
- 六维加入 score axis 与语义标签；综合分明确为宏观支持度 / 扩张友好度观察指标。
- report 成为 render-only 层；结论级 delta、聚合、异常、偏离和背离由 snapshot 输出。
- 工作台升级为浅色 Macro Cockpit，保留完整 drill-down 与 canvas 恢复体系。
- verifier 升级为 20 项 gate。
- 安装器加入包外 staging、旧版备份、SHA manifest、rename 切换、回滚与 `--check-installed`。

## 版本

- package：2.0.1
- snapshot：`MACRO_SNAPSHOT` 1.1.0
- report：`MACRO_DAILY_REPORT` 1.1.0
