/** Explicit public HQ backup. EDB stays on the existing iFinD connection. */
export function publicSymbol(code, referenceDate = new Date().toISOString().slice(0, 10)) {
  const index = /^(\d{6})\.(SH|SZ)$/.exec(code);
  if (index) return { kind: "index", symbol: index[2].toLowerCase() + index[1] };
  const contract = /^([A-Z]+)(\d{3,4})\.(SHF|DCE|CZC|INE|GFE)$/.exec(code);
  if (!contract || contract[2] === "00") return null;
  const [, product, month, exchange] = contract;
  let fullMonth = month;
  if (exchange === "CZC" && month.length === 3) {
    const year = Number(referenceDate.slice(0, 4));
    const decade = Math.floor(year / 10) * 10;
    const candidates = [decade - 10, decade, decade + 10].map(base => base + Number(month[0]));
    const contractYear = candidates.sort((a, b) => Math.abs(a - year) - Math.abs(b - year))[0];
    fullMonth = String(contractYear).slice(-2) + month.slice(1);
  }
  return { kind: "future", symbol: product + fullMonth };
}

const number = value => value === null || value === undefined || value === "" ? null : Number.isFinite(Number(value)) ? Number(value) : null;

export function publicRows(payload, kind, symbol) {
  if (kind === "sina-index") {
    if (!Array.isArray(payload)) throw new Error("PUBLIC_HQ_SCHEMA: Sina index daily bars missing");
    return payload.map(row => ({ time: row.day?.slice(0, 10), close: number(row.close), volume: null, openInterest: null, source: "Sina", volumeBasis: "unmapped" }));
  }
  if (kind === "index") {
    if (payload.code !== 0 || !Array.isArray(payload.data?.[symbol]?.day)) throw new Error("PUBLIC_HQ_SCHEMA: Tencent daily bars missing");
    return payload.data[symbol].day.map(row => ({ time: row[0], close: number(row[2]), volume: null, openInterest: null, source: "Tencent", volumeBasis: "unmapped" }));
  }
  if (!Array.isArray(payload)) throw new Error("PUBLIC_HQ_SCHEMA: Sina daily bars missing");
  return payload.map(row => ({ time: row.d, close: number(row.c), volume: number(row.v), openInterest: number(row.p), source: "Sina", amount: null, changeRatio: null }));
}

export function checkPublicOverlap(rows, previous, code) {
  const old = new Map((previous || []).filter(row => row.v > 0).map(row => [row.d, row.v]));
  const overlap = rows.filter(row => row.close > 0 && old.has(row.time)).sort((a, b) => a.time.localeCompare(b.time)).slice(-3);
  if (overlap.length < 3) throw new Error(`PUBLIC_HQ_PARITY: ${code} needs three overlap observations`);
  for (const row of overlap) {
    // Public index feeds publish different decimal precision; compare at their common 0.01 point precision.
    const index = /^\d{6}\.(SH|SZ)$/.test(code);
    const fresh = index ? Math.round(row.close * 100) : row.close;
    const existing = index ? Math.round(old.get(row.time) * 100) : old.get(row.time);
    if (Math.abs(fresh - existing) > (index ? 0 : Math.max(0.000001, Math.abs(existing) * 0.000001))) {
      throw new Error(`PUBLIC_HQ_PARITY: ${code} close mismatch on ${row.time}`);
    }
  }
  return overlap.length;
}

export function withPublicHq(connection, observations, { preferIfind = false } = {}) {
  const cache = new Map();
  const provenance = new Map();
  const parityFailures = [];
  let quotaReserved = false;
  async function getBars(mapping) {
    const key = mapping.kind + ":" + mapping.symbol;
    if (!cache.has(key)) cache.set(key, (async () => {
      const url = mapping.kind === "index"
        ? `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${mapping.symbol},day,,,40,qfq`
        : `https://stock2.finance.sina.com.cn/futures/api/jsonp.php/var%20_data=/InnerFuturesNewService.getDailyKLine?symbol=${mapping.symbol}`;
      let response = await fetch(url, { headers: mapping.kind === "future" ? { Referer: "https://finance.sina.com.cn" } : {}, signal: AbortSignal.timeout(20000) });
      let kind = mapping.kind;
      if (!response.ok && kind === "index") {
        console.log(`Tencent ${mapping.symbol}: HTTP ${response.status}; using Sina index daily bars`);
        response = await fetch(`https://quotes.sina.cn/cn/api/jsonp_v2.php/var%20_data=/CN_MarketDataService.getKLineData?symbol=${mapping.symbol}&scale=240&ma=no&datalen=40`, { signal: AbortSignal.timeout(20000) });
        kind = "sina-index";
      }
      if (!response.ok) throw new Error(`PUBLIC_HQ_HTTP: ${mapping.symbol} HTTP ${response.status}`);
      const text = await response.text();
      let payload;
      if (kind === "index") payload = JSON.parse(text);
      else {
        const match = /var\s+_data\s*=\s*\(([\s\S]*)\);?\s*$/.exec(text);
        if (!match) throw new Error(`PUBLIC_HQ_SCHEMA: ${mapping.symbol} JSONP`);
        payload = JSON.parse(match[1]);
      }
      return publicRows(payload, kind, mapping.symbol);
    })());
    return cache.get(key);
  }
  return {
    listTools: (...args) => connection.listTools(...args),
    close: () => connection.close(),
    provenanceFor: code => provenance.get(code),
    assertHealthy() { if (parityFailures.length) throw new Error(`PUBLIC_HQ_PARITY: ${parityFailures.join(", ")}`); },
    async callTool(name, args) {
      if (name !== "THS_HQ") return connection.callTool(name, args);
      if (preferIfind && !quotaReserved) {
        try {
          const result = await connection.callTool(name, args);
          const payload = typeof result === "string" ? JSON.parse(result) : result;
          if (payload?.success === false || (payload?.errorcode !== undefined && Number(payload.errorcode) !== 0)) {
            const error = new Error("IFIND_HQ_UNAVAILABLE");
            error.code = payload?.code;
            throw error;
          }
          if (!Array.isArray(payload?.data) || !payload.data.length) throw new Error("IFIND_HQ_EMPTY");
          provenance.set(args.thscode, { provider: "iFinD", collectedAt: new Date().toISOString() });
          return payload;
        } catch (error) {
          quotaReserved ||= error.code === "QUOTA_RESERVED" || /QUOTA_RESERVED|预留水位/.test(String(error.message));
          console.log(`iFinD ${args.thscode}: ${quotaReserved ? "QUOTA_RESERVED" : "request unavailable"}; trying public HQ backup`);
        }
      }
      const mapping = publicSymbol(args.thscode, args.endtime);
      if (!mapping) {
        provenance.set(args.thscode, { provider: "iFinD", status: "CARRIED_IDENTITY", reason: "Public continuous contract has a different roll identity" });
        return { data: [], source: "public-backup", status: "CARRIED_IDENTITY" };
      }
      const rows = (await getBars(mapping)).filter(row => row.time >= args.begintime && row.time <= args.endtime);
      const prior = Object.values(observations.indicators || {}).find(item => mapping.kind === "index"
        ? item.field_code === args.thscode
        : item.mainContract?.toCode === args.thscode);
      // Existing contracts must match recent historical closes before extending them.
      let overlap = 0;
      if (prior) {
        try { overlap = checkPublicOverlap(rows, prior.series, args.thscode); }
        catch (error) { parityFailures.push(error.message); throw error; }
      }
      const provider = rows[0]?.source || (mapping.kind === "index" ? "Tencent" : "Sina");
      provenance.set(args.thscode, { provider, symbol: mapping.symbol, overlap, priceBasis: "daily_close", collectedAt: new Date().toISOString() });
      return { data: rows, source: provider };
    },
  };
}
