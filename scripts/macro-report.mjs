// 宏观高频监测 · 每日汇报生成器
//
// 输入（唯一数据源）：
//   public/macro-snapshot.json          —— 所有 z / 分位 / 涨跌幅 / 广度已由 macro-snapshot.mjs 算好
//   work/macro/snapshots/<日期>.json    —— 历史轻量快照，用于日间对比（可选）
//
// 输出：
//   public/macro-daily-report.md        当日汇报（Markdown，可直接阅读 / 转发 / 贴进周会材料）
//   work/macro/reports/<asOf>.md        历史归档
//   work/macro/report.json              结构化区块，供工作台「每日汇报」面板渲染
//
// 铁律（Spec §37）：本模块不做任何重新计算，也不调用 LLM。
//   筛选、排序、四舍五入、措辞拼装全部由代码完成；出现的每个数字都来自 snapshot。
//   唯一的新增语义是「阈值判定」（如 |z|≥2 视为统计极端），阈值写在本文件顶部的 THRESH 中，便于审计。
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const snapshotPath = resolve(root, "public/macro-snapshot.json");
const historyDir = resolve(root, "work/macro/snapshots");
const reportDir = resolve(root, "work/macro/reports");
const mdOut = resolve(root, "public/macro-daily-report.md");
const jsonOut = resolve(root, "work/macro/report.json");

if (!existsSync(snapshotPath)) throw new Error(`快照不存在，请先运行 macro-snapshot.mjs：${snapshotPath}`);
const S = JSON.parse(readFileSync(snapshotPath, "utf8"));

/* ============================================================
 * 阈值（唯一人工配置项，集中在此，便于复核）
 * ============================================================ */
const THRESH = {
  zExtreme: 2,          // |z(1Y)| ≥ 2 视为统计极端
  pctHigh: 0.95,        // 3 年 / 1 年分位 ≥ 95% 视为高位
  pctLow: 0.05,         // ≤ 5% 视为低位
  oiSurge: 0.3,         // |持仓量 5 日变化| ≥ 30% 视为异动
  tierGapPct: 3,        // 上下游 20 日中位数差 ≥ 3 个百分点视为传导信号
  moversTop: 5,         // 极值榜条数
  anomalyTop: 10,       // 异常清单条数
  futuresMoverTop: 10,  // 期货涨跌榜条数
  /* 「今日显著偏离」专用 */
  chgExtreme: 0.9,      // |1 期变化| 落在自身近 3 年单期变化分布的前 10%，即视为当日偏离
  chgExtremeStrong: 0.97, // 前 3%：措辞升级为「极端」
  deviationTop: 6,      // 涨幅榜 / 跌幅榜各取几项
};

/* ============================================================
 * 格式化工具（纯展示，不改数值）
 * ============================================================ */
const has = v => v !== null && v !== undefined && Number.isFinite(v);

const UNIT_CN = {
  cny_per_ton: "元/吨",
  cny_per_barrel: "元/桶",
  cny_per_m3: "元/立方米",
  cny_per_kg: "元/千克",
  cny_per_gram: "元/克",
  cny_per_500kg: "元/500千克",
  cny: "元",
  point: "点",
  pct: "%",
  index: "指数",
  usd_per_barrel: "美元/桶",
  usd_per_ton: "美元/吨",
};
const unitCn = u => (u && UNIT_CN[u]) || "";

/** 带符号百分比，输入为小数（0.128 → +12.8%） */
function pct(v, d = 1) {
  if (!has(v)) return "—";
  return (v > 0 ? "+" : v < 0 ? "-" : "") + Math.abs(v * 100).toFixed(d) + "%";
}
/** 无符号百分比（分位、广度等，输入为小数） */
function pctRaw(v, d = 1) {
  if (!has(v)) return "—";
  return (v * 100).toFixed(d) + "%";
}
/** 带符号数值，用于 z 值、绝对价差变化 */
function sgn(v, d = 2) {
  if (!has(v)) return "—";
  return (v > 0 ? "+" : v < 0 ? "-" : "") + Math.abs(v).toFixed(d);
}
/** 价格类数值：按量级自动定小数位 */
function price(v, d) {
  if (!has(v)) return "—";
  if (d !== undefined) return v.toFixed(d);
  const a = Math.abs(v);
  if (a >= 10000) return v.toFixed(0);
  if (a >= 100) return Number.isInteger(v) ? v.toFixed(0) : v.toFixed(1);
  if (a >= 1) return v.toFixed(2).replace(/0$/, "");
  return v.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
}
/** 最新值 + 单位，用于异常清单 */
function valueWithUnit(v, unit) {
  if (!has(v)) return "—";
  if (unit === "pct") return v.toFixed(2) + "%";
  if (unit === "index") return v.toFixed(1);
  const body = price(v);
  const u = unitCn(unit);
  return u ? `${body} ${u}` : body;
}
/** 周期中文名 */
const FREQ_CN = { daily: "日", weekly: "周", monthly: "月", quarterly: "季" };
const DIM_CN = {
  growth: "增长", consumption: "消费", property: "地产",
  inflation: "通胀", liquidity: "流动性", external: "外需",
};
/** 指标板块中文名（模块级，供各章节统一取用，避免各处重定义） */
const CAT_CN = {
  rates: "利率", liquidity: "资金面", risk: "权益", fx: "汇率", credit: "货币与信用",
  growth: "增长", sentiment: "景气调查", inflation: "通胀", property: "地产",
  consumption: "消费", external: "外需",
};
const CAT_CN_OF = c => CAT_CN[c] || c || "其他";

/* ------------------------------------------------------------------ */
/* 走势可视化：Unicode 迷你走势图                                        */
/*   为什么不用 SVG：报告是 Markdown，纯文本 sparkline 在任何查看器里都能渲染， */
/*   且在等宽字体下天然对齐。工作台里的同一份序列会渲染成真正的 ECharts 折线。 */
/* ------------------------------------------------------------------ */
const SPARK = "▁▂▃▄▅▆▇█";
/** 近一年对应的观测条数（按频率换算），与「1年分位」口径对齐 */
const ONE_YEAR = { daily: 250, weekly: 52, monthly: 12, quarterly: 4 };
function sparkline(id, buckets = 30) {
  const t = (S.trends || {})[id];
  if (!t || !Array.isArray(t.points)) return "—";
  const cap = ONE_YEAR[t.frequency] || 250;
  const raw = t.points.length > cap ? t.points.slice(-cap) : t.points;
  const pts = raw.map(p => p[1]).filter(v => has(v));
  if (pts.length < 4) return "—";
  const out = [];
  const step = pts.length / buckets;
  for (let i = 0; i < buckets; i += 1) {
    const from = Math.floor(i * step);
    const to = Math.max(Math.floor((i + 1) * step), from + 1);
    const seg = pts.slice(from, to);
    out.push(seg.reduce((a, b) => a + b, 0) / seg.length);
  }
  const min = Math.min(...out);
  const max = Math.max(...out);
  const span = max - min;
  if (span < 1e-9) return "`" + SPARK[3].repeat(out.length) + "`";
  return "`" + out.map(v => SPARK[Math.min(7, Math.max(0, Math.round(((v - min) / span) * 7)))]).join("") + "`";
}
function arrow(v, eps = 1e-9) {
  if (!has(v)) return "";
  if (v > eps) return "↗";
  if (v < -eps) return "↘";
  return "→";
}

/* ------------------------------------------------------------------ */
/* 指标表：最新值 / 1日 / 5日 / 20日 / 一年走势 / 分位 / z               */
/*   变化口径按单位分流，避免把「收益率上行 2bp」写成「+1.2%」：          */
/*     pct          → 绝对变化，单位百分点(pp)                          */
/*     index（股指）→ 百分比变化                                        */
/*     index（其他）→ 绝对变化，单位点                                  */
/*     其余（价格/金额）→ 百分比变化                                     */
/* ------------------------------------------------------------------ */
const UNIT_DEC = { cny_100m: 0, sqm_10k: 1 };
function fmtLatest(item) {
  if (!item.latest) return "—";
  const v = item.latest.value;
  if (item.unit === "pct") return v.toFixed(2) + "%";
  if (item.unit === "index") return v.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (item.unit === "cny") return v.toFixed(4);
  if (item.unit === "cny_100m") return price(v, 0) + " 亿";
  if (item.unit === "sqm_10k") return price(v, 1) + " 万㎡";
  return price(v, UNIT_DEC[item.unit]) + (unitCn(item.unit) ? " " + unitCn(item.unit) : "");
}
const isRateCat = i => i.category === "rates" || i.category === "liquidity";
/** 指标类：(单位, 是否百分比变化) */
function changeKind(item) {
  if (item.unit === "pct") return isRateCat(item) ? "bp" : "pp";
  if (item.unit === "index") return item.category === "risk" ? "pct" : "pt";
  return "pct";
}
function fmtChange(item, field, short) {
  const kind = changeKind(item);
  if (kind === "pct") {
    const v = item["pctChg" + short];
    if (!has(v)) return "—";
    return (v > 0 ? "+" : v < 0 ? "-" : "") + Math.abs(v).toFixed(Math.abs(v) >= 10 ? 1 : 2) + "%";
  }
  const abs = item.changes ? item.changes[field] : null;
  if (!has(abs)) return "—";
  if (kind === "bp") {
    const bp = abs * 100;
    return (bp > 0 ? "+" : bp < 0 ? "-" : "") + (Math.abs(bp) >= 10 ? Math.abs(bp).toFixed(0) : Math.abs(bp).toFixed(1)) + "bp";
  }
  if (kind === "pp") return (abs > 0 ? "+" : abs < 0 ? "-" : "") + Math.abs(abs).toFixed(2) + "pp";
  return (abs > 0 ? "+" : abs < 0 ? "-" : "") + (Math.abs(abs) >= 100 ? Math.abs(abs).toFixed(0) : Math.abs(abs).toFixed(1)) + "点";
}
function fmtPct1y(item) {
  return has(item.pct1y) ? pctRaw(item.pct1y, 1) : "—";
}
function indicatorRow(item) {
  return [
    item.name_cn + (item.status !== "FRESH" && item.status !== "OK" ? `（${item.status}）` : ""),
    fmtLatest(item),
    fmtChange(item, "chg1", 1),
    fmtChange(item, "chg5", 5),
    fmtChange(item, "chg20", 20),
    arrow(item.changes ? item.changes[item.frequency === "daily" ? "chg20" : "chg1"] : null) + " " + sparkline(item.id),
    fmtPct1y(item),
    has(item.z1y) ? sgn(item.z1y) : "—",
    item.polarity === 0 ? "—（方向未定）" : has(item.dirZ) ? sgn(item.dirZ) : "—",
  ];
}
const IND_HEAD = ["指标", "最新值", "1日", "5日", "20日", "近一年走势", "1年分位", "z(1Y)", "校正后"];
const IND_ALIGN = ["l", "n", "n", "n", "n", "l", "n", "n", "n"];
const READOUT_NOTE = "读数口径：变化列自带单位 —— 收益率与资金利率用 **bp（基点）**，其他百分比类指标用 **pp（百分点）**，" +
  "股指用 **%**，PMI/BDI/景气等指数用 **点**，价格与金额类用 **%**；" +
  "`近一年走势` 为等距分桶后的 Unicode 迷你图（左旧右新），箭头按 20 日（月频/季频按 1 期）方向标注；" +
  "`校正后` 为按方向偏好校正后的 z，方向未定的派生指标显示 —。" +
  "所有数字均来自 `public/macro-snapshot.json`，本报告不做任何重算。";


/* ============================================================
 * 区块模型
 *   { type:"p",    text }
 *   { type:"ul",   items:[] }
 *   { type:"table",head:[], rows:[[]], align:["l"|"n"] }
 * ============================================================ */
const P = text => ({ type: "p", text });
const UL = items => ({ type: "ul", items });

function table(head, rows, align) {
  return { type: "table", head, rows, align: align || head.map(() => "l") };
}
function blocksToMd(blocks) {
  const mdCell = s => String(s).replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
  const out = [];
  for (const b of blocks) {
    if (b.type === "p") out.push(b.text, "");
    else if (b.type === "ul") { for (const it of b.items) out.push("- " + it); out.push(""); }
    else if (b.type === "table") {
      out.push("| " + b.head.map(mdCell).join(" | ") + " |");
      out.push("| " + b.head.map((_, i) => (b.align[i] === "n" ? "---:" : ":---")).join(" | ") + " |");
      for (const r of b.rows) out.push("| " + r.map(mdCell).join(" | ") + " |");
      out.push("");
    }
    else if (b.type === "note") {
      for (const line of String(b.text).split("\n")) out.push("> " + line);
      out.push("");
    }
  }
  return out.join("\n");
}

/* ============================================================
 * 取值助手
 * ============================================================ */
const HL = S.headline || {};
const DIMS = (S.dimensions || []).filter(d => has(d.score));
const FUT = S.futures || {};
const CHAINS = FUT.chains || [];
const VARIETIES = FUT.varieties || [];
const SPREADS = FUT.spreads || [];
const SIGNALS = FUT.signals || [];
const liveVar = VARIETIES.filter(v => v.status === "OK" && has(v.value));

/* 全指标总表（快照 indicators 块）——报告「宏观市场层」的唯一数据来源 */
const IND = S.indicators || [];
const IND_BY_ID = new Map(IND.map(i => [i.id, i]));
const CATEGORIES = S.categories || {};
/** 按注册表 category 取指标，缺失的自动跳过 */
function indsOf(...cats) {
  return cats.flatMap(c => CATEGORIES[c] || []).map(id => IND_BY_ID.get(id)).filter(Boolean);
}
/** 取单个指标，缺失返回 null */
const ind = id => IND_BY_ID.get(id) || null;
/** 一组指标的中位数变化（用百分比口径），用于「板块整体」判读 */
function medianPctChg(items, key = "pctChg20") {
  const vals = items.map(i => i[key]).filter(v => has(v)).sort((a, b) => a - b);
  if (!vals.length) return null;
  const mid = Math.floor(vals.length / 2);
  return vals.length % 2 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2;
}

const dimSorted = DIMS.slice().sort((a, b) => b.score - a.score);
const strongDim = dimSorted[0];
const weakDim = dimSorted[dimSorted.length - 1];
const chainSorted = CHAINS.filter(c => c.metrics && has(c.metrics.d5)).slice().sort((a, b) => b.metrics.d5 - a.metrics.d5);
const upTop = ((FUT.movers || {}).up || []).filter(v => has(v.d5));
const downTop = ((FUT.movers || {}).down || []).filter(v => has(v.d5));
const divHits = (S.divergences || []).filter(d => d.hit);

/* 日间对比：上一份历史快照 */
function loadPrev() {
  if (!existsSync(historyDir)) return null;
  const files = readdirSync(historyDir).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  const older = files.filter(f => f.slice(0, 10) < S.asOf);
  if (!older.length) return null;
  try { return JSON.parse(readFileSync(resolve(historyDir, older[older.length - 1]), "utf8")); }
  catch { return null; }
}
const PREV = loadPrev();

/* ============================================================
 * 一、摘要
 * ============================================================ */
function buildSummary() {
  const items = [];
  const N = DIMS.length;
  const expand = DIMS.filter(d => d.score > 50).length;
  const contract = DIMS.filter(d => d.score < 50).length;
  let head = `综合宏观状态分 **${HL.composite}**（${HL.label}），六维中 ${expand} 个扩张、${contract} 个收缩`;
  if (PREV && has(PREV.composite)) {
    const delta = HL.composite - PREV.composite;
    head += `；较上一交易日 ${PREV.asOf}（${PREV.composite}）${delta > 0 ? "+" : delta < 0 ? "-" : "±"}${Math.abs(delta).toFixed(1)} 分`;
  }
  items.push(head + "。");
  if (strongDim && weakDim) {
    items.push(
      `宏观结构：最强 **${strongDim.name_cn} ${strongDim.score}**（z 均值 ${sgn(strongDim.zMean)}，方向偏好 ${sgn(strongDim.directionBias)}）；` +
      `最弱 **${weakDim.name_cn} ${weakDim.score}**（z 均值 ${sgn(weakDim.zMean)}）。` +
      `强弱差 ${(strongDim.score - weakDim.score).toFixed(1)} 分。`
    );
  }
  // 利率 / 权益 / 汇率：最常被追问的三块，摘要各给一行
  const cgb10 = ind("MKT_CGB_10Y");
  const c10y1y = ind("MKT_CURVE_10Y1Y");
  const dr007 = ind("MKT_DR007");
  if (cgb10) {
    items.push(
      `利率与资金面：10Y 国债 ${fmtLatest(cgb10)}（5 日 ${fmtChange(cgb10, "chg5", 5)}，1 年分位 ${fmtPct1y(cgb10)}）` +
      (c10y1y ? `，10Y-1Y 期限利差 ${has(c10y1y.latest?.value) ? c10y1y.latest.value.toFixed(2) + "pp" : "—"}（1 年分位 ${fmtPct1y(c10y1y)}）` : "") +
      (dr007 ? `，DR007 ${fmtLatest(dr007)}（z=${sgn(dr007.z1y)}）` : "") + "。"
    );
  }
  const hs = ind("MKT_HS300");
  if (hs) {
    items.push(
      `权益：${indsOf("risk").map(i => `${i.name_cn} ${fmtLatest(i)}（20 日 ${fmtChange(i, "chg20", 20)}）`).join("、")}。` +
      `沪深300 处 1 年 ${fmtPct1y(hs)} 分位、z=${sgn(hs.z1y)}。`
    );
  }
  const fx = indsOf("fx");
  if (fx.length) {
    items.push(`汇率：${fx.map(i => `${i.name_cn} ${fmtLatest(i)}（20 日 ${fmtChange(i, "chg20", 20)}，1 年分位 ${fmtPct1y(i)}）`).join("；")}。`);
  }
  const infl = [ind("CN_CPI"), ind("CN_PPI")].filter(Boolean);
  if (infl.length === 2) {
    items.push(`通胀：CPI ${fmtLatest(infl[0])}（z=${sgn(infl[0].z1y)}）、PPI ${fmtLatest(infl[1])}（z=${sgn(infl[1].z1y)}）；` +
      `M1 ${fmtLatest(ind("CN_M1") || {})}、M2 ${fmtLatest(ind("CN_M2") || {})}。`);
  }
  if (chainSorted.length >= 2) {
    const top = chainSorted[0], bot = chainSorted[chainSorted.length - 1];    items.push(
      `期货产业链（5 日）：最强 **${top.name_cn} 中位 ${pct(top.metrics.d5)}**（广度 ${pctRaw(top.metrics.breadth, 0)}），` +
      `最弱 **${bot.name_cn} 中位 ${pct(bot.metrics.d5)}**（广度 ${pctRaw(bot.metrics.breadth, 0)}）。` +
      `七条链中 ${chainSorted.filter(c => c.metrics.d5 > 0).length} 条上涨、${chainSorted.filter(c => c.metrics.d5 < 0).length} 条下跌。`
    );
  }
  if (upTop.length && downTop.length) {
    items.push(
      `品种层面 5 日领涨 **${upTop.slice(0, 3).map(v => `${v.name_cn} ${pct(v.d5)}`).join("、")}**；` +
      `领跌 **${downTop.slice(0, 3).map(v => `${v.name_cn} ${pct(v.d5)}`).join("、")}**。`
    );
  }
  const ext = liveVar.filter(v => Math.abs(v.z1y) >= THRESH.zExtreme).sort((a, b) => Math.abs(b.z1y) - Math.abs(a.z1y));
  if (ext.length) {
    items.push(
      `价格统计极端（|z| ≥ ${THRESH.zExtreme}）**${ext.length}** 个品种：` +
      ext.slice(0, 6).map(v => `${v.name_cn} z=${sgn(v.z1y)}`).join("、") +
      (ext.length > 6 ? ` 等` : "") + "。"
    );
  }
  const spreadExt = SPREADS.filter(s => s.available && has(s.pct1y) && (s.pct1y >= THRESH.pctHigh || s.pct1y <= THRESH.pctLow));
  if (spreadExt.length) {
    items.push(
      `价差极值 **${spreadExt.length}** 条：` +
      spreadExt.map(s => `${s.name_cn}（${s.pct1y >= THRESH.pctHigh ? "高位" : "低位"} ${pctRaw(s.pct1y, 0)} 分位）`).join("、") + "。"
    );
  }
  if (divHits.length) {
    items.push(`跨资产背离触发 **${divHits.length}** 条：` + divHits.map(d => `${d.name_cn}——${d.question}`).join("；") + "。");
  } else {
    items.push("未触发跨资产背离规则。");
  }
  items.push(`异常 **${HL.anomalyCount}** 项（单指标 + 维度聚集），其中高风险 **${HL.highSeverityCount}** 项；数据新鲜 ${HL.freshness?.FRESH ?? "—"}/${HL.indicatorTotal}，可参与评分 ${HL.indicatorScorable}/${HL.indicatorTotal}。`);
  if (SIGNALS.length) {
    items.push("产业链传导：" + SIGNALS.map(s => `**${s.implication}**（${s.detail}）`).join("；") + "。");
  }
  if ((S.dataQuality?.degraded || []).length) {
    items.push("数据质量降级：" + S.dataQuality.degraded.map(d => `${d.name_cn}（${d.status}${has(d.ageDays) ? `，${d.ageDays} 天前` : ""}）`).join("、") + "。");
  }
  return { id: "summary", title: "摘要", tag: "Executive summary", blocks: [UL(items)] };
}

/* ============================================================
 * 二、今日显著偏离（当日即时变化的加注）
 *
 * 诉求：抓完当日数据要能一眼看到「今天什么变了、变得离不离谱」。
 * 判定口径（全部由快照算好，本报告不重算，Spec §37）：
 *   chg1Extreme —— 本期的 |1 期变化| 落在「该指标自身近 3 年单期变化」分布中的分位。
 *                  ≥ THRESH.chgExtreme（前 10%）→ 当日偏离；≥ chgExtremeStrong（前 3%）→ 极端。
 *   位置另看：pct1y 是否创一年新高/新低，|z1y| 是否统计极端。
 * 注意：涨/跌按**原始变化方向**标注，不做方向校正 —— 这里回答的是「涨跌」，不是「好坏」。
 * ============================================================ */
/** 固定标注词表（避免自由发挥，便于复核） */
function deviationTags(ext, z, p1, oiChg5) {
  const tags = [];
  if (has(p1) && p1 >= 0.99) tags.push("刷一年新高");
  if (has(p1) && p1 <= 0.01) tags.push("刷一年新低");
  if (has(ext) && ext >= THRESH.chgExtreme && has(z) && Math.abs(z) >= THRESH.zExtreme) tags.push("变化+位置双极端");
  else if (has(ext) && ext >= THRESH.chgExtremeStrong) tags.push("变化极端");
  else if (has(ext) && ext >= THRESH.chgExtreme) tags.push("变化显著");
  else if (has(z) && Math.abs(z) >= THRESH.zExtreme) tags.push("位置极端");
  if (has(oiChg5) && Math.abs(oiChg5) >= THRESH.oiSurge) tags.push("持仓放大");
  return tags;
}
const DEV_HEAD = ["指标", "板块", "最新值", "本期变化", "变化分位(近3年)", "z(1Y)", "1年分位", "标注"];
const DEV_ALIGN = ["l", "l", "n", "n", "n", "n", "n", "l"];

function buildDeviations() {
  /* --- 日频：宏观日频 + 期货全品种 --- */
  /* 去重：宏观层里有一批「XX主力」的期货收盘价指标（沪铜主力/原油主力/铁矿石主力…），
     它们与期货层是同一标的。期货层口径更全（含持仓量与产业链分组），故保留期货层、
     丢弃宏观层的同标的行，避免同一行情在榜上出现两次。
     归一化方式：把宏观指标名末尾的「主力」去掉后与期货品种名比对。 */
  const futNames = new Set(liveVar.map(v => String(v.name_cn || "").trim()));
  const dupOfFutures = nm => futNames.has(String(nm || "").trim().replace(/主力$/, ""));

  const pool = [];
  for (const it of IND) {
    if (it.frequency !== "daily") continue;
    if (it.status === "DISCONTINUED" || it.status === "EMPTY") continue;
    if (!has(it.changes?.chg1) || !has(it.chg1Extreme)) continue;
    if (dupOfFutures(it.name_cn)) continue;
    pool.push({
      id: it.id,
      name: it.name_cn,
      group: CAT_CN_OF(it.category),
      value: fmtLatest(it),
      chg: it.changes.chg1,
      chgText: fmtChange(it, "chg1", 1),
      ext: it.chg1Extreme,
      z: it.z1y,
      p1: it.pct1y,
      oi: null,
      source: "宏观",
    });
  }
  for (const v of liveVar) {
    if (!has(v.d1) || !has(v.chg1Extreme)) continue;
    pool.push({
      id: v.id,
      name: v.name_cn,
      group: v.chain_cn || "期货",
      value: valueWithUnit(v.value, v.unit),
      chg: v.d1,
      chgText: pct(v.d1),
      ext: v.chg1Extreme,
      z: v.z1y,
      p1: v.pct1y,
      oi: v.oiChg5,
      source: "期货",
    });
  }

  const notable = pool.filter(x =>
    x.ext >= THRESH.chgExtreme ||
    (has(x.z) && Math.abs(x.z) >= THRESH.zExtreme) ||
    (has(x.p1) && (x.p1 >= 0.99 || x.p1 <= 0.01))
  );
  const byExt = (a, b) => (b.ext || 0) - (a.ext || 0);
  const ups = notable.filter(x => x.chg > 0).sort(byExt);
  const downs = notable.filter(x => x.chg < 0).sort(byExt);

  const row = x => [
    x.name + (x.source === "期货" ? "" : ""),
    x.group,
    x.value,
    x.chgText,
    has(x.ext) ? pctRaw(x.ext, 0) : "—",
    has(x.z) ? sgn(x.z) : "—",
    has(x.p1) ? pctRaw(x.p1, 0) : "—",
    deviationTags(x.ext, x.z, x.p1, x.oi).map(t => `**${t}**`).join(" · ") || "—",
  ];

  const blocks = [];
  if (!notable.length) {
    blocks.push(P(`本日无指标达到「显著偏离」阈值（| 本期变化 | 未进入自身近 3 年单期变化的前 ${Math.round((1 - THRESH.chgExtreme) * 100)}%，且 z 与分位均不极端）。`));
    return { id: "deviations", title: "今日显著偏离", tag: "Today's outliers", blocks };
  }

  const top = notable.slice().sort(byExt)[0];
  const extremeCnt = notable.filter(x => x.ext >= THRESH.chgExtremeStrong).length;
  blocks.push(P(
    `**结论：本日共 ${notable.length} 项出现显著偏离**（按原始涨跌方向计：上涨 ${ups.length} 项、下跌 ${downs.length} 项` +
    `${extremeCnt ? `，其中 ${extremeCnt} 项属于近 3 年最极端的 ${Math.round((1 - THRESH.chgExtremeStrong) * 100)}% 变化` : ""}）。` +
    `最极端的是 **${top.name}**（${top.group}）本期 **${top.chgText}**，该幅度在自身近 3 年中排到第 **${has(top.ext) ? Math.round(top.ext * 100) : "—"}** 分位` +
    `${has(top.z) ? `，z(1Y) ${sgn(top.z)}` : ""}。`
  ));

  if (ups.length) {
    blocks.push(P(`**上涨侧 · 今日显著偏离（${ups.length} 项，按变化极端度排序）**`));
    blocks.push(table(DEV_HEAD, ups.slice(0, THRESH.deviationTop).map(row), DEV_ALIGN));
  }
  if (downs.length) {
    blocks.push(P(`**下跌侧 · 今日显著偏离（${downs.length} 项，按变化极端度排序）**`));
    blocks.push(table(DEV_HEAD, downs.slice(0, THRESH.deviationTop).map(row), DEV_ALIGN));
  }

  /* --- 月频 / 季频：新一期同样极端的话单独列出，避免与「当日」混淆 --- */
  const slow = IND
    .filter(it => it.frequency !== "daily" && it.status !== "DISCONTINUED" && it.status !== "EMPTY")
    .filter(it => has(it.chg1Extreme) && it.chg1Extreme >= THRESH.chgExtreme)
    .sort((a, b) => b.chg1Extreme - a.chg1Extreme);
  if (slow.length) {
    const slowRows = slow.slice(0, 8).map(it => [
      it.name_cn,
      CAT_CN_OF(it.category),
      FREQ_CN[it.frequency] + "频",
      it.latest?.date || "—",
      fmtLatest(it),
      fmtChange(it, "chg1", 1),
      has(it.chg1Extreme) ? pctRaw(it.chg1Extreme, 0) : "—",
      has(it.z1y) ? sgn(it.z1y) : "—",
      has(it.pct1y) ? pctRaw(it.pct1y, 0) : "—",
    ]);
    blocks.push(P(`**月频 / 季频最新一期也出现显著偏离（${slow.length} 项）**　—— 下表是「最新一期的环比/同比变化有多极端」，**观测期不一定是今天**（发布有滞后），请与上面按当日口径的榜单区分看待。`));
    blocks.push(table(
      ["指标", "板块", "频率", "观测期", "最新值", "本期变化", "变化分位(近3年)", "z(1Y)", "1年分位"],
      slowRows, ["l", "l", "l", "l", "n", "n", "n", "n", "n"]
    ));
  }

  blocks.push(P(
    "**加注口径**：`变化分位(近3年)` = 本期 |变化| 在该指标自身近 3 年全部单期 |变化| 中的分位（≥" +
    `${Math.round(THRESH.chgExtreme * 100)}% 即进入显著偏离区）；` +
    "`刷一年新高/新低` 用 1 年分位 ≥99% / ≤1% 判定；`双极端` 指变化极端且 |z|≥2；" +
    "`持仓放大` 为期货品种持仓量 5 日变化 ≥" + Math.round(THRESH.oiSurge * 100) + "%。" +
    "同一标的若在宏观层与期货层重复出现（如沪铜主力 / 沪铜），只保留含持仓口径的期货层一次。" +
    "涨跌按原始方向，不代表对宏观的利弊；口径判断见各维度章节。"
  ));
  return { id: "deviations", title: "今日显著偏离", tag: `Today's outliers · ${notable.length} 项`, blocks };
}

/* ============================================================
 * 二、宏观六维
 * ============================================================ */
function buildMacro() {
  const rows = DIMS.map(d => {
    const prev = PREV && PREV.dimensions ? PREV.dimensions.find(x => x.key === d.key) : null;
    const delta = prev && has(prev.score) ? d.score - prev.score : null;
    return [
      d.name_cn,
      d.score.toFixed(1),
      has(delta) ? sgn(delta, 1) : "—",
      sgn(d.zMean),
      sgn(d.directionBias),
      `${d.coverage.used}/${d.coverage.configured}`,
      has(d.coverage.weightSum) ? d.coverage.weightSum.toFixed(2) : "—",
      d.score > 50 ? "扩张" : d.score < 50 ? "收缩" : "中性",
    ];
  });
  const blocks = [
    table(
      ["维度", "状态分", "较上日", "z 均值", "方向偏好", "覆盖", "权重和", "状态"],
      rows,
      ["l", "n", "n", "n", "n", "n", "n", "l"]
    ),
    P("表内数值全部直接取自快照：`dimensionScore = clamp(50 + 20 × Σ(方向偏好 × z1y)，0, 100)`，综合分为六维等权均值。方向偏好为正表示该维上行对宏观扩张有利。"),
  ];
  const lowCov = DIMS.filter(d => d.coverage.weightSum < 1);
  if (lowCov.length) {
    blocks.push(UL(lowCov.map(d => {
      const miss = (d.missingWeightMembers || []).map(m => (m && typeof m === "object" ? `${m.id}（${m.reason}）` : String(m)));
      return `覆盖不足：**${d.name_cn}** 权重和仅 ${d.coverage.weightSum.toFixed(2)}（成员 ${d.coverage.used}/${d.coverage.configured}），状态分的代表性弱于其余维度` +
        (miss.length ? `，缺失：${miss.join("、")}` : "") + "。";
    })));
  }
  return { id: "macro", title: "宏观六维状态", tag: "Six dimensions", blocks };
}

/* ============================================================
 * 三～九、宏观市场层：按注册表 category（板块）逐块展开
 *   与「六维状态」的区别：六维回答「经济方向好不好」，
 *   本层回答「每个具体指标现在什么水平、过去一年怎么走的」。
 * ============================================================ */
function chapterIndicators(id, title, tag, cats, opts = {}) {
  const items = opts.ids ? opts.ids.map(x => IND_BY_ID.get(x)).filter(Boolean) : indsOf(...cats);
  const blocks = [];
  if (opts.intro) blocks.push(P(opts.intro));
  if (items.length) {
    blocks.push(table(IND_HEAD, items.map(indicatorRow), IND_ALIGN));
    blocks.push(P(opts.note || READOUT_NOTE));
  } else {
    blocks.push(P("本板块无可读指标。"));
  }
  if (opts.readout) blocks.push(...opts.readout(items));
  return { id, title, tag, blocks };
}

/* 三、利率与资金面 */
function buildRates() {
  const items = indsOf("rates", "liquidity");
  const shape = (S.yieldCurve || {}).latestShape || [];
  const curveBlock = [];
  if (shape.length) {
    const rows = shape.map(p => [p.tenor + " 年", p.value.toFixed(4) + "%", p.date]);
    const c10y1y = ind("MKT_CURVE_10Y1Y");
    const c30y10y = ind("MKT_CURVE_30Y10Y");
    if (c10y1y) rows.push(["10Y-1Y", has(c10y1y.latest?.value) ? c10y1y.latest.value.toFixed(4) + " pp" : "—", c10y1y.latest?.date || "—"]);
    if (c30y10y) rows.push(["30Y-10Y", has(c30y10y.latest?.value) ? c30y10y.latest.value.toFixed(4) + " pp" : "—", c30y10y.latest?.date || "—"]);
    curveBlock.push(P("**最新曲线形态**"), table(["期限", "收益率", "日期"], rows, ["l", "n", "l"]));
    const shapeWord = has(c10y1y?.latest?.value)
      ? (c10y1y.latest.value < 0 ? "**倒挂**（10Y 低于 1Y）" : c10y1y.latest.value > 0.5 ? "**陡峭**" : c10y1y.latest.value > 0.2 ? "**偏陡**" : "**平坦**")
      : "—";
    const steep20 = has(c10y1y?.changes?.chg20) ? c10y1y.changes.chg20 : null;
    curveBlock.push(P(
      `曲线形态：10Y-1Y 为 ${has(c10y1y?.latest?.value) ? c10y1y.latest.value.toFixed(4) : "—"} pp，20 日${has(steep20) ? (steep20 > 0 ? "走陡 " : steep20 < 0 ? "走平 " : "持平 ") + sgn(steep20, 4) + " pp" : "—"}，` +
      `判定为 ${shapeWord}；30Y-10Y 为 ${has(c30y10y?.latest?.value) ? c30y10y.latest.value.toFixed(4) : "—"} pp` +
      `（1 年分位 ${fmtPct1y(c30y10y || {})}）。`
    ));
  }
  return chapterIndicators("rates", "利率与资金面", "Rates & funding", ["rates", "liquidity"], {
    intro: "国债收益率曲线与银行间资金价格。收益率**下行**通常对应宽松预期或避险，**上行**对应紧缩或预期改善；" +
      "资金利率（DR/R/SHIBOR）反映银行间实际松紧。",
    readout: all => {
      const out = [...curveBlock];
      const rates = indsOf("rates").filter(i => i.id.startsWith("MKT_CGB"));
      const funds = indsOf("liquidity");
      const longEnd = ind("MKT_CGB_10Y");
      if (longEnd) {
        out.push(P(
          `长端 10Y 现值 ${fmtLatest(longEnd)}（z=${sgn(longEnd.z1y)}，1 年分位 ${fmtPct1y(longEnd)}，20 日 ${fmtChange(longEnd, "chg20", 20)}）；` +
          `短端 1Y 现值 ${fmtLatest(ind("MKT_CGB_1Y") || {})}（1 年分位 ${fmtPct1y(ind("MKT_CGB_1Y") || {})}）。` +
          (has(longEnd.z1y) && longEnd.z1y <= -1.5 ? "长端处于统计低位，债市已price in较多宽松预期。" : "")
        ));
      }
      const fBp = funds.map(i => (has(i.changes?.chg5) ? i.changes.chg5 * 100 : null)).filter(has).sort((a, b) => a - b);
      if (fBp.length) {
        const mid = fBp[Math.floor(fBp.length / 2)];
        out.push(P(`资金面：${funds.length} 个资金利率 5 日中位变化 ${(mid > 0 ? "+" : mid < 0 ? "-" : "") + Math.abs(mid).toFixed(1)}bp，` +
          `${mid > 0.5 ? "资金价格上行，边际收敛" : mid < -0.5 ? "资金价格下行，边际转松" : "基本持平"}。`));
      }
      return out;
    },
  });
}

/* 四、权益与汇率 */
function buildRiskFx() {
  return chapterIndicators("riskfx", "权益与汇率", "Equity & FX", ["risk", "fx"], {
    intro: "权益指数与人民币汇率。股指用百分比变化；汇率中「美元兑人民币」数值下降＝人民币升值。",
    readout: () => {
      const out = [];
      const eq = indsOf("risk");
      const fx = indsOf("fx");
      const eqMed = medianPctChg(eq, "pctChg20");
      if (has(eqMed)) {
        out.push(P(`权益：4 大指数 20 日中位变化 ${pct(eqMed / 100)}，${eqMed > 0 ? "整体上行" : eqMed < 0 ? "整体下探" : "基本走平"}。` +
          eq.map(i => `${i.name_cn} ${fmtChange(i, "chg20", 20)}（1 年分位 ${fmtPct1y(i)}）`).join("；") + "。"));
      }
      const usdcny = ind("MKT_USDCNY");
      if (usdcny) {
        out.push(P(`汇率：美元兑人民币 ${fmtLatest(usdcny)}（20 日 ${fmtChange(usdcny, "chg20", 20)}，1 年分位 ${fmtPct1y(usdcny)}，z=${sgn(usdcny.z1y)}）。` +
          (has(usdcny.pct1y) && usdcny.pct1y <= 0.1 ? "处于一年内偏强区间（数值越低＝人民币越强）。" : "") +
          (ind("MKT_USDCNH") ? ` 离岸 ${fmtLatest(ind("MKT_USDCNH"))}。` : "")));
      }
      const hs = ind("MKT_HS300");
      const cgb = ind("MKT_CGB_10Y");
      if (hs && cgb && has(hs.z1y) && has(cgb.z1y)) {
        out.push(P(`股债相对：沪深300 z=${sgn(hs.z1y)}、10Y 国债收益率 z=${sgn(cgb.z1y)} —— ` +
          (hs.z1y < 0 && cgb.z1y < 0 ? "股弱债强，风险偏好偏低（对应背离检测里的「市场不确认」）。" :
            hs.z1y > 0 && cgb.z1y > 0 ? "股强债弱，风险偏好回升。" : "股债方向分化，需结合基本面组判断。")));
      }
      return out;
    },
  });
}

/* 五、货币与信用 */
function buildCredit() {
  return chapterIndicators("credit", "货币与信用", "Money & credit", ["credit"], {
    intro: "货币总量（M2/M1）、社会融资规模与信用利差。它们决定流动性的「量」，利率决定流动性的「价」。",
    readout: () => {
      const out = [];
      const m1 = ind("CN_M1"), m2 = ind("CN_M2");
      if (m1 && m2) {
        out.push(P(`M1 同比 ${fmtLatest(m1)}（z=${sgn(m1.z1y)}），M2 同比 ${fmtLatest(m2)}（z=${sgn(m2.z1y)}），` +
          (has(m1.latest?.value) && has(m2.latest?.value)
            ? `M1 ${m1.latest.value > m2.latest.value ? "高于" : "低于"} M2 ${Math.abs(m1.latest.value - m2.latest.value).toFixed(2)} pp，` +
              (m1.latest.value > m2.latest.value ? "资金活化程度相对改善。" : "资金活化偏弱，存款定期化仍未缓解。")
            : "")));
      }
      const tsf = ind("CN_TSF");
      if (tsf) out.push(P(`社融存量同比 ${fmtLatest(tsf)}（1 年分位 ${fmtPct1y(tsf)}，z=${sgn(tsf.z1y)}，20 期 ${fmtChange(tsf, "chg20", 20)}）。`));
      const spread = ind("MKT_CREDIT_SPREAD_3Y");
      if (spread) out.push(P(`AAA 3Y 信用利差 ${fmtLatest(spread)}（1 年分位 ${fmtPct1y(spread)}，z=${sgn(spread.z1y)}）：` +
        (has(spread.pct1y) && spread.pct1y <= 0.2 ? "利差处低位，信用环境偏宽松。" : has(spread.pct1y) && spread.pct1y >= 0.8 ? "利差处高位，信用风险定价偏谨慎。" : "利差居中。")));
      return out;
    },
  });
}

/* 六、增长与景气 */
function buildGrowth() {
  return chapterIndicators("growth", "增长与景气", "Growth & sentiment", ["growth", "sentiment"], {
    intro: "官方增长数据 + PMI 及分项 + 铜/钢材高频。官方数据月频/季频，PMI 为月频，高频为日频，**频率不可混算**（Spec §16）。",
    readout: () => {
      const out = [];
      const pmi = ind("CN_PMI");
      const order = ind("CN_PMI_ORDER");
      if (pmi && order) {
        out.push(P(`PMI ${fmtLatest(pmi)}（z=${sgn(pmi.z1y)}，1 年分位 ${fmtPct1y(pmi)}）；新订单 ${fmtLatest(order)}（z=${sgn(order.z1y)}）。` +
          (has(pmi.latest?.value) ? `景气${pmi.latest.value >= 50 ? "在荣枯线上" : "在荣枯线下"}` : "") +
          (has(pmi.latest?.value) && has(order.latest?.value) ? `，新订单${order.latest.value >= pmi.latest.value ? "强于" : "弱于"}总指数。` : "。")));
      }
      const inv = ind("CN_PMI_INVENTORY");
      const prod = ind("CN_PMI_PROD");
      if (inv && prod) out.push(P(`生产 ${fmtLatest(prod)}（z=${sgn(prod.z1y)}）、库存 ${fmtLatest(inv)}（z=${sgn(inv.z1y)}）：` +
        (has(prod.z1y) && has(inv.z1y)
          ? (prod.z1y > inv.z1y ? "生产强于库存，处于主动补库倾向。" : "库存强于生产，被动累库风险。") : "")));
      const hf = indsOf("growth").filter(i => i.layer === "highfreq");
      if (hf.length) {
        const med = medianPctChg(hf, "pctChg20");
        out.push(P(`高频实物（${hf.length} 项，含铜/热卷等）：20 日中位变化 ${has(med) ? pct(med / 100) : "—"}。` +
          hf.map(i => `${i.name_cn} ${fmtChange(i, "chg20", 20)}`).join("；") + "。"));
      }
      return out;
    },
  });
}

/* 七、通胀 */
function buildInflation() {
  return chapterIndicators("inflation", "通胀", "Inflation", ["inflation"], {
    intro: "CPI / PPI / PMI 价格分项 + 高频食品与油价。注意方向：**通胀上行对「宏观扩张」是负向**（`higher_is_tighter`）。",
    readout: () => {
      const out = [];
      const cpi = ind("CN_CPI"), ppi = ind("CN_PPI");
      if (cpi && ppi) {
        out.push(P(`CPI 同比 ${fmtLatest(cpi)}（z=${sgn(cpi.z1y)}），PPI 同比 ${fmtLatest(ppi)}（z=${sgn(ppi.z1y)}）：` +
          (has(cpi.latest?.value) && has(ppi.latest?.value)
            ? (ppi.latest.value < 0 && cpi.latest.value > 0 ? "PPI 仍为负而 CPI 为正 —— 上游通缩、下游有韧性，中游加工利润受压。" :
              ppi.latest.value > cpi.latest.value ? "PPI 高于 CPI，上游价格压力大于终端。" : "CPI 高于 PPI，终端强于上游。")
            : "")));
      }
      const food = ind("CN_CPI_FOOD"), nonfood = ind("CN_CPI_NONFOOD");
      if (food && nonfood) out.push(P(`CPI 食品 ${fmtLatest(food)}（1 年分位 ${fmtPct1y(food)}）vs 非食品 ${fmtLatest(nonfood)}（1 年分位 ${fmtPct1y(nonfood)}）：` +
        `食品端 20 期变化 ${fmtChange(food, "chg20", 20)}。`));
      const hf = indsOf("inflation").filter(i => i.layer === "highfreq");
      if (hf.length) {
        out.push(P(`高频价格（${hf.length} 项）：` + hf.map(i => `${i.name_cn} ${fmtLatest(i)}（z=${sgn(i.z1y)}）`).join("；") + "。"));
      }
      return out;
    },
  });
}

/* 八、地产 */
function buildProperty() {
  return chapterIndicators("property", "地产", "Property", ["property"], {
    intro: "投资、新开工、施工、竣工、销售五条线，加玻璃/螺纹两个建材高频。地产是当前六维中最弱的一维。",
    readout: () => {
      const out = [];
      const items = indsOf("property");
      const med = medianPctChg(items.filter(i => i.frequency === "monthly"), "pctChg1");
      if (has(med)) out.push(P(`月频地产指标 ${items.filter(i => i.frequency === "monthly").length} 项，最新一期同比/环比中位变化 ${pct(med / 100)}。`));
      const sales = ind("CN_RE_SALES_YOY"), start = ind("CN_RE_START");
      if (sales && start) out.push(P(`商品房销售额累计同比 ${fmtLatest(sales)}（z=${sgn(sales.z1y)}），房屋新开工 ${fmtLatest(start)}（1 年分位 ${fmtPct1y(start)}）—— ` +
        (has(sales.z1y) && has(start.z1y) ? (sales.z1y < -1 && start.z1y < -1 ? "销售与新开工双双处统计低位，行业仍在收缩区间。" : "两者未同时处低位，边际有分化。") : "")));
      const hf = items.filter(i => i.layer === "highfreq");
      if (hf.length) out.push(P("建材高频：" + hf.map(i => `${i.name_cn} ${fmtLatest(i)}（20 日 ${fmtChange(i, "chg20", 20)}）`).join("；") + "。"));
      return out;
    },
  });
}

/* 九、消费与外需 */
function buildConsumptionExternal() {
  return chapterIndicators("consumption", "消费与外需", "Consumption & external", ["consumption", "external"], {
    intro: "社会消费品零售（消费）与进出口、PMI 出口/进口、BDI（外需）。当前外需是最强的维度，消费是最弱的之一。",
    readout: () => {
      const out = [];
      const retail = ind("CN_RETAIL"), catering = ind("CN_RETAIL_CATERING");
      if (retail) out.push(P(`社零同比 ${fmtLatest(retail)}（z=${sgn(retail.z1y)}，1 年分位 ${fmtPct1y(retail)}）` +
        (catering ? `，餐饮同比 ${fmtLatest(catering)}（z=${sgn(catering.z1y)}）` : "") + "。"));
      const ext = ind("CN_EXPORT"), imp = ind("CN_IMPORT"), trade = ind("CN_TRADE");
      if (ext) out.push(P(`出口同比 ${fmtLatest(ext)}（z=${sgn(ext.z1y)}），进口同比 ${has(imp?.latest?.value) ? fmtLatest(imp) : "—"}，贸易差额 ${fmtLatest(trade || {})}。`));
      const bdi = ind("HF_BALTIC");
      const pex = ind("CN_PMI_EXPORT");
      if (bdi || pex) out.push(P(`外需高频：BDI ${fmtLatest(bdi || {})}（z=${sgn(bdi?.z1y)}，1 年分位 ${fmtPct1y(bdi || {})}）` +
        (pex ? `；PMI 新出口订单 ${fmtLatest(pex)}（z=${sgn(pex.z1y)}）` : "") + "。"));
      return out;
    },
  });
}

/* 十、全指标总表（附录） */
function buildIndicatorTable() {
  const order = ["rates", "liquidity", "risk", "fx", "credit", "growth", "sentiment", "inflation", "property", "consumption", "external"];
  const blocks = [
    P(`把 ${IND.length} 项指标全部摊开，按板块排列，便于逐项核对。数值与工作台「宏观指标总表」面板同源。`),
  ];
  const cats = order.filter(c => CATEGORIES[c]).concat(Object.keys(CATEGORIES).filter(c => !order.includes(c)));
  for (const c of cats) {
    const items = indsOf(c);
    if (!items.length) continue;
    blocks.push(P(`#### ${CAT_CN_OF(c)}（${items.length}）`));
    blocks.push(table(IND_HEAD, items.map(indicatorRow), IND_ALIGN));
  }
  return { id: "indicators-all", title: "全指标总表", tag: `Appendix · ${IND.length} 项`, blocks };
}


/* ============================================================
 * 十、指标极值（方向校正后）
 * ============================================================ */
function buildExtremes() {
  const mk = arr => arr.slice(0, THRESH.moversTop).map(m =>
    `**${m.name_cn}**（${DIM_CN[m.dimension] || m.dimension}·${FREQ_CN[m.frequency] || ""}）z=${sgn(m.z1y)}，` +
    `校正后 ${sgn(m.dirZ)}，最新 ${valueWithUnit(m.latest?.value, m.unit)}（${m.latest?.date}），3 年分位 ${pctRaw(m.pct3y, 1)}`
  );
  const stronger = (S.movers?.stronger || []).filter(m => has(m.dirZ));
  const weaker = (S.movers?.weaker || []).filter(m => has(m.dirZ));
  const blocks = [];
  if (stronger.length) blocks.push(P("**对宏观扩张最有利**"), UL(mk(stronger)));
  if (weaker.length) blocks.push(P("**对宏观扩张最不利**"), UL(mk(weaker)));
  return { id: "extremes", title: "指标极值", tag: "Direction-adjusted", blocks };
}

/* ============================================================
 * 四、跨资产背离
 * ============================================================ */
function buildDivergence() {
  const all = S.divergences || [];
  if (!all.length) return { id: "divergence", title: "跨资产背离", tag: "Divergence", blocks: [P("未配置背离规则。")] };
  const rows = all.map(d => [
    d.hit ? "**触发**" : "未触发",
    d.name_cn,
    d.question,
    has(d.fundamental?.meanZ) ? sgn(d.fundamental.meanZ) : "—",
    has(d.market?.meanZ) ? sgn(d.market.meanZ) : "—",
    d.severity,
  ]);
  const blocks = [
    table(["状态", "背离名称", "它回答的问题", "基本面组 z 均值", "市场组 z 均值", "严重度"], rows, ["l", "l", "l", "n", "n", "l"]),
  ];
  for (const d of divHits) blocks.push(P(`**${d.name_cn}**：${d.interpretation}。规则：${d.logic}`));
  if (!divHits.length) blocks.push(P("本日无背离触发，基本面组与市场组方向一致。"));
  return { id: "divergence", title: "跨资产背离", tag: "Divergence", blocks };
}

/* ============================================================
 * 五、重点异常
 * ============================================================ */
function buildAnomaly() {
  const sevRank = { high: 0, medium: 1, low: 2 };
  const list = (S.anomalies || []).slice().sort((a, b) => {
    const s = (sevRank[a.severity] ?? 9) - (sevRank[b.severity] ?? 9);
    if (s) return s;
    return Math.abs(b.dirZ ?? 0) - Math.abs(a.dirZ ?? 0);
  });
  const rows = list.slice(0, THRESH.anomalyTop).map(a => [
    a.severity,
    a.name_cn,
    DIM_CN[a.dimension] || a.dimension || "—",
    valueWithUnit(a.latest?.value, a.unit),
    sgn(a.z1y),
    pctRaw(a.pct3y, 1),
    (a.triggers || []).map(t => t.detail).join("；") || "—",
  ]);
  const blocks = [
    P(`共 ${list.length} 项异常（单指标 + 维度聚集），下表按严重度、|z| 排序取前 ${rows.length} 项；完整清单见工作台「异常清单」面板。`),
    table(["严重度", "指标", "维度", "最新值", "z(1Y)", "3年分位", "触发条件"], rows, ["l", "l", "l", "n", "n", "n", "l"]),
  ];
  return { id: "anomaly", title: "重点异常", tag: `Top ${rows.length} / ${list.length}`, blocks };
}

/* ============================================================
 * 六、期货产业链总览
 * ============================================================ */
function buildFuturesOverview() {
  const rows = chainSorted.map(c => [
    c.name_cn,
    pct(c.metrics.d5),
    pct(c.metrics.d20),
    pctRaw(c.metrics.breadth, 0),
    pct(c.metrics.oiChg5),
    sgn(c.metrics.z1y, 2),
    pctRaw(c.metrics.pct1y, 1),
    `${c.liveCount}/${c.memberCount}`,
  ]);
  const blocks = [
    P(`共 ${CHAINS.length} 条产业链、${FUT.varietyCount} 个品种，其中 ${FUT.liveVarietyCount} 个有当日有效报价。链级指标为成员**中位数**，广度＝上涨成员占比。`),
    table(["产业链", "5 日", "20 日", "广度", "持仓量 5 日", "z(1Y)", "1 年分位", "活跃/总"], rows, ["l", "n", "n", "n", "n", "n", "n", "n"]),
  ];
  for (const c of CHAINS) if (c.desc) blocks.push(P(`**${c.name_cn}**：${c.desc}`));
  return { id: "futures-overview", title: "期货产业链总览", tag: "Chains", blocks };
}

/* ============================================================
 * 七、期货领涨领跌
 * ============================================================ */
function buildFuturesMovers() {
  const mk = arr => arr.slice(0, THRESH.futuresMoverTop).map(v =>
    `**${v.name_cn}**（${v.chain_cn}·${v.chain_tier}）5 日 ${pct(v.d5)}｜1 日 ${pct(v.d1)}｜20 日 ${pct(v.d20)}｜z=${sgn(v.z1y)}｜1 年分位 ${pctRaw(v.pct1y, 1)}｜持仓 5 日 ${pct(v.oiChg5)}｜最新 ${price(v.value)} ${unitCn(v.unit)}`
  );
  const blocks = [];
  if (upTop.length) blocks.push(P(`**领涨（前 ${Math.min(upTop.length, THRESH.futuresMoverTop)}）**`), UL(mk(upTop)));
  if (downTop.length) blocks.push(P(`**领跌（前 ${Math.min(downTop.length, THRESH.futuresMoverTop)}）**`), UL(mk(downTop)));
  blocks.push(P("涨跌幅基于**真实主力月份合约**并做换月等比复权拼接，不含主力连续合约的换月跳空。持仓量变化为 5 个交易日环比，用于区分「增仓推动」与「减仓反弹」。"));
  return { id: "futures-movers", title: "期货领涨领跌", tag: `Top ${THRESH.futuresMoverTop} · 5D`, blocks };
}

/* ============================================================
 * 八、产业链深读（你关心的煤炭、化工都在这里）
 * ============================================================ */
function buildChainDeepDive() {
  const blocks = [];
  for (const c of CHAINS) {
    const members = liveVar.filter(v => v.chain === c.id);
    if (!members.length) continue;
    blocks.push(P(`#### ${c.name_cn}`));
    const m = c.metrics || {};
    blocks.push(P(
      `链级：5 日中位 **${pct(m.d5)}**、20 日中位 **${pct(m.d20)}**、广度 **${pctRaw(m.breadth, 0)}**、` +
      `持仓量 5 日 **${pct(m.oiChg5)}**；价格中位处于 1 年 **${pctRaw(m.pct1y, 1)}** 分位（z=${sgn(m.z1y)}）。` +
      (c.leaders && c.leaders.length ? ` 龙头品种：${c.leaders.map(id => (VARIETIES.find(v => v.id === id) || {}).name_cn || id).join("、")}。` : "")
    ));
    const tiers = (c.tiers || []).filter(t => t.metrics && has(t.metrics.d20));
    if (tiers.length >= 2) {
      blocks.push(UL(tiers.map(t =>
        `**${t.name_cn}**（${t.metrics.count} 个品种）：5 日 ${pct(t.metrics.d5)}｜20 日 ${pct(t.metrics.d20)}｜广度 ${pctRaw(t.metrics.breadth, 0)}｜z=${sgn(t.metrics.z1y)}`
      )));
    }
    const tierOrder = (c.tiers || []).map(t => t.name_cn);
    const sorted = members.slice().sort((a, b) => {
      const ti = tierOrder.indexOf(a.chain_tier) - tierOrder.indexOf(b.chain_tier);
      if (ti) return ti;
      return (b.d5 ?? -9) - (a.d5 ?? -9);
    });
    const stale = VARIETIES.filter(v => v.chain === c.id && (v.status !== "OK" || (has(v.staleDays) && v.staleDays > 0)));
    if (stale.length) {
      blocks.push(UL(stale.map(v => `⚠️ **${v.name_cn}** 无当日有效报价（${v.status}${has(v.staleDays) && v.staleDays > 0 ? `，滞后 ${v.staleDays} 天` : ""}），已从本链统计中剔除，链级中位数基于剩余 ${members.length} 个品种。`)));
    }
    blocks.push(table(
      ["品种", "层级", "最新", "1 日", "5 日", "20 日", "60 日", "z(1Y)", "1 年分位", "持仓 5 日", "主力合约"],
      sorted.map(v => [
        v.name_cn + (v.importance === "high" ? " ★" : ""),
        v.chain_tier,
        `${price(v.value)} ${unitCn(v.unit)}`.trim(),
        pct(v.d1),
        pct(v.d5),
        pct(v.d20),
        pct(v.d60),
        sgn(v.z1y),
        pctRaw(v.pct1y, 1),
        pct(v.oiChg5),
        v.code || "—",
      ]),
      ["l", "l", "n", "n", "n", "n", "n", "n", "n", "n", "l"]
    ));
  }
  blocks.push(P("★ 为链路龙头品种。主力合约为当日真实持仓量最大的月份合约代码；原始请求代码见工作台单品种走势面板。"));
  return { id: "futures-chains", title: "产业链深读", tag: "煤炭 · 化工 · 有色 · 能源 · 贵金属 · 农产品 · 新能源", blocks };
}

/* ============================================================
 * 九、主力价差
 * ============================================================ */
function buildSpreads() {
  const rows = SPREADS.map(s => {
    const fmtChg = v => (s.changeMode === "pct" ? pct(v) : has(v) ? `${v > 0 ? "+" : ""}${price(v)}` : "—");
    return [
      s.name_cn,
      s.available ? `${price(s.value)} ${unitCn(s.unit)}`.trim() : "—",
      s.available ? fmtChg(s.d1) : "—",
      s.available ? fmtChg(s.d5) : "—",
      s.available ? fmtChg(s.d20) : "—",
      s.available ? sgn(s.z1y) : "—",
      s.available ? pctRaw(s.pct1y, 1) : "—",
      s.desc || "—",
    ];
  });
  const blocks = [
    P("价差＝同链两个品种按行业单耗相减或相除，是加工环节利润的代理读数。差额型（元/吨）看绝对变化，比值型看百分比变化。"),
    table(["价差", "最新", "1 日", "5 日", "20 日", "z(1Y)", "1 年分位", "含义"], rows, ["l", "n", "n", "n", "n", "n", "n", "l"]),
  ];
  const ext = SPREADS.filter(s => s.available && has(s.pct1y) && (s.pct1y >= THRESH.pctHigh || s.pct1y <= THRESH.pctLow));
  if (ext.length) blocks.push(UL(ext.map(s => `**${s.name_cn}** 处于 1 年 ${pctRaw(s.pct1y, 1)} 分位（${s.pct1y >= THRESH.pctHigh ? "高位" : "低位"}）：${s.desc}`)));
  return { id: "futures-spreads", title: "主力价差", tag: "Spread · 加工利润代理", blocks };
}

/* ============================================================
 * 十、链内传导信号
 * ============================================================ */
function buildSignals() {
  if (!SIGNALS.length) return { id: "futures-signals", title: "链内传导信号", tag: "Chain signals", blocks: [P("本日无链条内部上下游强弱背离达到阈值（20 日中位数差 ≥ " + THRESH.tierGapPct + " 个百分点）。")] };
  const blocks = [table(["产业链", "类型", "严重度", "读数", "含义"], SIGNALS.map(s => [s.chain_cn, s.type, s.severity, s.detail, s.implication]), ["l", "l", "l", "l", "l"])];
  if (FUT.brief && FUT.brief.length) blocks.push(UL(FUT.brief));
  return { id: "futures-signals", title: "链内传导信号", tag: "Chain signals", blocks };
}

/* ============================================================
 * 十一、观察清单（阈值派生）
 * ============================================================ */
function buildWatch() {
  const items = [];
  const ext = liveVar.filter(v => has(v.z1y) && Math.abs(v.z1y) >= THRESH.zExtreme)
    .sort((a, b) => Math.abs(b.z1y) - Math.abs(a.z1y));
  for (const v of ext) {
    items.push(`**${v.name_cn}**（${v.chain_cn}）价格处 1 年 ${pctRaw(v.pct1y, 1)} 分位，z=${sgn(v.z1y)}，处于统计极端${v.z1y > 0 ? "高位，关注均值回归与追涨风险" : "低位，关注企稳信号"}。`);
  }
  const oi = liveVar.filter(v => has(v.oiChg5) && Math.abs(v.oiChg5) >= THRESH.oiSurge)
    .sort((a, b) => Math.abs(b.oiChg5) - Math.abs(a.oiChg5));
  for (const v of oi) {
    items.push(`**${v.name_cn}** 持仓量 5 日 ${pct(v.oiChg5)}（价格 5 日 ${pct(v.d5)}），${v.d5 > 0 === v.oiChg5 > 0 ? "量价同向，趋势可信度较高" : "量价背离，注意是否为减仓推动的短期反弹/回落"}。`);
  }
  for (const s of SPREADS.filter(x => x.available && has(x.pct1y) && (x.pct1y >= THRESH.pctHigh || x.pct1y <= THRESH.pctLow))) {
    items.push(`**${s.name_cn}** 处 1 年 ${pctRaw(s.pct1y, 1)} 分位（${s.pct1y >= THRESH.pctHigh ? "高位" : "低位"}），20 日变化 ${s.changeMode === "pct" ? pct(s.d20) : `${s.d20 > 0 ? "+" : ""}${price(s.d20)}`}：${s.desc}`);
  }
  for (const d of DIMS.filter(x => x.coverage.weightSum < 1)) {
    items.push(`**${d.name_cn}** 维度权重和仅 ${d.coverage.weightSum.toFixed(2)}，状态分代表性不足，判读该维度时需折扣。`);
  }
  for (const c of CHAINS.filter(x => x.metrics && (x.metrics.breadth === 1 || x.metrics.breadth === 0) && Math.abs(x.metrics.d5) >= 0.02)) {
    items.push(`**${c.name_cn}** 内部方向高度一致（广度 ${pctRaw(c.metrics.breadth, 0)}，5 日中位 ${pct(c.metrics.d5)}），属于板块性行情而非个别品种异动。`);
  }
  if (!items.length) items.push("本日无触达阈值的观察项。");
  return { id: "watch", title: "观察清单", tag: "Threshold-derived", blocks: [UL(items)] };
}

/* ============================================================
 * 十二、数据质量与口径
 * ============================================================ */
function buildQuality() {
  const meta = [
    ["数据来源", S.source?.data || "—"],
    ["配置版本", `${S.source?.registry?.version || "—"}（${S.source?.registry?.skillDir || "—"}）`],
    ["采集时间", S.source?.collectedAt || "—"],
    ["数据截止", S.asOf],
    ["回溯窗口", `${S.window?.begin} ~ ${S.window?.end}`],
    ["评分公式", S.scoringModel?.formula || "—"],
    ["权重状态", `${S.scoringModel?.weightProfileStatus || "—"}（未经回测冻结）`],
    ["指标覆盖", `总计 ${HL.indicatorTotal}，可评分 ${HL.indicatorScorable}`],
    ["期货口径", `${CHAINS.length} 条产业链 / ${FUT.liveVarietyCount} 个活跃品种，真实主力月份合约 + 换月等比复权，不参与六维评分`],
  ];
  const blocks = [
    table(["项", "值"], meta, ["l", "l"]),
  ];
  const dq = S.dataQuality || {};
  if ((dq.degraded || []).length) {
    blocks.push(P("**降级指标**"), UL(dq.degraded.map(d => `${d.name_cn}（${d.status}）：${d.reason || "—"}${has(d.ageDays) ? `，距今 ${d.ageDays} 天` : ""}`)));
  }
  if ((dq.derivedFailed || []).length) {
    blocks.push(P("**派生指标失败**"), UL(dq.derivedFailed.map(String)));
  }
  const staleFut = VARIETIES.filter(v => v.status !== "OK" || (has(v.staleDays) && v.staleDays > 0));
  if (staleFut.length) {
    blocks.push(P("**期货停更/滞后品种**"), UL(staleFut.map(v => `${v.name_cn}（${v.chain_cn}）：${v.status}，最后有效日 ${v.lastDate || "—"}${has(v.staleDays) ? `，滞后 ${v.staleDays} 天` : ""}`)));
  }
  if ((S.weights?.unavailableMembers || []).length) {
    blocks.push(P("**权重表不可用成员**（已按可用项重新归一化）：" + S.weights.unavailableMembers.join("、")));
  }
  blocks.push({ type: "note", text: (S.scoringModel?.disclaimer || "") + "\n本汇报由 scripts/macro-report.mjs 依快照规则生成，筛选与排序由代码完成，不含模型推算；所有数值可在工作台对应面板复核。" });
  return { id: "quality", title: "数据质量与口径", tag: "Lineage & quality", blocks };
}

/* ============================================================
 * 组装
 * ============================================================ */
/* 中文序号：支持到 30，避免章节增删时手工维护数组 */
function cnNum(n) {
  const d = "一二三四五六七八九";
  if (n <= 9) return d[n - 1];
  if (n === 10) return "十";
  if (n < 20) return "十" + d[n - 11];
  if (n === 20) return "二十";
  if (n < 30) return "二十" + d[n - 21];
  return "三十";
}
const sections = [
  buildSummary(),
  buildDeviations(),
  buildMacro(),
  buildRates(),
  buildRiskFx(),
  buildCredit(),
  buildGrowth(),
  buildInflation(),
  buildProperty(),
  buildConsumptionExternal(),
  buildExtremes(),
  buildDivergence(),
  buildAnomaly(),
  buildFuturesOverview(),
  buildFuturesMovers(),
  buildChainDeepDive(),
  buildSpreads(),
  buildSignals(),
  buildIndicatorTable(),
  buildWatch(),
  buildQuality(),
].map((s, i) => ({ ...s, order: i + 1, title: `${cnNum(i + 1)}、${s.title}` }));

const generated = new Date().toISOString();
const title = `宏观高频 × 期货产业链 · 每日汇报`;
const subtitle = `${S.asOf}｜综合状态分 ${HL.composite}（${HL.label}）`;

/* --- Markdown --- */
const md = [];
md.push(`# ${title}`);
md.push("");
md.push(`**${subtitle}**`);
md.push("");
md.push(`> 生成时间 ${generated}｜数据源 ${S.source?.data || "—"}｜采集 ${S.source?.collectedAt || "—"}｜本文件由规则生成，数值全部来自 ` + "`public/macro-snapshot.json`" + `。`);
md.push("");
md.push(`**目录**　` + sections.map(s => `[${s.title}](#${s.id})`).join("　·　"));
md.push("");
for (const s of sections) {
  md.push(`## ${s.title}`);
  md.push("");
  md.push(blocksToMd(s.blocks));
}
md.push("---");
md.push("");
md.push(`_${S.scoringModel?.disclaimer || ""}_`);
md.push("");

writeFileSync(mdOut, md.join("\n"), "utf8");
if (!existsSync(reportDir)) mkdirSync(reportDir, { recursive: true });
const archivePath = resolve(reportDir, `${S.asOf}.md`);
writeFileSync(archivePath, md.join("\n"), "utf8");

/* --- JSON（工作台消费） --- */
const reportJson = {
  contract: "MACRO_DAILY_REPORT",
  version: "1.0.0",
  asOf: S.asOf,
  generatedAt: generated,
  title,
  subtitle,
  tone: HL.label,
  composite: HL.composite,
  markdownFile: "macro-daily-report.md",
  archiveFile: `work/macro/reports/${S.asOf}.md`,
  summaryLine: `${subtitle}｜期货最强链 ${chainSorted[0] ? chainSorted[0].name_cn + " " + pct(chainSorted[0].metrics.d5) : "—"}｜异常 ${HL.anomalyCount} 项（高风险 ${HL.highSeverityCount}）`,
  sections: sections.map(s => ({ id: s.id, order: s.order, title: s.title, tag: s.tag, blocks: s.blocks })),
};
writeFileSync(jsonOut, JSON.stringify(reportJson, null, 1), "utf8");

/* --- 控制台摘要 --- */
const kb = v => (v / 1024).toFixed(0) + " KB";
console.log(`${title}  ${S.asOf}`);
console.log("─".repeat(72));
for (const s of sections) {
  let n = 0;
  for (const b of s.blocks) {
    if (b.type === "ul") n += b.items.length;
    else if (b.type === "table") n += b.rows.length;
    else n += 1;
  }
  console.log(`  ${String(s.order).padStart(2)}. ${s.title.replace(/^[一二三四五六七八九十]+、/, "").padEnd(12)} 区块 ${String(s.blocks.length).padStart(2)}  条目 ${String(n).padStart(3)}`);
}
console.log("─".repeat(72));
console.log(`摘要首条 : ${(sections[0].blocks[0].items[0] || "").replace(/\*\*/g, "")}`);
console.log(`→ Markdown: ${mdOut} (${kb(readFileSync(mdOut, "utf8").length)})`);
console.log(`→ 归档    : ${archivePath}`);
console.log(`→ JSON    : ${jsonOut} (${kb(readFileSync(jsonOut, "utf8").length)})`);
