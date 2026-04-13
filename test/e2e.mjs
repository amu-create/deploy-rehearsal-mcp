// End-to-end test for deploy-rehearsal-mcp.
// Spawns the stdio server, speaks JSON-RPC manually, and asserts every tool works.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = dirname(__dirname);
const FIXTURE = join(__dirname, "fixture");
const SERVER = join(ROOT, "dist", "index.js");

// Prime the fixture with a deterministic state:
// - callback.ts has an appended blocked-secret test value
// - .env.production matches the known baseline
// - any stale baseline snapshot/config-with-extra-suppress is removed
const CALLBACK = join(FIXTURE, "src", "auth", "callback.ts");
const ENV_PROD = join(FIXTURE, ".env.production");
const BASELINE_PATH = join(FIXTURE, "test-baseline.json");
const EXTRA_CONFIG_PATH = join(FIXTURE, "deploy-rehearsal.extra.json");

const ENV_PROD_BASE = `DATABASE_URL=postgresql://prod-db.internal/app
NEXTAUTH_URL=https://myapp.com
NEXTAUTH_SECRET=
STRIPE_SECRET_KEY=sk_live_prod
GOOGLE_CLIENT_ID=prod-google-id
FEATURE_FLAG_X=true
SENTRY_DSN=https://sentry.io/abc
`;

const callbackOriginal = readFileSync(CALLBACK, "utf8").replace(/\n\/\/ new change[\s\S]*$/, "");
writeFileSync(
  CALLBACK,
  callbackOriginal +
    '\n// new change\nconst stripeKeyFORTESTONLY = "sk_live_TESTONLYABC123XYZ456";\n',
);
writeFileSync(ENV_PROD, ENV_PROD_BASE);
if (existsSync(BASELINE_PATH)) unlinkSync(BASELINE_PATH);
if (existsSync(EXTRA_CONFIG_PATH)) unlinkSync(EXTRA_CONFIG_PATH);

const child = spawn(process.execPath, [SERVER], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env },
});

let stderrBuf = "";
child.stderr.on("data", (d) => {
  stderrBuf += d.toString();
});

// Manual Content-Length framing reader (MCP over stdio also supports newline-delimited JSON —
// the TypeScript SDK's StdioServerTransport uses newline-delimited JSON by default).
let stdoutBuf = "";
const pending = new Map();
let nextId = 1;

child.stdout.on("data", (chunk) => {
  stdoutBuf += chunk.toString();
  let idx;
  while ((idx = stdoutBuf.indexOf("\n")) >= 0) {
    const line = stdoutBuf.slice(0, idx).trim();
    stdoutBuf = stdoutBuf.slice(idx + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id != null && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(`RPC error: ${JSON.stringify(msg.error)}`));
        else resolve(msg.result);
      }
    } catch (e) {
      console.error("Failed to parse line:", line);
    }
  }
});

function rpc(method, params) {
  const id = nextId++;
  const req = { jsonrpc: "2.0", id, method, params };
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify(req) + "\n");
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`Timeout waiting for ${method} (id=${id}). stderr=${stderrBuf}`));
      }
    }, 15000);
  });
}

function section(title) {
  console.log("\n============================================================");
  console.log("  " + title);
  console.log("============================================================");
}

function assert(cond, msg) {
  if (!cond) {
    console.error("  ❌ ASSERT FAILED:", msg);
    process.exitCode = 1;
  } else {
    console.log("  ✓", msg);
  }
}

function parseToolResult(result) {
  const text = result?.content?.[0]?.text;
  if (!text) throw new Error("No text content in tool result");
  return JSON.parse(text);
}

async function main() {
  section("1) initialize");
  const init = await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "e2e-test", version: "1.0" },
  });
  assert(init.serverInfo?.name === "deploy-rehearsal-mcp", "server name is deploy-rehearsal-mcp");
  assert(init.capabilities?.tools != null, "server advertises tools capability");

  // notify initialized
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  section("2) tools/list");
  const list = await rpc("tools/list", {});
  const toolNames = list.tools.map((t) => t.name).sort();
  console.log("  tools:", toolNames);
  const expected = ["analyze_diff", "check_oauth_redirects", "compare_env", "preflight_checklist", "run_rehearsal", "score_deploy_risk"];
  assert(JSON.stringify(toolNames) === JSON.stringify(expected), "all 6 tools listed");

  section("3) preflight_checklist");
  const preflightRaw = await rpc("tools/call", {
    name: "preflight_checklist",
    arguments: { cwd: FIXTURE },
  });
  const preflight = parseToolResult(preflightRaw);
  console.log("  preflight:", JSON.stringify(preflight, null, 2));
  assert(preflight.checks.some((c) => c.name === "git-repo" && c.status === "pass"), "git-repo check passes");
  assert(preflight.checks.some((c) => c.name === "build-script" && c.status === "pass"), "build-script present");
  assert(preflight.checks.some((c) => c.name === "lockfile" && c.status === "pass"), "lockfile present");
  assert(preflight.checks.some((c) => c.name === "env-ignored" && c.status === "pass"), ".env is gitignored");
  assert(preflight.checks.some((c) => c.name === "uncommitted" && c.status === "warn"), "uncommitted changes warning");

  section("4) analyze_diff");
  const diffRaw = await rpc("tools/call", {
    name: "analyze_diff",
    arguments: { cwd: FIXTURE, baseRef: "HEAD", headRef: "WORKING" },
  });
  const diff = parseToolResult(diffRaw);
  console.log("  diff summary:", {
    files: diff.totalFiles,
    signals: diff.signals.map((s) => ({ kind: s.kind, sev: s.severity, n: s.files.length })),
  });
  assert(diff.totalFiles >= 1, "diff detected at least one file");
  assert(diff.signals.some((s) => s.kind === "auth" && s.severity === "high"), "auth signal detected (HIGH)");

  section("5) compare_env (fixture .env.development vs .env.production)");
  const envRaw = await rpc("tools/call", {
    name: "compare_env",
    arguments: {
      files: [
        join(FIXTURE, ".env.development"),
        join(FIXTURE, ".env.production"),
      ],
    },
  });
  const env = parseToolResult(envRaw);
  console.log("  missingKeys:", env.missingKeys.map((k) => `${k.key}(missing in ${k.missingIn.length})`));
  console.log("  emptyKeys:", env.emptyKeys.map((k) => k.key));
  console.log("  divergentValues:", env.divergentValues.map((k) => k.key));
  console.log("  onlyInOne:", env.onlyInOne.map((k) => k.key));

  assert(env.missingKeys.some((k) => k.key === "GOOGLE_CLIENT_SECRET"), "GOOGLE_CLIENT_SECRET flagged missing in prod");
  assert(env.missingKeys.some((k) => k.key === "SENTRY_DSN"), "SENTRY_DSN flagged missing in dev");
  assert(env.emptyKeys.some((k) => k.key === "NEXTAUTH_SECRET"), "NEXTAUTH_SECRET flagged empty in prod");
  assert(env.divergentValues.some((k) => k.key === "STRIPE_SECRET_KEY"), "STRIPE_SECRET_KEY flagged as divergent");
  assert(env.divergentValues.some((k) => k.key === "STRIPE_SECRET_KEY" && k.secretLike === true), "STRIPE_SECRET_KEY marked secretLike");

  section("6) check_oauth_redirects");
  const oauthRaw = await rpc("tools/call", {
    name: "check_oauth_redirects",
    arguments: { cwd: FIXTURE, expectedDomains: ["myapp.com"] },
  });
  const oauth = parseToolResult(oauthRaw);
  console.log("  redirects found:", oauth.redirects.length);
  console.log("  byDomain:", oauth.byDomain);
  console.log("  localhost flagged:", oauth.localhostInNonTestFiles.length);
  console.log("  unexpectedDomains:", oauth.unexpectedDomains.map((r) => r.domain));

  assert(oauth.redirects.length >= 2, "found multiple oauth redirect URLs");
  assert(oauth.localhostInNonTestFiles.length >= 1, "localhost redirect flagged in non-test file");
  assert(oauth.unexpectedDomains.some((r) => r.domain === "old-staging.example.com"), "unexpected staging domain flagged");
  assert(oauth.byDomain["myapp.com"] >= 1, "expected myapp.com domain present");

  section("7) score_deploy_risk");
  const scoreRaw = await rpc("tools/call", {
    name: "score_deploy_risk",
    arguments: { cwd: FIXTURE },
  });
  const score = parseToolResult(scoreRaw);
  console.log("  verdict:", score.verdict);
  console.log("  score:", score.score);
  console.log("  top reasons:");
  for (const r of score.reasons.slice(0, 6)) console.log("    -", r);
  assert(["GO", "CAUTION", "BLOCK"].includes(score.verdict), "verdict is one of GO/CAUTION/BLOCK");
  assert(typeof score.score === "number", "score is numeric");
  assert(score.diffSummary.highSignals.includes("auth"), "risk score picked up auth HIGH signal");

  section("8) run_rehearsal (orchestrator + config)");
  const rehRaw = await rpc("tools/call", {
    name: "run_rehearsal",
    arguments: { cwd: FIXTURE, report: "markdown" },
  });
  const reh = parseToolResult(rehRaw);
  console.log("  verdict:", reh.verdict, "score:", reh.score);
  console.log("  configSource:", reh.configSource);
  console.log("  blockers:", reh.blockers.length, "warnings:", reh.warnings.length);
  console.log("  suppressed:", reh.suppressedCount);
  console.log("  sample finding ids:");
  for (const f of reh.findings.slice(0, 8)) console.log("    -", f.id, `(${f.severity})`);

  assert(reh.verdict === "BLOCK", "verdict is BLOCK (score should exceed threshold)");
  assert(typeof reh.score === "number" && reh.score > 60, "score > 60");
  assert(reh.configSource.endsWith("deploy-rehearsal.config.json"), "config loaded from fixture file");
  assert(
    reh.findings.some((f) => f.id === "env:required:DOES_NOT_EXIST_ANYWHERE"),
    "required env key finding created",
  );
  assert(
    reh.findings.some((f) => f.id === "secret:blocked:sk_live_[A-Za-z0-9]+"),
    "blocked secret pattern detected in diff",
  );
  assert(
    !reh.findings.some((f) => f.id === "preflight:ci-config"),
    "suppressed finding (preflight:ci-config) is absent",
  );
  assert(reh.suppressedCount >= 1, "suppressedCount > 0");
  assert(reh.blockers.every((f) => f.severity === "high"), "blockers are all HIGH");
  assert(
    reh.findings.every((f) => typeof f.confidence === "number" && typeof f.id === "string"),
    "every finding has id + confidence",
  );
  assert(typeof reh.reportMarkdown === "string" && reh.reportMarkdown.includes("# Deploy Rehearsal"), "markdown report rendered");
  assert(reh.reportMarkdown.includes("BLOCK"), "markdown report reflects BLOCK verdict");

  section("9) run_rehearsal — default config path absent → fallback to defaults");
  // Point configPath at a missing file; our loader falls back only if no path was passed,
  // so explicit missing path should raise. Test graceful behavior with a fresh tmp cwd
  // (no config), using a pre-existing fixture parent that is NOT a git repo would error —
  // so instead we exercise fallback by using the fixture but forcing config via override.
  const rehDefaultRaw = await rpc("tools/call", {
    name: "run_rehearsal",
    arguments: { cwd: FIXTURE, configPath: "deploy-rehearsal.config.json" },
  });
  const rehDefault = parseToolResult(rehDefaultRaw);
  assert(rehDefault.verdict === "BLOCK", "explicit configPath loads same config");

  section("10) error path — compare_env with 1 file");
  const errRaw = await rpc("tools/call", {
    name: "compare_env",
    arguments: { files: [join(FIXTURE, ".env.development")] },
  });
  console.log("  response:", JSON.stringify(errRaw));
  assert(errRaw.isError === true, "error returned when fewer than 2 files");

  // ---- Prisma detector helpers ----
  const SCHEMA_PATH = join(FIXTURE, "prisma", "schema.prisma");
  const MIGRATIONS_DIR = join(FIXTURE, "prisma", "migrations");
  const PRISMA_BASELINE_PATH = join(FIXTURE, "prisma-baseline.json");
  const SCHEMA_ORIGINAL = readFileSync(SCHEMA_PATH, "utf8");

  function gitFix(args) {
    return execSync(`git ${args}`, { cwd: FIXTURE, stdio: ["ignore", "pipe", "pipe"] }).toString();
  }
  function writeMigration(name, sql) {
    const dir = join(MIGRATIONS_DIR, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "migration.sql"), sql);
    gitFix(`add prisma/migrations/${name}/migration.sql`);
  }
  function removeMigration(name) {
    const dir = join(MIGRATIONS_DIR, name);
    if (existsSync(dir)) {
      try { gitFix(`reset -q HEAD -- prisma/migrations/${name}/migration.sql`); } catch {}
      rmSync(dir, { recursive: true, force: true });
    }
  }
  function resetPrismaState(extraMigrationNames = []) {
    writeFileSync(SCHEMA_PATH, SCHEMA_ORIGINAL);
    try { gitFix(`checkout -- prisma/schema.prisma`); } catch {}
    for (const n of extraMigrationNames) removeMigration(n);
    if (existsSync(PRISMA_BASELINE_PATH)) unlinkSync(PRISMA_BASELINE_PATH);
  }
  async function callRun(extra = {}) {
    const raw = await rpc("tools/call", {
      name: "run_rehearsal",
      arguments: { cwd: FIXTURE, ...extra },
    });
    return parseToolResult(raw);
  }
  function prismaFindings(result) {
    return (result.findings ?? []).filter((f) => f.category === "prisma");
  }

  // Start Prisma scenarios with a clean state.
  resetPrismaState();

  section("11) baseline — save snapshot (first run)");
  const saveRaw = await rpc("tools/call", {
    name: "run_rehearsal",
    arguments: {
      cwd: FIXTURE,
      baselinePath: "test-baseline.json",
      saveBaseline: true,
    },
  });
  const saved = parseToolResult(saveRaw);
  console.log("  baselineSaved:", saved.baselineSaved);
  console.log("  has baseline comparison:", !!saved.baseline);
  assert(saved.baselineSaved && typeof saved.baselineSaved.path === "string", "baselineSaved.path returned");
  assert(existsSync(BASELINE_PATH), "baseline file exists on disk");
  assert(saved.baseline === undefined, "first save produces no comparison (no prior snapshot)");
  const baselineFindingCount = saved.findings.length;
  const baselineScore = saved.score;

  section("12) baseline — no changes → persisting only, delta 0, changeVerdict GO");
  const rerunRaw = await rpc("tools/call", {
    name: "run_rehearsal",
    arguments: {
      cwd: FIXTURE,
      baselinePath: "test-baseline.json",
      report: "markdown",
    },
  });
  const rerun = parseToolResult(rerunRaw);
  console.log("  delta:", rerun.baseline?.deltaScore, "changeVerdict:", rerun.changeVerdict, "absolute:", rerun.verdict);
  console.log("  new:", rerun.baseline?.newFindings.length, "resolved:", rerun.baseline?.resolvedFindings.length, "persisting:", rerun.baseline?.persistingFindings.length);
  assert(rerun.baseline != null, "baseline comparison attached");
  assert(rerun.baseline.newFindings.length === 0, "no new findings");
  assert(rerun.baseline.resolvedFindings.length === 0, "no resolved findings");
  assert(rerun.baseline.persistingFindings.length === baselineFindingCount, "all baseline findings persist");
  assert(rerun.baseline.deltaScore === 0, "deltaScore is 0");
  assert(rerun.changeVerdict === "GO", "changeVerdict is GO");
  assert(rerun.verdict === "BLOCK", "absolute verdict still BLOCK (separation confirmed)");
  assert(typeof rerun.reportMarkdown === "string" && rerun.reportMarkdown.includes("Changes since baseline"), "markdown report includes baseline section");

  section("13) baseline — add a new finding → shows up as new, delta > 0");
  writeFileSync(ENV_PROD, ENV_PROD_BASE + "UNIQUE_NEW_KEY_FOR_TEST=prod-only-value\n");
  const addedRaw = await rpc("tools/call", {
    name: "run_rehearsal",
    arguments: {
      cwd: FIXTURE,
      baselinePath: "test-baseline.json",
    },
  });
  const added = parseToolResult(addedRaw);
  console.log("  new findings:", added.baseline?.newFindings.map((f) => f.fingerprint));
  console.log("  delta:", added.baseline?.deltaScore, "changeVerdict:", added.changeVerdict);
  assert(
    added.baseline.newFindings.some((f) => f.fingerprint === "env:missing:UNIQUE_NEW_KEY_FOR_TEST"),
    "new env:missing:UNIQUE_NEW_KEY_FOR_TEST reported as new",
  );
  assert(added.baseline.deltaScore > 0, "deltaScore > 0 after new finding");
  assert(added.score > baselineScore, "absolute score increased");

  section("14) baseline — suppress a persisting finding → shows up as resolved");
  writeFileSync(ENV_PROD, ENV_PROD_BASE);
  const pickToResolve = rerun.baseline.persistingFindings.find(
    (f) => f.fingerprint === "env:divergent:DATABASE_URL",
  );
  assert(!!pickToResolve, "prerequisite: baseline contained env:divergent:DATABASE_URL");
  const originalConfig = JSON.parse(readFileSync(join(FIXTURE, "deploy-rehearsal.config.json"), "utf8"));
  const extraConfig = {
    ...originalConfig,
    suppress: [...(originalConfig.suppress ?? []), "env:divergent:DATABASE_URL"],
  };
  writeFileSync(EXTRA_CONFIG_PATH, JSON.stringify(extraConfig, null, 2));
  const resolvedRaw = await rpc("tools/call", {
    name: "run_rehearsal",
    arguments: {
      cwd: FIXTURE,
      configPath: "deploy-rehearsal.extra.json",
      baselinePath: "test-baseline.json",
    },
  });
  const resolved = parseToolResult(resolvedRaw);
  console.log("  resolved findings:", resolved.baseline?.resolvedFindings.map((f) => f.fingerprint));
  console.log("  suppressedCount:", resolved.suppressedCount);
  assert(
    resolved.baseline.resolvedFindings.some((f) => f.fingerprint === "env:divergent:DATABASE_URL"),
    "env:divergent:DATABASE_URL appears in resolvedFindings after suppression",
  );
  assert(resolved.baseline.deltaScore < 0, "deltaScore negative when findings removed");
  assert(resolved.suppressedCount >= 2, "suppress list applied (preflight:ci-config + new entry)");

  section("15) baseline — fingerprint stability (id has line, fingerprint does not)");
  const localhostFinding = rerun.findings.find((f) => f.fingerprint.startsWith("oauth:localhost:"));
  assert(!!localhostFinding, "oauth:localhost finding present");
  assert(
    !/:\d+$/.test(localhostFinding.fingerprint),
    "oauth:localhost fingerprint does not include line number",
  );
  assert(
    /:\d+$/.test(localhostFinding.id),
    "oauth:localhost id DOES include line number (id stays verbose)",
  );

  // cleanup mutations so re-running the test starts clean
  writeFileSync(ENV_PROD, ENV_PROD_BASE);
  if (existsSync(EXTRA_CONFIG_PATH)) unlinkSync(EXTRA_CONFIG_PATH);
  if (existsSync(BASELINE_PATH)) unlinkSync(BASELINE_PATH);
  resetPrismaState();

  // ============================================================
  //  Prisma detector scenarios (16–27)
  // ============================================================

  section("16) Prisma — DROP TABLE → BLOCK");
  writeMigration("20260413_drop_users", `DROP TABLE "User";\n`);
  {
    const r = await callRun();
    const prisma = prismaFindings(r);
    console.log("  prisma findings:", prisma.map((f) => `${f.fingerprint} (${f.severity})`));
    assert(
      prisma.some((f) => f.fingerprint === "prisma:drop-table:User" && f.severity === "high"),
      "DROP TABLE User → prisma:drop-table:User HIGH",
    );
    resetPrismaState(["20260413_drop_users"]);
  }

  section("17) Prisma — DROP COLUMN → BLOCK");
  writeMigration(
    "20260413_drop_col",
    `ALTER TABLE "User" DROP COLUMN "email";\n`,
  );
  {
    const r = await callRun();
    const prisma = prismaFindings(r);
    console.log("  prisma findings:", prisma.map((f) => f.fingerprint));
    assert(
      prisma.some((f) => f.fingerprint === "prisma:drop-column:User.email" && f.severity === "high"),
      "DROP COLUMN → prisma:drop-column:User.email HIGH",
    );
    resetPrismaState(["20260413_drop_col"]);
  }

  section("18) Prisma — ALTER COLUMN TYPE → CAUTION");
  writeMigration(
    "20260413_alter_type",
    `ALTER TABLE "User" ALTER COLUMN "name" TYPE TEXT;\n`,
  );
  {
    const r = await callRun();
    const prisma = prismaFindings(r);
    console.log("  prisma findings:", prisma.map((f) => `${f.fingerprint} (${f.severity})`));
    assert(
      prisma.some((f) => f.fingerprint === "prisma:alter-type:User.name" && f.severity === "warn"),
      "ALTER COLUMN TYPE → warn",
    );
    assert(
      !prisma.some((f) => f.fingerprint === "prisma:alter-type:User.name" && f.severity === "high"),
      "ALTER COLUMN TYPE is NOT high",
    );
    resetPrismaState(["20260413_alter_type"]);
  }

  section("19) Prisma — ADD UNIQUE → CAUTION");
  writeMigration(
    "20260413_add_unique",
    `ALTER TABLE "User" ADD CONSTRAINT "User_email_key" UNIQUE ("email");\n`,
  );
  {
    const r = await callRun();
    const prisma = prismaFindings(r);
    console.log("  prisma findings:", prisma.map((f) => `${f.fingerprint} (${f.severity})`));
    assert(
      prisma.some((f) => f.fingerprint === "prisma:add-unique:User" && f.severity === "warn"),
      "ADD UNIQUE → prisma:add-unique:User warn",
    );
    resetPrismaState(["20260413_add_unique"]);
  }

  section("20) Prisma — schema.prisma structural change WITHOUT migration → CAUTION");
  writeFileSync(
    SCHEMA_PATH,
    SCHEMA_ORIGINAL.replace("name  String?", "name  String?\n  age   Int?"),
  );
  {
    const r = await callRun();
    const prisma = prismaFindings(r);
    console.log("  prisma findings:", prisma.map((f) => f.fingerprint));
    assert(
      prisma.some((f) => f.fingerprint === "prisma:schema-drift:no-migration"),
      "structural schema change + no migration → drift finding",
    );
    resetPrismaState();
  }

  section("21) Prisma — migration WITHOUT schema change → CAUTION");
  writeMigration(
    "20260413_data_backfill",
    `UPDATE "User" SET "name" = 'unknown' WHERE "name" IS NULL;\n`,
  );
  {
    const r = await callRun();
    const prisma = prismaFindings(r);
    console.log("  prisma findings:", prisma.map((f) => f.fingerprint));
    assert(
      prisma.some((f) => f.fingerprint === "prisma:schema-drift:migration-without-schema"),
      "migration + untouched schema → drift finding",
    );
    resetPrismaState(["20260413_data_backfill"]);
  }

  section("22) Prisma — provider=postgresql but env URL is mysql:// → BLOCK");
  writeFileSync(ENV_PROD, ENV_PROD_BASE.replace(/^DATABASE_URL=.+$/m, "DATABASE_URL=mysql://prod/app"));
  {
    const r = await callRun();
    const prisma = prismaFindings(r);
    console.log("  prisma findings:", prisma.map((f) => `${f.fingerprint} (${f.severity})`));
    assert(
      prisma.some((f) => f.fingerprint === "prisma:provider-mismatch:postgresql:mysql" && f.severity === "high"),
      "postgresql provider vs mysql:// URL → BLOCK",
    );
    writeFileSync(ENV_PROD, ENV_PROD_BASE);
    resetPrismaState();
  }

  section("23) Prisma — provider changed in schema diff → BLOCK");
  writeFileSync(
    SCHEMA_PATH,
    SCHEMA_ORIGINAL.replace('provider = "postgresql"', 'provider = "mysql"'),
  );
  {
    const r = await callRun();
    const prisma = prismaFindings(r);
    console.log("  prisma findings:", prisma.map((f) => `${f.fingerprint} (${f.severity})`));
    assert(
      prisma.some((f) => f.fingerprint === "prisma:provider-changed" && f.severity === "high"),
      "provider change in schema diff → BLOCK",
    );
    resetPrismaState();
  }

  section("24) Prisma — baseline compatibility (persisting)");
  writeMigration("20260413_drop_users_b", `DROP TABLE "User";\n`);
  {
    const save = await callRun({
      baselinePath: "prisma-baseline.json",
      saveBaseline: true,
    });
    assert(save.baselineSaved != null, "prisma-baseline.json saved");
    const rerun = await callRun({ baselinePath: "prisma-baseline.json" });
    console.log("  baseline new:", rerun.baseline.newFindings.length, "persisting:", rerun.baseline.persistingFindings.length);
    assert(
      rerun.baseline.persistingFindings.some((f) => f.fingerprint === "prisma:drop-table:User"),
      "prisma:drop-table:User persists across baseline runs",
    );
    assert(rerun.baseline.newFindings.length === 0, "no new findings when state unchanged");
    resetPrismaState(["20260413_drop_users_b"]);
  }

  section("25) Prisma — suppression removes a prisma finding");
  writeMigration("20260413_drop_users_c", `DROP TABLE "User";\n`);
  {
    const baseConfig = JSON.parse(readFileSync(join(FIXTURE, "deploy-rehearsal.config.json"), "utf8"));
    const withPrismaSuppress = {
      ...baseConfig,
      suppress: [...(baseConfig.suppress ?? []), "prisma:drop-table:User"],
    };
    const tmpCfg = join(FIXTURE, "deploy-rehearsal.prisma-sup.json");
    writeFileSync(tmpCfg, JSON.stringify(withPrismaSuppress, null, 2));
    const r = await callRun({ configPath: "deploy-rehearsal.prisma-sup.json" });
    const prisma = prismaFindings(r);
    console.log("  prisma findings after suppress:", prisma.map((f) => f.fingerprint));
    assert(
      !prisma.some((f) => f.fingerprint === "prisma:drop-table:User"),
      "suppress[] removes prisma:drop-table:User",
    );
    assert(r.suppressedCount >= 1, "suppressedCount reflects prisma suppression");
    unlinkSync(tmpCfg);
    resetPrismaState(["20260413_drop_users_c"]);
  }

  section("26) Prisma — fingerprint stability across different migration files/lines");
  writeMigration("20260413_drop_A", `-- comment\n-- another\nALTER TABLE "User" DROP COLUMN "name";\n`);
  writeMigration("20260413_drop_B", `ALTER TABLE "User" DROP COLUMN "name";\n`);
  {
    const r = await callRun();
    const dupes = prismaFindings(r).filter((f) => f.fingerprint === "prisma:drop-column:User.name");
    console.log("  dupes:", dupes.map((f) => f.id));
    assert(dupes.length === 2, "two findings share the same fingerprint");
    assert(new Set(dupes.map((f) => f.id)).size === 2, "but have two distinct ids (file/line differ)");
    resetPrismaState(["20260413_drop_A", "20260413_drop_B"]);
  }

  section("27) Prisma — no-op when schema.prisma is absent");
  {
    const baseConfig = JSON.parse(readFileSync(join(FIXTURE, "deploy-rehearsal.config.json"), "utf8"));
    const noPrisma = {
      ...baseConfig,
      prisma: { ...(baseConfig.prisma ?? {}), schemaPath: "does-not-exist/schema.prisma" },
    };
    const tmpCfg = join(FIXTURE, "deploy-rehearsal.noprisma.json");
    writeFileSync(tmpCfg, JSON.stringify(noPrisma, null, 2));
    // Even with a destructive migration on disk (staged), no prisma findings should appear.
    writeMigration("20260413_noop_test", `DROP TABLE "Whatever";\n`);
    const r = await callRun({ configPath: "deploy-rehearsal.noprisma.json" });
    const prisma = prismaFindings(r);
    console.log("  prisma findings (expected 0):", prisma.length);
    assert(prisma.length === 0, "no prisma findings when schema.prisma is absent");
    unlinkSync(tmpCfg);
    resetPrismaState(["20260413_noop_test"]);
  }

  // ============================================================
  //  Tuning scenarios (28–33): hard blockers, grouping, bonuses
  // ============================================================

  resetPrismaState();
  const TUNING_CFG = join(FIXTURE, "deploy-rehearsal.tuning.json");
  const baseConfigForTuning = JSON.parse(readFileSync(join(FIXTURE, "deploy-rehearsal.config.json"), "utf8"));

  section("28) hard blocker forces BLOCK even when score threshold would not");
  writeFileSync(
    ENV_PROD,
    ENV_PROD_BASE.replace(/^DATABASE_URL=.+$/m, "DATABASE_URL=mysql://prod/app"),
  );
  writeFileSync(
    TUNING_CFG,
    JSON.stringify(
      {
        ...baseConfigForTuning,
        thresholds: { block: 99999, caution: 99999 },
      },
      null,
      2,
    ),
  );
  {
    const r = await callRun({ configPath: "deploy-rehearsal.tuning.json" });
    console.log("  verdict:", r.verdict, "reason:", r.verdictReason, "hardBlockers:", r.hardBlockers.length, "score:", r.score);
    assert(r.verdict === "BLOCK", "hard blocker → BLOCK regardless of score threshold");
    assert(r.verdictReason === "hard-blocker", "verdictReason = hard-blocker");
    assert(
      r.hardBlockers.some((f) => f.fingerprint.startsWith("prisma:provider-mismatch:")),
      "provider-mismatch is in hardBlockers",
    );
    writeFileSync(ENV_PROD, ENV_PROD_BASE);
    unlinkSync(TUNING_CFG);
  }

  section("29) no hard blocker → verdict falls through to score threshold");
  writeFileSync(
    TUNING_CFG,
    JSON.stringify(
      {
        ...baseConfigForTuning,
        thresholds: { block: 99999, caution: 25 },
      },
      null,
      2,
    ),
  );
  {
    const r = await callRun({ configPath: "deploy-rehearsal.tuning.json" });
    console.log("  verdict:", r.verdict, "reason:", r.verdictReason, "hardBlockers:", r.hardBlockers.length);
    assert(r.hardBlockers.length === 0, "no prisma hard blockers with default env.production");
    assert(r.verdict === "CAUTION", "score > caution 25 but under block 99999 → CAUTION");
    assert(r.verdictReason === "score", "verdictReason = score");
    unlinkSync(TUNING_CFG);
  }

  section("30) fingerprint grouping — duplicates add penalty, not raw sum");
  writeMigration("20260413_dupe_A", `ALTER TABLE "User" DROP COLUMN "email";\n`);
  const singleRun = await callRun();
  const singleScore = singleRun.score;
  writeMigration("20260413_dupe_B", `ALTER TABLE "User" DROP COLUMN "email";\n`);
  const doubleRun = await callRun();
  const doubleScore = doubleRun.score;
  const dupeCount = doubleRun.findings.filter((f) => f.fingerprint === "prisma:drop-column:User.email").length;
  console.log("  single score:", singleScore, "double score:", doubleScore, "duplicate count:", dupeCount);
  const rawSumDelta = 70 + 12; // raw weight + critical bonus would be ~82 per finding
  const groupedDelta = doubleScore - singleScore;
  console.log("  delta:", groupedDelta, "(raw-sum would be ~", rawSumDelta, ")");
  assert(dupeCount === 2, "two findings share the same fingerprint");
  assert(groupedDelta > 0, "second duplicate adds some score");
  assert(groupedDelta < rawSumDelta, "second duplicate adds LESS than raw sum (grouping penalty applied)");
  resetPrismaState(["20260413_dupe_A", "20260413_dupe_B"]);

  section("31) critical model bonus — User gets higher score than Foo for same kind");
  writeMigration("20260413_foo", `ALTER TABLE "Foo" DROP COLUMN "bar";\n`);
  const fooRun = await callRun();
  const fooPrismaScore = fooRun.findings
    .filter((f) => f.category === "prisma" && f.fingerprint === "prisma:drop-column:Foo.bar")
    .reduce((acc, f) => acc + (f.weight ?? 0), 0);
  const fooTotal = fooRun.score;
  resetPrismaState(["20260413_foo"]);
  writeMigration("20260413_user_email", `ALTER TABLE "User" DROP COLUMN "email";\n`);
  const userRun = await callRun();
  const userTotal = userRun.score;
  console.log("  Foo score:", fooTotal, "User score:", userTotal, "diff:", userTotal - fooTotal);
  assert(userTotal - fooTotal >= 10, "critical-model (User) gets ≥10 more than non-critical (Foo)");
  resetPrismaState(["20260413_user_email"]);

  section("32) mitigation discount — backfill hint lowers the score");
  writeMigration(
    "20260413_drop_no_mit",
    `ALTER TABLE "User" DROP COLUMN "email";\n`,
  );
  const noMitRun = await callRun();
  const noMitScore = noMitRun.score;
  resetPrismaState(["20260413_drop_no_mit"]);
  writeMigration(
    "20260413_drop_with_mit",
    `-- plan: backfill replacement column, then drop\nUPDATE "User" SET "email_v2" = "email";\nALTER TABLE "User" DROP COLUMN "email";\n`,
  );
  const withMitRun = await callRun();
  const withMitScore = withMitRun.score;
  const userDrop = withMitRun.findings.find((f) => f.fingerprint === "prisma:drop-column:User.email");
  console.log("  no-mit score:", noMitScore, "with-mit score:", withMitScore, "diff:", noMitScore - withMitScore);
  assert(userDrop && userDrop.evidence.mitigated === true, "evidence.mitigated = true when backfill hint present");
  assert(noMitScore - withMitScore >= 10, "mitigation discount lowers score by ≥10");
  resetPrismaState(["20260413_drop_with_mit"]);

  section("33) change verdict — new hard blocker BLOCKS even under high delta thresholds");
  writeFileSync(
    TUNING_CFG,
    JSON.stringify(
      {
        ...baseConfigForTuning,
        baseline: {
          ...(baseConfigForTuning.baseline ?? {}),
          deltaBlockThreshold: 99999,
          deltaCautionThreshold: 99999,
        },
      },
      null,
      2,
    ),
  );
  // Save baseline with NO prisma hard blockers on disk
  await callRun({
    configPath: "deploy-rehearsal.tuning.json",
    baselinePath: "tuning-baseline.json",
    saveBaseline: true,
  });
  // Add a DROP TABLE migration → creates a new hard blocker
  writeMigration("20260413_drop_users_hb", `DROP TABLE "User";\n`);
  {
    const r = await callRun({
      configPath: "deploy-rehearsal.tuning.json",
      baselinePath: "tuning-baseline.json",
    });
    console.log("  changeVerdict:", r.changeVerdict, "reason:", r.changeVerdictReason, "deltaScore:", r.baseline?.deltaScore);
    assert(r.changeVerdict === "BLOCK", "new hard blocker → change verdict BLOCK");
    assert(r.changeVerdictReason === "new-hard-blocker", "changeVerdictReason = new-hard-blocker");
    assert(
      r.baseline.newFindings.some((f) => f.fingerprint === "prisma:drop-table:User"),
      "prisma:drop-table:User appears as new finding",
    );
  }

  // cleanup tuning state
  resetPrismaState(["20260413_drop_users_hb"]);
  if (existsSync(TUNING_CFG)) unlinkSync(TUNING_CFG);
  const tuningBaseline = join(FIXTURE, "tuning-baseline.json");
  if (existsSync(tuningBaseline)) unlinkSync(tuningBaseline);

  // ============================================================
  //  Next.js detector scenarios (34–43)
  // ============================================================

  const MIDDLEWARE_PATH = join(FIXTURE, "middleware.ts");
  const NEXT_CONFIG_PATH = join(FIXTURE, "next.config.js");
  const MIDDLEWARE_ORIGINAL = readFileSync(MIDDLEWARE_PATH, "utf8");
  const NEXT_CONFIG_ORIGINAL = readFileSync(NEXT_CONFIG_PATH, "utf8");
  const ENV_DEV = join(FIXTURE, ".env.development");
  const ENV_DEV_ORIGINAL = readFileSync(ENV_DEV, "utf8");

  function writeSource(relPath, content) {
    const abs = join(FIXTURE, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
    gitFix(`add -f ${relPath.replace(/\\/g, "/")}`);
  }
  function removeSource(relPath) {
    const abs = join(FIXTURE, relPath);
    if (existsSync(abs)) {
      try { gitFix(`reset -q HEAD -- ${relPath.replace(/\\/g, "/")}`); } catch {}
      rmSync(abs, { force: true });
    }
  }
  function removeDir(relPath) {
    const abs = join(FIXTURE, relPath);
    if (existsSync(abs)) rmSync(abs, { recursive: true, force: true });
  }
  function modifyTracked(relPath, newContent) {
    writeFileSync(join(FIXTURE, relPath), newContent);
    gitFix(`add ${relPath.replace(/\\/g, "/")}`);
  }
  function restoreTracked(relPath) {
    try { gitFix(`reset HEAD -- ${relPath.replace(/\\/g, "/")}`); } catch {}
    try { gitFix(`checkout -- ${relPath.replace(/\\/g, "/")}`); } catch {}
  }
  function resetNextjsState(extraFiles = [], extraDirs = []) {
    for (const f of extraFiles) removeSource(f);
    for (const d of extraDirs) removeDir(d);
    restoreTracked("middleware.ts");
    restoreTracked("next.config.js");
    writeFileSync(MIDDLEWARE_PATH, MIDDLEWARE_ORIGINAL);
    writeFileSync(NEXT_CONFIG_PATH, NEXT_CONFIG_ORIGINAL);
    writeFileSync(ENV_DEV, ENV_DEV_ORIGINAL);
  }
  function nextjsFindings(result) {
    return (result.findings ?? []).filter((f) => f.category === "nextjs");
  }

  resetNextjsState();

  section("34) Next.js — NEXT_PUBLIC_*SECRET* in env file → BLOCK");
  writeFileSync(ENV_DEV, ENV_DEV_ORIGINAL + "NEXT_PUBLIC_STRIPE_SECRET_KEY=sk_live_leak\n");
  {
    const r = await callRun();
    const nx = nextjsFindings(r);
    console.log("  nextjs findings:", nx.map((f) => `${f.fingerprint} (${f.severity})`));
    assert(
      nx.some((f) => f.fingerprint === "nextjs:public-secret:NEXT_PUBLIC_STRIPE_SECRET_KEY" && f.severity === "high"),
      "NEXT_PUBLIC secret → BLOCK",
    );
    assert(
      r.hardBlockers.some((f) => f.fingerprint.startsWith("nextjs:public-secret:")),
      "public-secret sits in hardBlockers",
    );
    writeFileSync(ENV_DEV, ENV_DEV_ORIGINAL);
  }
  resetNextjsState();

  section("35) Next.js — client component reads server-only secret → BLOCK");
  writeSource(
    "app/billing/ClientCheckout.tsx",
    `"use client";\nexport function ClientCheckout() {\n  const key = process.env.STRIPE_SECRET_KEY;\n  return null;\n}\n`,
  );
  {
    const r = await callRun();
    const nx = nextjsFindings(r);
    console.log("  findings:", nx.map((f) => f.fingerprint));
    assert(
      nx.some((f) => f.fingerprint === "nextjs:client-env-access:STRIPE_SECRET_KEY"),
      "client component accessing server secret is flagged",
    );
  }
  resetNextjsState([], ["app/billing"]);

  section("36) Next.js — edge runtime route + Node `fs` import → BLOCK");
  writeSource(
    "app/api/foo/route.ts",
    `import fs from "fs";\nexport const runtime = "edge";\nexport async function GET() {\n  return new Response(String(fs));\n}\n`,
  );
  {
    const r = await callRun();
    const nx = nextjsFindings(r);
    console.log("  findings:", nx.map((f) => f.fingerprint));
    assert(
      nx.some((f) => f.fingerprint === "nextjs:edge-node-api:/api/foo:fs"),
      "edge + fs → fingerprint uses route + module",
    );
    assert(
      r.hardBlockers.some((f) => f.fingerprint.startsWith("nextjs:edge-node-api:")),
      "edge-node-api is a hard blocker",
    );
  }
  resetNextjsState([], ["app/api"]);

  section("37) Next.js — edge runtime route + @prisma/client → BLOCK");
  writeSource(
    "app/api/bar/route.ts",
    `import { PrismaClient } from "@prisma/client";\nexport const runtime = "edge";\nconst prisma = new PrismaClient();\nexport async function GET() {\n  return Response.json(await prisma.user.findMany());\n}\n`,
  );
  {
    const r = await callRun();
    const nx = nextjsFindings(r);
    console.log("  findings:", nx.map((f) => f.fingerprint));
    assert(
      nx.some((f) => f.fingerprint === "nextjs:edge-prisma:/api/bar"),
      "edge + Prisma → fingerprint uses route path",
    );
  }
  resetNextjsState([], ["app/api"]);

  section("38) Next.js — middleware matcher shrunk → CAUTION");
  modifyTracked(
    "middleware.ts",
    MIDDLEWARE_ORIGINAL.replace(
      /matcher:\s*\[[^\]]*\]/,
      'matcher: ["/dashboard/:path*"]',
    ),
  );
  {
    const r = await callRun();
    const nx = nextjsFindings(r);
    console.log("  findings:", nx.map((f) => f.fingerprint));
    const expected = "nextjs:matcher-shrunk:/admin/:path*|/billing/:path*";
    assert(
      nx.some((f) => f.fingerprint === expected),
      `matcher-shrunk fingerprint carries sorted removed matchers (expected ${expected})`,
    );
  }
  resetNextjsState();

  section("39) Next.js — new critical route without middleware coverage → CAUTION");
  writeSource(
    "app/account/page.tsx",
    `export default function AccountPage() { return <div>account</div>; }\n`,
  );
  {
    const r = await callRun();
    const nx = nextjsFindings(r);
    console.log("  findings:", nx.map((f) => f.fingerprint));
    assert(
      nx.some((f) => f.fingerprint === "nextjs:middleware-unprotected:/account"),
      "/account critical route missing middleware coverage is flagged",
    );
  }
  resetNextjsState([], ["app/account"]);

  section("40) Next.js — next.config basePath change → CAUTION");
  modifyTracked(
    "next.config.js",
    NEXT_CONFIG_ORIGINAL.replace(
      "reactStrictMode: true,",
      "reactStrictMode: true,\n  basePath: '/app',",
    ),
  );
  {
    const r = await callRun();
    const nx = nextjsFindings(r);
    console.log("  findings:", nx.map((f) => f.fingerprint));
    assert(nx.some((f) => f.fingerprint === "nextjs:config-basepath-change"), "basePath change flagged");
  }
  resetNextjsState();

  section("41) Next.js — next.config images.remotePatterns shrunk → CAUTION");
  modifyTracked(
    "next.config.js",
    NEXT_CONFIG_ORIGINAL.replace(
      /remotePatterns:\s*\[[^\]]*\]/,
      'remotePatterns: [\n      { protocol: "https", hostname: "images.example.com" },\n    ]',
    ),
  );
  {
    const r = await callRun();
    const nx = nextjsFindings(r);
    console.log("  findings:", nx.map((f) => f.fingerprint));
    assert(
      nx.some((f) => f.fingerprint === "nextjs:images-remote-patterns-shrunk:cdn.example.com"),
      "remotePatterns shrink → fingerprint carries removed domains",
    );
  }
  resetNextjsState();

  section("42) Next.js — personalized critical route with force-static → BLOCK");
  writeSource(
    "app/dashboard/page.tsx",
    `export const dynamic = "force-static";\nexport default function DashboardPage() { return <div>dash</div>; }\n`,
  );
  {
    const r = await callRun();
    const nx = nextjsFindings(r);
    console.log("  findings:", nx.map((f) => `${f.fingerprint} (${f.severity})`));
    assert(
      nx.some((f) => f.fingerprint === "nextjs:personalized-static:/dashboard" && f.severity === "high"),
      "force-static on personalized /dashboard → BLOCK",
    );
    assert(
      r.hardBlockers.some((f) => f.fingerprint.startsWith("nextjs:personalized-static:")),
      "personalized-static is a hard blocker",
    );
  }
  resetNextjsState([], ["app/dashboard"]);

  section("43) Next.js — dynamic/static conflict (force-static + cookies()) → CAUTION");
  writeSource(
    "app/api/me/route.ts",
    `import { cookies } from "next/headers";\nexport const dynamic = "force-static";\nexport async function GET() {\n  const c = cookies();\n  return Response.json({ user: c.get("uid") });\n}\n`,
  );
  {
    const r = await callRun();
    const nx = nextjsFindings(r);
    console.log("  findings:", nx.map((f) => f.fingerprint));
    assert(
      nx.some((f) => f.fingerprint === "nextjs:dynamic-static-conflict:/api/me"),
      "dynamic-static-conflict → fingerprint uses route path",
    );
  }
  resetNextjsState([], ["app/api"]);

  section("44) Next.js — NEXT_PUBLIC_*API_KEY (suspicious tier) → CAUTION");
  writeFileSync(ENV_DEV, ENV_DEV_ORIGINAL + "NEXT_PUBLIC_GOOGLE_MAPS_API_KEY=AIzaFOO\n");
  {
    const r = await callRun();
    const nx = nextjsFindings(r);
    console.log("  findings:", nx.map((f) => `${f.fingerprint} (${f.severity})`));
    assert(
      nx.some(
        (f) =>
          f.fingerprint === "nextjs:public-suspicious:NEXT_PUBLIC_GOOGLE_MAPS_API_KEY" &&
          f.severity === "warn",
      ),
      "api-key-shaped NEXT_PUBLIC_* is suspicious (warn, not hard block)",
    );
    assert(
      !r.hardBlockers.some((f) => f.fingerprint.startsWith("nextjs:public-suspicious:")),
      "suspicious tier is NOT a hard blocker",
    );
    writeFileSync(ENV_DEV, ENV_DEV_ORIGINAL);
  }
  resetNextjsState();

  // ============================================================
  //  git-ref baseline scenarios (46–53)
  // ============================================================

  resetNextjsState();
  const BOGUS_BASELINE = join(FIXTURE, "bogus-baseline.json");

  section("46) git-ref — baselineRef=HEAD direct → new findings = diff-based deltas only");
  {
    const r = await callRun({ baselineRef: "HEAD", baselineRefMode: "direct" });
    console.log("  baselineSource:", r.baselineSource, "displayRef:", r.baselineDisplayRef, "mode:", r.baselineMode);
    console.log("  resolvedRef:", r.baselineResolvedRef?.slice(0, 10));
    console.log("  new:", r.baseline?.newFindings.map((f) => f.fingerprint));
    assert(r.baselineSource === "git-ref", "baselineSource=git-ref");
    assert(r.baselineDisplayRef === "HEAD", "displayRef preserved");
    assert(typeof r.baselineResolvedRef === "string" && r.baselineResolvedRef.length >= 7, "resolvedRef is a real sha");
    assert(r.baselineMode === "direct", "mode echoed in result");
    assert(r.baseline != null, "baseline comparison attached");
    assert(
      r.baseline.newFindings.some((f) => f.fingerprint === "secret:blocked:sk_live_[A-Za-z0-9]+"),
      "sk_live secret (uncommitted) appears as new vs HEAD",
    );
  }

  section("47) git-ref — invalid ref → baselineError.reason=ref-not-found");
  {
    const r = await callRun({ baselineRef: "ref-does-not-exist-xyz" });
    console.log("  baselineError:", r.baselineError);
    assert(r.baselineError != null, "baselineError populated");
    assert(r.baselineError.reason === "ref-not-found", "reason=ref-not-found");
    assert(r.baseline === undefined, "no comparison attached on error");
    assert(r.verdict != null, "current verdict still returned");
  }

  section("48) git-ref — merge-base mode with main branch at HEAD~2");
  gitFix(`branch -f main HEAD~2`);
  try {
    const initSha = gitFix(`rev-parse HEAD~2`).trim();
    const r = await callRun({ baselineRef: "main", baselineRefMode: "merge-base" });
    console.log("  displayRef:", r.baselineDisplayRef, "mode:", r.baselineMode, "resolved:", r.baselineResolvedRef?.slice(0, 10));
    assert(r.baselineDisplayRef === "main", "displayRef=main");
    assert(r.baselineMode === "merge-base", "mode=merge-base");
    assert(r.baselineResolvedRef === initSha, "merge-base(HEAD, main) = main sha (init commit)");
  } finally {
    try { gitFix(`branch -D main`); } catch {}
  }

  section("49) git-ref — new hard blocker in diff → changeVerdict=BLOCK via new-hard-blocker");
  writeMigration("20260413_git_hb", `DROP TABLE "User";\n`);
  {
    const r = await callRun({ baselineRef: "HEAD" });
    console.log("  changeVerdict:", r.changeVerdict, "reason:", r.changeVerdictReason);
    console.log("  new:", r.baseline.newFindings.map((f) => f.fingerprint));
    assert(r.changeVerdict === "BLOCK", "new hard blocker → change verdict BLOCK");
    assert(r.changeVerdictReason === "new-hard-blocker", "reason=new-hard-blocker");
    assert(
      r.baseline.newFindings.some((f) => f.fingerprint === "prisma:drop-table:User"),
      "prisma:drop-table:User in newFindings",
    );
  }
  resetPrismaState(["20260413_git_hb"]);

  section("50) git-ref — resolved finding (baseline had it, current removed it)");
  const callbackRestored = readFileSync(CALLBACK, "utf8");
  writeFileSync(
    CALLBACK,
    callbackRestored.replace(/export const legacyCallback = \{[\s\S]*?\};\n/, ""),
  );
  try {
    const r = await callRun({ baselineRef: "HEAD" });
    console.log(
      "  resolved:",
      r.baseline.resolvedFindings.map((f) => f.fingerprint),
    );
    assert(
      r.baseline.resolvedFindings.some(
        (f) => f.fingerprint === "oauth:unexpected:old-staging.example.com",
      ),
      "legacyCallback off-allowlist redirect disappears → resolvedFindings",
    );
  } finally {
    writeFileSync(CALLBACK, callbackRestored);
  }

  section("51) git-ref — baselineRef beats baselinePath (precedence)");
  writeFileSync(
    BOGUS_BASELINE,
    JSON.stringify(
      { version: 1, createdAt: "2020-01-01T00:00:00Z", score: 0, verdict: "GO", findings: [] },
      null,
      2,
    ),
  );
  try {
    const r = await callRun({
      baselineRef: "HEAD",
      baselinePath: "bogus-baseline.json",
    });
    console.log("  baselineSource:", r.baselineSource);
    assert(r.baselineSource === "git-ref", "git-ref wins over file-mode baseline");
    assert(
      r.baselineResolvedRef && r.baselineResolvedRef.length >= 7,
      "real sha (not bogus-baseline contents)",
    );
  } finally {
    if (existsSync(BOGUS_BASELINE)) unlinkSync(BOGUS_BASELINE);
  }

  section("52) git-ref — markdown report surfaces 'Compared against' + sha");
  {
    const r = await callRun({ baselineRef: "HEAD", report: "markdown" });
    const shortSha = r.baselineResolvedRef.slice(0, 10);
    assert(typeof r.reportMarkdown === "string", "markdown rendered");
    assert(r.reportMarkdown.includes("Compared against"), "report has 'Compared against'");
    assert(r.reportMarkdown.includes("`HEAD`"), "report shows displayRef HEAD");
    assert(r.reportMarkdown.includes(shortSha), "report shows short sha");
  }

  section("53) git-ref — persisting findings carry stable fingerprints");
  {
    const r = await callRun({ baselineRef: "HEAD" });
    const persistingFps = new Set(r.baseline.persistingFindings.map((f) => f.fingerprint));
    console.log("  persisting sample:", [...persistingFps].slice(0, 6));
    assert(
      persistingFps.has("oauth:unexpected:old-staging.example.com"),
      "off-allowlist oauth finding is present in both",
    );
    assert(
      persistingFps.has("oauth:localhost:src/auth/callback.ts"),
      "localhost oauth finding is present in both",
    );
    assert(r.baseline.resolvedFindings.length === 0, "no resolvedFindings in default state");
  }

  // ============================================================
  //  Suppression expiry scenarios (54–62)
  //  Dates are obviously-past (2020) / obviously-future (2099),
  //  so tests don't depend on clock injection.
  // ============================================================

  const SUP_CFG = join(FIXTURE, "deploy-rehearsal.sup.json");
  const baseCfgForSup = JSON.parse(readFileSync(join(FIXTURE, "deploy-rehearsal.config.json"), "utf8"));
  function writeSupConfig(suppress) {
    const cfg = { ...baseCfgForSup, suppress };
    writeFileSync(SUP_CFG, JSON.stringify(cfg, null, 2));
  }
  function cleanupSup() {
    if (existsSync(SUP_CFG)) unlinkSync(SUP_CFG);
  }
  async function runWithSuppress() {
    return await callRun({ configPath: "deploy-rehearsal.sup.json" });
  }
  function hasFinding(r, fingerprint) {
    return (r.findings ?? []).some((f) => f.fingerprint === fingerprint);
  }

  section("54) suppression-string-remains-indefinite");
  writeSupConfig(["preflight:ci-config"]);
  {
    const r = await runWithSuppress();
    console.log("  active:", r.suppressionStatus.active.length, "expired:", r.suppressionStatus.expired.length);
    assert(!hasFinding(r, "preflight:ci-config"), "string form suppresses the finding");
    assert(
      r.suppressionStatus.active.some((a) => a.target === "preflight:ci-config" && !a.until),
      "string entry shows as active (indefinite)",
    );
    assert(r.suppressionStatus.expired.length === 0, "no expired entries");
  }
  cleanupSup();

  section("55) suppression-fingerprint-until-active");
  writeSupConfig([{ fingerprint: "preflight:ci-config", until: "2099-01-01", reason: "pending ci setup" }]);
  {
    const r = await runWithSuppress();
    assert(!hasFinding(r, "preflight:ci-config"), "finding is suppressed (until is in the future)");
    const entry = r.suppressionStatus.active.find((a) => a.target === "preflight:ci-config");
    assert(entry && entry.until === "2099-01-01", "active entry carries until");
    assert(entry && entry.reason === "pending ci setup", "reason preserved");
  }
  cleanupSup();

  section("56) suppression-fingerprint-until-expired");
  writeSupConfig([{ fingerprint: "preflight:ci-config", until: "2020-01-01", reason: "expired rule" }]);
  {
    const r = await runWithSuppress();
    assert(hasFinding(r, "preflight:ci-config"), "expired suppression: finding reappears in findings");
    assert(r.suppressionStatus.active.length === 0, "no active entries");
    const exp = r.suppressionStatus.expired.find((e) => e.target === "preflight:ci-config");
    assert(exp && exp.until === "2020-01-01", "expired list contains the entry");
  }
  cleanupSup();

  section("57) suppression-id-until-active");
  writeSupConfig([{ id: "oauth:localhost:src/auth/callback.ts:3", until: "2099-01-01" }]);
  {
    const r = await runWithSuppress();
    const stillPresent = (r.findings ?? []).some(
      (f) => f.id === "oauth:localhost:src/auth/callback.ts:3",
    );
    console.log("  oauth:localhost:callback.ts:3 present after id-suppress?", stillPresent);
    assert(!stillPresent, "finding with matching id is suppressed");
    const entry = r.suppressionStatus.active.find((a) => a.kind === "id");
    assert(entry && entry.until === "2099-01-01", "id-kind active entry reported");
  }
  cleanupSup();

  section("58) suppression-id-until-expired");
  writeSupConfig([{ id: "oauth:localhost:src/auth/callback.ts:3", until: "2020-01-01" }]);
  {
    const r = await runWithSuppress();
    const stillPresent = (r.findings ?? []).some(
      (f) => f.id === "oauth:localhost:src/auth/callback.ts:3",
    );
    assert(stillPresent, "expired id-suppress: finding reappears");
    assert(
      r.suppressionStatus.expired.some((e) => e.kind === "id"),
      "id-kind expired entry reported",
    );
  }
  cleanupSup();

  section("59) suppression-fingerprint-precedence-over-id");
  writeSupConfig([
    {
      fingerprint: "preflight:ci-config",
      id: "this-id-should-not-matter",
      until: "2099-01-01",
    },
  ]);
  {
    const r = await runWithSuppress();
    const entry = r.suppressionStatus.active.find((a) => a.target === "preflight:ci-config");
    console.log("  entry.kind:", entry?.kind);
    assert(entry && entry.kind === "fingerprint", "kind resolves to fingerprint when both set");
    assert(!hasFinding(r, "preflight:ci-config"), "finding suppressed by fingerprint");
  }
  cleanupSup();

  section("60) suppression-invalid-date-reported");
  writeSupConfig([{ fingerprint: "preflight:ci-config", until: "2026-13-99" }]);
  {
    const r = await runWithSuppress();
    assert(
      hasFinding(r, "preflight:ci-config"),
      "invalid-date entry does not suppress — finding present",
    );
    const inv = r.suppressionStatus.invalid.find(
      (i) => i.target === "preflight:ci-config" && i.reason === "invalid-date",
    );
    assert(inv, "invalid-date entry reported");
    const missing = r.suppressionStatus.invalid.find((i) => !i.target);
    assert(!missing, "no bogus missing-target entry");
  }
  cleanupSup();

  section("61) suppression-report-lists-expired-entries (markdown)");
  writeSupConfig([
    { fingerprint: "preflight:ci-config", until: "2020-01-01", reason: "expired rule" },
    { fingerprint: "env:divergent:DATABASE_URL", until: "2099-01-01" },
  ]);
  {
    const r = await rpc("tools/call", {
      name: "run_rehearsal",
      arguments: { cwd: FIXTURE, configPath: "deploy-rehearsal.sup.json", report: "markdown" },
    });
    const reh = parseToolResult(r);
    assert(typeof reh.reportMarkdown === "string", "markdown rendered");
    assert(reh.reportMarkdown.includes("Suppression status"), "report has section");
    assert(reh.reportMarkdown.includes("Active"), "has Active subsection");
    assert(reh.reportMarkdown.includes("Expired"), "has Expired subsection");
    assert(reh.reportMarkdown.includes("preflight:ci-config"), "expired target mentioned");
    assert(reh.reportMarkdown.includes("2020-01-01"), "expired date mentioned");
  }
  cleanupSup();

  section("62) suppression-multiple-rules-any-active-wins");
  writeSupConfig([
    { fingerprint: "preflight:ci-config", until: "2020-01-01" },
    "preflight:ci-config",
  ]);
  {
    const r = await runWithSuppress();
    assert(
      !hasFinding(r, "preflight:ci-config"),
      "expired rule AND active string rule → still suppressed (any active wins)",
    );
    assert(
      r.suppressionStatus.active.some((a) => a.target === "preflight:ci-config"),
      "string form is in active",
    );
    assert(
      r.suppressionStatus.expired.some((e) => e.target === "preflight:ci-config"),
      "explicit expired entry still reported for visibility",
    );
  }
  cleanupSup();

  // ============================================================
  //  Suppression provenance + breakdown scenarios (63–68)
  // ============================================================

  function writeSupConfigFull(patch) {
    const cfg = { ...baseCfgForSup, ...patch };
    writeFileSync(SUP_CFG, JSON.stringify(cfg, null, 2));
  }
  function findAudit(r, predicate) {
    return (r.suppressedFindings ?? []).find(predicate);
  }

  section("63) suppression-provenance-fingerprint (object → kind=fingerprint)");
  writeSupConfig([{ fingerprint: "preflight:ci-config", until: "2099-01-01", reason: "pending" }]);
  {
    const r = await runWithSuppress();
    const audit = findAudit(r, (a) => a.fingerprint === "preflight:ci-config");
    console.log("  audit:", audit && { kind: audit.suppressedBy.kind, target: audit.suppressedBy.target, until: audit.suppressedBy.until });
    assert(audit, "audit entry exists for the suppressed finding");
    assert(audit.suppressedBy.kind === "fingerprint", "kind=fingerprint");
    assert(audit.suppressedBy.target === "preflight:ci-config", "target preserved");
    assert(audit.suppressedBy.until === "2099-01-01", "until propagated");
    assert(audit.suppressedBy.reason === "pending", "reason propagated");
  }
  cleanupSup();

  section("64) suppression-provenance-id (object → kind=id)");
  writeSupConfig([{ id: "oauth:localhost:src/auth/callback.ts:3", until: "2099-01-01" }]);
  {
    const r = await runWithSuppress();
    const audit = findAudit(r, (a) => a.id === "oauth:localhost:src/auth/callback.ts:3");
    console.log("  audit:", audit && { kind: audit.suppressedBy.kind, target: audit.suppressedBy.target });
    assert(audit, "audit entry exists");
    assert(audit.suppressedBy.kind === "id", "kind=id");
    assert(audit.suppressedBy.target === "oauth:localhost:src/auth/callback.ts:3", "target=id");
  }
  cleanupSup();

  section("65) suppression-provenance-string (string → kind=string)");
  writeSupConfig(["preflight:ci-config"]);
  {
    const r = await runWithSuppress();
    const audit = findAudit(r, (a) => a.fingerprint === "preflight:ci-config");
    console.log("  audit:", audit && { kind: audit.suppressedBy.kind, target: audit.suppressedBy.target });
    assert(audit, "audit entry exists");
    assert(audit.suppressedBy.kind === "string", "kind=string for legacy bare-string entry");
    assert(audit.suppressedBy.target === "preflight:ci-config", "target preserved");
    assert(audit.suppressedBy.until === undefined, "no until for string form");
  }
  cleanupSup();

  section("66) suppression-precedence-fingerprint-object-beats-string");
  writeSupConfig([
    { fingerprint: "preflight:ci-config", until: "2099-01-01", reason: "object wins" },
    "preflight:ci-config",
  ]);
  {
    const r = await runWithSuppress();
    const audit = findAudit(r, (a) => a.fingerprint === "preflight:ci-config");
    assert(audit, "audit entry exists");
    assert(audit.suppressedBy.kind === "fingerprint", "object-fp wins over string for same target");
    assert(audit.suppressedBy.reason === "object wins", "reason from object entry");
  }
  cleanupSup();

  section("67) suppression-precedence-id-object-beats-string-via-fingerprint");
  // For oauth:localhost on callback.ts:3:
  //   id  = oauth:localhost:src/auth/callback.ts:3
  //   fp  = oauth:localhost:src/auth/callback.ts
  // Two competing rules:
  //   - object {id: ...} matches via activeIds (kind=id)
  //   - string "<fp>"   matches via activeFingerprints (kind=string)
  // Per spec: object-id beats string regardless of which map.
  writeSupConfig([
    { id: "oauth:localhost:src/auth/callback.ts:3", until: "2099-01-01", reason: "id wins" },
    "oauth:localhost:src/auth/callback.ts",
  ]);
  {
    const r = await runWithSuppress();
    const audit = findAudit(r, (a) => a.id === "oauth:localhost:src/auth/callback.ts:3");
    console.log("  audit kind:", audit && audit.suppressedBy.kind);
    assert(audit, "audit entry exists");
    assert(audit.suppressedBy.kind === "id", "object-id wins over string-via-fingerprint");
    assert(audit.suppressedBy.reason === "id wins", "reason from id object");
  }
  cleanupSup();

  section("68) suppression-breakdown-splits-ignore-vs-rules");
  // ignorePatterns hides everything under src/ → matches callback.ts findings.
  // suppress[] rule hides preflight:ci-config.
  writeSupConfigFull({
    suppress: ["preflight:ci-config"],
    ignorePatterns: ["src/**"],
  });
  {
    const r = await runWithSuppress();
    const b = r.suppressedBreakdown;
    console.log("  breakdown:", b);
    assert(b.rules >= 1, "rules counter incremented (preflight:ci-config)");
    assert(b.ignorePatterns >= 1, "ignorePatterns counter incremented (src/** matches)");
    assert(r.suppressedCount === b.rules + b.ignorePatterns, "total = sum");
  }
  cleanupSup();

  // ============================================================
  //  Next.js detector v2 scenarios (69–76)
  // ============================================================

  resetNextjsState();

  section("69) nextjs-v2-server-action-drift-detected");
  writeSource(
    "app/settings/PasswordReset.tsx",
    `"use client";\n\nimport { useState } from "react";\n\nexport async function resetPassword(formData) {\n  "use server";\n  return fetch("/api/reset", { method: "POST", body: formData });\n}\n\nexport default function PasswordReset() {\n  const [email, setEmail] = useState("");\n  return <form action={resetPassword}><input value={email} /></form>;\n}\n`,
  );
  {
    const r = await callRun();
    const nx = nextjsFindings(r);
    console.log("  findings:", nx.map((f) => f.fingerprint));
    assert(
      nx.some((f) => f.fingerprint === "nextjs:server-action-drift:app/settings/PasswordReset.tsx"),
      "use client + use server in same file is flagged",
    );
  }
  resetNextjsState([], ["app/settings"]);

  section("70) nextjs-v2-server-action-drift-hard-blocker");
  writeSource(
    "app/admin/DangerForm.tsx",
    `"use client";\nexport async function deleteEverything() {\n  "use server";\n  return null;\n}\n`,
  );
  {
    const r = await callRun();
    const nx = nextjsFindings(r);
    assert(
      nx.some((f) => f.fingerprint === "nextjs:server-action-drift:app/admin/DangerForm.tsx" && f.severity === "high"),
      "server-action-drift severity=high",
    );
    assert(
      r.hardBlockers.some((f) => f.fingerprint.startsWith("nextjs:server-action-drift:")),
      "server-action-drift is in hardBlockers",
    );
  }
  resetNextjsState([], ["app/admin"]);

  section("71) nextjs-v2-server-action-only-no-false-positive");
  writeSource(
    "app/actions/delete.ts",
    `"use server";\nexport async function deleteItem(id) {\n  return { ok: true, id };\n}\n`,
  );
  {
    const r = await callRun();
    const nx = nextjsFindings(r);
    console.log("  findings:", nx.map((f) => f.fingerprint));
    assert(
      !nx.some((f) => f.fingerprint.startsWith("nextjs:server-action-drift:")),
      "`use server` alone (no `use client`) → no drift finding",
    );
  }
  resetNextjsState([], ["app/actions"]);

  section("72) nextjs-v2-isr-revalidate-with-force-dynamic");
  writeSource(
    "app/blog/page.tsx",
    `export const dynamic = "force-dynamic";\nexport const revalidate = 60;\n\nexport default function BlogPage() { return <div>blog</div>; }\n`,
  );
  {
    const r = await callRun();
    const nx = nextjsFindings(r);
    console.log("  findings:", nx.map((f) => f.fingerprint));
    assert(
      nx.some((f) => f.fingerprint === "nextjs:isr-revalidate-conflict:revalidate-ignored-under-force-dynamic:/blog"),
      "force-dynamic + revalidate conflict is flagged at /blog",
    );
    const finding = nx.find((f) => f.fingerprint.startsWith("nextjs:isr-revalidate-conflict:"));
    assert(finding.severity === "warn", "ISR conflict is warn, not hard-blocker");
  }
  resetNextjsState([], ["app/blog"]);

  section("73) nextjs-v2-isr-revalidate-zero-with-force-static");
  writeSource(
    "app/docs/page.tsx",
    `export const dynamic = "force-static";\nexport const revalidate = 0;\n\nexport default function DocsPage() { return <div>docs</div>; }\n`,
  );
  {
    const r = await callRun();
    const nx = nextjsFindings(r);
    assert(
      nx.some((f) => f.fingerprint === "nextjs:isr-revalidate-conflict:revalidate-zero-under-force-static:/docs"),
      "force-static + revalidate=0 conflict is flagged at /docs",
    );
  }
  resetNextjsState([], ["app/docs"]);

  section("74) nextjs-v2-isr-revalidate-no-conflict-no-false-positive");
  writeSource(
    "app/posts/page.tsx",
    `export const revalidate = 3600;\n\nexport default function PostsPage() { return <div>posts</div>; }\n`,
  );
  {
    const r = await callRun();
    const nx = nextjsFindings(r);
    console.log("  findings:", nx.map((f) => f.fingerprint));
    assert(
      !nx.some((f) => f.fingerprint.startsWith("nextjs:isr-revalidate-conflict:")),
      "revalidate alone with no dynamic=force-* → no conflict",
    );
  }
  resetNextjsState([], ["app/posts"]);

  section("75) nextjs-v2-standalone-dockerfile-without-output");
  writeSource(
    "Dockerfile",
    `FROM node:20-alpine AS builder\nWORKDIR /app\nCOPY . .\nRUN npm ci && npm run build\n\nFROM node:20-alpine\nWORKDIR /app\nCOPY --from=builder /app/.next/standalone ./\nCOPY --from=builder /app/.next/static ./.next/static\nCMD [\"node\", \"server.js\"]\n`,
  );
  {
    const r = await callRun();
    const nx = nextjsFindings(r);
    console.log("  findings:", nx.map((f) => f.fingerprint));
    assert(
      nx.some((f) => f.fingerprint === "nextjs:standalone-output-missing"),
      "Dockerfile referencing `.next/standalone` + next.config without `output: 'standalone'` is flagged",
    );
  }
  resetNextjsState(["Dockerfile"]);

  section("76) nextjs-v2-standalone-dockerfile-with-output-no-false-positive");
  writeSource(
    "Dockerfile",
    `FROM node:20-alpine AS builder\nWORKDIR /app\nCOPY . .\nRUN npm ci && npm run build\n\nFROM node:20-alpine\nWORKDIR /app\nCOPY --from=builder /app/.next/standalone ./\nCMD [\"node\", \"server.js\"]\n`,
  );
  // Modify next.config to include output: 'standalone'
  modifyTracked(
    "next.config.js",
    NEXT_CONFIG_ORIGINAL.replace(
      "reactStrictMode: true,",
      "reactStrictMode: true,\n  output: 'standalone',",
    ),
  );
  {
    const r = await callRun();
    const nx = nextjsFindings(r);
    console.log("  findings:", nx.map((f) => f.fingerprint));
    assert(
      !nx.some((f) => f.fingerprint === "nextjs:standalone-output-missing"),
      "Dockerfile + next.config with output='standalone' → no finding",
    );
  }
  resetNextjsState(["Dockerfile"]);

  section("45) Next.js — auth-impacting rewrite in next.config → BLOCK via weight+severity");
  modifyTracked(
    "next.config.js",
    NEXT_CONFIG_ORIGINAL.replace(
      "module.exports = nextConfig;",
      `nextConfig.rewrites = async () => [\n  { source: "/login", destination: "/api/auth/signin" },\n];\nmodule.exports = nextConfig;`,
    ),
  );
  {
    const r = await callRun();
    const nx = nextjsFindings(r);
    console.log("  findings:", nx.map((f) => `${f.fingerprint} (${f.severity})`));
    assert(
      nx.some(
        (f) =>
          f.fingerprint === "nextjs:auth-rewrite-risk:/login->/api/auth/signin" &&
          f.severity === "high",
      ),
      "auth-rewrite-risk fingerprint carries source->destination",
    );
  }
  resetNextjsState();

  section("RESULT");
  if (process.exitCode) {
    console.log("  ❌ Some assertions failed.");
  } else {
    console.log("  ✅ All assertions passed.");
  }
  child.stdin.end();
  setTimeout(() => process.exit(process.exitCode ?? 0), 200);
}

main().catch((e) => {
  console.error("FATAL:", e);
  console.error("stderr:", stderrBuf);
  child.kill();
  process.exit(1);
});
