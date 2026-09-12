// 宏观高频监测 · 采集层
//
// 职责：按 indicator_registry.yaml 的 verified 指标，从 iFinD MCP 拉取全量历史序列，
//       落 work/macro/observations.json。
//
// 边界（Spec §41 / Inventory §4）：
// - 不写入 update-snapshots.mjs（那个脚本 63KB 且扛 A 股收盘主链路，混入会放大故障域）
// - 不做任何统计计算（zscore/percentile 归 macro-snapshot.mjs，Spec §37 禁止 LLM 算数，
//   同理也不让采集层兼职算数）
// - 不落库（D1 绑定仅在 Cloudflare 运行时可用，落库由 WorkBuddy 任务在部署侧完成）
//
// 用法：
//   IFIND_API_KEY=... node scripts/macro-collect.mjs
//   MACRO_BEGIN=2020-09-01 node scripts/macro-collect.mjs   # 自定义起始窗口
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { connectIfind } from "./ifind-mcp-client.mjs";
import { loadMacroConfig, SKILL_DIR } from "./macro-config.mjs";
import { ensureFuturesSeries, loadCache as loadMainCache, saveCache as saveMainCache } from "./macro-main-contract.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const workDir = resolve(here, "../work/macro");
mkdirSync(workDir, { recursive: true });

const EDB_CHUNK = Number(process.env.MACRO_EDB_CHUNK || 12);
const HQ_CONCURRENCY = Number(process.env.MACRO_HQ_CONCURRENCY || 4);

function shanghaiToday() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

function shiftYears(dateStr, years) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return `${y - years}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

const END = process.env.MACRO_END || shanghaiToday();
// 默认 6 年窗口：月频 5 年分位需要 60 个观测点，留 1 年余量
const BEGIN = process.env.MACRO_BEGIN || shiftYears(END, 6);
// 期货层只需支撑 1 年 zscore / 分位，用 3 年窗口即可，避免 60 个品种把观测库撑大
const FUT_BEGIN = process.env.MACRO_FUT_BEGIN || shiftYears(END, 3);

/* ---------------- 返回结构兼容解析 ---------------- */

function asObject(payload) {
  if (payload == null) return null;
  if (typeof payload === "string") {
    try {
      return JSON.parse(payload);
    } catch {
      return null;
    }
  }
  return payload;
}

/** 深度优先找到第一个「元素含 time 字段」的数组 —— 兼容外层包裹变化 */
function findTimeSeriesArray(payload) {
  const seen = new WeakSet();
  const stack = [payload];
  while (stack.length) {
    const node = stack.shift();
    if (!node || typeof node !== "object" || seen.has(node)) continue;
    seen.add(node);
    if (Array.isArray(node)) {
      const first = node.find(item => item && typeof item === "object");
      if (first && ("time" in first)) return node;
      for (const item of node) if (item && typeof item === "object") stack.push(item);
      continue;
    }
    for (const value of Object.values(node)) {
      if (value && typeof value === "object") stack.push(value);
    }
  }
  return null;
}

function toNumber(value) {
  if (value === null || value === undefined) return null;
  const n = Number(String(value).trim());
  return Number.isFinite(n) ? n : null;
}

/* ---------------- EDB ---------------- */

async function collectEdb(connection, indicators, report) {
  const series = new Map();
  // 一个 field_code 可能同时服务多个指标（如代码复用于宏观维度与期货层），故用多值映射
  const byCode = new Map();
  for (const item of indicators) {
    const code = item.ifind.field_code;
    if (!byCode.has(code)) byCode.set(code, []);
    byCode.get(code).push(item);
  }
  const chunks = [];
  for (let i = 0; i < indicators.length; i += EDB_CHUNK) chunks.push(indicators.slice(i, i + EDB_CHUNK));

  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    const codes = chunk.map(item => item.ifind.field_code);
    const label = `EDB ${index + 1}/${chunks.length}`;
    try {
      const raw = await connection.callTool("THS_EDB", {
        indicators: codes.join(";"), begintime: BEGIN, endtime: END,
      });
      const payload = asObject(raw);
      const rows = findTimeSeriesArray(payload);
      if (!rows) {
        const text = typeof raw === "string" ? raw : JSON.stringify(raw ?? "");
        report.push({ label, codes, ok: false, reason: "未找到时序数组", head: text.slice(0, 200) });
        continue;
      }
      let matched = 0;
      // 首块保留原始样本，便于后续排障
      if (index === 0) {
        writeFileSync(resolve(workDir, "sample-edb.json"), JSON.stringify(rows.slice(0, 5), null, 2), "utf8");
      }
      for (const row of rows) {
        const code = String(row.id ?? row.indicator ?? row.code ?? "");
        const metas = byCode.get(code);
        if (!metas) continue;
        const value = toNumber(row.value);
        const date = String(row.time ?? "").slice(0, 10);
        if (!date) continue;
        for (const meta of metas) {
          if (!series.has(meta.id)) series.set(meta.id, []);
          series.get(meta.id).push({
            d: date,
            v: value,
            r: row.rtime ? String(row.rtime).slice(0, 19) : null,
          });
        }
        matched += 1;
      }
      report.push({ label, codes, ok: true, returnedRows: rows.length, matchedRows: matched });
      console.log(`${label}  ${chunk.length} 指标 → 返回 ${rows.length} 行，命中 ${matched} 行`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      report.push({ label, codes, ok: false, reason: message });
      console.log(`${label}  失败：${message}`);
    }
  }
  return series;
}

/* ---------------- HQ ---------------- */

/** 期货身份的行需要持仓量；纯指数/宏观价格不需要，避免无谓的体积膨胀 */
function hqFieldsFor(items) {
  const isFutures = items.some(item => item.layer === "futures");
  return isFutures
    ? "close;volume;amount;changeRatio;openInterest"
    : "close;volume";
}

/**
 * 采集窗口分层：宏观层要 6 年（月频 5 年分位需要 60 点），
 * 期货层只需支撑 1 年 zscore，用更短窗口把 observations.json 的体积压住。
 * 同一代码同时服务两层时取较长的那个窗口。
 */
function hqWindowFor(items) {
  const needMacro = items.some(item => item.layer !== "futures");
  return needMacro ? BEGIN : FUT_BEGIN;
}

async function collectOneHq(connection, code, fields, needFuturesFields, begin) {
  const raw = await connection.callTool("THS_HQ", {
    thscode: code,
    jsonIndicator: fields,
    jsonparam: "CPS:1,Days:Tradedays,Fill:Blank",
    begintime: begin,
    endtime: END,
  });
  const payload = asObject(raw);
  const rows = findTimeSeriesArray(payload);
  if (!rows) return { series: [], zeroDays: 0, totalDays: 0 };
  const out = [];
  let zeroDays = 0;
  for (const row of rows) {
    const date = String(row.time ?? "").slice(0, 10);
    if (!date) continue;
    const close = toNumber(row.close);
    // 价格类序列的 0 是「当日无有效成交/结算」的哨兵值，不是真实价格。
    // 若直接当数值会污染 zscore 与分位（动力煤主力已实质停更但仍返回 0）。
    if (close === 0) zeroDays += 1;
    const item = { d: date, v: close === 0 ? null : close, r: null, vol: toNumber(row.volume) };
    if (needFuturesFields) {
      item.amt = toNumber(row.amount);
      item.chg = toNumber(row.changeRatio);
      item.oi = toNumber(row.openInterest);
    }
    out.push(item);
  }
  return { series: out, zeroDays, totalDays: out.length };
}

/**
 * 按 thscode 去重后请求：螺纹钢等 9 个品种同时挂在宏观层与期货层，
 * 同一代码只请求一次，结果广播给所有引用它的指标 ID。
 *
 * 期货身份额外走主力合约解析：iFinD 的 XX00 主力连续对部分郑商所品种会卡在
 * 僵尸合约上（SH00.CZC 实测 oi=7），此时自动探测真实主力月份合约。
 */
async function collectHq(connection, indicators, report) {
  const series = new Map();
  const zeroMap = new Map();
  const rolls = new Map();
  const mainCache = loadMainCache();
  const switches = [];
  const groups = new Map();
  for (const item of indicators) {
    // 期货层与宏观层必须分开分组：FUT_RB 要真实主力月份合约，
    // HF_REBAR 沿用 RB00 连续以保持既有六维评分口径不变，
    // 两者即使指向同一代码也不能共用一次请求。
    const scope = item.layer === "futures" ? "F" : "M";
    const key = `${scope}|${item.ifind.field_code}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  const queue = [...groups.entries()];
  let done = 0;
  async function worker() {
    while (queue.length) {
      const [key, items] = queue.shift();
      const code = items[0].ifind.field_code;
      const isFuturesLayer = items[0].layer === "futures";
      const fields = hqFieldsFor(items);
      const begin = hqWindowFor(items);
      try {
        let rows;
        let actualCode = code;
        if (isFuturesLayer) {
          const resolved = await ensureFuturesSeries(connection, code, {
            referenceDate: END, begin, cache: mainCache, alwaysResolve: true,
          });
          rows = resolved.rows;
          actualCode = resolved.code;
          if (resolved.switched) {
            switches.push(`${code} → ${resolved.code}${resolved.fromCache ? "（缓存）" : `（探测 ${resolved.detectTried} 个候选）`}${resolved.rollRatio && resolved.rollRatio !== 1 ? ` 复权 ${resolved.rollRatio}` : ""}`);
            for (const item of items) {
              rolls.set(item.id, {
                fromCode: code,
                toCode: resolved.code,
                rollRatio: resolved.rollRatio ?? 1,
                overlapDays: resolved.overlapDays ?? 0,
                fromCache: Boolean(resolved.fromCache),
              });
            }
          }
        } else {
          rows = (await collectOneHq(connection, code, fields, false, begin)).series;
        }
        const zeroDays = rows.filter(r => r.v === null).length;
        const totalDays = rows.length;
        const valid = rows.filter(r => r.v !== null).length;
        for (const item of items) {
          series.set(item.id, rows);
          zeroMap.set(item.id, zeroDays);
          report.push({ label: `HQ ${item.id}`, code: actualCode, requestedCode: code, ok: valid > 0, rows: totalDays, zeroDays, valid });
        }
        done += 1;
        const ids = items.map(i => i.id).join("+");
        const tag = actualCode === code ? "" : ` [主力 ${code}→${actualCode}]`;
        console.log(`HQ  ${actualCode.padEnd(12)} ${ids.padEnd(28)} ${totalDays} 行，有效 ${valid}，零值哨兵 ${zeroDays}  (${done}/${groups.size})${tag}`);
      } catch (error) {
        for (const item of items) {
          report.push({ label: `HQ ${item.id}`, code, ok: false, reason: String(error?.message || error) });
        }
        console.log(`HQ  ${code} 失败：${error?.message || error}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(HQ_CONCURRENCY, groups.size) }, worker));
  saveMainCache(mainCache);
  if (switches.length) {
    console.log("主力合约切换：");
    for (const s of switches) console.log(`  ${s}`);
  }
  return { series, zeroMap, rolls };
}

/* ---------------- 主流程 ---------------- */

const config = loadMacroConfig();
const MODE = String(process.env.MACRO_MODE || "full").toLowerCase();
const MODE_FILTER = {
  full: () => true,
  // 日频市场层：工作日收盘后拉，覆盖利率/汇率/商品/指数 + 日频价格
  daily: item => item.frequency === "daily",
  // 官方宏观层：只在发布窗口打开时拉，避免每日无脑全量（Spec §27）
  release: item => item.frequency === "monthly" || item.frequency === "quarterly" || item.frequency === "weekly",
};
if (!MODE_FILTER[MODE]) throw new Error(`未知 MACRO_MODE=${MODE}，可选 full / daily / release`);

// 期货产业链层全部是日频，归 daily/full 模式；release 窗口只刷官方宏观，不动期货
const macroSelected = config.collectable.filter(MODE_FILTER[MODE]);
const futuresSelected = MODE === "release" ? [] : config.futuresCollectable;
const selected = [...macroSelected, ...futuresSelected];
const edbIndicators = selected.filter(item => item.ifind.tool === "THS_EDB");
const hqIndicators = selected.filter(item => item.ifind.tool === "THS_HQ");
const hqCodes = new Set(hqIndicators.map(item => item.ifind.field_code));

console.log(`配置源   : ${SKILL_DIR}`);
console.log(`采集模式 : ${MODE}（可选 full / daily / release）`);
console.log(`窗口     : ${BEGIN} ~ ${END}`);
console.log(`待采集   : EDB ${edbIndicators.length} 项 / HQ ${hqIndicators.length} 指标（去重后 ${hqCodes.size} 个代码）`);
console.log(`           宏观 ${macroSelected.length} 项（注册表可采集 ${config.collectable.length}）+ 期货 ${futuresSelected.length} 项`);

const startedAt = new Date().toISOString();
const connection = await connectIfind({ timeoutMs: 180_000 });
const report = [];
let edbSeries;
let hqResult;
try {
  edbSeries = await collectEdb(connection, edbIndicators, report);
  hqResult = await collectHq(connection, hqIndicators, report);
} finally {
  await connection.close();
}
const hqSeries = hqResult.series;
const hqZeroMap = hqResult.zeroMap;
const hqRolls = hqResult.rolls;

// 与既有观测合并：daily / release 模式只拉一层，另一层沿用上次结果，避免整体覆盖丢数据。
const observationsPath = resolve(workDir, "observations.json");
const previous = existsSync(observationsPath)
  ? JSON.parse(readFileSync(observationsPath, "utf8"))
  : null;

function mergeSeries(previousRows, freshRows) {
  const map = new Map();
  for (const row of previousRows || []) map.set(row.d, row);
  for (const row of freshRows || []) map.set(row.d, row);
  return [...map.values()].sort((a, b) => a.d.localeCompare(b.d));
}

/**
 * 主力换月时的等比复权拼接。
 *
 * 问题：不同月份合约价位不同（实测 SH00.CZC 在 2026-09-01 收 1800，
 * 真实主力 SH701.CZC 同日收 1987，价差 10.4%）。若直接按日期合并，
 * 换月点会凭空出现一个约 10% 的跳空，污染 zscore、涨跌幅与分位。
 *
 * 做法：以「重叠期最后一个共同有效日」为锚，用新/旧比值把旧序列等比缩放后再拼接。
 * 同合约情况下锚日两侧数值完全相同，比值恒为 1，本函数等价于普通合并（无副作用）。
 */
function mergeWithRoll(previousRows, freshRows) {
  const prevMap = new Map();
  for (const row of previousRows || []) prevMap.set(row.d, row);
  let anchor = null;
  for (const row of freshRows || []) {
    const p = prevMap.get(row.d);
    if (p && p.v > 0 && row.v > 0) anchor = { d: row.d, prev: p.v, fresh: row.v };
  }
  if (!anchor) return { rows: mergeSeries(previousRows, freshRows), ratio: 1 };
  const ratio = anchor.fresh / anchor.prev;
  // 比值落在合理区间之外，说明不是换月（可能是数据修订或异常），不做缩放
  if (!(ratio > 0.8 && ratio < 1.25) || Math.abs(ratio - 1) < 1e-9) {
    return { rows: mergeSeries(previousRows, freshRows), ratio: 1 };
  }
  const adjusted = (previousRows || []).map(row =>
    row.d < anchor.d && row.v !== null ? { ...row, v: Number((row.v * ratio).toFixed(6)) } : row);
  return { rows: mergeSeries(adjusted, freshRows), ratio, anchor };
}

const indicators = {};
let totalRows = 0;
let emptyCount = 0;
let carried = 0;
// 只落「有 iFinD 字段」的原始指标；派生指标（如期限利差）没有独立数据源，
// 其序列由 macro-snapshot.mjs 从支撑序列相减得到，不应出现在采集层产物里。
const rawIndicators = [...config.indicators, ...config.futuresIndicators]
  .filter(meta => meta.ifind && meta.ifind.field_code);
for (const meta of rawIndicators) {
  const fresh = edbSeries?.get(meta.id) || hqSeries?.get(meta.id) || null;
  const previousSeries = previous?.indicators?.[meta.id]?.series || [];
  let rows;
  let rollRatio = 1;
  if (!fresh) {
    rows = previousSeries;
  } else if (meta.layer === "futures" && meta.ifind.tool === "THS_HQ") {
    // 期货层需处理主力换月的价差跳空；同合约时该函数退化为普通合并
    const rolled = mergeWithRoll(previousSeries, fresh);
    rows = rolled.rows;
    rollRatio = rolled.ratio;
  } else {
    rows = mergeSeries(previousSeries, fresh);
  }
  if (!fresh && rows.length) carried += 1;
  const valid = rows.filter(row => row.v !== null);
  const nonZero = valid.filter(row => row.v !== 0);
  let quality = "OK";
  if (!valid.length) quality = "EMPTY";
  else if (!nonZero.length) quality = "ALL_ZERO";
  else if (nonZero.length < valid.length * 0.5) quality = "SPARSE";
  if (quality !== "OK") emptyCount += 1;
  totalRows += rows.length;
  indicators[meta.id] = {
    id: meta.id,
    name_cn: meta.name_cn,
    layer: meta.layer,
    dimension: meta.dimension,
    category: meta.category,
    frequency: meta.frequency,
    unit: meta.unit,
    importance: meta.importance,
    chain: meta.chain || null,
    chain_cn: meta.chain_cn || null,
    chain_tier: meta.chain_tier || null,
    scoring: meta.scoring !== false,
    tool: meta.ifind.tool,
    field_code: meta.ifind.field_code,
    quality,
    zeroSentinelDays: hqZeroMap?.get(meta.id) || 0,
    rollRatio: rollRatio !== 1 ? rollRatio : undefined,
    mainContract: hqRolls?.get(meta.id) || undefined,
    rowCount: rows.length,
    validCount: nonZero.length,
    latest: nonZero.at(-1) || null,
    refreshedThisRun: Boolean(fresh),
    series: rows,
  };
}

writeFileSync(resolve(workDir, "collect-report.json"), JSON.stringify({ startedAt, mode: MODE, begin: BEGIN, end: END, report }, null, 2), "utf8");
writeFileSync(observationsPath, JSON.stringify({
  collectedAt: startedAt,
  mode: MODE,
  window: { begin: BEGIN, end: END },
  source: "ifind-mcp",
  registry: { skillDir: SKILL_DIR, version: config.registry.version, verifiedAt: config.registry.verified_at },
  stats: {
    indicators: Object.keys(indicators).length,
    rows: totalRows,
    degraded: emptyCount,
    refreshedThisRun: Object.values(indicators).filter(item => item.refreshedThisRun).length,
    carriedFromPrevious: carried,
  },
  modeRuns: { ...(previous?.modeRuns || {}), [MODE]: startedAt },
  indicators,
}), "utf8");

console.log("");
console.log(`采集完成 [${MODE}]：${Object.keys(indicators).length} 项指标 / ${totalRows} 行观测`);
console.log(`  本轮刷新 ${Object.values(indicators).filter(item => item.refreshedThisRun).length} 项，沿用上轮 ${carried} 项，质量异常 ${emptyCount} 项`);
const degraded = Object.values(indicators).filter(item => item.quality !== "OK");
if (degraded.length) {
  console.log("质量异常明细：");
  for (const item of degraded) console.log(`  ${item.quality.padEnd(9)} ${item.id.padEnd(20)} ${item.name_cn}`);
}
console.log("→ work/macro/observations.json");
console.log("→ work/macro/collect-report.json");
