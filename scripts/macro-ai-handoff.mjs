/** Build a compact, secret-free AI handoff from the canonical snapshot. */
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { handoffPayload, parseArgs, readJson, ROOT, sha256File } from "./macro-automation-lib.mjs";
const args = parseArgs();
const input = resolve(ROOT, String(args.input || "public/macro-snapshot.json"));
const output = resolve(ROOT, String(args.output || "dist/ai-handoff-latest.json"));
const payload = handoffPayload(readJson(input));
payload.source.sha256 = sha256File(input);
mkdirSync(dirname(output), { recursive: true });
const temporary = `${output}.${process.pid}.tmp`;
writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
renameSync(temporary, output);
console.log(`AI handoff: ${output}`);
console.log(`source: ${payload.source.contract} ${payload.source.version} · ${payload.source.sourceCommit}`);
console.log(`asOf: ${payload.asOf} · dimensions: ${payload.dimensions.length} · graph edges: ${payload.futures.graph?.edges?.length || 0}`);
