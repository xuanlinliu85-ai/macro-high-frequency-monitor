/** Optional thin publisher for a pre-existing ai-runtime git worktree. */
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, join, resolve } from "node:path";
import { gitInfo, parseArgs, readJson, ROOT, sha256File } from "./macro-automation-lib.mjs";
const args = parseArgs();
const targetText = String(args.target || process.env.AI_RUNTIME_DIR || "").trim();
const expectedBranch = String(args.branch || process.env.AI_RUNTIME_BRANCH || "ai-runtime");
if (!targetText) throw new Error("缺少 AI_RUNTIME_DIR");
const target = resolve(targetText);
if (!existsSync(join(target, ".git"))) throw new Error("AI_RUNTIME_DIR 必须指向已存在的 ai-runtime git worktree");
const handoffPath = resolve(ROOT, "dist/ai-handoff-latest.json"), reportPath = resolve(ROOT, "public/macro-daily-report.md");
for (const path of [handoffPath, reportPath]) if (!existsSync(path)) throw new Error(`发布文件缺失：${path}`);
execFileSync(process.execPath, [resolve(ROOT, "scripts/macro-check-handoff.mjs")], { cwd: ROOT, stdio: "inherit" });
const safe = target.replaceAll("\\", "/");
const git = (gitArgs, options = {}) => {
  const output = execFileSync("git", ["-c", `safe.directory=${safe}`, "-C", target, ...gitArgs], { encoding: "utf8", ...options });
  return typeof output === "string" ? output.trim() : "";
};
const branch = git(["branch", "--show-current"]);
if (branch !== expectedBranch) throw new Error(`ai-runtime 分支错误：需要 ${expectedBranch}，实际 ${branch}`);
const info = gitInfo();
if (info.sourceDirty) throw new Error("源仓库 tracked sourceDirty=true，停止发布");
const outputDir = target;
mkdirSync(outputDir, { recursive: true });
copyFileSync(handoffPath, join(outputDir, basename(handoffPath)));
copyFileSync(reportPath, join(outputDir, basename(reportPath)));
const handoff = readJson(handoffPath);
const meta = { contract: "AI_HANDOFF_META", version: "1.0.0", generatedAt: new Date().toISOString(), asOf: handoff.asOf,
  sourceSnapshotContract: handoff.source.contract, sourceSnapshotVersion: handoff.source.version,
  sourceCodeCommit: info.sourceCommit, sourceDirty: false,
  files: [handoffPath, reportPath].map(path => ({ name: basename(path), sha256: sha256File(path) })) };
writeFileSync(join(outputDir, "AI_HANDOFF_META.json"), `${JSON.stringify(meta, null, 2)}\n`, "utf8");
git(["add", "--", "ai-handoff-latest.json", "macro-daily-report.md", "AI_HANDOFF_META.json"]);
if (!git(["status", "--porcelain"])) { console.log("ai-runtime 已是最新状态；无需提交。"); process.exit(0); }
git(["commit", "-m", `chore: publish macro handoff ${handoff.asOf}`], { stdio: "inherit" });
git(["push", "origin", expectedBranch], { stdio: "inherit" });
console.log(`published: ${target} (${expectedBranch})`);
