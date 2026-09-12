/**
 * 期货产业链结构层。
 * 品种级统计由 macro-snapshot.mjs 传入；本模块只聚合已算状态并生成 raw spread series。
 */
const round = (value, digits = 4) => value === null || value === undefined || !Number.isFinite(value)
  ? null : Number(value.toFixed(digits));

function median(values) {
  const items = (values || []).filter(Number.isFinite).sort((a, b) => a - b);
  if (!items.length) return null;
  const middle = Math.floor(items.length / 2);
  return items.length % 2 ? items[middle] : (items[middle - 1] + items[middle]) / 2;
}

function evaluateSpread(definition, values) {
  if (definition.operation === "linear_combination") {
    const terms = definition.terms || [];
    if (!terms.length) throw new Error(`spread ${definition.id} 缺少 terms`);
    return terms.reduce((sum, term) => {
      const value = values[term.member];
      const coefficient = Number(term.coefficient);
      if (!Number.isFinite(value) || !Number.isFinite(coefficient)) throw new Error(`spread ${definition.id} term 无效`);
      return sum + value * coefficient;
    }, 0);
  }
  if (definition.operation === "ratio") {
    const numerator = values[definition.numerator?.member] * Number(definition.numerator?.multiplier);
    const denominator = values[definition.denominator?.member] * Number(definition.denominator?.multiplier);
    if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return null;
    return numerator / denominator;
  }
  throw new Error(`spread ${definition.id} 使用未知 operation: ${definition.operation}`);
}

function rawSpreadSeries(definition, seriesById) {
  const members = definition.operation === "linear_combination"
    ? (definition.terms || []).map(term => term.member)
    : [definition.numerator?.member, definition.denominator?.member];
  if (members.some(member => !member)) throw new Error(`spread ${definition.id} 成员声明不完整`);
  const maps = members.map(member => new Map((seriesById.get(member) || []).map(point => [point.d, point.v])));
  if (maps.some(map => map.size === 0)) return [];
  return [...maps[0].keys()].filter(date => maps.every(map => map.has(date))).sort().map(date => {
    const values = Object.fromEntries(members.map((member, index) => [member, maps[index].get(date)]));
    return { d: date, v: round(evaluateSpread(definition, values), 6) };
  }).filter(point => Number.isFinite(point.v));
}

export function buildFuturesAnalysis({ config, varieties, seriesById }) {
  const byId = new Map(varieties.map(item => [item.id, item]));
  const active = varieties.filter(item => item.status === "FRESH" || item.status === "EXPECTED");
  const chains = (config.futuresChains || []).map(chain => {
    const tiers = (chain.tiers || []).map(tier => {
      const members = (tier.members || []).map(id => byId.get(id)).filter(Boolean);
      const usable = members.filter(item => Number.isFinite(item.d5));
      return { name_cn: tier.name_cn, members: members.map(item => item.id), metrics: {
        d1: round(median(usable.map(item => item.d1)), 5), d5: round(median(usable.map(item => item.d5)), 5),
        d20: round(median(usable.map(item => item.d20)), 5), z1y: round(median(usable.map(item => item.z1y)), 4),
        breadth: usable.length ? round(usable.filter(item => item.d5 > 0).length / usable.length, 3) : null,
        count: usable.length,
      }};
    });
    const memberIds = (chain.tiers || []).flatMap(tier => tier.members || []);
    const members = memberIds.map(id => byId.get(id)).filter(Boolean);
    const usable = members.filter(item => Number.isFinite(item.d5));
    return { id: chain.id, name_cn: chain.name_cn, desc: chain.desc || null,
      memberCount: members.length, liveCount: usable.length, tiers,
      metrics: { d1: round(median(usable.map(item => item.d1)), 5), d5: round(median(usable.map(item => item.d5)), 5),
        d20: round(median(usable.map(item => item.d20)), 5), z1y: round(median(usable.map(item => item.z1y)), 4),
        pct1y: round(median(usable.map(item => item.pct1y)), 4),
        breadth: usable.length ? round(usable.filter(item => item.d5 > 0).length / usable.length, 3) : null,
        oiChg5: round(median(usable.map(item => item.oiChg5)), 5) },
      leaders: members.filter(item => item.importance === "high").map(item => item.id) };
  }).filter(chain => chain.memberCount > 0);

  const heatmap = { chains: chains.map(chain => ({ id: chain.id, name_cn: chain.name_cn,
    d5: chain.metrics.d5, d20: chain.metrics.d20, breadth: chain.metrics.breadth,
    cells: chain.tiers.flatMap(tier => tier.members.map(id => {
      const item = byId.get(id); return item ? { ...item, tier: tier.name_cn } : null;
    }).filter(Boolean)) })) };

  const limit = Number(config.display?.futures_movers_limit);
  if (!Number.isInteger(limit) || limit < 1) throw new Error("display.futures_movers_limit 必须是正整数");
  const ranked = active.filter(item => Number.isFinite(item.d5)).slice().sort((a, b) => b.d5 - a.d5);
  const pick = item => ({ id: item.id, name_cn: item.name_cn, chain: item.chain, chain_cn: item.chain_cn,
    chain_tier: item.chain_tier, d1: item.d1, d5: item.d5, d20: item.d20, z1y: item.z1y,
    pct1y: item.pct1y, value: item.value, unit: item.unit, oiChg5: item.oiChg5, tags: item.tags });

  const trends = {};
  for (const item of varieties) {
    const points = seriesById.get(item.id) || [];
    if (points.length < 2) continue;
    trends[item.id] = { id: item.id, name_cn: item.name_cn, chain: item.chain, chain_cn: item.chain_cn,
      chain_tier: item.chain_tier, unit: item.unit, importance: item.importance, lastDate: item.lastDate,
      points: points.slice(-520).map(point => [point.d, point.v]) };
  }

  return { contract: "MACRO_FUTURES", chainCount: chains.length, varietyCount: varieties.length,
    liveVarietyCount: active.length, chains, varieties, heatmap,
    movers: { window: "d5", up: ranked.slice(0, limit).map(pick), down: ranked.slice(-limit).reverse().map(pick) },
    rawSpreads: (config.futuresSpreads || []).map(definition => ({ definition, series: rawSpreadSeries(definition, seriesById) })),
    trends };
}
