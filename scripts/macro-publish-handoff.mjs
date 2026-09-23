/** Publish validated runtime artifacts to the existing ai-runtime worktree. */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { gitInfo, parseArgs, readJson, ROOT, sha256File } from "./macro-automation-lib.mjs";

const args = parseArgs();
const targetText = String(args.target || process.env.AI_RUNTIME_DIR || "").trim();
const expectedBranch = String(args.branch || process.env.AI_RUNTIME_BRANCH || "ai-runtime");
const retryPendingOnly = args["retry-pending-only"] === true;
const retryDelaysSeconds = [30, 60, 120, 240, 480];
if (!targetText) throw new Error("缺少 AI_RUNTIME_DIR");
const target = resolve(targetText);
if (!existsSync(join(target, ".git"))) throw new Error("AI_RUNTIME_DIR 必须指向已存在的 ai-runtime git worktree");

const safe = target.replaceAll("\\", "/");
const git = (gitArgs, options = {}) => {
  const output = execFileSync("git", ["-c", `safe.directory=${safe}`, "-C", target, ...gitArgs], { encoding: "utf8", ...options });
  return typeof output === "string" ? output.trim() : "";
};
const sanitize = value => String(value || "")
  .replace(/(Bearer\s+)[A-Za-z0-9._~-]+/gi, "$1[REDACTED]")
  .replace(/([?&](?:api_key|token|access_token|key)=)[^&\s]+/gi, "$1[REDACTED]");
const sleep = seconds => new Promise(resolveWait => setTimeout(resolveWait, seconds * 1000));
const remoteRef = `refs/heads/${expectedBranch}`;

function assertTarget() {
  const branch = git(["branch", "--show-current"]);
  if (branch !== expectedBranch) throw new Error(`ai-runtime 分支错误：需要 ${expectedBranch}，实际 ${branch}`);
  const dirty = git(["status", "--porcelain"]);
  if (dirty) throw new Error("ai-runtime worktree 存在未提交内容，保留现场并停止发布");
}
function aheadCount() {
  return Number(git(["rev-list", "--count", `origin/${expectedBranch}..HEAD`])) || 0;
}
async function pushWithRetry() {
  const waits = [0, ...retryDelaysSeconds];
  let lastError = "";
  for (let attempt = 0; attempt < waits.length; attempt += 1) {
    if (waits[attempt] > 0) {
      console.log(`push retry in ${waits[attempt]}s (${attempt}/${retryDelaysSeconds.length})`);
      await sleep(waits[attempt]);
    }
    const pushed = spawnSync("git", ["-c", `safe.directory=${safe}`, "-C", target, "push", "origin", expectedBranch], { encoding: "utf8", timeout: 60000 });
    const pushText = sanitize(`${pushed.stdout || ""}\n${pushed.stderr || ""}`).trim();
    if (pushText) console.log(pushText);
    if (pushed.status !== 0) { lastError = pushText || `git push exit ${pushed.status}`; continue; }
    const probed = spawnSync("git", ["-c", `safe.directory=${safe}`, "-C", target, "ls-remote", "--heads", "origin", remoteRef], { encoding: "utf8", timeout: 30000 });
    const remoteSha = String(probed.stdout || "").trim().split(/\s+/)[0] || "";
    const localSha = git(["rev-parse", "HEAD"]);
    if (probed.status === 0 && remoteSha === localSha) return localSha;
    lastError = sanitize(probed.stderr || `remote ref mismatch: local=${localSha} remote=${remoteSha || "missing"}`);
  }
  throw new Error(`PUBLISH_PUSH_FAILED: ${lastError}`);
}
function readMeta() {
  const path = join(target, "AI_HANDOFF_META.json");
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
}
function assertPendingComplete() {
  const meta = readMeta();
  if (meta.contract !== "AI_HANDOFF_META" || !Array.isArray(meta.files)) throw new Error("PENDING_PUBLISH_INCOMPLETE: metadata 缺失");
  if (meta.version === "2.0.0") {
    const expected = ["ai-handoff-latest.json", "macro-daily-report.md", "macro-snapshot.json", "macro-workbench.html"];
    if (meta.validationStatus !== "PASS" || !/^\d{4}-\d{2}-\d{2}$/.test(meta.tradingDataAsOf) || expected.some(name => !meta.files.some(file => file.name === name))) throw new Error("PENDING_PUBLISH_INCOMPLETE: 五文件清单或验收状态无效");
    const artifactCommit = git(["rev-parse", "HEAD^"]);
    if (meta.remotePublishCommit !== artifactCommit) throw new Error("PENDING_PUBLISH_INCOMPLETE: artifact commit 不一致");
    const historyMeta = join(target, "history", meta.tradingDataAsOf, "AI_HANDOFF_META.json");
    if (!existsSync(historyMeta) || sha256File(historyMeta) !== sha256File(join(target, "AI_HANDOFF_META.json"))) throw new Error("PENDING_PUBLISH_INCOMPLETE: history metadata 不一致");
    for (const file of meta.files) {
      const rootFile = join(target, file.name), historyFile = join(target, "history", meta.tradingDataAsOf, file.name);
      if (!existsSync(rootFile) || !existsSync(historyFile) || sha256File(rootFile) !== file.sha256 || sha256File(historyFile) !== file.sha256) throw new Error(`PENDING_PUBLISH_INCOMPLETE: ${file.name} SHA 无效`);
    }
  } else if (meta.version === "1.0.0") {
    for (const file of meta.files) if (!existsSync(join(target, file.name)) || sha256File(join(target, file.name)) !== file.sha256) throw new Error(`PENDING_PUBLISH_INCOMPLETE: legacy ${file.name} SHA 无效`);
  } else throw new Error(`PENDING_PUBLISH_INCOMPLETE: 未知 metadata version ${meta.version}`);
  return meta;
}
function printPublished(meta, remoteCommit) {
  console.log("MACRO DAILY PUBLISHED");
  console.log(`tradingDataAsOf: ${meta.tradingDataAsOf}`);
  console.log(`coverage: ${meta.dateQuality?.coverage}`);
  console.log(`verify: ${meta.validation?.verify?.status || "UNKNOWN"}${Number.isFinite(meta.validation?.verify?.passed) ? ` ${meta.validation.verify.passed}/${meta.validation.verify.total}` : ""}`);
  console.log(`handoff: ${meta.validation?.handoff?.status || "UNKNOWN"}${Number.isFinite(meta.validation?.handoff?.passed) ? ` ${meta.validation.handoff.passed}/${meta.validation.handoff.total}` : ""}`);
  console.log(`remote branch: ${expectedBranch}`);
  console.log(`remote commit: ${remoteCommit}`);
}

assertTarget();
if (retryPendingOnly) {
  const pending = aheadCount();
  if (!pending) { console.log("PENDING_PUBLISH=NONE"); process.exit(0); }
  const pendingMeta = assertPendingComplete();
  console.log(`PENDING_PUBLISH=${pending}`);
  const remoteCommit = await pushWithRetry();
  if (pendingMeta.version === "2.0.0") printPublished(pendingMeta, remoteCommit);
  else console.log(`LEGACY_PENDING_PUBLISHED remote branch: ${expectedBranch} remote commit: ${remoteCommit}`);
  process.exit(0);
}

if (aheadCount() > 0) throw new Error("PENDING_PUBLISH_EXISTS: 先执行 --retry-pending-only，当前产物保持不变");
const sourceInfo = gitInfo();
if (sourceInfo.sourceDirty) throw new Error("源仓库 tracked sourceDirty=true，停止发布");
const paths = {
  snapshot: resolve(ROOT, "public/macro-snapshot.json"), handoff: resolve(ROOT, "dist/ai-handoff-latest.json"),
  report: resolve(ROOT, "public/macro-daily-report.md"), workbench: resolve(ROOT, "public/macro-workbench.html"),
  reportJson: resolve(ROOT, "work/macro/report.json"),
  handoffValidation: resolve(ROOT, "work/macro/handoff-check-result.json"), verifyValidation: resolve(ROOT, "work/macro/verify-result.json"),
};
for (const [name, path] of Object.entries(paths)) if (!existsSync(path)) throw new Error(`发布文件缺失 ${name}: ${path}`);
const snapshot = readJson(paths.snapshot), handoff = readJson(paths.handoff), report = readJson(paths.reportJson);
const handoffValidation = readJson(paths.handoffValidation), verifyValidation = readJson(paths.verifyValidation);
if (snapshot.contract !== "MACRO_SNAPSHOT" || snapshot.version !== "1.1.0") throw new Error("snapshot contract/version 无效");
if (handoff.contract !== "AI_MACRO_HANDOFF" || handoff.version !== "1.0.0") throw new Error("handoff contract/version 无效");
if (handoff.tradingDataAsOf !== snapshot.tradingDataAsOf || handoff.asOf !== snapshot.asOf) throw new Error("snapshot/handoff tradingDataAsOf 不一致");
if (report.tradingDataAsOf !== snapshot.tradingDataAsOf) throw new Error("report tradingDataAsOf 不一致");
const workbenchHtml = readFileSync(paths.workbench, "utf8");
if (!workbenchHtml.includes(`\"tradingDataAsOf\":\"${snapshot.tradingDataAsOf}\"`) || !workbenchHtml.includes("MACRO_SNAPSHOT")) throw new Error("workbench 未内嵌当前 snapshot");
if (!(Number(snapshot.dateQuality?.coverage) >= Number(snapshot.dateQuality?.minimumCoverage))) throw new Error("dateQuality.coverage 低于配置阈值");
if (handoff.source?.sourceCommit !== sourceInfo.sourceCommit || handoff.source?.sourceDirty !== false) throw new Error("handoff source lineage 无效");
if (handoff.source?.sha256 !== sha256File(paths.snapshot)) throw new Error("handoff snapshot sha256 无效");
if (handoffValidation.status !== "PASS" || handoffValidation.sourceCommit !== sourceInfo.sourceCommit || handoffValidation.snapshotSha256 !== sha256File(paths.snapshot) || handoffValidation.handoffSha256 !== sha256File(paths.handoff)) throw new Error("handoff validation receipt 无效");
if (verifyValidation.status !== "PASS" || verifyValidation.sourceCommit !== sourceInfo.sourceCommit || verifyValidation.sourceDirty !== false || verifyValidation.snapshotSha256 !== sha256File(paths.snapshot)) throw new Error("verify validation receipt 无效");

const historyDir = join(target, "history", snapshot.tradingDataAsOf);
mkdirSync(historyDir, { recursive: true });
const published = [
  { key: "handoff", source: paths.handoff, name: "ai-handoff-latest.json" },
  { key: "report", source: paths.report, name: "macro-daily-report.md" },
  { key: "snapshot", source: paths.snapshot, name: "macro-snapshot.json" },
  { key: "workbench", source: paths.workbench, name: "macro-workbench.html" },
];
for (const file of published) {
  copyFileSync(file.source, join(target, file.name));
  copyFileSync(file.source, join(historyDir, file.name));
}
const artifactPaths = published.flatMap(file => [file.name, `history/${snapshot.tradingDataAsOf}/${file.name}`]);
git(["add", "--", ...artifactPaths]);
if (!git(["status", "--porcelain"])) throw new Error("本次产物与 ai-runtime 完全一致，无需创建发布提交");
git(["commit", "-m", `chore: stage macro runtime ${snapshot.tradingDataAsOf}`], { stdio: "inherit" });
const artifactCommit = git(["rev-parse", "HEAD"]);
const hashes = Object.fromEntries(published.map(file => [file.key, sha256File(file.source)]));
const meta = {
  contract: "AI_HANDOFF_META", version: "2.0.0", generatedAt: new Date().toISOString(),
  tradingDataAsOf: snapshot.tradingDataAsOf, runDate: snapshot.runDate, dateQuality: snapshot.dateQuality,
  sourceCommit: sourceInfo.sourceCommit, sourceDirty: false,
  snapshotSha256: hashes.snapshot, handoffSha256: hashes.handoff, reportSha256: hashes.report, workbenchSha256: hashes.workbench,
  validationStatus: "PASS",
  validation: {
    handoff: { status: handoffValidation.status, passed: handoffValidation.passed, total: handoffValidation.total, generatedAt: handoffValidation.generatedAt },
    verify: { status: verifyValidation.status, passed: verifyValidation.passed, total: verifyValidation.total, generatedAt: verifyValidation.generatedAt },
  },
  remoteBranch: expectedBranch, remotePublishCommit: artifactCommit, historyPath: `history/${snapshot.tradingDataAsOf}`,
  files: published.map(file => ({ name: file.name, sha256: hashes[file.key] })),
};
for (const path of [join(target, "AI_HANDOFF_META.json"), join(historyDir, "AI_HANDOFF_META.json")]) writeFileSync(path, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
git(["add", "--", "AI_HANDOFF_META.json", `history/${snapshot.tradingDataAsOf}/AI_HANDOFF_META.json`]);
git(["commit", "-m", `chore: publish macro runtime ${snapshot.tradingDataAsOf}`], { stdio: "inherit" });
assertPendingComplete();
const remoteCommit = await pushWithRetry();
printPublished(meta, remoteCommit);
