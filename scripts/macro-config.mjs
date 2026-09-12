// 宏观高频监测 · 配置层加载器
//
// 单一真源：.agents/skills/macro-high-frequency-monitor/references/*.yaml（随仓库分发，受 git 跟踪）
// 该 YAML 同时被 Codex 等 agent 技能消费，因此脚本不复制配置，只读取。
//
// 本文件自带一个「最小 YAML 子集解析器」——只覆盖本仓库配置实际使用的构造，
// 不引入额外 npm 依赖（Spec §24 精神：不为一个小需求新增第二套东西）。
// 支持：缩进映射 / 序列 / 内联映射 {a: 1} / 内联序列 [a, b] / 块标量 >- | /
//       行内注释 / 引号字符串 / 数字 / 布尔 / null
// 不支持：锚点、别名、多文档、标签、复杂流式嵌套（配置中均未使用）。
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const configHere = dirname(fileURLToPath(import.meta.url));

/** 配置目录里必须有注册表，才算找到真源 */
const hasRegistry = dir => existsSync(join(dir, "references", "indicator_registry.yaml"));

/**
 * 定位技能目录（配置真源）。按「就近优先」探测，绝不依赖某个人的绝对路径，
 * 也不依赖 DeerFlow —— 按治理约定 DeerFlow 已 deferred，运行时不得依赖它。
 *   1) MACRO_SKILL_DIR 环境变量（部署时可覆盖）
 *   2) 脚本上一级 —— 技能包被整体安装到 ~/.codex/skills/<name>/ 后的形态
 *   3) 仓库内 .agents/skills/macro-high-frequency-monitor —— 仓库源码形态
 */
function locateSkillDir() {
  const repoSkill = resolve(configHere, "../.agents/skills/macro-high-frequency-monitor");
  const candidates = [
    process.env.MACRO_SKILL_DIR,
    resolve(configHere, ".."),
    repoSkill,
  ].filter(Boolean);
  for (const dir of candidates) if (hasRegistry(dir)) return dir;
  throw new Error(
    "找不到宏观配置真源。期望在以下任一位置的 references/indicator_registry.yaml：\n" +
    candidates.map(d => `  - ${d}`).join("\n") +
    "\n仓库内应为 .agents/skills/macro-high-frequency-monitor/references/indicator_registry.yaml；" +
    "若已安装到 Codex，重跑 `npm run macro:install-skill` 即可。"
  );
}

export const SKILL_DIR = locateSkillDir();

/* ------------------------------------------------------------------ */
/* YAML 子集解析器                                                      */
/* ------------------------------------------------------------------ */

function stripComment(line) {
  let out = "";
  let quote = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote) {
      out += ch;
      if (ch === quote && line[i - 1] !== "\\") quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      out += ch;
      continue;
    }
    // 仅当 # 前面是空白或行首时才算注释，避免误伤值里的 #
    if (ch === "#" && (i === 0 || /\s/.test(line[i - 1]))) break;
    out += ch;
  }
  return out;
}

function splitTopLevel(text, sep = ",") {
  const parts = [];
  let depth = 0;
  let quote = null;
  let cur = "";
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      cur += ch;
      if (ch === quote && text[i - 1] !== "\\") quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === "{" || ch === "[") depth += 1;
    else if (ch === "}" || ch === "]") depth -= 1;
    if (ch === sep && depth === 0) {
      parts.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  parts.push(cur);
  return parts;
}

function findKeyColon(text) {
  let depth = 0;
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === quote && text[i - 1] !== "\\") quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "{" || ch === "[") depth += 1;
    else if (ch === "}" || ch === "]") depth -= 1;
    else if (ch === ":" && depth === 0) return i;
  }
  return -1;
}

function unquote(text) {
  const s = text.trim();
  if (s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))) {
    return s.slice(1, -1);
  }
  return s;
}

function parseScalar(text) {
  const s = text.trim();
  if (s === "") return null;
  if (s === "true") return true;
  if (s === "false") return false;
  if (s === "null" || s === "~") return null;
  if (s.startsWith("{") && s.endsWith("}")) {
    const obj = {};
    for (const part of splitTopLevel(s.slice(1, -1))) {
      if (!part.trim()) continue;
      const idx = findKeyColon(part);
      if (idx < 0) continue;
      obj[unquote(part.slice(0, idx))] = parseScalar(part.slice(idx + 1));
    }
    return obj;
  }
  if (s.startsWith("[") && s.endsWith("]")) {
    return splitTopLevel(s.slice(1, -1))
      .map(item => item.trim())
      .filter(item => item !== "")
      .map(item => parseScalar(item));
  }
  if (s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))) {
    return s.slice(1, -1);
  }
  if (/^-?\d+$/.test(s)) return Number(s);
  if (/^-?\d*\.\d+$/.test(s)) return Number(s);
  return s;
}

export function parseYaml(text) {
  const lines = [];
  for (const raw of String(text).replace(/\r\n?/g, "\n").split("\n")) {
    const stripped = stripComment(raw);
    if (!stripped.trim()) continue;
    lines.push({ indent: stripped.match(/^ */)[0].length, text: stripped.trim() });
  }
  let pos = 0;

  function parseBlock(indent) {
    if (pos < lines.length && lines[pos].indent === indent && lines[pos].text.startsWith("- ")) {
      return parseSequence(indent);
    }
    return parseMapping(indent);
  }

  function parseSequence(indent) {
    const arr = [];
    while (pos < lines.length && lines[pos].indent === indent && lines[pos].text.startsWith("- ")) {
      const body = lines[pos].text.slice(2).trim();
      pos += 1;
      if (body === "") {
        arr.push(pos < lines.length && lines[pos].indent > indent ? parseBlock(lines[pos].indent) : null);
        continue;
      }
      // 内联映射/序列作为整项：- { id: X, ... } 或 - [a, b]
      if (body.startsWith("{") || body.startsWith("[")) {
        arr.push(parseScalar(body));
        continue;
      }
      const colon = findKeyColon(body);
      if (colon < 0) {
        arr.push(parseScalar(body));
        continue;
      }
      const obj = {};
      obj[unquote(body.slice(0, colon))] = parseScalar(body.slice(colon + 1));
      if (pos < lines.length && lines[pos].indent > indent) {
        const child = parseBlock(lines[pos].indent);
        if (Array.isArray(child)) obj._items = child;
        else if (child) Object.assign(obj, child);
      }
      arr.push(obj);
    }
    return arr;
  }

  function parseMapping(indent) {
    const obj = {};
    while (pos < lines.length && lines[pos].indent === indent && !lines[pos].text.startsWith("- ")) {
      const line = lines[pos];
      const colon = findKeyColon(line.text);
      if (colon < 0) {
        pos += 1;
        continue;
      }
      const key = unquote(line.text.slice(0, colon));
      const rest = line.text.slice(colon + 1).trim();
      pos += 1;
      if (rest === ">-" || rest === ">" || rest === "|" || rest === "|-") {
        const buf = [];
        while (pos < lines.length && lines[pos].indent > line.indent) {
          buf.push(lines[pos].text);
          pos += 1;
        }
        obj[key] = buf.join(rest.startsWith("|") ? "\n" : " ");
        continue;
      }
      if (rest === "") {
        obj[key] = pos < lines.length && lines[pos].indent > indent ? parseBlock(lines[pos].indent) : null;
        continue;
      }
      obj[key] = parseScalar(rest);
    }
    return obj;
  }

  return parseBlock(lines[0]?.indent ?? 0);
}

/* ------------------------------------------------------------------ */
/* 配置封装                                                            */
/* ------------------------------------------------------------------ */

export function loadMacroConfig() {
  const registryPath = resolve(SKILL_DIR, "references/indicator_registry.yaml");
  const rulesPath = resolve(SKILL_DIR, "references/signal_rules.yaml");
  const futuresPath = resolve(SKILL_DIR, "references/futures_chains.yaml");

  const registry = parseYaml(readFileSync(registryPath, "utf8"));
  const rules = parseYaml(readFileSync(rulesPath, "utf8"));
  let futures = {};
  try {
    futures = parseYaml(readFileSync(futuresPath, "utf8"));
  } catch {
    futures = {};
  }

  const indicators = [
    ...(registry.layer_official || []).map(item => ({ ...item, layer: "official" })),
    ...(registry.layer_highfreq || []).map(item => ({ ...item, layer: "highfreq" })),
    ...(registry.layer_market || []).map(item => ({ ...item, layer: "market" })),
  ];

  // 期货产业链层：独立于宏观六维，只做展示与产业链分析
  const futuresIndicators = (futures.layer_futures || []).map(item => ({ ...item, layer: "futures" }));

  // 可采集 = 已实测验证 且 有具体 field_code 且 不是纯派生指标
  const collectable = indicators.filter(
    item => item?.ifind?.verified === true
      && typeof item.ifind.field_code === "string"
      && item.ifind.field_code
      && !/FIELD_LOOKUP_REQUIRED/.test(item.ifind.field_code),
  );
  const futuresCollectable = futuresIndicators.filter(
    item => item?.ifind?.verified === true && typeof item.ifind.field_code === "string" && item.ifind.field_code,
  );
  const futuresDiscontinued = futuresIndicators.filter(item => item?.ifind?.status === "DISCONTINUED");

  // 去重：同一 field_code 只请求一次（螺纹钢等 9 个品种同时服务宏观维度与期货层）
  const codeOwners = new Map();
  for (const item of [...collectable, ...futuresCollectable]) {
    const code = `${item.ifind.tool}|${item.ifind.field_code}`;
    if (!codeOwners.has(code)) codeOwners.set(code, []);
    codeOwners.get(code).push(item.id);
  }
  const uniqueRequests = [...codeOwners.entries()].map(([key, ids]) => {
    const [tool, field_code] = key.split("|");
    return { key, tool, field_code, ids };
  });

  const derived = indicators.filter(item => item?.derived?.formula);
  const pending = registry.pending_lookup || [];

  return {
    registry,
    rules,
    futures,
    indicators,
    futuresIndicators,
    collectable,
    futuresCollectable,
    futuresDiscontinued,
    uniqueRequests,
    derived,
    pending,
    paths: { registryPath, rulesPath, futuresPath },
    dimensions: registry.dimensions || {},
    futuresChains: futures.futures_chains || [],
    hqFuturesFields: futures.hq_fields || {},
    weightProfile: rules.weight_profile || {},
    signalRules: rules.signal_rules || {},
    directionSemantics: rules.direction_semantics || {},
    anomalyTriggers: rules.anomaly_triggers || [],
    divergenceRules: rules.divergence_rules || [],
    freshness: rules.freshness || {},
  };
}

// 直接执行时输出自检信息，用于确认解析器正确性
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}` || process.argv[1]?.endsWith("macro-config.mjs")) {
  const cfg = loadMacroConfig();
  console.log("SKILL_DIR      :", SKILL_DIR);
  console.log("registry 版本   :", cfg.registry.version, "| verified_at:", cfg.registry.verified_at);
  console.log("指标总数        :", cfg.indicators.length);
  console.log("  官方层 L1     :", cfg.indicators.filter(i => i.layer === "official").length);
  console.log("  高频层 L2     :", cfg.indicators.filter(i => i.layer === "highfreq").length);
  console.log("  市场层 L3     :", cfg.indicators.filter(i => i.layer === "market").length);
  console.log("期货层 L4       :", cfg.futuresIndicators.length, "| 可采集", cfg.futuresCollectable.length, "| 停更", cfg.futuresDiscontinued.length);
  console.log("  产业链        :", cfg.futuresChains.map(c => `${c.name_cn}(${(c.tiers || []).reduce((a, t) => a + (t.members || []).length, 0)})`).join(", "));
  console.log("去重后请求数    :", cfg.uniqueRequests.length, `（宏观 ${cfg.collectable.length} + 期货 ${cfg.futuresCollectable.length}）`);
  console.log("可采集(verified):", cfg.collectable.length);
  console.log("  其中 EDB      :", cfg.collectable.filter(i => i.ifind.tool === "THS_EDB").length);
  console.log("  其中 HQ       :", cfg.collectable.filter(i => i.ifind.tool === "THS_HQ").length);
  console.log("派生指标        :", cfg.derived.map(i => i.id).join(", ") || "无");
  console.log("待补指标        :", cfg.pending.length);
  console.log("六维            :", Object.keys(cfg.dimensions).join(", "));
  console.log("权重档位        :", cfg.weightProfile.status, "| 维度:", Object.keys(cfg.weightProfile.dimensions || {}).join(", "));
  console.log("异常触发规则    :", cfg.anomalyTriggers.map(x => x.id).join(", "));
  console.log("背离规则        :", cfg.divergenceRules.map(x => x.id).join(", "));
  const missingDim = cfg.collectable.filter(i => !i.dimension).map(i => i.id);
  console.log("缺 dimension 的指标:", missingDim.length ? missingDim.join(", ") : "无");
  const dup = cfg.collectable.map(i => i.id).filter((id, idx, arr) => arr.indexOf(id) !== idx);
  console.log("重复 ID         :", dup.length ? dup.join(", ") : "无");
}
