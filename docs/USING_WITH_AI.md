# 让别人（ChatGPT / Codex）读懂并改进这个方案

**仓库地址**：<https://github.com/xuanlinliu85-ai/macro-high-frequency-monitor> （public，只读即可）

本仓库本身就是**自包含**的：知识层（技能定义 + 配置真源）与代码层（流水线）在同一个仓库里，
不依赖任何外部目录。所以「让别人读到」这件事只需要**把仓库给它**。

## 一、给 ChatGPT 读

### 方式 A：仓库公开 + 直接给两个入口（最省事）

把仓库设为 public，然后让它先读这两页：

```text
https://github.com/xuanlinliu85-ai/macro-high-frequency-monitor/blob/main/MANIFEST.md    ← 方案由什么组成、数据流、代码文件地图、待完善清单
https://github.com/xuanlinliu85-ai/macro-high-frequency-monitor/blob/main/SKILL.md       ← 技能定义、调用契约、解释框架、口径纪律
```

`MANIFEST.md` 里有一张「按顺序读什么」的表，它会自己往下读。

> **公开前的红线**：确认仓库里**没有** API key、`.env`、授权行情数据、客户/个人信息。
> 本仓库的 `.gitignore` 已经把快照、日报、工作台 HTML、`work/` 全部排除，
> 密钥只通过环境变量传入 —— 但**提交前仍请自己再看一眼**。

### 方式 B：ChatGPT 的 GitHub 连接器

账号支持的话，连接仓库后可检索/读取文件，无需公开。适合仓库必须保持 private 的情况。

### 方式 C：手工投喂（不依赖任何连接器，最稳）

把这几个文件贴进对话或 Project：

```text
MANIFEST.md
SKILL.md
references/indicator_registry.yaml
references/signal_rules.yaml
references/futures_chains.yaml
references/interpretation_framework.md
docs/ARCHITECTURE.md
docs/DATA_CONTRACT.md
docs/DEVIATION_RULES.md
```

### 建议开场白（照抄即可）

```text
这是一个「中国宏观高频监测」的自包含方案仓库。请先读 MANIFEST.md，再读 SKILL.md，
然后按 MANIFEST 里的阅读顺序按需展开。

改动时的硬约束（违反即为破坏性改动）：
1. zscore / percentile / change / chg1Extreme 必须由 scripts/macro-snapshot.mjs 算出并写进快照，
   解释层不得重算数字；
2. 不新建第二套前端 / 第二个图表库 / 第二个 scheduler / 第二份数据契约；
3. 不写死绝对路径（npm run verify 第 04 项会扫描）；源码不放 work/（那是产物区且被 gitignore）；
4. 指标语义与阈值只写在 references/*.yaml，SKILL.md 内不得出现字段代码清单或数值阈值；
5. 频率不可混算：日频只看 1D/5D/20D，月频只看 MoM/YoY/3M。

请先指出方案中自相矛盾、口径不清、或与上述约束冲突的地方，再给改进建议。
```

## 二、装到 Codex

```bash
npm run check-skill      # 装配体检：清单齐备、无死路径、注册表可解析
npm run install-skill    # 装到 ~/.codex/skills/macro-high-frequency-monitor
```

装出来的结构与本仓库布局**保持一致**（这是刻意的）：脚本用 `resolve(here, "..")` 找包根、
用同级 `references/` 找配置，因此原样复制后相对关系全部成立，**不需要改任何路径**。

```text
~/.codex/skills/macro-high-frequency-monitor/
├── SKILL.md            ← agent 靠 frontmatter 的 name + description 路由到它
├── MANIFEST.md  README.md  INSTALLED.json
├── references/         （配置真源）
├── scripts/            （流水线 + 安装器 + 自检）
├── templates/macro/    （工作台模板）
├── docs/  examples/
└── public/vendor/echarts.min.js
```

**另一种用法**：如果你的 agent 支持仓库级技能约定（`<项目>/.agents/skills/<name>/SKILL.md`），
把本仓库放到该位置即可，无需安装。

**回环**：改进 → `npm run verify` 通过 → `npm run install-skill` 刷新 agent 侧 → 提交。

## 三、命令速查

| 目的 | 命令 |
|---|---|
| 只读自检 | `npm run verify` |
| 完整流水线（需 iFinD） | `npm run run` |
| 离线重跑（只要 `work/macro/observations.json` 在） | `npm run run:offline` |
| 技能装配体检 | `npm run check-skill` |
| 安装/刷新技能 | `npm run install-skill` |
| 装到别处 | `node scripts/macro-install-skill.mjs --target <dir>` |
| 附带快照与日报（离线可答） | `node scripts/macro-install-skill.mjs --with-data` |
