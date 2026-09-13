/**
 * MACRO_DAILY_REPORT 纯渲染层。
 * 所有判定、标签、聚合、delta 与榜单成员均来自 public/macro-snapshot.json。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const snapshotPath = resolve(root, "public/macro-snapshot.json");
if (!existsSync(snapshotPath)) throw new Error("缺少 public/macro-snapshot.json，请先运行 npm run snapshot");
const S = JSON.parse(readFileSync(snapshotPath, "utf8"));
if (S.contract !== "MACRO_SNAPSHOT") throw new Error(`未知快照契约 ${S.contract}`);

const has = value => value !== null && value !== undefined;
const signed = (value, digits = 2) => !has(value) ? "—" : `${value > 0 ? "+" : ""}${Number(value).toFixed(digits)}`;
const percent = (value, digits = 1) => !has(value) ? "—" : `${value > 0 ? "+" : ""}${(Number(value) * 100).toFixed(digits)}%`;
const percentile = value => !has(value) ? "—" : `${(Number(value) * 100).toFixed(0)}%`;
const latest = item => has(item?.latest?.value) ? `${item.latest.value}${item.unit ? ` ${item.unit}` : ""}` : "—";
const P = text => ({ type: "p", text });
const note = text => ({ type: "note", text });
const UL = items => ({ type: "ul", items });
const table = (head, rows) => ({ type: "table", head, rows });
const dimName = Object.fromEntries((S.dimensions || []).map(item => [item.key, item.name_cn]));

function changeText(item) {
  return (item.changeView?.items || []).map(change => {
    if (change.status === "unavailable") return `${change.label} unavailable`;
    if (typeof change.value === "string") return `${change.label} ${change.value}`;
    return `${change.label} ${signed(change.value)}`;
  }).join("｜") || "unavailable";
}

function deviationRows(items) {
  return (items || []).map(item => [item.name_cn, item.frequency || "daily", latest(item),
    has(item.d1) ? percent(item.d1) : has(item.pctChg1) ? percent(item.pctChg1) : signed(item.changes?.chg1),
    percentile(item.chg1Extreme), signed(item.z1y), (item.tags || []).join("、")]);
}

function categorySection(id, title, categories) {
  const rows = (S.indicators || []).filter(item => categories.includes(item.category));
  return { id, title, tag: `${rows.length} indicators`, blocks: [
    table(["指标", "频率", "最新", "频率原生变化", "z(1Y)", "1年分位", "状态"], rows.map(item => [
      item.name_cn, item.frequency, latest(item), changeText(item), signed(item.z1y), percentile(item.pct1y), item.status,
    ])),
  ] };
}

const sections = [];
sections.push({ id: "summary", title: "摘要", tag: S.headline.label, blocks: [
  UL(S.brief?.lines || []),
  table(["数据截止", "综合支持度", "较前快照", "显著偏离", "背离", "异常"], [[S.asOf,
    S.headline.composite, signed(S.headline.compositeDelta, 1), S.headline.notableDeviationCount,
    S.headline.divergenceHits, S.headline.anomalyCount]]),
] });
sections.push({ id: "deviations", title: "今日显著偏离", tag: `${S.deviations?.total || 0}`, blocks: [
  P(`结论：今日 ${S.deviations?.total || 0} 项显著偏离，其中极端 ${S.deviations?.extreme || 0} 项。成员与标签均由 snapshot 判定。`),
  P("上涨侧"), table(["项目", "频率", "最新", "1D", "变化极端度", "z(1Y)", "标签"], deviationRows(S.deviations?.up)),
  P("下跌侧"), table(["项目", "频率", "最新", "1D", "变化极端度", "z(1Y)", "标签"], deviationRows(S.deviations?.down)),
  P("月频 / 季频发布观察（观测期与今日不同）"), table(["项目", "频率", "最新", "变化", "变化极端度", "z(1Y)", "标签"], deviationRows(S.deviations?.releaseFrequency)),
  note("加注口径：isNotable、deviationLevel 与 tags 直接来自 snapshot；本报告只展示结果。"),
] });
sections.push({ id: "dimensions", title: "宏观六维状态", tag: "Semantic axes", blocks: [
  table(["维度", "得分", "语义标签", "较前快照", "轴定义", "覆盖"], (S.dimensions || []).map(item => [
    item.name_cn, item.score, item.semanticLabel, signed(item.delta, 1), item.scoreAxis, `${item.coverage.used}/${item.coverage.configured}`,
  ])),
  note(S.scoringModel?.compositeDefinition + "；" + S.scoringModel?.disclaimer),
] });
sections.push(categorySection("rates", "利率与资金面", ["rates", "liquidity"]));
sections.push(categorySection("risk-fx", "权益与汇率", ["risk", "fx"]));
sections.push(categorySection("credit", "货币与信用", ["credit"]));
sections.push(categorySection("growth", "增长与景气", ["growth", "sentiment"]));
sections.push(categorySection("inflation", "通胀", ["inflation"]));
sections.push(categorySection("property", "地产", ["property"]));
sections.push(categorySection("consumption-external", "消费与外需", ["consumption", "external"]));
sections.push({ id: "divergence", title: "结构化背离", tag: `${S.headline.divergenceHits} hits`, blocks: [
  table(["状态", "规则", "Evaluator", "Side A", "Side B", "严重度", "可证伪问题"], (S.divergences || []).map(item => [
    item.hit ? "触发" : "未触发", item.name_cn, `${item.evaluator}/${item.valueField}`,
    `${item.sideA.label} ${item.sideA.direction} (${item.sideA.usable})`, `${item.sideB.label} ${item.sideB.direction} (${item.sideB.usable})`,
    item.severity, item.question,
  ])),
] });
sections.push({ id: "anomalies", title: "重点异常", tag: `${S.anomalies?.length || 0}`, blocks: [
  table(["严重度", "指标", "维度", "z(1Y)", "3年分位", "触发器"], (S.anomalies || []).map(item => [
    item.severity, item.name_cn, dimName[item.dimension] || item.dimension || "—", signed(item.z1y), percentile(item.pct3y),
    (item.triggers || []).map(trigger => trigger.id).join("、"),
  ])),
] });
sections.push({ id: "futures-overview", title: "期货产业链总览", tag: `${S.futures?.chainCount || 0} chains`, blocks: [
  table(["产业链", "1D", "5D", "20D", "广度", "z(1Y)", "活跃/总"], (S.futures?.chains || []).map(item => [
    item.name_cn, percent(item.metrics.d1), percent(item.metrics.d5), percent(item.metrics.d20),
    percentile(item.metrics.breadth), signed(item.metrics.z1y), `${item.liveCount}/${item.memberCount}`,
  ])),
] });
sections.push({ id: "futures-varieties", title: "期货品种明细", tag: `${S.futures?.varietyCount || 0}`, blocks: [
  table(["品种", "链条", "最新", "1D", "5D", "20D", "z(1Y)", "1年分位", "状态"], (S.futures?.varieties || []).map(item => [
    item.name_cn, item.chain_cn, item.value, percent(item.d1), percent(item.d5), percent(item.d20), signed(item.z1y), percentile(item.pct1y), item.status,
  ])),
] });
sections.push({ id: "spreads", title: "主力价差", tag: "YAML definitions", blocks: [
  table(["价差", "最新", "1D", "5D", "20D", "z(1Y)", "1年分位", "标签"], (S.futures?.spreads || []).map(item => [
    item.name_cn, item.available ? item.value : "unavailable", item.available ? (item.changeMode === "pct" ? percent(item.d1) : signed(item.d1)) : "—",
    item.available ? (item.changeMode === "pct" ? percent(item.d5) : signed(item.d5)) : "—",
    item.available ? (item.changeMode === "pct" ? percent(item.d20) : signed(item.d20)) : "—",
    signed(item.z1y), percentile(item.pct1y), (item.tags || []).join("、"),
  ])),
] });
sections.push({ id: "transmission", title: "链内传导信号", tag: `${S.futures?.signals?.length || 0}`, blocks: [
  table(["产业链", "严重度", "上游", "下游", "差值", "含义"], (S.futures?.signals || []).map(item => [
    item.chain_cn, item.severity, `${item.sideA.label} ${percent(item.sideA.value)}`, `${item.sideB.label} ${percent(item.sideB.value)}`,
    percent(item.difference), item.implication,
  ])),
] });
sections.push({ id: "all-indicators", title: "全指标总表", tag: `${S.indicators?.length || 0}`, blocks: [
  table(["指标", "板块", "维度", "频率", "最新", "频率原生变化", "z", "方向z", "状态"], (S.indicators || []).map(item => [
    item.name_cn, item.category, dimName[item.dimension] || item.dimension, item.frequency, latest(item), changeText(item),
    signed(item.z1y), signed(item.dirZ), item.status,
  ])),
] });
sections.push({ id: "quality", title: "数据质量与 Lineage", tag: "Audit", blocks: [
  table(["项", "值"], [["契约", `${S.contract} ${S.version}`], ["数据截止", S.asOf], ["采集时间", S.source?.collectedAt],
    ["配置版本", S.source?.registry?.version], ["可评分", `${S.headline.indicatorScorable}/${S.headline.indicatorTotal}`],
    ["权重状态", S.scoringModel?.weightProfileStatus]]),
  UL((S.dataQuality?.degraded || []).map(item => `${item.name_cn}：${item.status}（${item.ageDays ?? "—"} calendar days）`)),
  note("报告由 scripts/macro-report.mjs 渲染；统计、标签、聚合与结论级 delta 均来自 snapshot。"),
] });

const cn = index => ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十", "十一", "十二", "十三", "十四", "十五", "十六", "十七", "十八", "十九", "二十"][index] || String(index + 1);
const numbered = sections.map((section, index) => ({ ...section, order: index + 1, title: `${cn(index)}、${section.title}` }));
function blocksToMarkdown(blocks) {
  const lines = [];
  for (const block of blocks) {
    if (block.type === "p") lines.push(block.text, "");
    if (block.type === "note") lines.push(`> ${block.text}`, "");
    if (block.type === "ul") lines.push(...(block.items.length ? block.items.map(item => `- ${item}`) : ["- 无"]), "");
    if (block.type === "table") {
      lines.push(`| ${block.head.join(" | ")} |`, `| ${block.head.map(() => "---").join(" | ")} |`);
      for (const row of block.rows) lines.push(`| ${row.map(value => String(value ?? "—").replaceAll("|", "\\|")).join(" | ")} |`);
      if (!block.rows.length) lines.push(`| ${["无", ...block.head.slice(1).map(() => "—")].join(" | ")} |`);
      lines.push("");
    }
  }
  return lines.join("\n");
}

const generatedAt = new Date().toISOString();
const title = "宏观高频 × 期货产业链 · 每日汇报";
const markdown = [`# ${title}`, "", `**${S.asOf}｜宏观支持度 ${S.headline.composite}（${S.headline.label}）**`, "",
  `> 生成时间 ${generatedAt}｜所有判断来自 \`public/macro-snapshot.json\`。`, "",
  ...numbered.flatMap(section => [`## ${section.title}`, "", blocksToMarkdown(section.blocks)])].join("\n");
const publicPath = resolve(root, "public/macro-daily-report.md");
const reportDir = resolve(root, "work/macro/reports");
mkdirSync(reportDir, { recursive: true });
writeFileSync(publicPath, markdown, "utf8");
writeFileSync(resolve(reportDir, `${S.asOf}.md`), markdown, "utf8");
const report = { contract: "MACRO_DAILY_REPORT", version: "1.1.0", asOf: S.asOf, generatedAt, title,
  subtitle: `${S.asOf}｜宏观支持度 ${S.headline.composite}（${S.headline.label}）`, tone: S.headline.label,
  composite: S.headline.composite, summaryLine: S.brief?.lines?.[0] || "", sections: numbered };
writeFileSync(resolve(root, "work/macro/report.json"), JSON.stringify(report, null, 2), "utf8");
console.log(`${title} · ${numbered.length} sections · render-only`);
console.log("→ public/macro-daily-report.md");
console.log("→ work/macro/report.json");
