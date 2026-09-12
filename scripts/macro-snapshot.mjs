// 宏观高频监测 · 评分与信号层
//
// 铁律（Spec §37 / §18 / §20）：
//   zscore / percentile / change / 维度分 / 异常判定 —— 全部由本文件用代码算出。
//   LLM 只负责解释已经算好的结构化 signal，绝不参与计算。
//
// 输入：work/macro/observations.json（由 macro-collect.mjs 产出）
// 输出：public/macro-snapshot.json（前端消费）
//       work/macro/snapshots/<日期>.json（每日留档，用于累积分数序列）
import { mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadMacroConfig } from "./macro-config.mjs";
import { buildFuturesAnalysis } from "./macro-futures.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const workDir = resolve(root, "work/macro");
const snapshotDir = resolve(workDir, "snapshots");
mkdirSync(snapshotDir, { recursive: true });

const config = loadMacroConfig();
const observations = JSON.parse(readFileSync(resolve(workDir, "observations.json"), "utf8"));

/* ------------------------------------------------------------------ */
/* 基础统计（纯代码，无 LLM）                                            */
/* ------------------------------------------------------------------ */

const OBS_WINDOWS = {
  daily: { z1y: 250, p3y: 750, p5y: 1250 },
  weekly: { z1y: 52, p3y: 156, p5y: 260 },
  monthly: { z1y: 12, p3y: 36, p5y: 60 },
  quarterly: { z1y: 4, p3y: 12, p5y: 20 },
};

const mean = arr => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);
function std(arr) {
  if (arr.length < 2) return null;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((acc, v) => acc + (v - m) ** 2, 0) / (arr.length - 1));
}
/** 当前值在历史窗口中的分位（0~1），并列取平均秩 */
function percentileOf(history, value) {
  if (!history.length) return null;
  const below = history.filter(v => v < value).length;
  const equal = history.filter(v => v === value).length;
  return (below + equal / 2) / history.length;
}
function percentileValue(history, p) {
  if (!history.length) return null;
  const sorted = [...history].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
  return sorted[idx];
}
const round = (value, digits = 4) => (value === null || value === undefined || !Number.isFinite(value)
  ? null
  : Number(value.toFixed(digits)));

/**
 * 方向极性：数值上升对「宏观扩张 / 风险偏好」是正向(+1) 还是负向(-1)；contextual 记 0。
 *
 * 优先从 signal_rules.yaml 的 direction_semantics.polarity 读取（配置为唯一真源），
 * 配置缺失时回落到内置默认值。历史踩坑：registry 曾使用 higher_is_looser，
 * 而方向语义表未登记该标签，导致 M2 / 社融被静默排除出评分。
 */
const POLARITY_FALLBACK = {
  higher_is_stronger: 1,
  lower_is_stronger: -1,
  higher_is_tighter: -1,
  lower_is_tighter: 1,
  higher_is_looser: 1,
  lower_is_looser: -1,
  contextual: 0,
};

const POLARITY = { ...POLARITY_FALLBACK };
for (const [key, value] of Object.entries(config.directionSemantics || {})) {
  const polarity = Number(value?.polarity);
  if (Number.isFinite(polarity)) POLARITY[key] = polarity;
}
const UNKNOWN_DIRECTIONS = new Set();

function directionOf(item) {
  const direction = item?.signal?.direction;
  if (typeof direction !== "string") return "contextual";
  if (direction in POLARITY) return direction;
  UNKNOWN_DIRECTIONS.add(direction);
  return "contextual";
}

function computeStats(series, frequency) {
  const win = OBS_WINDOWS[frequency] || OBS_WINDOWS.monthly;
  const pts = series.filter(p => p.v !== null && Number.isFinite(p.v));
  if (!pts.length) {
    return { count: 0, latest: null, prev: null, changes: {}, z1y: null, pct1y: null, pct3y: null, pct5y: null, ma20: null, moveExtreme: null };
  }
  const values = pts.map(p => p.v);
  const latest = pts.at(-1);

  const changeAt = back => (values.length > back ? latest.v - values[values.length - 1 - back] : null);
  const changes = {
    chg1: round(changeAt(1)),
    chg5: round(changeAt(5)),
    chg20: round(changeAt(20)),
    chg12: round(changeAt(12)),
  };

  const zWindow = values.slice(-win.z1y);
  const zMean = mean(zWindow);
  const zStd = std(zWindow);
  const z1y = zStd && zStd > 1e-9 ? round((latest.v - zMean) / zStd) : null;

  const p3Window = values.slice(-win.p3y);
  const p5Window = values.slice(-win.p5y);
  const pct1y = round(percentileOf(zWindow, latest.v));
  const pct3y = round(percentileOf(p3Window, latest.v));
  const pct5y = round(percentileOf(p5Window, latest.v));

  const ma20 = round(mean(values.slice(-20)));

  // 5 期变化的极端度：|chg5| 在近 3 年 |chg5| 分布中的分位
  let moveExtreme = null;
  if (values.length > win.p3y) {
    const hist = [];
    for (let i = 5; i < values.length; i += 1) hist.push(Math.abs(values[i] - values[i - 5]));
    const hist3y = hist.slice(-win.p3y);
    if (changes.chg5 !== null && hist3y.length > 20) {
      moveExtreme = round(percentileOf(hist3y, Math.abs(changes.chg5)));
    }
  }

  // 1 期（当日/当月）变化的极端度 —— 「今天这一下，在该指标自身近 3 年的单期变化里有多极端」。
  // 这是「当日明显偏离」判定的核心量：只看 z(1Y) 只能说明位置高/低，说明不了今天变化大不大。
  let chg1Extreme = null;
  if (values.length > win.p3y) {
    const hist1 = [];
    for (let i = 1; i < values.length; i += 1) hist1.push(Math.abs(values[i] - values[i - 1]));
    const hist1w = hist1.slice(-win.p3y);
    if (changes.chg1 !== null && hist1w.length > 20) {
      chg1Extreme = round(percentileOf(hist1w, Math.abs(changes.chg1)));
    }
  }

  return {
    count: values.length,
    firstDate: pts[0].d,
    latest: { date: latest.d, value: latest.v },
    prev: pts.length > 1 ? { date: pts.at(-2).d, value: pts.at(-2).v } : null,
    changes,
    z1y,
    pct1y,
    pct3y,
    pct5y,
    ma20,
    moveExtreme,
    chg1Extreme,
    zWindowSize: zWindow.length,
  };
}

/* ------------------------------------------------------------------ */
/* 派生序列                                                            */
/* ------------------------------------------------------------------ */

function seriesOf(id) {
  const item = observations.indicators[id];
  return item ? item.series : [];
}

function subtractSeries(a, b) {
  const bMap = new Map(b.filter(p => p.v !== null).map(p => [p.d, p.v]));
  return a
    .filter(p => p.v !== null && bMap.has(p.d))
    .map(p => ({ d: p.d, v: round(p.v - bMap.get(p.d)), r: p.r }));
}

const derivedSeries = new Map();
for (const item of config.derived) {
  const formula = String(item.derived?.formula || "");
  const match = formula.match(/^\s*([A-Z0-9_]+)\s*-\s*([A-Z0-9_]+)\s*$/);
  if (!match) {
    derivedSeries.set(item.id, { ok: false, reason: `公式无法解析: ${formula}` });
    continue;
  }
  const [, leftId, rightId] = match;
  const left = seriesOf(leftId);
  const right = seriesOf(rightId);
  if (!left.length || !right.length) {
    derivedSeries.set(item.id, { ok: false, reason: `缺少支撑序列 ${!left.length ? leftId : rightId}` });
    continue;
  }
  const series = subtractSeries(left, right);
  derivedSeries.set(item.id, { ok: series.length > 0, series, reason: series.length ? null : "对齐后无交集" });
}

/* ------------------------------------------------------------------ */
/* 逐指标状态                                                          */
/* ------------------------------------------------------------------ */

const TODAY = observations.window.end;
const dayDiff = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);

const freshCfg = config.freshness || {};
const DISC_THRESHOLD_DAYS = 60; // 日频指标超过 60 天无有效观测 → 判定合约/序列已停更

const states = [];
for (const meta of config.indicators) {
  const derived = derivedSeries.get(meta.id);
  const source = derived && derived.ok ? derived.series : seriesOf(meta.id);
  const frequency = meta.frequency || "monthly";
  const stats = computeStats(source, frequency);
  const direction = directionOf(meta);
  const polarity = POLARITY[direction];

  let status = "OK";
  let ageDays = null;
  if (!stats.latest) {
    status = "MISSING";
  } else {
    ageDays = dayDiff(stats.latest.date, TODAY);
    if (frequency === "daily" && ageDays > DISC_THRESHOLD_DAYS) {
      status = "DISCONTINUED";
    } else {
      const cfg = freshCfg[frequency] || freshCfg.monthly || {};
      const freshWithin = cfg.fresh_within_days ?? 45;
      const staleAfter = cfg.stale_after_days ?? cfg.stale_after_trading_days ?? 75;
      if (ageDays <= freshWithin) status = "FRESH";
      else if (ageDays <= staleAfter) status = "EXPECTED";
      else status = "STALE";
    }
  }

  const dirZ = stats.z1y === null ? null : round(polarity * stats.z1y);
  const scorable = status !== "MISSING" && status !== "DISCONTINUED" && polarity !== 0 && stats.z1y !== null;

  states.push({
    id: meta.id,
    name_cn: meta.name_cn,
    layer: meta.layer,
    dimension: meta.dimension || null,
    category: meta.category || null,
    frequency,
    unit: meta.unit || null,
    importance: meta.importance || null,
    tool: derived && derived.ok ? "DERIVED" : meta.ifind?.tool || null,
    fieldCode: meta.ifind?.field_code || null,
    direction,
    polarity,
    status,
    ageDays,
    scorable,
    notScorableReason: scorable
      ? null
      : !stats.latest
        ? "无有效观测"
        : status === "DISCONTINUED"
          ? `序列已停更（最后有效观测 ${stats.latest.date}）`
          : polarity === 0
            ? `方向 ${direction}，按约定不参与打分`
            : "z 值不可计算（窗口内无波动或样本不足）",
    stats,
    dirZ,
    series: source,
  });
}

const byId = new Map(states.map(item => [item.id, item]));

/* ------------------------------------------------------------------ */
/* 六维评分                                                            */
/* ------------------------------------------------------------------ */

const weightDims = config.weightProfile.dimensions || {};
const dimensionMeta = config.dimensions || {};
const dimensionKeys = Object.keys(weightDims);

const dimensionResult = [];
for (const key of dimensionKeys) {
  const weights = weightDims[key] || {};
  const members = [];
  const missingWeightMembers = [];
  let weightSum = 0;
  let weighted = 0;

  for (const [indicatorId, weight] of Object.entries(weights)) {
    const state = byId.get(indicatorId);
    if (!state) {
      missingWeightMembers.push({ id: indicatorId, reason: "不在注册表" });
      continue;
    }
    if (!state.scorable) {
      missingWeightMembers.push({ id: indicatorId, reason: state.notScorableReason || state.status });
      continue;
    }
    weightSum += weight;
    weighted += weight * state.dirZ;
    members.push({ id: indicatorId, name_cn: state.name_cn, weight, z: state.stats.z1y, dirZ: state.dirZ, status: state.status });
  }

  const zMean = weightSum > 0 ? weighted / weightSum : null;
  const score = zMean === null ? null : round(Math.max(0, Math.min(100, 50 + 20 * zMean)), 1);
  const upCount = members.filter(m => m.dirZ > 0.5).length;
  const downCount = members.filter(m => m.dirZ < -0.5).length;

  dimensionResult.push({
    key,
    name_cn: dimensionMeta[key]?.name_cn || key,
    score,
    zMean: round(zMean),
    coverage: { used: members.length, configured: Object.keys(weights).length, weightSum: round(weightSum, 3) },
    missingWeightMembers,
    members,
    upCount,
    downCount,
    directionBias: members.length ? round(members.reduce((acc, m) => acc + m.dirZ, 0) / members.length) : null,
  });
}

const scorableDims = dimensionResult.filter(d => d.score !== null);
const composite = scorableDims.length
  ? round(scorableDims.reduce((acc, d) => acc + d.score, 0) / scorableDims.length, 1)
  : null;

/** 综合分语义分档（阈值与 signal_rules 的 zscore 档位保持一致） */
function compositeLabel(score) {
  if (score === null) return "数据不足";
  if (score >= 62) return "明显扩张";
  if (score >= 55) return "温和扩张";
  if (score >= 45) return "中性震荡";
  if (score >= 38) return "温和收缩";
  return "明显收缩";
}

/* ------------------------------------------------------------------ */
/* 异常识别                                                            */
/* ------------------------------------------------------------------ */

const anomalies = [];
for (const state of states) {
  const triggers = [];
  const { stats } = state;
  if (stats.z1y !== null && Math.abs(stats.z1y) >= 2) {
    triggers.push({ id: "ZSCORE_EXTREME", detail: `|z|=${Math.abs(stats.z1y)}≥2` });
  }
  if (stats.pct3y !== null && stats.pct3y <= 0.05) {
    triggers.push({ id: "PERCENTILE_LOW", detail: `3年分位 ${(stats.pct3y * 100).toFixed(1)}%≤5%` });
  }
  if (stats.pct3y !== null && stats.pct3y >= 0.95) {
    triggers.push({ id: "PERCENTILE_HIGH", detail: `3年分位 ${(stats.pct3y * 100).toFixed(1)}%≥95%` });
  }
  if (stats.moveExtreme !== null && stats.moveExtreme >= 0.95) {
    triggers.push({ id: "FIVE_DAY_MOVE_EXTREME", detail: `5期变化处于近3年 ${(stats.moveExtreme * 100).toFixed(1)}% 分位` });
  }
  if (triggers.length && state.status !== "DISCONTINUED" && state.status !== "MISSING") {
    anomalies.push({
      id: state.id,
      name_cn: state.name_cn,
      dimension: state.dimension,
      frequency: state.frequency,
      unit: state.unit,
      status: state.status,
      latest: stats.latest,
      z1y: stats.z1y,
      dirZ: state.dirZ,
      pct3y: stats.pct3y,
      changes: stats.changes,
      triggers,
      severity: triggers.some(t => t.id === "ZSCORE_EXTREME" || t.id.endsWith("PERCENTILE_HIGH") || t.id.endsWith("PERCENTILE_LOW")) ? "high" : "medium",
    });
  }
}

// 维度内部同向聚集：同一维度 ≥3 个指标同向
for (const dim of dimensionResult) {
  if (dim.downCount >= 3 || dim.upCount >= 3) {
    const sameDirection = dim.downCount >= 3 ? "down" : "up";
    anomalies.push({
      id: `DIM_${dim.key.toUpperCase()}_SAME_DIRECTION`,
      name_cn: `${dim.name_cn}维度同向聚集`,
      dimension: dim.key,
      frequency: "-",
      status: "OK",
      latest: null,
      z1y: dim.zMean,
      dirZ: null,
      pct3y: null,
      changes: {},
      triggers: [{ id: "THREE_SAME_DIRECTION", detail: `${sameDirection === "down" ? "走弱" : "走强"}指标 ${sameDirection === "down" ? dim.downCount : dim.upCount} 个（阈值 3）` }],
      severity: "medium",
      aggregate: true,
    });
  }
}

/* ------------------------------------------------------------------ */
/* 背离检测（Spec §39，本模块最高价值功能）                              */
/* ------------------------------------------------------------------ */

const divergences = [];
for (const rule of config.divergenceRules) {
  const summarize = ids => {
    const group = ids.map(id => byId.get(id)).filter(Boolean).map(s => ({ id: s.id, name_cn: s.name_cn, z: s.stats.z1y }));
    const usable = group.filter(g => g.z !== null);
    return {
      members: group,
      usable: usable.length,
      up: usable.filter(g => g.z > 0.5).length,
      down: usable.filter(g => g.z < -0.5).length,
      meanZ: round(mean(usable.map(g => g.z))),
    };
  };
  const fundamental = summarize(rule.fundamental_side || []);
  const market = summarize(rule.market_side || []);
  const a = fundamental, b = market;
  const hit = a.usable >= 2 && b.usable >= 2
    && ((a.up > a.down && b.down > b.up) || (a.down > a.up && b.up > b.down));

  divergences.push({
    id: rule.id,
    name_cn: rule.name_cn,
    question: rule.question,
    severity: rule.severity,
    logic: rule.logic,
    hit,
    fundamental,
    market,
    interpretation: hit
      ? `基本面组 ${a.up} 强 / ${a.down} 弱，市场组 ${b.up} 强 / ${b.down} 弱 —— 方向相反，触发背离`
      : `未触发：基本面组 ${a.up} 强 / ${a.down} 弱，市场组 ${b.up} 强 / ${b.down} 弱`,
  });
}

/* ------------------------------------------------------------------ */
/* 异动榜                                                              */
/* ------------------------------------------------------------------ */

const ranked = states
  .filter(s => s.scorable && s.dirZ !== null)
  .slice()
  .sort((a, b) => Math.abs(b.dirZ) - Math.abs(a.dirZ));

const movers = {
  // 「走强」= 方向校正后为正，即对宏观扩张有利
  stronger: ranked.filter(s => s.dirZ > 0).slice(0, 10).map(s => ({
    id: s.id, name_cn: s.name_cn, dimension: s.dimension, unit: s.unit, frequency: s.frequency,
    dirZ: s.dirZ, z1y: s.stats.z1y, pct3y: s.stats.pct3y, latest: s.stats.latest, changes: s.stats.changes,
  })),
  weaker: ranked.filter(s => s.dirZ < 0).slice(0, 10).map(s => ({
    id: s.id, name_cn: s.name_cn, dimension: s.dimension, unit: s.unit, frequency: s.frequency,
    dirZ: s.dirZ, z1y: s.stats.z1y, pct3y: s.stats.pct3y, latest: s.stats.latest, changes: s.stats.changes,
  })),
};

/* ------------------------------------------------------------------ */
/* 期货产业链分析（与六维评分平行，不参与打分）                          */
/* ------------------------------------------------------------------ */

const futures = buildFuturesAnalysis({ config, observations, asOf: TODAY });

/* ------------------------------------------------------------------ */
/* 图表数据（裁剪以控制体积）                                            */
/* ------------------------------------------------------------------ */

function trimSeries(series, frequency) {
  const cap = frequency === "daily" ? 520 : frequency === "weekly" ? 260 : series.length;
  const valid = series.filter(p => p.v !== null);
  return valid.slice(-cap).map(p => [p.d, p.v]);
}

const trendIds = states
  .filter(s => s.status === "FRESH" || s.status === "EXPECTED")
  .map(s => s.id);

const trends = {};
for (const id of trendIds) {
  const state = byId.get(id);
  const points = trimSeries(state.series, state.frequency);
  if (points.length < 2) continue;
  trends[id] = {
    id,
    name_cn: state.name_cn,
    dimension: state.dimension,
    category: state.category,
    unit: state.unit,
    importance: state.importance,
    frequency: state.frequency,
    z1y: state.stats.z1y,
    dirZ: state.dirZ,
    pct1y: state.stats.pct1y,
    pct3y: state.stats.pct3y,
    latest: state.stats.latest,
    changes: state.stats.changes,
    points,
  };
}

// 全指标总表：报告与工作台的「宏观市场层」共用同一份数，避免各处自行重算（Spec §37）
// 同时给出绝对变化（changes，与指标同单位）与百分比变化（pctChg1/5/20，用于指数、价格类横向比较）
const pctChange = (latest, back) =>
  back === null || back === undefined || !Number.isFinite(back) || Math.abs(back) < 1e-9
    ? null
    : round(((latest - back) / Math.abs(back)) * 100, 4);

const indicators = states.map(state => {
  const s = state.stats;
  const v = s.latest ? s.latest.value : null;
  const back = k => (s.changes && Number.isFinite(s.changes[k]) ? round(v - s.changes[k]) : null);
  return {
    id: state.id,
    name_cn: state.name_cn,
    layer: state.layer,
    dimension: state.dimension,
    category: state.category,
    frequency: state.frequency,
    unit: state.unit,
    importance: state.importance,
    direction: state.direction,
    polarity: state.polarity,
    status: state.status,
    ageDays: state.ageDays,
    scorable: state.scorable,
    latest: s.latest,
    changes: s.changes,
    pctChg1: pctChange(v, back("chg1")),
    pctChg5: pctChange(v, back("chg5")),
    pctChg20: pctChange(v, back("chg20")),
    pctChg12: pctChange(v, back("chg12")),
    z1y: s.z1y,
    dirZ: state.dirZ,
    pct1y: s.pct1y,
    pct3y: s.pct3y,
    ma20: s.ma20,
    moveExtreme: s.moveExtreme,
    chg1Extreme: s.chg1Extreme,
  };
});

// 分类（category）分组索引，供报告的「宏观市场层」章节直接消费
const categories = {};
for (const item of indicators) {
  const key = item.category || "uncategorized";
  if (!categories[key]) categories[key] = [];
  categories[key].push(item.id);
}

// 利率曲线（同族口径，Spec 建议用 L001619604 系列）
const curveMembers = ["MKT_CGB_1Y", "MKT_CGB_3Y", "MKT_CGB_10Y", "MKT_CGB_30Y"];
const curveSeries = {};
const curveDates = new Set();
for (const id of curveMembers) {
  const state = byId.get(id);
  if (!state) continue;
  const points = trimSeries(state.series, "daily").slice(-260);
  curveSeries[id] = { name_cn: state.name_cn, points };
  for (const [date] of points) curveDates.add(date);
}
const curveDatesSorted = [...curveDates].sort();
const yieldCurve = {
  dates: curveDatesSorted,
  series: Object.fromEntries(Object.entries(curveSeries).map(([id, value]) => {
    const map = new Map(value.points);
    return [id, { name_cn: value.name_cn, values: curveDatesSorted.map(d => (map.has(d) ? map.get(d) : null)) }];
  })),
  // 最新一条完整曲线（用于期限结构形状图）
  latestShape: curveMembers
    .map(id => {
      const state = byId.get(id);
      return state?.stats?.latest ? { id, name_cn: state.name_cn, tenor: state.name_cn.match(/(\d+)年/)?.[1], date: state.stats.latest.date, value: state.stats.latest.value } : null;
    })
    .filter(Boolean),
};

const heatmap = {
  dimensions: dimensionResult.map(dim => ({
    key: dim.key,
    name_cn: dim.name_cn,
    score: dim.score,
    zMean: dim.zMean,
    cells: states
      .filter(s => s.dimension === dim.key && s.status !== "MISSING" && s.status !== "DISCONTINUED" && s.stats.z1y !== null)
      .map(s => ({
        id: s.id, name_cn: s.name_cn, z: s.stats.z1y, dirZ: s.dirZ,
        pct3y: s.stats.pct3y, status: s.status, frequency: s.frequency, scorable: s.scorable,
      }))
      .sort((a, b) => (b.dirZ ?? 0) - (a.dirZ ?? 0)),
  })),
};

/* ------------------------------------------------------------------ */
/* 结构化简报（模板生成，非 LLM）                                        */
/* ------------------------------------------------------------------ */

function buildBrief() {
  const lines = [];
  lines.push(`综合宏观状态分 ${composite ?? "-"}（${compositeLabel(composite)}），六维中 ${scorableDims.filter(d => (d.score ?? 50) >= 55).length} 个扩张、${scorableDims.filter(d => (d.score ?? 50) <= 45).length} 个收缩。`);

  const sorted = scorableDims.slice().sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  if (sorted.length) {
    const strongest = sorted[0];
    const weakest = sorted[sorted.length - 1];
    lines.push(`最强维度：${strongest.name_cn} ${strongest.score}（z均值 ${strongest.zMean}，配置成员 ${strongest.coverage.used}/${strongest.coverage.configured} 可用）；最弱维度：${weakest.name_cn} ${weakest.score}（z均值 ${weakest.zMean}）。`);
  }

  // 展示「原始 z → 方向校正后」两个数，避免读者把利率/通胀类指标的原始 z 符号读反
  const fmtMover = m => `${m.name_cn}(z=${m.z1y}，校正后=${m.dirZ})`;
  const strongNames = movers.stronger.slice(0, 3).map(fmtMover).join("、");
  const weakNames = movers.weaker.slice(0, 3).map(fmtMover).join("、");
  if (strongNames) lines.push(`方向校正后对宏观扩张最有利：${strongNames}。`);
  if (weakNames) lines.push(`方向校正后对宏观扩张最不利：${weakNames}。`);

  const hits = divergences.filter(d => d.hit);
  if (hits.length) {
    lines.push(`触发 ${hits.length} 条背离：${hits.map(d => `${d.name_cn}（${d.question}）`).join("；")}。`);
  } else {
    lines.push("未触发任何背离规则：基本面与市场定价方向一致。");
  }

  if (anomalies.length) {
    const aggregate = anomalies.filter(a => a.aggregate).length;
    const single = anomalies.length - aggregate;
    lines.push(`异常 ${anomalies.length} 项（单指标 ${single} + 维度聚集 ${aggregate}），其中高风险 ${anomalies.filter(a => a.severity === "high").length} 项。`);
  } else {
    lines.push("无异常触发。");
  }

  const degraded = states.filter(s => s.status === "DISCONTINUED" || s.status === "MISSING" || s.status === "STALE");
  if (degraded.length) {
    lines.push(`数据质量提示：${degraded.map(s => `${s.name_cn}(${s.status}${s.ageDays !== null ? `, ${s.ageDays}天前` : ""})`).join("、")}。`);
  }

  lines.push("⚠️ 六维权重档位为 DRAFT（未回测），综合分用于观察，不构成下注依据（Spec §20）。");
  return { tone: compositeLabel(composite), lines };
}

/* ------------------------------------------------------------------ */
/* 落盘                                                                */
/* ------------------------------------------------------------------ */

const freshnessTally = states.reduce((acc, s) => {
  acc[s.status] = (acc[s.status] || 0) + 1;
  return acc;
}, {});

const snapshot = {
  contract: "MACRO_SNAPSHOT",
  version: "1.0.0",
  generatedAt: new Date().toISOString(),
  asOf: TODAY,
  window: observations.window,
  source: {
    data: "iFinD MCP (THS_EDB / THS_HQ)",
    registry: observations.registry,
    collectedAt: observations.collectedAt,
  },
  scoringModel: {
    polarity: POLARITY,
    formula: "dimensionScore = clamp(50 + 20 * weightedMean(polarity × zscore_1y), 0, 100)；composite = 各维度等权均值",
    dimensionAggregation: "weighted_mean",
    weightProfileStatus: config.weightProfile.status || "draft",
    zWindow: OBS_WINDOWS,
    unknownDirections: [...UNKNOWN_DIRECTIONS],
    disclaimer: "权重档位为 DRAFT，未经回测冻结；综合分仅用于观察宏观方向，禁止作为下注依据。",
  },
  headline: {
    composite,
    label: compositeLabel(composite),
    anomalyCount: anomalies.length,
    highSeverityCount: anomalies.filter(a => a.severity === "high").length,
    divergenceHits: divergences.filter(d => d.hit).length,
    freshness: freshnessTally,
    indicatorTotal: states.length,
    indicatorScorable: states.filter(s => s.scorable).length,
  },
  dimensions: dimensionResult,
  heatmap,
  movers,
  anomalies: anomalies.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "high" ? -1 : 1)),
  divergences,
  yieldCurve,
  // 全指标总表：报告与工作台共用，避免各处自行重算（Spec §37）
  indicators,
  categories,
  trends,
  futures,
  brief: buildBrief(),
  dataQuality: {
    degraded: states
      .filter(s => s.status !== "OK" && s.status !== "FRESH" && s.status !== "EXPECTED")
      .map(s => ({ id: s.id, name_cn: s.name_cn, status: s.status, ageDays: s.ageDays, latest: s.stats.latest, reason: s.notScorableReason })),
    derivedOk: [...derivedSeries.entries()].filter(([, v]) => v.ok).map(([k]) => k),
    derivedFailed: [...derivedSeries.entries()].filter(([, v]) => !v.ok).map(([k, v]) => ({ id: k, reason: v.reason })),
  },
  weights: {
    // 供审计：权重表里引用但当前不可用的成员
    unavailableMembers: [...new Set(dimensionResult.flatMap(d => d.missingWeightMembers.map(m => m.id)))],
  },
};

writeFileSync(resolve(root, "public/macro-snapshot.json"), JSON.stringify(snapshot, null, 2), "utf8");
writeFileSync(resolve(snapshotDir, `${TODAY}.json`), JSON.stringify({
  asOf: TODAY, generatedAt: snapshot.generatedAt, composite,
  dimensions: dimensionResult.map(d => ({ key: d.key, score: d.score, zMean: d.zMean })),
  anomalyCount: anomalies.length, divergenceHits: divergences.filter(d => d.hit).length,
}), "utf8");

const historyFiles = readdirSync(snapshotDir).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();

console.log(`数据截止      : ${TODAY}`);
console.log(`综合宏观状态分 : ${composite}（${compositeLabel(composite)}）`);
console.log("");
console.log("六维明细：");
for (const dim of dimensionResult) {
  const bar = dim.score === null ? "" : "█".repeat(Math.round(dim.score / 5)).padEnd(20, "·");
  console.log(`  ${dim.name_cn.padEnd(5)} ${String(dim.score ?? "-").padStart(5)}  z=${String(dim.zMean ?? "-").padStart(6)}  ${bar}  成员 ${dim.coverage.used}/${dim.coverage.configured}`);
}
console.log("");
console.log(`异常 ${anomalies.length} 项（高风险 ${snapshot.headline.highSeverityCount}）| 背离触发 ${snapshot.headline.divergenceHits}/${divergences.length}`);
console.log(`新鲜度   : ${Object.entries(freshnessTally).map(([k, v]) => `${k}=${v}`).join("  ")}`);
console.log(`可参与评分: ${snapshot.headline.indicatorScorable}/${snapshot.headline.indicatorTotal}`);
if (snapshot.dataQuality.degraded.length) {
  console.log("数据质量降级：");
  for (const d of snapshot.dataQuality.degraded) console.log(`  ${d.status.padEnd(13)} ${d.id.padEnd(20)} ${d.name_cn}${d.ageDays !== null ? ` (${d.ageDays}天前)` : ""}`);
}
if (snapshot.weights.unavailableMembers.length) {
  console.log(`权重表内不可用成员（已按可用项归一化）: ${snapshot.weights.unavailableMembers.join(", ")}`);
}
if (UNKNOWN_DIRECTIONS.size) {
  console.log(`⚠️ 未登记的方向标签（已降级为 contextual）: ${[...UNKNOWN_DIRECTIONS].join(", ")}`);
}
console.log("");
console.log(`期货产业链：${futures.chainCount} 条链 / ${futures.liveVarietyCount} 个活跃品种（共 ${futures.varietyCount}）`);
for (const c of futures.chains) {
  const d5 = c.metrics.d5 === null ? "  -  " : `${(c.metrics.d5 * 100 >= 0 ? "+" : "") + (c.metrics.d5 * 100).toFixed(1)}%`;
  const br = c.metrics.breadth === null ? " -" : `${(c.metrics.breadth * 100).toFixed(0)}%`;
  console.log(`  ${c.name_cn.padEnd(11)} d5 ${d5.padStart(7)}  广度 ${br.padStart(4)}  品种 ${c.liveCount}/${c.memberCount}`);
}
const liveSpread = futures.spreads.filter(s => s.available);
if (liveSpread.length) {
  console.log(`价差 ${liveSpread.length}/${futures.spreads.length} 条可用`);
  for (const s of liveSpread) {
    const d5 = s.d5 === null ? "-" : s.changeMode === "pct" ? `${(s.d5 * 100).toFixed(1)}%` : `${s.d5 >= 0 ? "+" : ""}${s.d5}`;
    console.log(`  ${s.name_cn.padEnd(12)} ${String(s.value).padStart(10)}  d5 ${d5.padStart(9)}  1年分位 ${s.pct1y === null ? "-" : (s.pct1y * 100).toFixed(0) + "%"}`);
  }
}
if (futures.signals.length) {
  console.log("链内信号：");
  for (const s of futures.signals) console.log(`  [${s.severity}] ${s.implication}（${s.detail}）`);
}
console.log(`历史快照累计: ${historyFiles.length} 天`);
console.log("→ public/macro-snapshot.json");
console.log(`→ work/macro/snapshots/${TODAY}.json`);
