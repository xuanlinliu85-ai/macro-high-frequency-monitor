/**
 * 期货产业链分析（展示层）
 *
 * 定位：与宏观六维评分**平行**的一层。期货品种不参与六维打分，
 *       因为它们是同一批宏观变量的市场价格镜像，混入评分会造成双重计数。
 *       本模块只做「品种明细 + 链级聚合 + 涨跌榜 + 主力价差 + 链内信号」。
 *
 * 铁律（Spec §37）：所有统计量在此用代码算完，LLM 只负责解读算好的数字。
 */

/* ---------------- 统计工具（模块内自包含，避免与 snapshot 循环依赖） ---------------- */

const round = (v, d = 4) => (v === null || v === undefined || !Number.isFinite(v) ? null : Number(v.toFixed(d)));

function median(arr) {
  const a = (arr || []).filter(v => v !== null && v !== undefined && Number.isFinite(v));
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function mean(arr) {
  const a = (arr || []).filter(v => v !== null && Number.isFinite(v));
  return a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
}

function std(arr) {
  const a = (arr || []).filter(v => v !== null && Number.isFinite(v));
  if (a.length < 2) return null;
  const m = mean(a);
  return Math.sqrt(a.reduce((acc, v) => acc + (v - m) ** 2, 0) / (a.length - 1));
}

function percentileOf(history, value) {
  const a = (history || []).filter(v => v !== null && Number.isFinite(v));
  if (!a.length || !Number.isFinite(value)) return null;
  const below = a.filter(v => v < value).length;
  const equal = a.filter(v => v === value).length;
  return (below + equal / 2) / a.length;
}

/** n 期百分比变化：(最新 − n期前) / n期前 */
function pctChange(values, back) {
  if (!values || values.length <= back) return null;
  const now = values[values.length - 1];
  const prev = values[values.length - 1 - back];
  if (!Number.isFinite(now) || !Number.isFinite(prev) || prev === 0) return null;
  return (now - prev) / prev;
}

/* ---------------- 主力价差定义 ---------------- */
/*
 * 这些是产业链的「加工利润代理」，比单品种价格更能说明传导方向。
 * 系数为行业常规单耗：吨钢耗矿 1.6、吨焦耗煤 1.3、吨 PTA 耗 PX 0.655。
 * 仅当成员单位一致时才有意义，故逐条标注单位与口径。
 * 放在代码而非 YAML：需要按成员取值实时运算，YAML 无法表达。
 */
const SPREAD_DEFS = [
  {
    id: "FUT_SPREAD_REBAR_ORE",
    name_cn: "螺纹-铁矿价差",
    members: { RB: "FUT_RB", I: "FUT_I" },
    compute: v => v.RB - 1.6 * v.I,
    unit: "cny_per_ton",
    desc: "高炉即期利润代理。价差压缩 = 钢厂利润被原料侵蚀，通常对应钢厂减产预期。",
  },
  {
    id: "FUT_SPREAD_COKE_COAL",
    name_cn: "焦炭-焦煤价差",
    members: { J: "FUT_J", JM: "FUT_JM" },
    compute: v => v.J - 1.3 * v.JM,
    unit: "cny_per_ton",
    desc: "焦化利润代理。价差走阔 = 焦化厂有提产动力，利多焦煤需求。",
  },
  {
    id: "FUT_SPREAD_PTA_PX",
    name_cn: "PTA-PX价差",
    members: { TA: "FUT_TA", PX: "FUT_PX" },
    compute: v => v.TA - 0.655 * v.PX,
    unit: "cny_per_ton",
    desc: "聚酯加工费代理。是观察 PX 与 PTA 之间利润分配的核心读数。",
  },
  {
    id: "FUT_SPREAD_GOLD_SILVER",
    name_cn: "金银比",
    members: { AU: "FUT_AU", AG: "FUT_AG" },
    compute: v => (v.AU * 1000) / v.AG,
    unit: "ratio",
    desc: "避险与工业属性的相对强弱。比值抬升通常对应风险偏好回落。",
  },
  {
    id: "FUT_SPREAD_OIL_MEAL",
    name_cn: "油粕比",
    members: { Y: "FUT_Y", M: "FUT_M" },
    compute: v => v.Y / v.M,
    unit: "ratio",
    desc: "压榨利润在油脂与蛋白之间的分配。比值抬升 = 油脂强于粕。",
  },
  {
    id: "FUT_SPREAD_SA_FG",
    name_cn: "纯碱-玻璃价差",
    members: { SA: "FUT_SA", FG: "FUT_FG" },
    compute: v => v.SA * 0.2 - v.FG,
    unit: "cny_per_ton",
    desc: "纯碱是玻璃主料（单耗约 0.2 吨/重量箱）。价差反映浮法玻璃的原料成本压力。",
  },
];

/* ---------------- 主入口 ---------------- */

export function buildFuturesAnalysis({ config, observations, asOf }) {
  const metaById = new Map(config.futuresIndicators.map(m => [m.id, m]));
  const obsById = observations.indicators || {};

  /* --- 品种级 --- */
  const varieties = [];
  const seriesMap = new Map();

  for (const meta of config.futuresIndicators) {
    const obs = obsById[meta.id];
    const rawSeries = obs?.series || [];
    const pts = rawSeries.filter(p => p.v !== null && Number.isFinite(p.v));
    const values = pts.map(p => p.v);

    const oiPts = rawSeries.filter(p => p.oi !== null && Number.isFinite(p.oi));
    const oiValues = oiPts.map(p => p.oi);

    const zWindow = values.slice(-250);
    const zMean = mean(zWindow);
    const zStd = std(zWindow);
    const latestValue = values.length ? values[values.length - 1] : null;
    const z1y = zStd && zStd > 1e-9 ? round((latestValue - zMean) / zStd) : null;

    const lastDate = pts.length ? pts[pts.length - 1].d : null;
    const staleDays = lastDate
      ? Math.round((Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${lastDate}T00:00:00Z`)) / 86400000)
      : null;

    /* 当日涨跌幅在该品种自身近 3 年单日涨跌幅分布里的分位 —— 「今天这一下有多罕见」。
       报告用它给「当日明显偏离」加注：只看 z(1Y) 说明不了今天动得多不多。 */
    let chg1Extreme = null;
    if (values.length > 60) {
      const hist1 = [];
      for (let i = 1; i < values.length; i += 1) {
        if (values[i - 1]) hist1.push(Math.abs(values[i] / values[i - 1] - 1));
      }
      const hist1w = hist1.slice(-750);
      const today = values.length > 1 && values[values.length - 2]
        ? Math.abs(values[values.length - 1] / values[values.length - 2] - 1)
        : null;
      if (today !== null && hist1w.length > 20) chg1Extreme = round(percentileOf(hist1w, today), 4);
    }

    const item = {
      id: meta.id,
      name_cn: meta.name_cn,
      chain: meta.chain || null,
      chain_cn: meta.chain_cn || null,
      chain_tier: meta.chain_tier || null,
      code: obs?.mainContract?.toCode || meta.ifind?.field_code || null,
      requestedCode: meta.ifind?.field_code || null,
      unit: meta.unit || null,
      importance: meta.importance || null,
      status: obs?.quality === "OK" ? "OK" : obs?.quality || "EMPTY",
      lastDate,
      staleDays,
      value: latestValue === null ? null : round(latestValue, 4),
      d1: round(pctChange(values, 1), 5),
      d5: round(pctChange(values, 5), 5),
      d20: round(pctChange(values, 20), 5),
      d60: round(pctChange(values, 60), 5),
      z1y,
      pct1y: round(percentileOf(values.slice(-250), latestValue), 4),
      pct3y: round(percentileOf(values.slice(-750), latestValue), 4),
      chg1Extreme,
      ma20: round(mean(values.slice(-20)), 4),
      historyDays: values.length,
      oi: oiValues.length ? oiValues[oiValues.length - 1] : null,
      oiChg5: oiValues.length > 5 ? round(pctChange(oiValues, 5), 5) : null,
      oiChg20: oiValues.length > 20 ? round(pctChange(oiValues, 20), 5) : null,
      mainContract: obs?.mainContract || null,
    };
    varieties.push(item);
    if (pts.length >= 2) seriesMap.set(meta.id, pts);
  }

  const byId = new Map(varieties.map(v => [v.id, v]));
  const tradable = varieties.filter(v => v.value !== null && v.staleDays !== null && v.staleDays <= 7);

  /* --- 链级 / 层级聚合 --- */
  const chains = (config.futuresChains || []).map(chain => {
    const tiers = (chain.tiers || []).map(tier => {
      const members = (tier.members || []).map(id => byId.get(id)).filter(Boolean);
      const live = members.filter(v => v.value !== null && v.d5 !== null);
      return {
        name_cn: tier.name_cn,
        members: members.map(v => v.id),
        metrics: {
          d1: round(median(live.map(v => v.d1)), 5),
          d5: round(median(live.map(v => v.d5)), 5),
          d20: round(median(live.map(v => v.d20)), 5),
          z1y: round(median(live.map(v => v.z1y)), 4),
          breadth: live.length ? round(live.filter(v => v.d5 > 0).length / live.length, 3) : null,
          count: live.length,
        },
      };
    });
    const memberIds = (chain.tiers || []).flatMap(t => t.members || []);
    const members = memberIds.map(id => byId.get(id)).filter(Boolean);
    const live = members.filter(v => v.value !== null && v.d5 !== null);
    return {
      id: chain.id,
      name_cn: chain.name_cn,
      desc: chain.desc || null,
      memberCount: members.length,
      liveCount: live.length,
      tiers,
      metrics: {
        d1: round(median(live.map(v => v.d1)), 5),
        d5: round(median(live.map(v => v.d5)), 5),
        d20: round(median(live.map(v => v.d20)), 5),
        z1y: round(median(live.map(v => v.z1y)), 4),
        pct1y: round(median(live.map(v => v.pct1y)), 4),
        breadth: live.length ? round(live.filter(v => v.d5 > 0).length / live.length, 3) : null,
        oiChg5: round(median(live.map(v => v.oiChg5)), 5),
      },
      leaders: members.filter(v => v.importance === "high").map(v => v.id),
    };
  }).filter(c => c.memberCount > 0);

  const chainById = new Map(chains.map(c => [c.id, c]));

  /* --- 热力图：链 × 品种 --- */
  const heatmap = {
    chains: chains.map(c => ({
      id: c.id,
      name_cn: c.name_cn,
      d5: c.metrics.d5,
      d20: c.metrics.d20,
      breadth: c.metrics.breadth,
      cells: c.tiers.flatMap(t => t.members.map(id => {
        const v = byId.get(id);
        if (!v) return null;
        return {
          id: v.id, name_cn: v.name_cn, tier: t.name_cn,
          d1: v.d1, d5: v.d5, d20: v.d20, z1y: v.z1y, pct1y: v.pct1y,
          value: v.value, unit: v.unit, importance: v.importance,
          staleDays: v.staleDays, status: v.status,
        };
      }).filter(Boolean)),
    })),
  };

  /* --- 涨跌榜（按 5 日涨跌幅） --- */
  const ranked = tradable.filter(v => v.d5 !== null).slice().sort((a, b) => b.d5 - a.d5);
  const movers = {
    window: "d5",
    up: ranked.slice(0, 12).map(pick),
    down: ranked.slice(-12).reverse().map(pick),
  };

  function pick(v) {
    return {
      id: v.id, name_cn: v.name_cn, chain_cn: v.chain_cn, chain: v.chain, chain_tier: v.chain_tier,
      d1: v.d1, d5: v.d5, d20: v.d20, z1y: v.z1y, pct1y: v.pct1y,
      value: v.value, unit: v.unit, oiChg5: v.oiChg5,
    };
  }

  /* --- 主力价差 --- */
  const spreads = [];
  for (const def of SPREAD_DEFS) {
    const keys = Object.keys(def.members);
    const maps = keys.map(k => {
      const s = seriesMap.get(def.members[k]) || [];
      return new Map(s.map(p => [p.d, p.v]));
    });
    const anchor = maps[0];
    const dates = [...anchor.keys()].filter(d => maps.every(m => m.has(d))).sort();
    if (dates.length < 30) {
      spreads.push({ id: def.id, name_cn: def.name_cn, desc: def.desc, unit: def.unit, available: false, reason: `共同交易日不足（${dates.length}）` });
      continue;
    }
    const series = dates.map(d => {
      const vals = {};
      keys.forEach((k, i) => { vals[k] = maps[i].get(d); });
      return { d, v: def.compute(vals) };
    });
    const values = series.map(p => p.v);
    const latest = values[values.length - 1];
    const zw = values.slice(-250);
    const m = mean(zw);
    const sd = std(zw);
    // 价差的百分比变化在价差过零时会爆炸（焦炭-焦煤价差从 -33.8 走到 -7.2，
    // 百分比算出 +323%，毫无信息量）。仅对「比值」型价差保留百分比，
    // 差额型价差一律用绝对变化（元/吨）。
    const isRatio = def.unit === "ratio";
    const deltaAt = back => {
      if (values.length <= back) return null;
      const now = values[values.length - 1];
      const prev = values[values.length - 1 - back];
      return Number.isFinite(now) && Number.isFinite(prev) ? round(now - prev, 4) : null;
    };
    spreads.push({
      id: def.id,
      name_cn: def.name_cn,
      desc: def.desc,
      unit: def.unit,
      available: true,
      members: def.members,
      lastDate: series[series.length - 1].d,
      value: round(latest, 4),
      changeMode: isRatio ? "pct" : "abs",
      d1: isRatio ? round(pctChange(values, 1), 5) : deltaAt(1),
      d5: isRatio ? round(pctChange(values, 5), 5) : deltaAt(5),
      d20: isRatio ? round(pctChange(values, 20), 5) : deltaAt(20),
      z1y: sd && sd > 1e-9 ? round((latest - m) / sd) : null,
      pct1y: round(percentileOf(zw, latest), 4),
      pct3y: round(percentileOf(values.slice(-750), latest), 4),
      historyDays: values.length,
      // 价差历史序列（近 300 个共同交易日），供工作台直接画折线。
      // 计算留在采集/快照层，前端只做展示，符合 Spec §37「统计量由代码算」。
      points: series.slice(-300).map(p => [p.d, round(p.v, 4)]),
    });
  }

  /* --- 链内信号 --- */
  const signals = [];
  for (const chain of chains) {
    const tiers = chain.tiers.filter(t => t.metrics.d20 !== null && t.metrics.count >= 2);
    if (tiers.length >= 2) {
      const up = tiers[0];
      const down = tiers[tiers.length - 1];
      const diff = up.metrics.d20 - down.metrics.d20;
      if (Math.abs(diff) > 0.05) {
        signals.push({
          id: `TIER_SPREAD_${chain.id}`,
          chain: chain.id,
          chain_cn: chain.name_cn,
          type: "CHAIN_TIER_SPREAD",
          severity: Math.abs(diff) > 0.10 ? "high" : "medium",
          detail: `近 20 日 ${up.name_cn} 中位 ${(up.metrics.d20 * 100).toFixed(1)}% vs ${down.name_cn} 中位 ${(down.metrics.d20 * 100).toFixed(1)}%，差 ${(diff * 100).toFixed(1)}pct`,
          implication: diff > 0
            ? `${chain.name_cn}：原料强于成品，加工环节利润受压`
            : `${chain.name_cn}：成品强于原料，加工环节利润扩张`,
        });
      }
    }
  }

  /* --- 走势序列（控制体积：每品种最多 250 点） --- */
  const trends = {};
  for (const v of varieties) {
    const pts = seriesMap.get(v.id);
    if (!pts || pts.length < 2) continue;
    trends[v.id] = {
      id: v.id,
      name_cn: v.name_cn,
      chain: v.chain,
      chain_cn: v.chain_cn,
      chain_tier: v.chain_tier,
      unit: v.unit,
      importance: v.importance,
      lastDate: v.lastDate,
      points: pts.slice(-250).map(p => [p.d, p.v]),
    };
  }

  /* --- 结构化要点（模板生成，非 LLM 叙述） --- */
  const brief = [];
  const sortedChains = chains.filter(c => c.metrics.d5 !== null).slice().sort((a, b) => b.metrics.d5 - a.metrics.d5);
  if (sortedChains.length) {
    brief.push(`期货产业链 5 日涨跌：${sortedChains.map(c => `${c.name_cn}${(c.metrics.d5 * 100).toFixed(1)}%`).join("、")}。`);
    const top = sortedChains[0];
    const bot = sortedChains[sortedChains.length - 1];
    brief.push(`最强链 ${top.name_cn}（中位 ${(top.metrics.d5 * 100).toFixed(1)}%，广度 ${(top.metrics.breadth * 100).toFixed(0)}%）；最弱链 ${bot.name_cn}（中位 ${(bot.metrics.d5 * 100).toFixed(1)}%，广度 ${(bot.metrics.breadth * 100).toFixed(0)}%）。`);
  }
  if (movers.up.length && movers.down.length) {
    brief.push(`5 日领涨：${movers.up.slice(0, 4).map(v => `${v.name_cn}${(v.d5 * 100).toFixed(1)}%`).join("、")}；领跌：${movers.down.slice(0, 4).map(v => `${v.name_cn}${(v.d5 * 100).toFixed(1)}%`).join("、")}。`);
  }
  const extreme = tradable.filter(v => v.z1y !== null && Math.abs(v.z1y) >= 2)
    .sort((a, b) => Math.abs(b.z1y) - Math.abs(a.z1y)).slice(0, 6);
  if (extreme.length) {
    brief.push(`价格处于 1 年统计极端（|z|≥2）：${extreme.map(v => `${v.name_cn}(z=${v.z1y})`).join("、")}。`);
  }
  const liveSpreads = spreads.filter(s => s.available && s.pct1y !== null);
  const spreadExtreme = liveSpreads.filter(s => s.pct1y <= 0.1 || s.pct1y >= 0.9).sort((a, b) => Math.abs(b.pct1y - 0.5) - Math.abs(a.pct1y - 0.5));
  if (spreadExtreme.length) {
    brief.push(`价差处于 1 年极值：${spreadExtreme.map(s => `${s.name_cn}（${s.pct1y <= 0.5 ? "低位" : "高位"} ${(s.pct1y * 100).toFixed(0)}% 分位）`).join("、")}。`);
  }
  if (signals.length) {
    brief.push(`链内传导信号 ${signals.length} 条：${signals.map(s => s.implication).join("；")}。`);
  }
  const staleList = varieties.filter(v => v.staleDays === null || v.staleDays > 7);
  if (staleList.length) {
    brief.push(`数据滞后提示：${staleList.map(v => v.value === null ? `${v.name_cn}(无有效数据)` : `${v.name_cn}(滞后 ${v.staleDays} 天)`).join("、")}。`);
  }

  return {
    contract: "MACRO_FUTURES",
    asOf,
    chainCount: chains.length,
    varietyCount: varieties.length,
    liveVarietyCount: tradable.length,
    chains,
    varieties,
    heatmap,
    movers,
    spreads,
    signals,
    trends,
    brief,
  };
}
