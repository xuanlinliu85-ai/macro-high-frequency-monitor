/**
 * 期货主力合约解析器
 *
 * 背景（实测发现）：
 *   iFinD 的「主力连续」代码 XX00.交易所 对部分郑商所品种会卡在已无持仓的旧合约上，
 *   返回 close=0 且 openInterest=0。典型：SH00.CZC（烧碱）指向 oi=7 的僵尸合约，
 *   而真实主力是 SH701.CZC（oi 7.1 万）。
 *
 * 策略：
 *   先用注册表代码取数；若最后有效观测明显落后于当前交易日，
 *   则生成候选月份合约并实测持仓量，取最大者作为主力。
 *   结果缓存到 work/macro/futures-main.json，避免每天重复探测。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
/** 缓存落在仓库的 work/ 产物区；用环境变量可覆盖，绝不写死绝对路径（否则换台机器就崩） */
const CACHE_PATH = process.env.MACRO_MAIN_CACHE ||
  resolve(here, "../work/macro/futures-main.json");

/** 主力连续失效的判定阈值（自然日）。留足周末与节假日的余量，避免误报 */
export const STALE_DAYS = Number(process.env.MACRO_STALE_DAYS || 6);

function parseCode(code) {
  const m = /^([A-Z]+)00\.(.+)$/.exec(code);
  if (!m) return null;
  return { base: m[1], exchange: m[2] };
}

function daysBetween(a, b) {
  return Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86400000);
}

/** 最后有效观测是否明显落后于参考日 */
export function isStale(rows, referenceDate) {
  const valid = (rows || []).filter(r => r.v !== null && r.v !== 0);
  if (!valid.length) return true;
  return daysBetween(valid.at(-1).d, referenceDate) > STALE_DAYS;
}

/**
 * 持仓量是否在快速衰减。
 *
 * 主力合约在临近交割前持仓会连续萎缩（实测甲醇 MA 从 12.4 万手衰减到 1300 手），
 * 而「主力连续」代码 XX00 此时给出的持仓量是那个即将到期的合约的，
 * 收益序列里则混入了换月跳空。持仓快速衰减是「缓存合约已不是主力」的可靠前兆。
 */
export function oiDecaying(rows, threshold = -0.4) {
  const ois = (rows || []).filter(r => r.oi !== null && Number.isFinite(r.oi) && r.oi > 0).map(r => r.oi);
  if (ois.length < 6) return false;
  const recent = ois.slice(-6);
  const first = recent[0];
  if (!first) return false;
  return (recent[recent.length - 1] - first) / first < threshold;
}

/**
 * 生成候选月份合约。
 * 郑商所（CZC）月份为 3 位（年份末位+月份），主力集中在 01/05/09；
 * 其余交易所为 4 位（两位年+两位月），逐月试。
 */
export function candidateContracts(code, referenceDate, back = 2, forward = 14) {
  const parsed = parseCode(code);
  if (!parsed) return [];
  const { base, exchange } = parsed;
  const [y, m] = referenceDate.split("-").map(Number);
  const out = [];
  for (let i = -back; i <= forward; i += 1) {
    const t = new Date(Date.UTC(y, m - 1 + i, 1));
    const yy = t.getUTCFullYear();
    const mm = String(t.getUTCMonth() + 1).padStart(2, "0");
    if (exchange === "CZC") {
      if (!["01", "05", "09"].includes(mm)) continue;
      out.push(`${base}${String(yy).slice(3)}${mm}.${exchange}`);
    } else {
      out.push(`${base}${String(yy).slice(2)}${mm}.${exchange}`);
    }
  }
  return out;
}

export function loadCache() {
  try {
    return existsSync(CACHE_PATH) ? JSON.parse(readFileSync(CACHE_PATH, "utf8")) : {};
  } catch {
    return {};
  }
}

export function saveCache(cache) {
  writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2), "utf8");
}

function findSeries(payload) {
  const seen = new WeakSet();
  const stack = [payload];
  while (stack.length) {
    const n = stack.shift();
    if (!n || typeof n !== "object" || seen.has(n)) continue;
    seen.add(n);
    if (Array.isArray(n)) {
      const f = n.find(x => x && typeof x === "object");
      if (f && "time" in f) return n;
      for (const x of n) if (x && typeof x === "object") stack.push(x);
      continue;
    }
    for (const v of Object.values(n)) if (v && typeof v === "object") stack.push(v);
  }
  return null;
}

const asObj = r => {
  if (r && typeof r === "object") return r;
  if (typeof r === "string") { try { return JSON.parse(r); } catch { return null; } }
  return null;
};

/**
 * 主力换月复权拼接。
 *
 * 不同月份合约存在价差（实测 SH00.CZC 与 SH701.CZC 同日相差 10.4%），
 * 直接拼接会造出虚假跳空，污染 zscore / 涨跌幅 / 分位。
 * 做法：取重叠期比值的**中位数**作为缩放系数（对个别异常日稳健），
 * 把旧序列在换月点之前的部分等比缩放，再与新序列拼接。
 */
export function rollAdjust(oldRows, newRows) {
  const oldMap = new Map();
  for (const r of oldRows || []) if (r.v !== null && r.v > 0) oldMap.set(r.d, r.v);
  const ratios = [];
  let lastOverlap = null;
  for (const r of newRows || []) {
    const o = oldMap.get(r.d);
    if (o > 0 && r.v > 0) {
      ratios.push(r.v / o);
      lastOverlap = r.d;
    }
  }
  if (!ratios.length || !lastOverlap) {
    return { rows: newRows, ratio: 1, overlapDays: 0 };
  }
  ratios.sort((a, b) => a - b);
  const ratio = ratios[Math.floor(ratios.length / 2)];
  if (Math.abs(ratio - 1) < 1e-9) {
    return { rows: mergeRows(oldRows, newRows), ratio: 1, overlapDays: ratios.length };
  }
  const adjusted = (oldRows || []).map(r =>
    r.d < lastOverlap && r.v !== null ? { ...r, v: Number((r.v * ratio).toFixed(6)) } : r);
  return {
    rows: mergeRows(adjusted, newRows),
    ratio,
    anchor: lastOverlap,
    overlapDays: ratios.length,
  };
}

function mergeRows(a, b) {
  const map = new Map();
  for (const r of a || []) map.set(r.d, r);
  for (const r of b || []) map.set(r.d, r);
  return [...map.values()].sort((x, y) => x.d.localeCompare(y.d));
}

/** 取一个合约的最近数据，返回 { rows, latestDate, latestOi, validCount } */
async function fetchContract(connection, code, begin, end) {
  const raw = await connection.callTool("THS_HQ", {
    thscode: code,
    jsonIndicator: "close;volume;openInterest",
    jsonparam: "CPS:1,Days:Tradedays,Fill:Blank",
    begintime: begin,
    endtime: end,
  });
  const rows = findSeries(asObj(raw)) || [];
  const out = [];
  for (const row of rows) {
    const d = String(row.time ?? "").slice(0, 10);
    if (!d) continue;
    const close = Number(row.close);
    const oi = Number(row.openInterest);
    out.push({
      d,
      v: Number.isFinite(close) && close !== 0 ? close : null,
      vol: Number.isFinite(Number(row.volume)) ? Number(row.volume) : null,
      oi: Number.isFinite(oi) ? oi : null,
      amt: null,
      chg: null,
      r: null,
    });
  }
  out.sort((a, b) => a.d.localeCompare(b.d));
  const valid = out.filter(r => r.v !== null);
  const last = valid.at(-1);
  return {
    rows: out,
    validCount: valid.length,
    latestDate: last?.d || null,
    latestOi: last?.oi ?? null,
  };
}

/**
 * 探测主力合约：在候选月份里实测持仓量，取「最新交易日有值 且 oi 最大」的那个。
 * 返回 { code, rows, oi, tried, validCount } 或 null。
 */
export async function detectMainContract(connection, code, { referenceDate, concurrency = 4 } = {}) {
  const candidates = candidateContracts(code, referenceDate);
  if (!candidates.length) return null;
  // 只取近 40 个自然日做筛选，降低成本
  const begin = new Date(`${referenceDate}T00:00:00Z`);
  begin.setUTCDate(begin.getUTCDate() - 40);
  const beginStr = begin.toISOString().slice(0, 10);

  const results = [];
  let cursor = 0;
  async function worker() {
    while (cursor < candidates.length) {
      const cand = candidates[cursor++];
      try {
        const r = await fetchContract(connection, cand, beginStr, referenceDate);
        results.push({ code: cand, ...r });
      } catch {
        // 到期或不存在：-4210 / EMPTY_RESULT 属预期，直接跳过
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));

  const usable = results.filter(r => r.validCount > 0 && r.latestDate === referenceDate);
  const pool = usable.length ? usable : results.filter(r => r.validCount > 0);
  if (!pool.length) return null;
  pool.sort((a, b) => (b.latestOi || 0) - (a.latestOi || 0));
  const best = pool[0];
  best.tried = candidates.length;
  return best;
}

/**
 * 对外主入口：确保拿到「当前主力合约」的序列。
 *
 * alwaysResolve = true（期货展示层）：
 *   不信任 XX00 主力连续 —— 实测它不复权，换月处会造出 7%~12% 的假跳空
 *   （甲醇 2026-09-08→09-10 的 +11.75% 即换月所致）。
 *   因此始终解析真实主力月份合约，并沿用缓存的上任主力做复权拼接。
 *
 * alwaysResolve = false（宏观维度层）：
 *   沿用注册表代码，仅在明显滞后时才探测，避免改动既有六维评分口径。
 */
export async function ensureFuturesSeries(connection, code, { referenceDate, begin, cache, alwaysResolve = false } = {}) {
  const cached = cache?.[code];

  // 缓存优先：上一轮确定的主力若仍活跃且持仓未快速衰减，直接复用，避免每日重复探测
  if (cached?.main) {
    const reused = await fetchContract(connection, cached.main, begin, referenceDate).catch(() => null);
    if (reused && reused.validCount > 0 && !isStale(reused.rows, referenceDate) && !oiDecaying(reused.rows)) {
      return {
        code: cached.main,
        rows: reused.rows,
        switched: cached.main !== code,
        originalCode: code,
        fromCache: true,
        rollRatio: 1,
        overlapDays: 0,
        detectTried: 0,
      };
    }
  }

  // 宏观层：注册表代码仍然新鲜就直接用，不动既有口径
  let primary = null;
  if (!alwaysResolve) {
    primary = await fetchContract(connection, code, begin, referenceDate).catch(() => null);
    if (primary && primary.validCount > 0 && !isStale(primary.rows, referenceDate)) {
      return { code, rows: primary.rows, switched: false, originalCode: code, detectTried: 0 };
    }
  }

  const detected = await detectMainContract(connection, code, { referenceDate });
  if (!detected) {
    const fallback = primary || await fetchContract(connection, code, begin, referenceDate).catch(() => null);
    return {
      code,
      rows: fallback?.rows || [],
      switched: false,
      originalCode: code,
      detectTried: 0,
      reason: "未能解析出主力月份合约",
    };
  }

  const newFull = await fetchContract(connection, detected.code, begin, referenceDate);
  if (!newFull.validCount) {
    return { code, rows: [], switched: false, originalCode: code, detectTried: detected.tried };
  }

  // 换月拼接：用缓存记录的上任主力合约历史作基底，复权后接到新主力之前。
  // 必须用两份 API 原始序列计算，不能依赖上一轮已复权的结果（会重复缩放）。
  let baseRows = primary?.rows || [];
  if (cached?.main && cached.main !== detected.code) {
    const prev = await fetchContract(connection, cached.main, begin, referenceDate).catch(() => null);
    if (prev?.validCount && prev.validCount > baseRows.filter(r => r.v !== null).length) baseRows = prev.rows;
  }
  const rolled = baseRows.length
    ? rollAdjust(baseRows, newFull.rows)
    : { rows: newFull.rows, ratio: 1, overlapDays: 0 };

  if (cache) {
    cache[code] = {
      main: detected.code,
      detectedAt: referenceDate,
      oi: detected.latestOi,
      latestDate: detected.latestDate,
      rollRatio: rolled.ratio,
      overlapDays: rolled.overlapDays,
    };
  }
  return {
    code: detected.code,
    rows: rolled.rows,
    switched: detected.code !== code,
    originalCode: code,
    detectTried: detected.tried,
    rollRatio: rolled.ratio,
    overlapDays: rolled.overlapDays,
    oi: detected.latestOi,
  };
}

export { CACHE_PATH };
