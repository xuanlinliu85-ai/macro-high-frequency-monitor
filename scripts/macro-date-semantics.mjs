/** Deterministic trading-data date resolution shared by snapshot and validation. */

const isoDate = value => /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));

export function resolveTradingDataAsOf(candidates, minimumCoverage) {
  const threshold = Number(minimumCoverage);
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 1) {
    throw new Error("DATE_COHERENCE_CONFIG_INVALID: minimum_coverage must be in (0, 1]");
  }
  const eligible = (candidates || []).filter(item =>
    item?.refreshedThisRun === true
    && item?.quality === "OK"
    && isoDate(item?.latest?.d)
    && item?.status !== "DISCONTINUED");
  if (!eligible.length) throw new Error("DATE_COHERENCE_FAILED: no refreshed daily observations");

  const counts = new Map();
  for (const item of eligible) counts.set(item.latest.d, (counts.get(item.latest.d) || 0) + 1);
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0].localeCompare(a[0]));
  const [date, count] = ranked[0];
  const coverage = count / eligible.length;
  if (coverage < threshold) {
    throw new Error(`DATE_COHERENCE_FAILED: coverage ${coverage.toFixed(4)} below ${threshold.toFixed(4)} (${JSON.stringify(Object.fromEntries(ranked))})`);
  }
  return { date, coverage, total: eligible.length, byDate: Object.fromEntries(ranked) };
}

