import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const readJson = path => JSON.parse(readFileSync(resolve(path), "utf8"));
export const sha256File = path => createHash("sha256").update(readFileSync(resolve(path))).digest("hex");
export function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
}
export const stableJson = value => JSON.stringify(stable(value));
export function parseArgs(argv = process.argv.slice(2)) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    if (!raw.startsWith("--")) continue;
    const [name, inline] = raw.slice(2).split(/=(.*)/s, 2);
    if (inline !== undefined) values[name] = inline;
    else if (argv[index + 1] && !argv[index + 1].startsWith("--")) values[name] = argv[++index];
    else values[name] = true;
  }
  return values;
}
export function gitInfo(root = ROOT) {
  const safe = root.replaceAll("\\", "/");
  const git = args => execFileSync("git", ["-c", `safe.directory=${safe}`, "-C", root, ...args], { encoding: "utf8" }).trim();
  return { sourceCommit: git(["rev-parse", "HEAD"]), sourceDirty: git(["status", "--porcelain", "--untracked-files=no"]).length > 0 };
}
const FORBIDDEN_SERIES_KEYS = new Set(["history", "observations", "points", "rawSeries", "series", "trends"]);
export function stripRawSeries(value) {
  if (Array.isArray(value)) return value.map(stripRawSeries);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !FORBIDDEN_SERIES_KEYS.has(key)).map(([key, child]) => [key, stripRawSeries(child)]));
}
export function handoffPayload(snapshot, info = gitInfo()) {
  if (snapshot.contract !== "MACRO_SNAPSHOT" || snapshot.version !== "1.1.0") throw new Error(`需要 MACRO_SNAPSHOT 1.1.0，实际 ${snapshot.contract || "missing"} ${snapshot.version || "missing"}`);
  const futures = snapshot.futures || {};
  return {
    contract: "AI_MACRO_HANDOFF", version: "1.0.0", generatedAt: new Date().toISOString(), asOf: snapshot.asOf,
    source: { contract: snapshot.contract, version: snapshot.version, generatedAt: snapshot.generatedAt, sha256: null, sourceCommit: info.sourceCommit, sourceDirty: info.sourceDirty },
    headline: stripRawSeries(snapshot.headline), dimensions: stripRawSeries(snapshot.dimensions), deviations: stripRawSeries(snapshot.deviations),
    anomalies: stripRawSeries(snapshot.anomalies), divergences: stripRawSeries(snapshot.divergences), aggregates: stripRawSeries(snapshot.aggregates),
    freshness: stripRawSeries(snapshot.headline?.freshness || {}),
    futures: stripRawSeries({ contract: futures.contract, chainCount: futures.chainCount, varietyCount: futures.varietyCount,
      liveVarietyCount: futures.liveVarietyCount, chains: futures.chains, varieties: futures.varieties, heatmap: futures.heatmap,
      movers: futures.movers, graph: futures.graph, asOf: futures.asOf, spreads: futures.spreads, signals: futures.signals }),
    meta: { indicatorCount: snapshot.indicators?.length || 0, futuresVarietyCount: futures.varieties?.length || 0,
      graphEdgeCount: futures.graph?.edges?.length || 0 },
  };
}
export function semanticProjection(snapshot) {
  const futures = snapshot.futures || {};
  return stripRawSeries({ contract: snapshot.contract, version: snapshot.version, asOf: snapshot.asOf,
    headline: snapshot.headline, dimensions: snapshot.dimensions, deviations: snapshot.deviations, anomalies: snapshot.anomalies,
    divergences: snapshot.divergences, aggregates: snapshot.aggregates,
    futures: { contract: futures.contract, chainCount: futures.chainCount, varietyCount: futures.varietyCount,
      liveVarietyCount: futures.liveVarietyCount, chains: futures.chains, varieties: futures.varieties, heatmap: futures.heatmap,
      movers: futures.movers, graph: futures.graph, asOf: futures.asOf, spreads: futures.spreads, signals: futures.signals } });
}
