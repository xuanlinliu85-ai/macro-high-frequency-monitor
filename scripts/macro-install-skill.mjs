/** Safe staging installer for macro-high-frequency-monitor. */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = name => args.includes(`--${name}`);
const value = name => { const index = args.indexOf(`--${name}`); return index >= 0 ? args[index + 1] : null; };
const checkOnly = flag("check");
const checkInstalled = flag("check-installed");
const withData = flag("with-data");
const codexRoot = join(homedir(), ".codex");
const target = resolve(value("target") || join(codexRoot, "skills", "macro-high-frequency-monitor"));
const requiredFiles = ["SKILL.md", "MANIFEST.md", "README.md", "package.json"];
const requiredRoots = ["references", "scripts", "templates", "docs", "public/vendor"];
const optionalRoots = ["examples"];
const dataFiles = ["public/macro-snapshot.json", "public/macro-daily-report.md"];

function enumerate(directory) {
  const absolute = resolve(root, directory);
  if (!existsSync(absolute) || !statSync(absolute).isDirectory()) throw new Error(`安装根目录缺失：${directory}`);
  return readdirSync(absolute, { withFileTypes: true }).flatMap(entry => {
    const rel = `${directory}/${entry.name}`;
    return entry.isDirectory() ? enumerate(rel) : [rel];
  });
}
function sourcePlan(includeData = withData) {
  for (const file of requiredFiles) if (!existsSync(resolve(root, file))) throw new Error(`安装文件缺失：${file}`);
  const files = [...requiredFiles, ...requiredRoots.flatMap(enumerate)];
  for (const directory of optionalRoots) if (existsSync(resolve(root, directory))) files.push(...enumerate(directory));
  if (includeData) {
    for (const file of dataFiles) if (!existsSync(resolve(root, file))) throw new Error(`--with-data 要求 ${file}`);
    files.push(...dataFiles);
  }
  return [...new Set(files)].sort();
}
function sha(path) { return createHash("sha256").update(readFileSync(path)).digest("hex"); }
function copyPlan(plan, destination) {
  for (const rel of plan) {
    const output = resolve(destination, rel);
    mkdirSync(dirname(output), { recursive: true });
    copyFileSync(resolve(root, rel), output);
  }
}
function gitInfo() {
  try {
    return { sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
      sourceDirty: execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim().length > 0 };
  } catch { return { sourceCommit: null, sourceDirty: null }; }
}
function manifest(plan) {
  const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  return { name: "macro-high-frequency-monitor", installedAt: new Date().toISOString(), packageVersion: pkg.version,
    snapshotContract: "MACRO_SNAPSHOT", snapshotContractVersion: "1.1.0",
    sourceRepo: "xuanlinliu85-ai/macro-high-frequency-monitor", ...gitInfo(), withData,
    files: plan.map(path => ({ path, sha256: sha(resolve(root, path)) })) };
}
function compareInstalled(destination, installedManifest) {
  const failures = [];
  for (const item of installedManifest.files || []) {
    const path = resolve(destination, item.path);
    if (!existsSync(path)) failures.push(`missing ${item.path}`);
    else if (sha(path) !== item.sha256) failures.push(`sha256 ${item.path}`);
  }
  const planned = new Set((installedManifest.files || []).map(item => item.path.replaceAll("\\", "/")));
  for (const directory of requiredRoots) {
    const absolute = resolve(destination, directory);
    if (!existsSync(absolute)) { failures.push(`missing root ${directory}`); continue; }
    const walk = dir => readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(join(dir, entry.name)) : [relative(destination, join(dir, entry.name)).replaceAll("\\", "/")]);
    for (const rel of walk(absolute)) if (!planned.has(rel)) failures.push(`extra ${rel}`);
  }
  return failures;
}

if (checkInstalled) {
  const installedPath = resolve(target, "INSTALLED.json");
  if (!existsSync(installedPath)) throw new Error(`缺少 ${installedPath}`);
  const installed = JSON.parse(readFileSync(installedPath, "utf8"));
  const currentPlan = sourcePlan(Boolean(installed.withData));
  const expected = manifest(currentPlan);
  installed.files = expected.files;
  const failures = compareInstalled(target, installed);
  console.log(`installed target: ${target}`);
  console.log(failures.length ? failures.join("\n") : `SHA-256 一致：${installed.files.length} files`);
  if (failures.length) process.exitCode = 1;
} else {
  const plan = sourcePlan();
  console.log(`install plan: ${plan.length} files`);
  console.log(`target: ${target}`);
  if (checkOnly) {
    console.log("安装包结构完整；未写入文件。");
  } else {
    const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "");
    const stagingRoot = target === join(codexRoot, "skills", "macro-high-frequency-monitor")
      ? join(codexRoot, ".skill-staging") : join(dirname(dirname(target)), ".skill-staging");
    const backupRoot = target === join(codexRoot, "skills", "macro-high-frequency-monitor")
      ? join(codexRoot, "skill-backups") : join(dirname(dirname(target)), "skill-backups");
    const staging = join(stagingRoot, `macro-high-frequency-monitor-${stamp}`);
    const backup = join(backupRoot, `macro-high-frequency-monitor-pre-v2-${stamp}`);
    mkdirSync(stagingRoot, { recursive: true });
    mkdirSync(staging, { recursive: false });
    copyPlan(plan, staging);
    const installed = manifest(plan);
    writeFileSync(join(staging, "INSTALLED.json"), JSON.stringify(installed, null, 2) + "\n", "utf8");
    try {
      execFileSync(process.execPath, [join(staging, "scripts", "verify.mjs")], { cwd: staging, stdio: "inherit" });
      execFileSync(process.execPath, [join(staging, "scripts", "macro-install-skill.mjs"), "--check"], { cwd: staging, stdio: "inherit" });
      const stagedFailures = compareInstalled(staging, installed);
      if (stagedFailures.length) throw new Error(`staging SHA failure: ${stagedFailures.join(", ")}`);
    } catch (error) {
      console.error(`staging 保留供排查：${staging}`);
      throw error;
    }
    let backedUp = false;
    try {
      if (existsSync(target)) { mkdirSync(backupRoot, { recursive: true }); renameSync(target, backup); backedUp = true; }
      mkdirSync(dirname(target), { recursive: true });
      renameSync(staging, target);
      const failures = compareInstalled(target, installed);
      if (failures.length) throw new Error(`安装后 SHA failure: ${failures.join(", ")}`);
      console.log(`staging: ${staging}`);
      console.log(`backup: ${backedUp ? backup : "none"}`);
      console.log(`installed: ${target}`);
      console.log(`SHA-256 一致：${installed.files.length} files`);
    } catch (error) {
      if (existsSync(target)) renameSync(target, `${staging}-failed`);
      if (backedUp && existsSync(backup)) renameSync(backup, target);
      throw error;
    }
  }
}
