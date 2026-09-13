/** Compare two independently generated snapshots at byte and semantic levels. */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs, readJson, ROOT, semanticProjection, sha256File, stableJson } from "./macro-automation-lib.mjs";
const args = parseArgs();
if (!args.left || !args.right) throw new Error("用法：npm run parity -- --left <snapshot-a> --right <snapshot-b> [--output <result.json>]");
const leftPath = resolve(String(args.left)), rightPath = resolve(String(args.right));
const left = readJson(leftPath), right = readJson(rightPath);
const leftSemantic = semanticProjection(left), rightSemantic = semanticProjection(right);
const sections = ["headline", "dimensions", "deviations", "anomalies", "divergences", "aggregates", "futures"];
const fields = Object.fromEntries(sections.map(key => [key, stableJson(leftSemantic[key]) === stableJson(rightSemantic[key])]));
const result = { contract: "MACRO_PARITY_RESULT", version: "1.0.0", generatedAt: new Date().toISOString(),
  left: { path: leftPath, sha256: sha256File(leftPath), contract: left.contract, version: left.version, asOf: left.asOf },
  right: { path: rightPath, sha256: sha256File(rightPath), contract: right.contract, version: right.version, asOf: right.asOf },
  byteExactMatch: sha256File(leftPath) === sha256File(rightPath), contractMatch: left.contract === right.contract && left.version === right.version, fields };
result.semanticParityPass = result.contractMatch && Object.values(fields).every(Boolean);
const output = resolve(ROOT, String(args.output || `work/parity/${left.asOf || "unknown"}.json`));
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, "utf8");
console.log(`BYTE_EXACT_MATCH=${result.byteExactMatch ? "PASS" : "FAIL"}`);
for (const [key, pass] of Object.entries(fields)) console.log(`${key}=${pass ? "PASS" : "FAIL"}`);
console.log(`SEMANTIC_PARITY=${result.semanticParityPass ? "PASS" : "FAIL"}`);
console.log(`result=${output}`);
if (!result.semanticParityPass) process.exitCode = 1;
