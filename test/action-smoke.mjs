// Smoke test: invoke the GitHub Action runner as a subprocess, with no GitHub
// context available, and assert that:
//   - stderr surfaces the verdict header
//   - exit code respects fail-on-block
//   - GITHUB_OUTPUT receives verdict / score
//
// We run twice against the fixture:
//   (a) fail-on-block=false → must exit 0
//   (b) fail-on-block=true  → must exit 1 (fixture verdict is BLOCK)

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(__dirname);
const RUN = join(ROOT, "action", "run.mjs");
const FIXTURE = join(__dirname, "fixture");

function assert(cond, msg) {
  if (!cond) {
    console.error("  ❌", msg);
    process.exitCode = 1;
  } else {
    console.log("  ✓", msg);
  }
}

function runAction({ failOnBlock }) {
  const outputDir = mkdtempSync(join(tmpdir(), "deploy-rehearsal-action-out-"));
  const outputFile = join(outputDir, "GITHUB_OUTPUT");
  writeFileSync(outputFile, "");
  const env = {
    PATH: process.env.PATH,
    INPUT_WORKING_DIRECTORY: FIXTURE,
    BASE_REF: "HEAD",
    MODE: "direct",
    FAIL_ON_BLOCK: failOnBlock ? "true" : "false",
    SHOULD_COMMENT: "false",
    GITHUB_OUTPUT: outputFile,
  };
  const r = spawnSync(process.execPath, [RUN], { env, encoding: "utf8" });
  const outputs = readFileSync(outputFile, "utf8");
  try {
    if (existsSync(outputFile)) unlinkSync(outputFile);
  } catch {}
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, outputs };
}

console.log("\n============================================================");
console.log("  action-smoke (a) fail-on-block=false → exit 0");
console.log("============================================================");
const a = runAction({ failOnBlock: false });
console.log("  exit:", a.code);
console.log("  stderr first lines:\n   ", a.stderr.split("\n").slice(0, 4).join("\n    "));
console.log("  GITHUB_OUTPUT:", a.outputs.replace(/\n/g, " | ").trim());
assert(a.code === 0, "exit code is 0 when fail-on-block=false");
assert(/verdict=/.test(a.stderr), "stderr surfaces verdict");
assert(/^verdict=(GO|CAUTION|BLOCK)$/m.test(a.outputs), "GITHUB_OUTPUT carries `verdict=...`");
assert(/^score=\d+$/m.test(a.outputs), "GITHUB_OUTPUT carries numeric `score=...`");
assert(/^change-verdict=(GO|CAUTION|BLOCK)$/m.test(a.outputs), "GITHUB_OUTPUT carries `change-verdict=...` (baseline ran)");

console.log("\n============================================================");
console.log("  action-smoke (b) fail-on-block=true → exit 1 (BLOCK)");
console.log("============================================================");
const b = runAction({ failOnBlock: true });
console.log("  exit:", b.code);
console.log("  stderr last line:", b.stderr.trim().split("\n").pop());
assert(b.code === 1, "exit code is 1 when verdict=BLOCK and fail-on-block=true");

console.log("\n============================================================");
if (process.exitCode) {
  console.log("  ❌ Action smoke test FAILED.");
} else {
  console.log("  ✅ Action smoke test PASSED.");
}
console.log("============================================================");
