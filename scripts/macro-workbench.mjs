// 宏观高频监测 · 工作台构建器
//
// 单一真源：templates/macro/workbench.template.html（模板，受 git 跟踪的源码）
//           public/macro-snapshot.json（数据，由 macro-snapshot.mjs 产出）
//           public/vendor/echarts.min.js（首个图表库，Spec §24）
//
// 产出：public/macro-workbench.html —— 数据与 ECharts 全部内联，可离线双击打开，
//       也可由站点以 /macro-workbench.html 直接访问。避免维护两套前端。
import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const templatePath = resolve(root, "templates/macro/workbench.template.html");
const snapshotPath = resolve(root, "public/macro-snapshot.json");
const reportPath = resolve(root, "work/macro/report.json");
const reportMdPath = resolve(root, "public/macro-daily-report.md");
const echartsPath = resolve(root, "public/vendor/echarts.min.js");
const outPath = resolve(root, "public/macro-workbench.html");

for (const [label, path] of [["模板", templatePath], ["快照", snapshotPath], ["ECharts", echartsPath]]) {
  if (!existsSync(path)) throw new Error(`${label}不存在：${path}`);
}

const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));
const template = readFileSync(templatePath, "utf8");
const echarts = readFileSync(echartsPath, "utf8");

/** 内联嵌入前裁剪序列长度：日频 500 点（约 2 年，够「宏观市场走势」多图用），月度保留全部历史 */
const TREND_CAP = { daily: 500, weekly: 260 };
function trimForEmbed(data) {
  const copy = JSON.parse(JSON.stringify(data));
  for (const trend of Object.values(copy.trends || {})) {
    const cap = TREND_CAP[trend.frequency];
    if (cap && trend.points.length > cap) trend.points = trend.points.slice(-cap);
  }
  return copy;
}

const embedded = trimForEmbed(snapshot);

// 每日汇报：由 macro-report.mjs 生成，若存在则一并内联，供「每日汇报」面板渲染
if (existsSync(reportPath)) {
  embedded.report = JSON.parse(readFileSync(reportPath, "utf8"));
  if (existsSync(reportMdPath)) embedded.report.markdownInline = readFileSync(reportMdPath, "utf8");
}

// 内联 JS 时把 </script 转义，避免提前闭合 script 标签
function safeInline(text) {
  return text.replace(/<\/script/gi, "<\\/script");
}

const dataJson = safeInline(JSON.stringify(embedded));
const html = template
  .replace("<!--__ECHARTS__-->", `<script>${safeInline(echarts)}</script>`)
  .replace("/*__DATA__*/", dataJson);

writeFileSync(outPath, html, "utf8");

const kb = value => (value / 1024).toFixed(0) + " KB";
console.log(`模板      : ${templatePath}`);
console.log(`数据快照  : ${snapshotPath} (${kb(statSync(snapshotPath).size)})`);
console.log(`内嵌数据  : ${kb(dataJson.length)}（日频序列裁剪至 ${TREND_CAP.daily} 点）`);console.log(`ECharts   : ${kb(echarts.length)}（内联，离线可用）`);
console.log(`→ 工作台  : ${outPath} (${kb(statSync(outPath).size)})`);
console.log("");
console.log(`数据截止  : ${snapshot.asOf} | 综合分 ${snapshot.headline.composite}（${snapshot.headline.label}）`);
if (embedded.report) {
  console.log(`每日汇报  : 已内联 ${embedded.report.sections?.length || 0} 个章节（${embedded.report.title}）`);
} else {
  console.log(`每日汇报  : 未找到 ${reportPath}，请先运行 macro-report.mjs`);
}
console.log(`面板内容  : 每日汇报 / 今日全景 / 六维脉冲 / 结构化简报 / 异动榜 / 背离检测 / 热力图 / 期货全链 / 利率曲线 / 期限结构 / 单指标趋势 / 异常清单 / 口径与质量`);
