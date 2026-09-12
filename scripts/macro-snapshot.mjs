/**
 * MACRO_SNAPSHOT 统计与信号唯一入口。
 * collect 提供原始序列；report/workbench 只消费这里生成的结构化结论。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
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
const TODAY = observations.window.end;

const requiredNumber = (value, path) => {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`signal_rules.yaml 缺少有效数值 ${path}`);
  return number;
};
const round = (value, digits = 4) => value === null || value === undefined || !Number.isFinite(value)
  ? null : Number(value.toFixed(digits));
const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const std = values => {
  if (values.length < 2) return null;
  const average = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1));
};
const median = values => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const percentileOf = (history, value) => {
  if (!history.length || !Number.isFinite(value)) return null;
  const below = history.filter(item => item < value).length;
  const equal = history.filter(item => item === value).length;
  return (below + equal / 2) / history.length;
};
const pctChange = (values, back) => {
  if (values.length <= back) return null;
  const latest = values.at(-1);
  const previous = values[values.length - 1 - back];
  return Number.isFinite(latest) && Number.isFinite(previous) && previous !== 0 ? (latest - previous) / Math.abs(previous) : null;
};
const dayDiff = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);

const windows = config.standardization.windows || {};
const minimum = config.standardization.min_samples || {};
for (const frequency of ["daily", "weekly", "monthly", "quarterly"]) {
  for (const key of ["z1y", "p3y", "p5y"]) requiredNumber(windows[frequency]?.[key], `standardization.windows.${frequency}.${key}`);
}
const minZ = requiredNumber(minimum.zscore, "standardization.min_samples.zscore");
const minPercentile = requiredNumber(minimum.percentile, "standardization.min_samples.percentile");
const minExtreme = requiredNumber(minimum.change_extreme, "standardization.min_samples.change_extreme");

function computeStats(series, frequency, { changeMode = "absolute" } = {}) {
  const points = (series || []).filter(point => Number.isFinite(point.v));
  const values = points.map(point => point.v);
  if (!values.length) return { count: 0, latest: null, prev: null, changes: {}, pctChanges: {}, z1y: null, pct1y: null, pct3y: null, pct5y: null, ma20: null, moveExtreme: null, chg1Extreme: null };
  const window = windows[frequency];
  if (!window) throw new Error(`未知 frequency: ${frequency}`);
  const latest = points.at(-1);
  const delta = back => values.length > back ? latest.v - values[values.length - 1 - back] : null;
  const changes = { chg1: round(delta(1)), chg4: round(delta(4)), chg5: round(delta(5)), chg12: round(delta(12)), chg13: round(delta(13)), chg20: round(delta(20)) };
  const pctChanges = { chg1: round(pctChange(values, 1), 6), chg4: round(pctChange(values, 4), 6), chg5: round(pctChange(values, 5), 6), chg12: round(pctChange(values, 12), 6), chg13: round(pctChange(values, 13), 6), chg20: round(pctChange(values, 20), 6) };
  const zValues = values.slice(-window.z1y);
  const zStd = zValues.length >= minZ ? std(zValues) : null;
  const z1y = zStd && zStd > Number.EPSILON ? round((latest.v - mean(zValues)) / zStd) : null;
  const percentile = size => {
    const sample = values.slice(-size);
    return sample.length >= minPercentile ? round(percentileOf(sample, latest.v)) : null;
  };
  const move = (index, back) => changeMode === "percent"
    ? Math.abs(pctChange(values.slice(0, index + 1), back))
    : Math.abs(values[index] - values[index - back]);
  const extreme = back => {
    if (values.length <= back) return null;
    const history = [];
    for (let index = back; index < values.length; index += 1) {
      const value = move(index, back);
      if (Number.isFinite(value)) history.push(value);
    }
    const sample = history.slice(-window.p3y);
    return sample.length >= minExtreme ? round(percentileOf(sample, move(values.length - 1, back))) : null;
  };
  return { count: values.length, firstDate: points[0].d, latest: { date: latest.d, value: latest.v },
    prev: points.length > 1 ? { date: points.at(-2).d, value: points.at(-2).v } : null,
    changes, pctChanges, z1y, pct1y: percentile(window.z1y), pct3y: percentile(window.p3y),
    pct5y: percentile(window.p5y), ma3: round(mean(values.slice(-3))), ma20: round(mean(values.slice(-20))), moveExtreme: extreme(5),
    chg1Extreme: extreme(1), zWindowSize: zValues.length };
}

function seriesOf(id) { return observations.indicators[id]?.series || []; }
function subtractSeries(left, right) {
  const map = new Map(right.filter(point => Number.isFinite(point.v)).map(point => [point.d, point.v]));
  return left.filter(point => Number.isFinite(point.v) && map.has(point.d)).map(point => ({ d: point.d, v: round(point.v - map.get(point.d)), r: point.r }));
}
const derivedSeries = new Map();
for (const item of config.derived) {
  const match = String(item.derived?.formula || "").match(/^\s*([A-Z0-9_]+)\s*-\s*([A-Z0-9_]+)\s*$/);
  if (!match) throw new Error(`派生指标 ${item.id} 公式超出受支持 schema`);
  const series = subtractSeries(seriesOf(match[1]), seriesOf(match[2]));
  derivedSeries.set(item.id, series);
}

function statusFor(latestDate, frequency) {
  if (!latestDate) return { status: "MISSING", ageDays: null };
  const ageDays = dayDiff(latestDate, TODAY);
  const rule = config.freshness[frequency];
  if (!rule) throw new Error(`freshness.${frequency} 未配置`);
  const fresh = requiredNumber(rule.fresh_within_calendar_days, `freshness.${frequency}.fresh_within_calendar_days`);
  const stale = requiredNumber(rule.stale_after_calendar_days, `freshness.${frequency}.stale_after_calendar_days`);
  const discontinued = rule.discontinued_after_calendar_days === undefined ? null
    : requiredNumber(rule.discontinued_after_calendar_days, `freshness.${frequency}.discontinued_after_calendar_days`);
  if (discontinued !== null && ageDays > discontinued) return { status: "DISCONTINUED", ageDays };
  if (ageDays <= fresh) return { status: "FRESH", ageDays };
  if (ageDays <= stale) return { status: "EXPECTED", ageDays };
  return { status: "STALE", ageDays };
}

const polarity = {};
for (const [key, value] of Object.entries(config.directionSemantics)) polarity[key] = requiredNumber(value?.polarity, `direction_semantics.${key}.polarity`);
function directionOf(meta) {
  const direction = meta?.signal?.direction;
  if (!(direction in polarity)) throw new Error(`indicator ${meta.id} direction ${direction} 未在 signal_rules.yaml 登记`);
  return direction;
}

function changeView(meta, stats) {
  const transforms = new Set(meta.transforms || []);
  const items = [];
  const unavailable = label => ({ key: "unavailable", label, value: null, status: "unavailable" });
  if (meta.frequency === "daily") {
    for (const [transform, label, key] of [["d1", "1D", "chg1"], ["d5", "5D", "chg5"], ["d20", "20D", "chg20"]]) {
      if (transforms.has(transform)) items.push({ key: transform, label, value: stats.changes[key], pctValue: stats.pctChanges[key], status: stats.changes[key] === null ? "unavailable" : "available" });
    }
  } else if (meta.frequency === "weekly") {
    for (const [transform, label, key] of [["wow", "WoW", "chg1"], ["w4", "4W", "chg4"], ["w13", "13W", "chg13"]]) {
      if (transforms.has(transform)) items.push({ key: transform, label, value: stats.changes[key], status: stats.changes[key] === null ? "unavailable" : "available" });
    }
  } else if (meta.frequency === "monthly") {
    if (/同比/.test(meta.name_cn)) items.push({ key: "yoy_level", label: "YoY", value: stats.latest?.value ?? null, status: stats.latest ? "available" : "unavailable" });
    else if (/环比/.test(meta.name_cn)) items.push({ key: "mom_level", label: "MoM", value: stats.latest?.value ?? null, status: stats.latest ? "available" : "unavailable" });
    else {
      if (transforms.has("mom")) items.push({ key: "mom", label: "MoM", value: stats.pctChanges.chg1, status: stats.pctChanges.chg1 === null ? "unavailable" : "available" });
      if (transforms.has("yoy")) items.push({ key: "yoy", label: "YoY", value: stats.pctChanges.chg12, status: stats.pctChanges.chg12 === null ? "unavailable" : "available" });
    }
    if (transforms.has("ma3")) {
      const trend = stats.latest && Number.isFinite(stats.ma3) ? Math.sign(stats.latest.value - stats.ma3) : null;
      items.push({ key: "trend3m", label: "3M", value: trend === null ? null : trend > 0 ? "up" : trend < 0 ? "down" : "flat", status: trend === null ? "unavailable" : "available" });
    }
  } else if (meta.frequency === "quarterly") {
    if (/同比/.test(meta.name_cn)) items.push({ key: "yoy_level", label: "YoY", value: stats.latest?.value ?? null, status: stats.latest ? "available" : "unavailable" });
    else {
      if (transforms.has("qoq")) items.push({ key: "qoq", label: "QoQ", value: stats.pctChanges.chg1, status: stats.pctChanges.chg1 === null ? "unavailable" : "available" });
      if (transforms.has("yoy")) items.push({ key: "yoy", label: "YoY", value: stats.pctChanges.chg4, status: stats.pctChanges.chg4 === null ? "unavailable" : "available" });
    }
  }
  return { frequency: meta.frequency, items: items.length ? items : [unavailable("Unavailable")], legacy: { deprecated: true, field: "changes" } };
}

const states = config.indicators.map(meta => {
  const source = derivedSeries.has(meta.id) ? derivedSeries.get(meta.id) : seriesOf(meta.id);
  const stats = computeStats(source, meta.frequency || "monthly");
  const freshness = statusFor(stats.latest?.date, meta.frequency || "monthly");
  const direction = directionOf(meta);
  const dirZ = stats.z1y === null ? null : round(polarity[direction] * stats.z1y);
  const scorable = !["MISSING", "DISCONTINUED"].includes(freshness.status) && polarity[direction] !== 0 && dirZ !== null;
  return { id: meta.id, name_cn: meta.name_cn, layer: meta.layer, dimension: meta.dimension || null,
    category: meta.category || null, frequency: meta.frequency, unit: meta.unit || null, importance: meta.importance || null,
    direction, polarity: polarity[direction], ...freshness, scorable, stats, dirZ, series: source,
    changeView: changeView(meta, stats) };
});
const byId = new Map(states.map(state => [state.id, state]));

const scoreCfg = config.scoreMapping;
const scoreCenter = requiredNumber(scoreCfg.center, "score_mapping.center");
const scoreScale = requiredNumber(scoreCfg.z_scale, "score_mapping.z_scale");
const scoreMin = requiredNumber(scoreCfg.minimum, "score_mapping.minimum");
const scoreMax = requiredNumber(scoreCfg.maximum, "score_mapping.maximum");
const scoreBands = scoreCfg.bands || [];
if (!scoreBands.length) throw new Error("score_mapping.bands 为空");
const labelForScore = score => score === null ? "数据不足" : scoreBands.find(band => score >= Number(band.min))?.label || scoreBands.at(-1).label;
const positiveZ = requiredNumber(config.dimensionSignal.positive_z, "dimension_signal.positive_z");
const negativeZ = requiredNumber(config.dimensionSignal.negative_z, "dimension_signal.negative_z");

const dimensions = Object.entries(config.weightProfile.dimensions || {}).map(([key, weights]) => {
  const members = Object.entries(weights).map(([id, weight]) => ({ state: byId.get(id), weight: Number(weight) })).filter(item => item.state?.scorable && Number.isFinite(item.weight));
  const weightSum = members.reduce((sum, item) => sum + item.weight, 0);
  const zMean = weightSum ? members.reduce((sum, item) => sum + item.weight * item.state.dirZ, 0) / weightSum : null;
  const score = zMean === null ? null : round(Math.max(scoreMin, Math.min(scoreMax, scoreCenter + scoreScale * zMean)), 1);
  const meta = config.dimensions[key] || {};
  const semanticLabel = score === null ? "数据不足" : score > scoreCenter + scoreScale * positiveZ ? meta.high_label : score < scoreCenter + scoreScale * negativeZ ? meta.low_label : meta.neutral_label;
  return { key, name_cn: meta.name_cn || key, scoreAxis: meta.score_axis, highLabel: meta.high_label,
    neutralLabel: meta.neutral_label, lowLabel: meta.low_label, semanticLabel, score, zMean: round(zMean),
    coverage: { used: members.length, configured: Object.keys(weights).length, weightSum: round(weightSum, 3) },
    members: members.map(item => ({ id: item.state.id, name_cn: item.state.name_cn, weight: item.weight,
      z: item.state.stats.z1y, dirZ: item.state.dirZ, status: item.state.status })),
    upCount: members.filter(item => item.state.dirZ > positiveZ).length,
    downCount: members.filter(item => item.state.dirZ < negativeZ).length };
});
const scorableDimensions = dimensions.filter(item => item.score !== null);
const composite = scorableDimensions.length ? round(mean(scorableDimensions.map(item => item.score)), 1) : null;

const anomalyCfg = config.anomaly;
const anomalyZ = requiredNumber(anomalyCfg.z_extreme, "anomaly.z_extreme");
const anomalyLow = requiredNumber(anomalyCfg.percentile_low, "anomaly.percentile_low");
const anomalyHigh = requiredNumber(anomalyCfg.percentile_high, "anomaly.percentile_high");
const anomalyMove = requiredNumber(anomalyCfg.move_extreme, "anomaly.move_extreme");
const clusterCount = requiredNumber(anomalyCfg.same_direction_count, "anomaly.same_direction_count");
const highTriggers = new Set(anomalyCfg.high_severity_triggers || []);
const anomalies = [];
for (const state of states) {
  const triggers = [];
  if (Number.isFinite(state.stats.z1y) && Math.abs(state.stats.z1y) >= anomalyZ) triggers.push({ id: "ZSCORE_EXTREME", value: Math.abs(state.stats.z1y) });
  if (Number.isFinite(state.stats.pct3y) && state.stats.pct3y <= anomalyLow) triggers.push({ id: "PERCENTILE_LOW", value: state.stats.pct3y });
  if (Number.isFinite(state.stats.pct3y) && state.stats.pct3y >= anomalyHigh) triggers.push({ id: "PERCENTILE_HIGH", value: state.stats.pct3y });
  if (Number.isFinite(state.stats.moveExtreme) && state.stats.moveExtreme >= anomalyMove) triggers.push({ id: "FIVE_DAY_MOVE_EXTREME", value: state.stats.moveExtreme });
  if (triggers.length && !["MISSING", "DISCONTINUED"].includes(state.status)) anomalies.push({ id: state.id, name_cn: state.name_cn,
    dimension: state.dimension, frequency: state.frequency, unit: state.unit, status: state.status, latest: state.stats.latest,
    z1y: state.stats.z1y, dirZ: state.dirZ, pct3y: state.stats.pct3y, changes: state.stats.changes, triggers,
    severity: triggers.some(trigger => highTriggers.has(trigger.id)) ? "high" : "medium" });
}
for (const dimension of dimensions) {
  if (dimension.upCount >= clusterCount || dimension.downCount >= clusterCount) anomalies.push({
    id: `DIM_${dimension.key.toUpperCase()}_SAME_DIRECTION`, name_cn: `${dimension.name_cn}维度同向聚集`, dimension: dimension.key,
    aggregate: true, severity: "medium", triggers: [{ id: "THREE_SAME_DIRECTION", value: Math.max(dimension.upCount, dimension.downCount) }],
  });
}

const deviationCfg = config.deviation;
const devNotable = requiredNumber(deviationCfg.notable_change_extreme, "deviation.notable_change_extreme");
const devStrong = requiredNumber(deviationCfg.strong_change_extreme, "deviation.strong_change_extreme");
const devZ = requiredNumber(deviationCfg.position_z_extreme, "deviation.position_z_extreme");
const devHigh = requiredNumber(deviationCfg.position_percentile_high, "deviation.position_percentile_high");
const devLow = requiredNumber(deviationCfg.position_percentile_low, "deviation.position_percentile_low");
const devOi = requiredNumber(deviationCfg.oi_change_extreme, "deviation.oi_change_extreme");
const devLimit = requiredNumber(deviationCfg.display_limit_per_side, "deviation.display_limit_per_side");
function classifyDeviation(item) {
  const tags = [];
  const extreme = item.chg1Extreme;
  const z = item.z1y;
  if (Number.isFinite(item.pct1y) && item.pct1y >= devHigh) tags.push("刷一年新高");
  if (Number.isFinite(item.pct1y) && item.pct1y <= devLow) tags.push("刷一年新低");
  if (Number.isFinite(extreme) && extreme >= devNotable && Number.isFinite(z) && Math.abs(z) >= devZ) tags.push("变化+位置双极端");
  else if (Number.isFinite(extreme) && extreme >= devStrong) tags.push("变化极端");
  else if (Number.isFinite(extreme) && extreme >= devNotable) tags.push("变化显著");
  else if (Number.isFinite(z) && Math.abs(z) >= devZ) tags.push("位置极端");
  if (Number.isFinite(item.oiChg5) && Math.abs(item.oiChg5) >= devOi) tags.push("持仓放大");
  return { tags, isNotable: tags.length > 0, deviationLevel: tags.includes("变化+位置双极端") || tags.includes("变化极端") ? "extreme" : tags.length ? "notable" : "normal" };
}

const indicatorRows = states.map(state => {
  const s = state.stats;
  const deviation = classifyDeviation({ chg1Extreme: s.chg1Extreme, z1y: s.z1y, pct1y: s.pct1y });
  return { id: state.id, name_cn: state.name_cn, layer: state.layer, dimension: state.dimension,
    category: state.category, frequency: state.frequency, unit: state.unit, importance: state.importance,
    direction: state.direction, polarity: state.polarity, status: state.status, ageDays: state.ageDays,
    scorable: state.scorable, latest: s.latest, changes: s.changes, pctChg1: s.pctChanges.chg1,
    pctChg5: s.pctChanges.chg5, pctChg20: s.pctChanges.chg20, pctChg12: s.pctChanges.chg12,
    z1y: s.z1y, dirZ: state.dirZ, pct1y: s.pct1y, pct3y: s.pct3y, ma20: s.ma20,
    moveExtreme: s.moveExtreme, chg1Extreme: s.chg1Extreme, changeView: state.changeView, ...deviation };
});

const futuresSeries = new Map();
const futuresVarieties = config.futuresIndicators.map(meta => {
  const raw = seriesOf(meta.id).filter(point => Number.isFinite(point.v));
  futuresSeries.set(meta.id, raw);
  const stats = computeStats(raw, "daily", { changeMode: "percent" });
  const oiValues = (observations.indicators[meta.id]?.series || []).filter(point => Number.isFinite(point.oi)).map(point => point.oi);
  const freshness = statusFor(stats.latest?.date, "daily");
  const base = { id: meta.id, name_cn: meta.name_cn, chain: meta.chain || null, chain_cn: meta.chain_cn || null,
    chain_tier: meta.chain_tier || null, code: observations.indicators[meta.id]?.mainContract?.toCode || meta.ifind?.field_code || null,
    requestedCode: meta.ifind?.field_code || null, unit: meta.unit || null, importance: meta.importance || null,
    ...freshness, lastDate: stats.latest?.date || null, value: stats.latest?.value ?? null,
    d1: stats.pctChanges.chg1, d5: stats.pctChanges.chg5, d20: stats.pctChanges.chg20, d60: round(pctChange(raw.map(p => p.v), 60), 6),
    z1y: stats.z1y, pct1y: stats.pct1y, pct3y: stats.pct3y, chg1Extreme: stats.chg1Extreme,
    ma20: stats.ma20, historyDays: stats.count, oi: oiValues.at(-1) ?? null,
    oiChg5: round(pctChange(oiValues, 5), 6), oiChg20: round(pctChange(oiValues, 20), 6),
    mainContract: observations.indicators[meta.id]?.mainContract || null };
  return { ...base, ...classifyDeviation(base) };
});

const futures = buildFuturesAnalysis({ config, varieties: futuresVarieties, seriesById: futuresSeries });
futures.asOf = TODAY;
futures.spreads = futures.rawSpreads.map(({ definition, series }) => {
  if (series.length < minExtreme) return { id: definition.id, name_cn: definition.name_cn, desc: definition.desc,
    unit: definition.unit, available: false, reason: `共同交易日不足（${series.length}）`, points: [] };
  const stats = computeStats(series, "daily", { changeMode: definition.change_mode === "pct" ? "percent" : "absolute" });
  const row = { id: definition.id, name_cn: definition.name_cn, desc: definition.desc, unit: definition.unit,
    operation: definition.operation, available: true, members: definition.operation === "linear_combination"
      ? definition.terms.map(term => term.member) : [definition.numerator.member, definition.denominator.member],
    lastDate: stats.latest.date, value: stats.latest.value, changeMode: definition.change_mode,
    d1: definition.change_mode === "pct" ? stats.pctChanges.chg1 : stats.changes.chg1,
    d5: definition.change_mode === "pct" ? stats.pctChanges.chg5 : stats.changes.chg5,
    d20: definition.change_mode === "pct" ? stats.pctChanges.chg20 : stats.changes.chg20,
    z1y: stats.z1y, pct1y: stats.pct1y, pct3y: stats.pct3y, chg1Extreme: stats.chg1Extreme,
    points: series.slice(-300).map(point => [point.d, point.v]) };
  return { ...row, ...classifyDeviation(row) };
});
delete futures.rawSpreads;

const fsCfg = config.futuresSignal;
const tierMin = requiredNumber(fsCfg.tier_min_members, "futures_signal.tier_min_members");
const tierMedium = requiredNumber(fsCfg.tier_gap_medium, "futures_signal.tier_gap_medium");
const tierHigh = requiredNumber(fsCfg.tier_gap_high, "futures_signal.tier_gap_high");
futures.signals = [];
for (const chain of futures.chains) {
  const tiers = chain.tiers.filter(tier => Number.isFinite(tier.metrics.d20) && tier.metrics.count >= tierMin);
  if (tiers.length < 2) continue;
  const difference = tiers[0].metrics.d20 - tiers.at(-1).metrics.d20;
  if (Math.abs(difference) < tierMedium) continue;
  futures.signals.push({ id: `TIER_SPREAD_${chain.id}`, chain: chain.id, chain_cn: chain.name_cn,
    type: "CHAIN_TIER_SPREAD", hit: true, severity: Math.abs(difference) >= tierHigh ? "high" : "medium",
    sideA: { label: tiers[0].name_cn, value: tiers[0].metrics.d20 },
    sideB: { label: tiers.at(-1).name_cn, value: tiers.at(-1).metrics.d20 }, difference,
    implication: difference > 0 ? `${chain.name_cn}原料强于成品，加工利润承压` : `${chain.name_cn}成品强于原料，加工利润改善` });
}

const divPositive = requiredNumber(config.divergenceDefaults.positive_z, "divergence_defaults.positive_z");
const divNegative = requiredNumber(config.divergenceDefaults.negative_z, "divergence_defaults.negative_z");
function summarizeSide(side, valueField) {
  const members = (side.members || []).map(id => byId.get(id)).filter(Boolean).map(state => ({ id: state.id, name_cn: state.name_cn, value: valueField === "dirZ" ? state.dirZ : state.stats.z1y }));
  const usable = members.filter(item => Number.isFinite(item.value));
  const positive = usable.filter(item => item.value > divPositive).length;
  const negative = usable.filter(item => item.value < divNegative).length;
  return { label: side.label, members, usable: usable.length, positive, negative, mean: round(mean(usable.map(item => item.value))), direction: positive > negative ? "positive" : negative > positive ? "negative" : "neutral" };
}
const divergences = (config.divergenceRules || []).map(rule => {
  if (!["opposite_majority", "opposite_mean"].includes(rule.evaluator)) throw new Error(`divergence ${rule.id} evaluator 不受支持`);
  if (!["dirZ", "z1y"].includes(rule.value_field)) throw new Error(`divergence ${rule.id} value_field 不受支持`);
  const minimumUsable = requiredNumber(rule.minimum_usable_members ?? config.divergenceDefaults.minimum_usable_members, `divergence ${rule.id}.minimum_usable_members`);
  const sideA = summarizeSide(rule.side_a || {}, rule.value_field);
  const sideB = summarizeSide(rule.side_b || {}, rule.value_field);
  let hit = false;
  if (sideA.usable >= minimumUsable && sideB.usable >= minimumUsable) {
    hit = rule.evaluator === "opposite_majority"
      ? sideA.direction !== "neutral" && sideB.direction !== "neutral" && sideA.direction !== sideB.direction
      : Number.isFinite(sideA.mean) && Number.isFinite(sideB.mean) && ((sideA.mean > divPositive && sideB.mean < divNegative) || (sideA.mean < divNegative && sideB.mean > divPositive));
  }
  return { id: rule.id, name_cn: rule.name_cn, evaluator: rule.evaluator, valueField: rule.value_field,
    minimumUsableMembers: minimumUsable, severity: rule.severity, question: rule.question, logic_cn: rule.logic_cn,
    hit, sideA, sideB, interpretation: `${sideA.label} ${sideA.direction} / ${sideB.label} ${sideB.direction}` };
});

const historyFiles = readdirSync(snapshotDir).filter(file => /^\d{4}-\d{2}-\d{2}\.json$/.test(file) && file < `${TODAY}.json`).sort();
const previous = historyFiles.length ? JSON.parse(readFileSync(resolve(snapshotDir, historyFiles.at(-1)), "utf8")) : null;
const previousDimensions = new Map((previous?.dimensions || []).map(item => [item.key, item]));
for (const dimension of dimensions) {
  const previousValue = previousDimensions.get(dimension.key)?.score;
  dimension.delta = Number.isFinite(previousValue) && Number.isFinite(dimension.score) ? round(dimension.score - previousValue, 1) : null;
  dimension.history = historyFiles.slice(-29).map(file => {
    const row = JSON.parse(readFileSync(resolve(snapshotDir, file), "utf8"));
    return [row.asOf, row.dimensions?.find(item => item.key === dimension.key)?.score ?? null];
  }).concat([[TODAY, dimension.score]]);
}
const compositeDelta = Number.isFinite(previous?.composite) && Number.isFinite(composite) ? round(composite - previous.composite, 1) : null;

const linkedMacroIds = new Set(config.futuresIndicators.map(item => item.linked_macro_id).filter(Boolean));
const allDeviations = indicatorRows.filter(item => item.isNotable && !linkedMacroIds.has(item.id))
  .concat(futures.varieties.filter(item => item.isNotable));
const dailyDeviations = allDeviations.filter(item => !item.frequency || item.frequency === "daily");
const directionValue = item => item.pctChg1 ?? item.d1 ?? item.changes?.chg1 ?? null;
const sortedDeviation = dailyDeviations.slice().sort((a, b) => (b.chg1Extreme ?? -1) - (a.chg1Extreme ?? -1));
const deviationSummary = {
  total: dailyDeviations.length,
  extreme: dailyDeviations.filter(item => item.deviationLevel === "extreme").length,
  up: sortedDeviation.filter(item => directionValue(item) > 0).slice(0, devLimit),
  down: sortedDeviation.filter(item => directionValue(item) < 0).slice(0, devLimit),
  releaseFrequency: indicatorRows.filter(item => ["monthly", "quarterly"].includes(item.frequency) && item.isNotable),
};

const categories = {};
for (const item of indicatorRows) (categories[item.category || "uncategorized"] ||= []).push(item.id);
const categoryAggregates = Object.fromEntries(Object.entries(categories).map(([key, ids]) => {
  const rows = ids.map(id => indicatorRows.find(item => item.id === id)).filter(Boolean);
  return [key, { count: rows.length, usable: rows.filter(item => item.status !== "MISSING").length,
    medianDirZ: round(median(rows.map(item => item.dirZ))), median20DPct: round(median(rows.filter(item => item.frequency === "daily").map(item => item.pctChg20)), 6) }];
}));

const displayLimit = requiredNumber(config.display.movers_limit, "display.movers_limit");
const ranked = indicatorRows.filter(item => item.scorable && Number.isFinite(item.dirZ)).sort((a, b) => Math.abs(b.dirZ) - Math.abs(a.dirZ));
const movers = { stronger: ranked.filter(item => item.dirZ > 0).slice(0, displayLimit), weaker: ranked.filter(item => item.dirZ < 0).slice(0, displayLimit) };
const trends = {};
for (const state of states.filter(item => ["FRESH", "EXPECTED"].includes(item.status))) {
  const cap = state.frequency === "daily" ? 520 : state.frequency === "weekly" ? 260 : state.series.length;
  const points = state.series.filter(point => Number.isFinite(point.v)).slice(-cap).map(point => [point.d, point.v]);
  if (points.length >= 2) trends[state.id] = { id: state.id, name_cn: state.name_cn, dimension: state.dimension,
    category: state.category, unit: state.unit, importance: state.importance, frequency: state.frequency,
    z1y: state.stats.z1y, dirZ: state.dirZ, pct1y: state.stats.pct1y, latest: state.stats.latest,
    changeView: state.changeView, points };
}

const curveMembers = ["MKT_CGB_1Y", "MKT_CGB_3Y", "MKT_CGB_10Y", "MKT_CGB_30Y"];
const curveDates = [...new Set(curveMembers.flatMap(id => (trends[id]?.points || []).slice(-260).map(point => point[0])))].sort();
const yieldCurve = { dates: curveDates, series: Object.fromEntries(curveMembers.filter(id => trends[id]).map(id => {
  const map = new Map(trends[id].points); return [id, { name_cn: trends[id].name_cn, values: curveDates.map(date => map.get(date) ?? null) }];
})), latestShape: curveMembers.map(id => byId.get(id)).filter(state => state?.stats.latest).map(state => ({ id: state.id,
  name_cn: state.name_cn, tenor: state.name_cn.match(/(\d+)年/)?.[1], date: state.stats.latest.date, value: state.stats.latest.value })) };

const freshnessTally = states.reduce((tally, state) => ({ ...tally, [state.status]: (tally[state.status] || 0) + 1 }), {});
const headline = { composite, label: labelForScore(composite), compositeDelta, anomalyCount: anomalies.length,
  highSeverityCount: anomalies.filter(item => item.severity === "high").length,
  notableDeviationCount: deviationSummary.total, divergenceHits: divergences.filter(item => item.hit).length,
  freshness: freshnessTally, indicatorTotal: states.length, indicatorScorable: states.filter(item => item.scorable).length,
  draft: String(config.weightProfile.status).toLowerCase() === "draft" };
const brief = { tone: headline.label, lines: [
  `综合宏观支持度 ${composite ?? "—"}（${headline.label}），较上一有效快照 ${compositeDelta === null ? "暂无可比" : `${compositeDelta >= 0 ? "+" : ""}${compositeDelta}`}。`,
  `今日显著偏离 ${deviationSummary.total} 项，结构化背离触发 ${headline.divergenceHits} 项，异常 ${headline.anomalyCount} 项。`,
  `六维中 ${dimensions.map(item => `${item.name_cn}${item.semanticLabel}`).join("、")}。`,
  "六维权重为 DRAFT；综合分是宏观支持度 / 扩张友好度的规则化观察指标。",
] };

const snapshot = { contract: "MACRO_SNAPSHOT", version: "1.1.0", generatedAt: new Date().toISOString(), asOf: TODAY,
  window: observations.window, source: { data: "iFinD MCP (THS_EDB / THS_HQ)", registry: observations.registry, collectedAt: observations.collectedAt },
  scoringModel: { polarity, formula: "YAML score_mapping applied to weighted mean dirZ", dimensionAggregation: "weighted_mean",
    weightProfileStatus: config.weightProfile.status, standardization: config.standardization,
    compositeDefinition: "宏观支持度 / 扩张友好度的规则化观察指标", disclaimer: "六维权重为 DRAFT，综合分用于观察。" },
  headline, dimensions, dimensionHistory: dimensions.map(item => ({ key: item.key, points: item.history })), movers,
  anomalies, deviations: deviationSummary, divergences, indicators: indicatorRows, categories,
  aggregates: { categories: categoryAggregates }, trends, futures, yieldCurve, brief,
  regime: { growth: dimensions.find(item => item.key === "growth")?.zMean ?? null,
    inflation: dimensions.find(item => item.key === "inflation")?.zMean ?? null },
  dataQuality: { degraded: states.filter(item => !["FRESH", "EXPECTED"].includes(item.status)).map(item => ({ id: item.id,
    name_cn: item.name_cn, status: item.status, ageDays: item.ageDays, latest: item.stats.latest })),
    derivedOk: [...derivedSeries.keys()], derivedFailed: [] } };

writeFileSync(resolve(root, "public/macro-snapshot.json"), JSON.stringify(snapshot, null, 2), "utf8");
writeFileSync(resolve(snapshotDir, `${TODAY}.json`), JSON.stringify({ asOf: TODAY, generatedAt: snapshot.generatedAt,
  composite, dimensions: dimensions.map(item => ({ key: item.key, score: item.score, zMean: item.zMean })),
  anomalyCount: anomalies.length, divergenceHits: headline.divergenceHits }, null, 2), "utf8");
console.log(`MACRO_SNAPSHOT ${snapshot.version} · ${TODAY}`);
console.log(`综合宏观支持度 ${composite}（${headline.label}）· Δ ${compositeDelta ?? "—"}`);
console.log(`显著偏离 ${headline.notableDeviationCount} · 异常 ${headline.anomalyCount} · 背离 ${headline.divergenceHits}/${divergences.length}`);
console.log(`期货 ${futures.liveVarietyCount}/${futures.varietyCount} · 价差 ${futures.spreads.filter(item => item.available).length}/${futures.spreads.length}`);
console.log("→ public/macro-snapshot.json");
