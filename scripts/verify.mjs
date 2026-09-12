// 宏观高频监测 · 自检（只读，不改任何文件）
//
// 用法：node scripts/verify.mjs
//
// 为什么不用原仓库那份 20 项 Smoke Test：那份里有一半断言是「原仓库专有」的
//（站点入口 app/monitor/macro、dist 构建产物、治理契约、跨项目文档），
// 放到独立仓库必然失败，会污染信号。这里只保留**与仓库无关、本包自洽**的断言。
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadMacroConfig, SKILL_DIR } from "./macro-config.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

const results = [];
function check(id, title, fn) {
  try {
    results.push({ id, title, ok: true, detail: fn() || "通过" });
  } catch (error) {
    results.push({ id, title, ok: false, detail: error instanceof Error ? error.message : String(error) });
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
const read = p => readFileSync(p, "utf8");

/* 01 配置真源可定位 */
check("01", "配置真源可定位（不依赖任何写死的绝对路径）", () => {
  assert(SKILL_DIR.startsWith(root), `配置真源应在包内，实际 ${SKILL_DIR}`);
  const registry = resolve(SKILL_DIR, "references/indicator_registry.yaml");
  assert(existsSync(registry), "缺少 references/indicator_registry.yaml");
  const ids = (read(registry).match(/^\s*-\s*id:\s*\S+/gm) || []).length;
  assert(ids >= 60, `注册表只解析出 ${ids} 条 id，疑似损坏`);
  return `SKILL_DIR=${SKILL_DIR.replace(root, ".")} · 注册表 ${ids} 条 id（${statSync(registry).size} 字节）`;
});

/* 02 注册表可被代码解析 */
check("02", "注册表可被代码解析，且指标字段完整", () => {
  const config = loadMacroConfig();
  assert(config.indicators.length >= 60, `指标数 ${config.indicators.length} 偏少`);
  assert(config.collectable.length >= 50, `可采集 ${config.collectable.length} 偏少`);
  assert(Object.keys(config.dimensions || {}).length === 6, "维度数应为 6");
  const noDim = config.collectable.filter(i => !i.dimension);
  assert(noDim.length === 0, `缺 dimension：${noDim.map(i => i.id).join(", ")}`);
  return `指标 ${config.indicators.length} / 可采集 ${config.collectable.length} / 派生 ${(config.derived || []).length} / 六维齐备`;
});

/* 03 知识层齐备（agent 能否把它当技能加载） */
check("03", "知识层齐备：SKILL.md frontmatter + 四份 references", () => {
  const skill = read(resolve(root, "SKILL.md"));
  assert(/^---\r?\n/.test(skill), "SKILL.md 缺 YAML frontmatter，agent 无法识别为技能");
  assert(/^name:\s*macro-high-frequency-monitor\s*$/m.test(skill), "frontmatter name 不符");
  assert(/^description:/m.test(skill), "frontmatter 缺 description（技能路由靠它）");
  for (const f of ["indicator_registry.yaml", "futures_chains.yaml", "signal_rules.yaml", "interpretation_framework.md"]) {
    assert(existsSync(resolve(root, "references", f)), `缺少 references/${f}`);
  }
  assert(existsSync(resolve(root, "MANIFEST.md")), "缺少 MANIFEST.md（接手的人靠它定位方案组成）");
  return "SKILL.md frontmatter ✓ · references 四件套 ✓ · MANIFEST.md ✓";
});

/* 04 代码层无写死的绝对路径（换台机器不至于崩） */
check("04", "代码层无写死绝对路径，无仓库外依赖", () => {
  const ABS = /["'](?:[A-Za-z]:[\\/]|\\\\\\)[^"'\n]*["']/g;
  const ALLOW = /https?:|macro_key\.tmp/;
  const offenders = [];
  const files = ["macro-config.mjs", "macro-collect.mjs", "macro-main-contract.mjs", "macro-snapshot.mjs",
    "macro-futures.mjs", "macro-report.mjs", "macro-workbench.mjs", "macro-install-skill.mjs", "verify.mjs"];
  for (const f of files) {
    const p = resolve(root, "scripts", f);
    if (!existsSync(p)) continue;
    const code = read(p).split(/\r?\n/).filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    const hits = (code.match(ABS) || []).filter(s => !ALLOW.test(s));
    if (hits.length) offenders.push(`${f} → ${hits.slice(0, 2).join(" ")}`);
  }
  assert(offenders.length === 0, `发现写死的绝对路径：\n  ${offenders.join("\n  ")}`);
  return `已扫描 ${files.filter(f => existsSync(resolve(root, "scripts", f))).length} 个脚本，无死路径`;
});

/* 05 模板与图表库齐备（工作台能否离线构建） */
check("05", "工作台可离线构建：模板 + ECharts 齐备", () => {
  const tpl = resolve(root, "templates/macro/workbench.template.html");
  const ech = resolve(root, "public/vendor/echarts.min.js");
  assert(existsSync(tpl), "缺少 templates/macro/workbench.template.html");
  assert(existsSync(ech), "缺少 public/vendor/echarts.min.js（工作台需内联它）");
  const t = read(tpl);
  assert(/function drawLine/.test(t), "模板里找不到折线绘制函数，疑似损坏");
  assert(/var RENDERERS|RENDERERS\[/.test(t), "模板缺少 RENDERERS 重画登记表（0×0 canvas 兜底）");
  assert(/chartSelfCheck|chartDiag/.test(t), "模板缺少图表自检兜底");
  return `模板 ${(statSync(tpl).size / 1024).toFixed(0)} KB · ECharts ${(statSync(ech).size / 1024 / 1024).toFixed(1)} MB`;
});

/* 06 若已有快照：验证契约与「今日显著偏离」所需字段 */
check("06", "快照契约：指标与期货品种均带 chg1Extreme", () => {
  const p = resolve(root, "public/macro-snapshot.json");
  if (!existsSync(p)) return "跳过：尚无快照，先运行 npm run collect / snapshot";
  const S = JSON.parse(read(p));
  assert(S.asOf, "快照缺 asOf");
  const ind = S.indicators || [];
  assert(ind.length >= 60, `快照指标数 ${ind.length} 偏少`);
  const daily = ind.filter(i => i.frequency === "daily" && i.chg1Extreme !== null && i.chg1Extreme !== undefined);
  assert(daily.length > 0, "日频指标无一携带 chg1Extreme，「今日显著偏离」会永远为空");
  const varz = ((S.futures || {}).varieties || []).filter(v => v.chg1Extreme !== null && v.chg1Extreme !== undefined);
  assert(varz.length > 0, "期货品种无一携带 chg1Extreme");
  const bad = daily.concat(varz).filter(x => !(x.chg1Extreme >= 0 && x.chg1Extreme <= 1));
  assert(bad.length === 0, `chg1Extreme 越界 ${bad.length} 项（应在 [0,1]）`);
  return `asOf ${S.asOf} · 指标 ${ind.length}（日频带 chg1Extreme ${daily.length}）· 期货带 chg1Extreme ${varz.length}`;
});

/* 07 若已有报告：验证「今日显著偏离」章存在且带结论与口径 */
check("07", "日报「今日显著偏离」：第 2 章 + 结论句 + 口径说明", () => {
  const p = resolve(root, "public/macro-daily-report.md");
  if (!existsSync(p)) return "跳过：尚无日报，先运行 npm run report";
  const md = read(p);
  const headings = md.split(/\r?\n/).filter(l => /^##\s/.test(l));
  assert(headings.length >= 15, `日报只有 ${headings.length} 个章节，疑似未生成完整`);
  assert(/^##\s*二、今日显著偏离/m.test(md), "第 2 章不是「今日显著偏离」（当日变化必须一眼可见）");
  assert(/结论：/.test(md), "缺结论句（「最后要给个结论」）");
  assert(/加注口径/.test(md), "缺口径说明，读数无法复核");
  return `${headings.length} 个章节 · 第 2 章为今日显著偏离 · 结论与口径齐备`;
});

/* ---------------- 输出 ---------------- */
console.log("宏观高频监测 · 自检（只读）");
console.log("=".repeat(88));
for (const r of results) {
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.id}  ${r.title}`);
  console.log(`      ${r.detail}`);
}
const passed = results.filter(r => r.ok).length;
console.log("=".repeat(88));
console.log(`结果：${passed}/${results.length} 通过`);
if (passed < results.length) {
  console.log("失败项：");
  for (const r of results.filter(x => !x.ok)) console.log(`  ${r.id} ${r.title} → ${r.detail}`);
  process.exitCode = 1;
}
