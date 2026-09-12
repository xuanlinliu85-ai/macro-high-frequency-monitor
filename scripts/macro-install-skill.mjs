// 宏观高频监测 · 技能包安装器
//
// 本仓库本身就是「知识层 + 代码层」合并后的自包含技能包，因此安装 = 把整个包
// 按原布局复制到目标 skills 目录（默认 ~/.codex/skills/macro-high-frequency-monitor）。
//
// 布局保持不变是刻意的：脚本用 `resolve(here, "..")` 找仓库根、用同级的 references/ 找配置，
// 原样复制后这些相对关系全部成立，安装后无需改任何路径。
//
// 用法：
//   npm run install-skill                    # 装到 ~/.codex/skills/
//   node scripts/macro-install-skill.mjs --target <dir>
//   node scripts/macro-install-skill.mjs --check          # 只体检，不写盘
//   node scripts/macro-install-skill.mjs --with-data      # 附带快照与日报（离线可答）
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

const argv = process.argv.slice(2);
const hasFlag = n => argv.includes(`--${n}`);
const flagValue = n => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null;
};

const checkOnly = hasFlag("check");
const withData = hasFlag("with-data");
const target = flagValue("target") || join(homedir(), ".codex", "skills", "macro-high-frequency-monitor");

/** 要装的文件（仓库相对路径）。装到目标目录时保持同样的相对路径 */
const ALWAYS = [
  "SKILL.md", "MANIFEST.md", "README.md",
  "references/indicator_registry.yaml", "references/futures_chains.yaml",
  "references/signal_rules.yaml", "references/interpretation_framework.md",
  "templates/macro/workbench.template.html",
  "public/vendor/echarts.min.js",
];
const SCRIPTS = [
  "macro-config.mjs", "macro-collect.mjs", "macro-main-contract.mjs",
  "macro-snapshot.mjs", "macro-futures.mjs", "macro-report.mjs",
  "macro-workbench.mjs", "macro-install-skill.mjs", "verify.mjs",
].map(n => `scripts/${n}`);
/** docs/ 与 examples/ 整体随包分发：枚举目录而不是写死清单，避免加文档后忘记同步 */
const enumerate = dir => {
  const abs = resolve(root, dir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs).filter(f => f.endsWith(".md")).map(f => `${dir}/${f}`);
};
const DATA = ["public/macro-snapshot.json", "public/macro-daily-report.md"];

const plan = [
  ...ALWAYS,
  ...SCRIPTS,
  ...enumerate("docs"),
  ...enumerate("examples"),
  ...(withData ? DATA : []),
].filter(rel => existsSync(resolve(root, rel)));

/* ---------------- 体检 ---------------- */
let problems = 0;
console.log("宏观高频监测 · 技能包装配");
console.log("=".repeat(80));
console.log(`包根   : ${root}`);
console.log(`目标   : ${target}${checkOnly ? "（仅体检）" : ""}`);
console.log("-".repeat(80));

for (const rel of plan) {
  if (!existsSync(resolve(root, rel))) {
    console.log(`缺失   ${rel}`);
    problems += 1;
  }
}

// 配置真源必须在包内，且注册表能解析出指标 id
const registry = resolve(root, "references/indicator_registry.yaml");
if (existsSync(registry)) {
  const ids = (readFileSync(registry, "utf8").match(/^\s*-\s*id:\s*\S+/gm) || []).length;
  console.log(`注册表 : ${ids} 条 id（${statSync(registry).size} 字节）`);
  if (ids < 60) { console.log("注册表解析出的 id 不足 60 条，装出来的技能不可用"); problems += 1; }
} else {
  console.log("注册表 : 缺失");
  problems += 1;
}

// 死路径体检：脚本里不得出现写死的绝对路径
const ABS = /["'](?:[A-Za-z]:[\\/]|\\\\\\)[^"'\n]*["']/g;
const ALLOW = /https?:|macro_key\.tmp/;
for (const rel of SCRIPTS) {
  const p = resolve(root, rel);
  if (!existsSync(p)) continue;
  const code = readFileSync(p, "utf8").split(/\r?\n/).filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  const hits = (code.match(ABS) || []).filter(s => !ALLOW.test(s));
  if (hits.length) {
    console.log(`死路径 ${rel} → ${hits.slice(0, 3).join(" , ")}`);
    problems += 1;
  }
}

if (problems) {
  console.log("-".repeat(80));
  console.log(`体检未通过：${problems} 处问题，未写入任何文件。`);
  process.exitCode = 1;
} else if (checkOnly) {
  console.log("-".repeat(80));
  console.log(`体检通过：${plan.length} 个文件齐备，无死路径。`);
} else {
  for (const rel of plan) {
    const dest = join(target, rel);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(resolve(root, rel), dest);
  }
  writeFileSync(join(target, "INSTALLED.json"), JSON.stringify({
    name: "macro-high-frequency-monitor",
    installedAt: new Date().toISOString(),
    source: root,
    files: plan.length,
    withData,
  }, null, 2) + "\n", "utf8");
  console.log("-".repeat(80));
  console.log(`已安装 ${plan.length} 个文件 → ${target}`);
  console.log("提示：新建会话即可加载该技能；包内有改动后重跑本命令即完成更新。");
}
