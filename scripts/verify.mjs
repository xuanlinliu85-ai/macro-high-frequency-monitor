/** Macro Cockpit V2 gates — read-only by default; --output writes a validation receipt. */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadMacroConfig, SKILL_DIR } from "./macro-config.mjs";
import { resolveTradingDataAsOf } from "./macro-date-semantics.mjs";
import { gitInfo, parseArgs, sha256File } from "./macro-automation-lib.mjs";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = path => readFileSync(resolve(root, path), "utf8");
const config = loadMacroConfig();
const args = parseArgs();
const results = [];
const assert = (value, message) => { if (!value) throw new Error(message); };
const gate = (id, name, run) => { try { results.push({ id, name, ok: true, detail: run() || "通过" }); } catch (error) { results.push({ id, name, ok: false, detail: error.message }); } };
const snapshot = existsSync(resolve(root, "public/macro-snapshot.json")) ? JSON.parse(read("public/macro-snapshot.json")) : null;
const walk = directory => readdirSync(resolve(root, directory), { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(`${directory}/${entry.name}`) : [`${directory}/${entry.name}`]);

gate("01", "配置真源可解析", () => {
  assert(SKILL_DIR.startsWith(root), `配置位于包外 ${SKILL_DIR}`);
  assert(config.indicators.length >= 60 && config.futuresIndicators.length >= 50, "注册表规模异常");
  assert(config.futuresSpreads.length > 0, "futures_chains.yaml 缺少 spreads");
  const futuresIds = new Set(config.futuresIndicators.map(item => item.id));
  const edges = config.futuresChains.flatMap(chain => {
    const members = new Set((chain.tiers || []).flatMap(tier => tier.members || []));
    return (chain.edges || []).map(edge => {
      assert(futuresIds.has(edge.source) && futuresIds.has(edge.target), `${chain.id} edge 引用未配置节点 ${edge.source} → ${edge.target}`);
      assert(members.has(edge.source) && members.has(edge.target), `${chain.id} edge 跨越本链成员 ${edge.source} → ${edge.target}`);
      assert(edge.source !== edge.target, `${chain.id} edge 自循环 ${edge.source}`);
      return edge;
    });
  });
  assert(edges.length > 0, "futures_chains.yaml 缺少显式 edges");
  assert(config.collectable.length === 69, `可采集宏观源指标应为 69，实际 ${config.collectable.length}`);
  return `${config.collectable.length} source indicators + ${config.derived.length} derived · ${config.futuresIndicators.length} futures · ${config.futuresSpreads.length} spreads · ${edges.length} edges`;
});
gate("02", "单向主契约与计算边界", () => {
  const collect = read("scripts/macro-collect.mjs"), snap = read("scripts/macro-snapshot.mjs"), workbench = read("scripts/macro-workbench.mjs");
  assert(!/zscore|percentileOf|chg1Extreme/.test(collect.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")), "collect 含信号计算");
  assert(!/connectIfind|callTool\(/.test(snap), "snapshot 含网络调用");
  assert(/macro-snapshot\.json/.test(workbench), "workbench 未消费主契约");
  assert(!existsSync(resolve(root, "public/macro-snapshot-v2.json")), "发现并行 snapshot contract");
  return "collect → snapshot → report → workbench";
});
gate("03", "Skill discovery 与知识文件", () => {
  const skill = read("SKILL.md");
  assert(/^---\r?\n/.test(skill) && /^name:\s*macro-high-frequency-monitor$/m.test(skill), "SKILL frontmatter 无效");
  for (const file of ["MANIFEST.md", "README.md", "package.json", "package-lock.json", "references/indicator_registry.yaml", "references/signal_rules.yaml", "references/futures_chains.yaml", "references/interpretation_framework.md"]) assert(existsSync(resolve(root, file)), `缺少 ${file}`);
  return "frontmatter 与核心知识文件齐备";
});
gate("04", "源码无机器路径与 secret", () => {
  const files = ["SKILL.md", "MANIFEST.md", "README.md", ...walk("references"), ...walk("scripts"), ...walk("templates"), ...walk("docs")];
  const bad = [];
  for (const file of files) {
    const text = read(file);
    if (/C:\\Users\\[A-Za-z0-9._-]+|\/Users\/[A-Za-z0-9._-]+|(?:api[_-]?key|token)\s*[:=]\s*["'][^"']{8,}/i.test(text)) bad.push(file);
  }
  assert(!bad.length, `路径/secret 泄漏：${bad.join(", ")}`);
  assert(!files.some(file => /(^|\/)\.env$/i.test(file)), "安装源码含 .env");
  return `${files.length} files scanned`;
});
gate("05", "非回归保护存在", () => {
  const collect = read("scripts/macro-collect.mjs"), main = read("scripts/macro-main-contract.mjs"), tpl = read("templates/macro/workbench.template.html");
  for (const pattern of [/row\.rtime/, /close === 0 \? null/, /mergeSeries/, /alwaysResolve/]) assert(pattern.test(collect), `collect 非回归缺失 ${pattern}`);
  for (const pattern of [/detectMainContract/, /rollAdjust/, /ratios\.sort[\s\S]*Math\.floor/]) assert(pattern.test(main), `主力合约非回归缺失 ${pattern}`);
  for (const pattern of [/RENDERERS/, /chartDiag/, /canvas\.width/, /try\{fn\(\)\}catch/, /ResizeObserver/, /IntersectionObserver/, /visibilitychange/]) assert(pattern.test(tpl), `canvas 恢复缺失 ${pattern}`);
  return "主力解析 / roll / zero / rtime / merge / canvas recovery";
});
gate("06", "Snapshot 1.1.0 结构", () => {
  if (!snapshot) return "SKIPPED — no generated snapshot";
  assert(snapshot.contract === "MACRO_SNAPSHOT" && snapshot.version === "1.1.0", "snapshot contract/version 错误");
  assert(snapshot.headline && snapshot.deviations && snapshot.aggregates && snapshot.futures?.varieties, "V2 结构块缺失");
  assert(Array.isArray(snapshot.futures?.graph?.nodes) && Array.isArray(snapshot.futures?.graph?.edges), "futures.graph 主契约缺失");
  assert(snapshot.dimensions.every(item => item.scoreAxis && item.semanticLabel && "delta" in item), "六维语义/delta 缺失");
  return `${snapshot.indicators.length} indicators · ${snapshot.futures.varieties.length} varieties`;
});
gate("07", "展示层只消费结构化信号", () => {
  const tpl = read("templates/macro/workbench.template.html");
  assert(!/chg1Extreme\s*[><=]|Math\.abs\([^)]*z1y[^)]*\)\s*[><=]/.test(tpl), "前端重做信号判定");
  assert(/x\.tags|item\.tags|\.tags\|\|/.test(tpl), "前端未展示 snapshot tags");
  assert(/F\.graph\|\|/.test(tpl) && /G\.edges\|\|/.test(tpl), "前端未读取 snapshot graph edges");
  assert(!/tiers\s*\[\s*ti\s*-\s*1\s*\]|slice\(\s*0\s*,\s*3\s*\)/.test(tpl), "前端仍在按相邻 tier 自动连边");
  return "frontend renders snapshot decisions and explicit graph edges";
});
gate("08", "Report 无第二套判定阈值", () => {
  const report = read("scripts/macro-report.mjs");
  assert(!/\bTHRESH\b|chg1Extreme\s*[><=]|Math\.abs\([^)]*(?:z1y|oiChg)/.test(report), "report 含生产判定");
  assert(!/snapshots|readdirSync|median\(|percentileOf|computeStats|function\s+std/i.test(report), "report 含结论级重算或历史读取");
  return "render-only";
});
gate("09", "Futures 无第二套品种统计", () => {
  const futures = read("scripts/macro-futures.mjs");
  assert(!/function\s+(?:std|percentileOf|pctChange)|z1y\s*=|chg1Extreme\s*=/.test(futures), "futures 含品种统计引擎");
  assert(/rawSpreadSeries/.test(futures), "futures 未生成 raw spread series");
  assert(/computeStats\(series, "daily"/.test(read("scripts/macro-snapshot.mjs")), "spread 未回到 snapshot 统计引擎");
  return "variety states in snapshot · chain aggregate only";
});
gate("10", "SKILL 治理纯净", () => {
  const skill = read("SKILL.md");
  assert(!/\b[M|S|L]\d{9}\b|THRESH|(?:z|pct|chg)\w*\s*(?:>=|<=|>|<)\s*\d/i.test(skill), "SKILL 复制 field code 或阈值");
  return "无字段代码与数值判定表";
});
gate("11", "frequency-native", () => {
  if (!snapshot) return "SKIPPED — no generated snapshot";
  const allowed = { daily: new Set(["1D", "5D", "20D"]), weekly: new Set(["WoW", "4W", "13W"]), monthly: new Set(["MoM", "YoY", "3M", "Unavailable"]), quarterly: new Set(["QoQ", "YoY", "Unavailable"]) };
  for (const item of snapshot.indicators) for (const change of item.changeView?.items || []) assert(allowed[item.frequency]?.has(change.label), `${item.id}/${item.frequency} 非法标签 ${change.label}`);
  for (const item of snapshot.indicators.filter(row => row.frequency === "monthly" && /同比/.test(row.name_cn))) {
    assert(!(item.changeView?.items || []).some(change => change.key === "yoy"), `${item.id} 生成同比的同比`);
  }
  for (const item of snapshot.indicators.filter(row => row.frequency === "quarterly" && /同比/.test(row.name_cn))) {
    assert(!(item.changeView?.items || []).some(change => change.key === "qoq"), `${item.id} 同比序列生成 QoQ`);
  }
  for (const anomaly of snapshot.anomalies || []) {
    if (["monthly", "quarterly"].includes(anomaly.frequency)) assert(!(anomaly.triggers || []).some(trigger => trigger.id === "FIVE_DAY_MOVE_EXTREME"), `${anomaly.id} 非日频触发 FIVE_DAY_MOVE_EXTREME`);
  }
  const report = read("scripts/macro-report.mjs"), tpl = read("templates/macro/workbench.template.html");
  assert(!/monthly[^\n]{0,80}(?:1日|5日|20日)|月频[^\n]{0,80}(?:1日|5日|20日)/i.test(report + tpl), "月频 UI 含日频标签");
  return "frequency + registry transforms + availability";
});
gate("12", "direction 完整", () => {
  const missing = [...config.indicators, ...config.futuresIndicators].filter(item => !(item.signal?.direction in config.directionSemantics));
  assert(!missing.length, `未登记 direction: ${missing.map(item => item.id).join(", ")}`);
  assert(!/POLARITY_FALLBACK/.test(read("scripts/macro-snapshot.mjs")), "生产代码仍有 POLARITY_FALLBACK");
  return `${Object.keys(config.directionSemantics).length} semantics complete`;
});
gate("13", "divergence schema 可执行且无 eval", () => {
  const supported = new Set(["opposite_majority", "opposite_mean"]);
  for (const rule of config.divergenceRules) {
    assert(supported.has(rule.evaluator), `${rule.id} evaluator 无效`);
    assert(["dirZ", "z1y"].includes(rule.value_field), `${rule.id} value_field 无效`);
    assert(rule.side_a?.members?.length && rule.side_b?.members?.length, `${rule.id} side 缺失`);
  }
  const source = [read("scripts/macro-snapshot.mjs"), read("scripts/macro-futures.mjs")].join("\n");
  assert(!/\beval\s*\(|new\s+Function/.test(source), "发现动态执行");
  return `${config.divergenceRules.length} structured evaluators`;
});
gate("14", "文档与 package 一致", () => {
  const pkg = JSON.parse(read("package.json"));
  const expected = ["collect", "snapshot", "report", "workbench", "handoff", "check-handoff", "parity", "publish-handoff", "run", "run:offline", "verify", "check-skill", "install-skill", "check-installed"];
  for (const command of expected) assert(pkg.scripts[command], `缺 npm script ${command}`);
  const docs = [read("README.md"), read("MANIFEST.md"), read("SKILL.md")].join("\n");
  for (const stale of ["app/monitor/macro", "contracts/", "db/schema", "drizzle/", "macro:test", "macro:install-skill"]) assert(!docs.includes(stale), `文档残留 ${stale}`);
  assert(!/\b72\s*项宏观指标/.test(docs), "文档指标数量仍为 72");
  assert(/69\s*项宏观指标/.test(read("README.md")), "README 未声明实际 69 项宏观指标");
  assert(!/weight_source|CN_USDCNY/.test(read("references/indicator_registry.yaml")), "registry 存在重复权重 metadata 或外需汇率 ID 漂移");
  return `${expected.length} commands aligned · 69 indicators documented`;
});
gate("15", "单前端 / 单图表库", () => {
  assert(walk("templates").filter(file => /workbench.*\.html$/i.test(file)).length === 1, "workbench template 数量不是 1");
  const source = ["macro-config.mjs", "macro-collect.mjs", "macro-main-contract.mjs", "macro-snapshot.mjs", "macro-futures.mjs", "macro-report.mjs", "macro-workbench.mjs"]
    .map(file => read(`scripts/${file}`)).join("\n") + read("templates/macro/workbench.template.html");
  assert(!/(?:from\s+["'](?:react|vue|svelte|d3)|ReactDOM|Vue\.createApp|<script[^>]+(?:plotly|chart\.js|d3\.js))/i.test(source), "发现第二前端/图表库");
  assert(/echarts/.test(source), "ECharts 缺失");
  return "one template · ECharts only";
});
gate("16", "Macro Cockpit 关键区", () => {
  const tpl = read("templates/macro/workbench.template.html");
  for (const id of ["topBar", "dimensionCards", "extremeScatter", "divergenceGrid", "crossAsset", "fundamentals", "supplyChain", "drillDown"]) assert(new RegExp(`id=["']${id}["']`).test(tpl), `缺 cockpit 区 ${id}`);
  assert(!/function\s+top\s*\(/.test(tpl), "workbench 使用了浏览器保留的全局 top 标识符");
  assert(/function\s+renderTop\s*\(/.test(tpl) && /renderTop\(\);dimensionCards\(\)/.test(tpl), "顶部渲染入口缺失或未调用");
  return "top / six dimensions / scatter / divergence / cross-asset / chain / drill-down · safe renderTop";
});
gate("17", "安装包完整性", () => {
  const installer = read("scripts/macro-install-skill.mjs");
  for (const rootName of ["references", "scripts", "templates", "docs", "public/vendor"]) assert(installer.includes(`"${rootName}"`) || installer.includes(`'${rootName}'`), `installer 未递归包含 ${rootName}`);
  assert(/package\.json/.test(installer) && /package-lock\.json/.test(installer), "installer 缺 package manifest/lockfile");
  assert(/\.gitignore/.test(installer), "installer 缺运行产物隔离规则");
  assert(/"ci",\s*"--omit=dev"/.test(installer), "installer 未使用 npm ci --omit=dev");
  assert(/runtimeImportSmoke\(staging\)/.test(installer) && /runtimeImportSmoke\(target\)/.test(installer), "staging/正式安装缺 runtime import smoke");
  assert(!/\.filter\([^\n]*existsSync/.test(installer), "install plan 先过滤缺失文件");
  for (const file of ["scripts/run-daily.ps1", "scripts/install-windows-task.ps1", "scripts/uninstall-windows-task.ps1", "scripts/macro-ai-handoff.mjs", "scripts/macro-check-handoff.mjs", "scripts/macro-parity-check.mjs"]) assert(existsSync(resolve(root, file)), `自动运行文件缺失 ${file}`);
  const runner = read("scripts/run-daily.ps1");
  for (const command of ["collect", "snapshot", "report", "workbench", "handoff", "check-handoff"]) assert(runner.includes(`\"${command}\"`), `runner 缺步骤 ${command}`);
  assert(/ExpectedCommit/.test(runner) && /sourceDirty/.test(runner), "runner 缺 canonical source gate");
  assert(/LEGACY_INSECURE_UPSTREAM/.test(runner) && /AllowLegacyInsecureUpstream/.test(runner), "runner 缺 legacy 二次授权");
  assert(/IFIND_ALLOW_INSECURE_HTTP/.test(runner), "runner 未把显式 legacy 授权传递给外部 capability policy");
  assert(/nodeDirectory[\s\S]*env:PATH/.test(runner), "runner 未固定 Task Scheduler 子进程 Node PATH");
  return "required roots · lockfile · runtime smoke · canonical Windows runner";
});
gate("18", "源码与动态数据隔离", () => {
  const trackedLike = ["SKILL.md", "MANIFEST.md", "README.md", "package.json", ...walk("references"), ...walk("scripts"), ...walk("templates"), ...walk("docs"), ...walk("public/vendor")];
  assert(!trackedLike.some(file => /(^|\/)work\//.test(file)), "源码进入 work/");
  assert(!trackedLike.some(file => /macro-(?:snapshot|daily-report|workbench)\.(?:json|md|html)$/.test(file)), "动态产物进入默认安装源");
  const ignore = read(".gitignore");
  assert(/^work\/$/m.test(ignore) && /^dist\/$/m.test(ignore), "runner log 或 AI handoff 未隔离出源码");
  return `${trackedLike.length} distributable source files`;
});

gate("19", "iFinD endpoint 与凭据传输", () => {
  const client = read("scripts/ifind-mcp-client.mjs");
  const local = read("scripts/ifind-local-provider.mjs");
  assert(!/DEFAULT_BASE_URL|219\.141\.246\.230|searchParams\.set\([^\n]*api_key/i.test(client), "客户端仍含公网 HTTP 默认值或 query api_key");
  assert(/IFIND_MCP_BASE_URL/.test(client) && /Authorization/.test(client), "客户端缺显式 endpoint 或 Authorization header");
  assert(/IFIND_MCP_ALLOW_INSECURE_HTTP/.test(client), "可信内网/VPN HTTP 缺显式授权开关");
  assert(!/IFIND_PROVIDER\s*\|\|\s*["'](?:local|https-mcp)["']/.test(client), "IFIND_PROVIDER 仍存在隐式默认值");
  assert(/缺少 IFIND_PROVIDER/.test(client) && /local 或 https-mcp/.test(client), "IFIND_PROVIDER 未执行显式配置 gate");
  assert(/IFIND_ALLOW_LEGACY_INSECURE_UPSTREAM/.test(client) && /LEGACY_INSECURE_UPSTREAM/.test(client), "local provider 缺少 legacy upstream 二次授权 gate");
  assert(/provider === ["']https-mcp["']/.test(client), "https-mcp provider 路径缺失");
  assert(/IFIND_LOCAL_HOME/.test(local) && /scripts["'],\s*["']ifind-mcp-client\.mjs/.test(local), "local provider 未从可移植根目录定位既有 client");
  assert(!/@modelcontextprotocol|THS_EDB|THS_HQ|THS_RQ|219\.141\.246\.230|api_key/i.test(local), "local provider 复制了 MCP/THS/credential 实现");
  assert(!/219\.141\.246\.230|searchParams\.set\([^\n]*api_key/i.test(`${client}\n${local}`), "provider 源码出现旧公网 IP 或 query api_key 实现");
  return "fail closed · explicit legacy authorization · optional HTTPS MCP · thin local adapter";
});

gate("20", "release-aware freshness", () => {
  const registry = read("references/indicator_registry.yaml"), snap = read("scripts/macro-snapshot.mjs");
  assert(/window_start_calendar_days_after_period_end/.test(registry), "registry 未声明 indicator release metadata 结构");
  assert(/statusFor\([^\n]*meta\.release/.test(snap) && /releaseWindow/.test(snap), "snapshot 未优先执行 indicator release window");
  return "indicator release window first · frequency calendar-day fallback";
});

gate("21", "交易数据日与运行日分离", () => {
  const fixture = Array.from({ length: 35 }, (_, index) => ({ id: `D${index}`, refreshedThisRun: true,
    quality: "OK", status: "FRESH", latest: { d: "2026-09-18" } }));
  const resolved = resolveTradingDataAsOf(fixture, config.dateCoherence.minimum_coverage);
  assert(resolved.date === "2026-09-18" && resolved.total === 35 && resolved.coverage === 1, "周末 fixture 未解析为 2026-09-18 / 35/35");
  const snap = read("scripts/macro-snapshot.mjs"), report = read("scripts/macro-report.mjs"), handoff = read("scripts/macro-automation-lib.mjs");
  assert(/const RUN_DATE = observations\.window\.end/.test(snap), "snapshot 缺 runDate 真源");
  assert(/asOf: TRADING_DATA_AS_OF/.test(snap) && /`\$\{TRADING_DATA_AS_OF\}\.json`/.test(snap), "snapshot asOf 或历史文件名未使用交易数据日");
  assert(/tradingDataAsOf \|\| S\.asOf/.test(report) && /`\$\{S\.asOf\}\.md`/.test(report), "report 未使用交易数据日");
  assert(/tradingDataAsOf: snapshot\.tradingDataAsOf \|\| snapshot\.asOf/.test(handoff), "handoff 未传递交易数据日");
  return "weekend fixture 2026-09-20 → trading data 2026-09-18 · 35/35";
});

gate("22", "日期一致性 fail closed", () => {
  const fixture = [
    ...Array.from({ length: 18 }, (_, index) => ({ id: `A${index}`, refreshedThisRun: true, quality: "OK", status: "FRESH", latest: { d: "2026-09-18" } })),
    ...Array.from({ length: 17 }, (_, index) => ({ id: `B${index}`, refreshedThisRun: true, quality: "OK", status: "FRESH", latest: { d: "2026-09-17" } })),
  ];
  let rejected = false;
  try { resolveTradingDataAsOf(fixture, config.dateCoherence.minimum_coverage); } catch (error) { rejected = /DATE_COHERENCE_FAILED/.test(error.message); }
  assert(rejected, "18/17 分裂日期 fixture 未被拒绝");
  assert(/date coherence/.test(read("scripts/macro-check-handoff.mjs")), "handoff/publish 缺日期一致性 gate");
  return `minimum coverage ${config.dateCoherence.minimum_coverage} · split fixture rejected`;
});

gate("23", "国内原油映射与身份", () => {
  const macro = config.indicators.find(item => item.id === "HF_CRUDE");
  const future = config.futuresIndicators.find(item => item.id === "FUT_SC");
  assert(future?.linked_macro_id === "HF_CRUDE", `FUT_SC linked_macro_id=${future?.linked_macro_id}`);
  assert(macro?.series_role === "macro_continuous" && future?.series_role === "resolved_main_contract", "国内原油 series_role 不完整");
  assert(macro?.name_cn !== future?.name_cn && /连续/.test(macro?.name_cn) && /实际主力合约/.test(future?.name_cn), "国内原油展示名未明确区分口径");
  for (const item of [macro, future]) assert(item?.instrument_identity?.exchange === "INE" && item?.instrument_identity?.root_symbol === "SC", `${item?.id} instrument_identity 缺失`);
  return `${macro.name_cn} ↔ ${future.name_cn} · linked HF_CRUDE`;
});

gate("24", "共享字段双身份显式治理", () => {
  const groups = new Map();
  for (const item of [...config.indicators, ...config.futuresIndicators]) {
    if (!item.ifind?.tool || !item.ifind?.field_code) continue;
    const key = `${item.ifind.tool}|${item.ifind.field_code}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  const shared = [...groups.entries()].filter(([, members]) => members.length > 1 && members.some(item => item.layer === "futures") && members.some(item => item.layer !== "futures"));
  for (const [key, members] of shared) {
    assert(members.every(item => item.series_role), `${key} 缺 series_role: ${members.filter(item => !item.series_role).map(item => item.id).join(", ")}`);
    assert(new Set(members.map(item => item.name_cn)).size === members.length, `${key} 存在同名身份`);
  }
  assert(/sharedSourceIdentities/.test(read("scripts/macro-snapshot.mjs")), "snapshot validation report 未列出共享字段身份");
  return `${shared.length} shared HQ fields · roles/names explicit`;
});

gate("25", "Brent 连续合约口径", () => {
  const brent = config.indicators.find(item => item.id === "HF_BRENT");
  const identity = brent?.market_identity || {};
  for (const key of ["vendor", "exchange", "price_basis", "field_code"]) assert(identity[key], `HF_BRENT market_identity.${key} 缺失`);
  assert(identity.price_basis === "continuous" && /连续/.test(brent.name_cn) && /iFinD/i.test(brent.name_cn), "HF_BRENT 展示名或连续口径错误");
  assert(identity.field_code === brent.ifind.field_code, "HF_BRENT metadata field_code 漂移");
  return `${brent.name_cn} · ${identity.exchange}/${identity.price_basis}`;
});

gate("26", "生产单链发布闭环", () => {
  const runner = read("scripts/run-daily.ps1"), publisher = read("scripts/macro-publish-handoff.mjs"), installer = read("scripts/install-windows-task.ps1");
  const ordered = ["collect", "snapshot", "report", "workbench", "handoff", "check-handoff", "verify"];
  let cursor = -1;
  for (const command of ordered) { const next = runner.indexOf(`\"${command}\"`, cursor + 1); assert(next > cursor, `runner 步骤顺序缺失 ${command}`); cursor = next; }
  for (const name of ["AI_HANDOFF_META.json", "ai-handoff-latest.json", "macro-daily-report.md", "macro-snapshot.json", "macro-workbench.html"]) assert(publisher.includes(name), `publisher 缺 ${name}`);
  assert(/history["'],\s*snapshot\.tradingDataAsOf/.test(publisher), "publisher 缺 tradingDataAsOf history");
  for (const field of ["tradingDataAsOf", "runDate", "dateQuality", "sourceCommit", "sourceDirty", "snapshotSha256", "handoffSha256", "reportSha256", "validationStatus", "remotePublishCommit"]) assert(publisher.includes(field), `AI_HANDOFF_META 缺 ${field}`);
  assert(/\[30, 60, 120, 240, 480\]/.test(publisher), "GitHub push 退避序列缺失");
  assert(/retry-pending-only/.test(runner) && /PENDING_PUBLISH_EXISTS/.test(publisher), "runner 缺 pending-first 保护");
  assert(/Production runner requires main/.test(runner), "runner 未固定 main");
  assert(/PublishHandoff/.test(installer) && /AiRuntimeDir/.test(installer), "Task Scheduler 未固定 ai-runtime 发布");
  return "main-only runner · 5 artifacts + history · validation receipts · pending-first · push backoff";
});

console.log("Macro Cockpit V2 · Verification");
console.log("=".repeat(92));
for (const result of results) console.log(`${result.ok ? "PASS" : "FAIL"} ${result.id} ${result.name}\n     ${result.detail}`);
console.log("=".repeat(92));
const passed = results.filter(item => item.ok).length;
console.log(`结果：${passed}/${results.length} 通过`);
const verifyResult = { contract: "MACRO_VERIFY_RESULT", version: "1.0.0", generatedAt: new Date().toISOString(),
  status: passed === results.length ? "PASS" : "FAIL", passed, total: results.length,
  snapshotSha256: snapshot ? sha256File(resolve(root, "public/macro-snapshot.json")) : null, checks: results };
if (args.output) {
  const info = gitInfo();
  verifyResult.sourceCommit = info.sourceCommit;
  verifyResult.sourceDirty = info.sourceDirty;
  const output = resolve(root, String(args.output));
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(verifyResult, null, 2)}\n`, "utf8");
}
if (verifyResult.status !== "PASS") process.exitCode = 1;
