#!/usr/bin/env node
// Regenerates canonical landing-page assets by actually running the engine.
// Writes under docs/landing-assets/. Safe to re-run anytime after `npm run build`.
//
// Outputs:
//   comment-block.md    — fixture as-is (hard blockers fire)
//   comment-caution.md  — fixture + explicit suppressions for hard blockers
//   comment-go.md       — minimal clean repo (no findings)

import { runRehearsal } from "../dist/tools/runRehearsal.js";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  mkdtempSync,
  existsSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(__dirname);
const FIXTURE = join(ROOT, "test", "fixture");
const OUT = join(ROOT, "docs", "landing-assets");
mkdirSync(OUT, { recursive: true });

// Prime fixture to a deterministic state (same priming as test/e2e.mjs).
const CALLBACK = join(FIXTURE, "src", "auth", "callback.ts");
const ENV_PROD = join(FIXTURE, ".env.production");
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

function summaryHeader(r) {
  const v = r.verdict;
  const badge = v === "GO" ? "✅" : v === "CAUTION" ? "⚠️" : "⛔";
  const cv = r.changeVerdict
    ? `\n**Change verdict:** ${r.changeVerdict}${r.changeVerdictReason ? ` _(${r.changeVerdictReason})_` : ""}`
    : "";
  const ref = r.baselineDisplayRef
    ? `\n**Compared against:** \`${r.baselineDisplayRef}\` @ \`${(r.baselineResolvedRef ?? "").slice(0, 10)}\` _(mode: ${r.baselineMode})_`
    : r.baselineError
      ? `\n**Baseline unavailable:** \`${r.baselineError.reason}\` — ${r.baselineError.detail ?? ""}`
      : "";
  return `${badge} **${v}** — score ${r.score} _(via ${r.verdictReason})_${cv}${ref}`;
}

function sanitize(md, cwd) {
  if (!md) return md;
  const normCwd = cwd.replace(/\\/g, "/");
  const normMd = md.replace(/\\/g, "/");
  // Strip absolute cwd paths, leave just the filename for config references.
  return normMd
    .replaceAll(normCwd + "/", "")
    .replaceAll(normCwd, ".")
    // Collapse any remaining absolute temp paths into `./<basename>`
    .replace(/`[A-Z]:\/[^`]+\/([^`\/]+\.json)`/gi, "`./$1`");
}

function writeComment(name, scenario, result, cwd) {
  const body = [
    `<!-- canonical landing-page asset · ${name} · regenerate via: node scripts/render-demo-comments.mjs -->`,
    "",
    "<!--",
    "This file is the exact body that the GitHub Action posts as a PR comment,",
    "with the internal `<!-- deploy-rehearsal-mcp:pr-comment -->` marker stripped",
    "for readability. Regenerate with the script above.",
    "-->",
    "",
    `> **Scenario:** ${scenario}`,
    "",
    summaryHeader(result),
    "",
    sanitize(result.reportMarkdown ?? "_(engine returned no markdown body)_", cwd),
    "",
  ].join("\n");
  writeFileSync(join(OUT, `comment-${name}.md`), body);
  console.log(
    `  wrote comment-${name}.md   verdict=${result.verdict}  score=${result.score}  findings=${result.findings.length}`,
  );
}

async function renderBlock() {
  const r = await runRehearsal({
    cwd: FIXTURE,
    baselineRef: "HEAD",
    baselineRefMode: "direct",
    report: "markdown",
  });
  writeComment(
    "block",
    "A PR that introduces a `DROP TABLE` migration plus an uncommitted `sk_live_…` token. The hard-blocker rule fires before the score threshold even matters.",
    r,
    FIXTURE,
  );
}

async function renderCaution() {
  const baseCfg = JSON.parse(readFileSync(join(FIXTURE, "deploy-rehearsal.config.json"), "utf8"));
  const overlayPath = join(FIXTURE, "deploy-rehearsal.demo-caution.json");
  writeFileSync(
    overlayPath,
    JSON.stringify(
      {
        ...baseCfg,
        suppress: [
          ...(baseCfg.suppress ?? []),
          {
            fingerprint: "secret:blocked:sk_live_[A-Za-z0-9]+",
            until: "2099-01-01",
            reason: "Test token used during a fire-drill — already rotated.",
          },
          {
            fingerprint: "env:empty:NEXTAUTH_SECRET",
            until: "2099-01-01",
            reason: "Set in Vercel secret manager, not checked into .env.production.",
          },
          {
            fingerprint: "env:missing:GOOGLE_CLIENT_SECRET",
            until: "2099-01-01",
            reason: "Set in secret manager for prod.",
          },
          {
            fingerprint: "env:required:DOES_NOT_EXIST_ANYWHERE",
            until: "2099-01-01",
            reason: "Demo key — stubbed until INGEST-142 lands.",
          },
          {
            fingerprint: "diff:auth:src/auth/callback.ts",
            until: "2099-01-01",
            reason: "Intentional: touching auth for the OAuth cleanup epic. Re-review in PR.",
          },
          {
            fingerprint: "oauth:http:http://old-staging.example.com/cb",
            until: "2099-01-01",
            reason: "Legacy redirect removed in follow-up PR INGEST-143.",
          },
          {
            fingerprint: "oauth:unexpected:old-staging.example.com",
            until: "2099-01-01",
            reason: "Same legacy redirect, different rule.",
          },
          {
            fingerprint: "env:missing:DEBUG",
            until: "2099-01-01",
            reason: "DEBUG is dev-only — intentional gap.",
          },
          {
            fingerprint: "env:empty:DEBUG",
            until: "2099-01-01",
            reason: "Empty DEBUG in dev is intentional.",
          },
          {
            fingerprint: "env:missing:SENTRY_DSN",
            until: "2099-01-01",
            reason: "Sentry is prod-only.",
          },
        ],
      },
      null,
      2,
    ),
  );
  try {
    const r = await runRehearsal({
      cwd: FIXTURE,
      configPath: "deploy-rehearsal.demo-caution.json",
      baselineRef: "HEAD",
      baselineRefMode: "direct",
      report: "markdown",
    });
    writeComment(
      "caution",
      "Same PR as BLOCK, but the team has already tagged the obvious hard-blockers with explicit `suppress` rules — each with a `reason` and an `until` date. Remaining risk is still real, just softer.",
      r,
      FIXTURE,
    );
  } finally {
    rmSync(overlayPath, { force: true });
  }
}

async function renderGo() {
  const tmp = mkdtempSync(join(tmpdir(), "deploy-rehearsal-demo-go-"));
  try {
    const git = (args) =>
      execFileSync("git", args, {
        cwd: tmp,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "demo",
          GIT_AUTHOR_EMAIL: "demo@example.com",
          GIT_COMMITTER_NAME: "demo",
          GIT_COMMITTER_EMAIL: "demo@example.com",
        },
      });
    git(["init", "-q"]);
    writeFileSync(
      join(tmp, "package.json"),
      JSON.stringify(
        {
          name: "demo-app",
          version: "0.1.0",
          scripts: { build: "tsc", test: "vitest" },
        },
        null,
        2,
      ),
    );
    writeFileSync(
      join(tmp, "package-lock.json"),
      JSON.stringify({ name: "demo-app", version: "0.1.0", lockfileVersion: 3, packages: {} }, null, 2),
    );
    writeFileSync(join(tmp, ".gitignore"), "node_modules/\n.env\n.env.*\n!.env.example\n");
    writeFileSync(
      join(tmp, ".env.example"),
      "# document required env here — real values go in your secret manager.\nDATABASE_URL=\nNEXTAUTH_URL=\nNEXTAUTH_SECRET=\n",
    );
    mkdirSync(join(tmp, ".github", "workflows"), { recursive: true });
    writeFileSync(
      join(tmp, ".github", "workflows", "ci.yml"),
      [
        "name: CI",
        "on: [pull_request]",
        "jobs:",
        "  test:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - uses: actions/checkout@v4",
        "      - run: npm test",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(tmp, "deploy-rehearsal.config.json"),
      JSON.stringify(
        {
          thresholds: { block: 90, caution: 25 },
          allowedDomains: ["myapp.com"],
        },
        null,
        2,
      ),
    );
    git(["add", "-A"]);
    git(["-c", "commit.gpgsign=false", "commit", "-q", "-m", "seed clean repo"]);

    const r = await runRehearsal({
      cwd: tmp,
      baselineRef: "HEAD",
      baselineRefMode: "direct",
      report: "markdown",
    });
    writeComment(
      "go",
      "A small, well-structured PR — nothing destructive, no env drift, no Next.js / Prisma risks. This is what a healthy change looks like.",
      r,
      tmp,
    );
  } finally {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  }
}

async function main() {
  console.log("rendering landing assets → " + OUT);
  await renderBlock();
  await renderCaution();
  await renderGo();
  console.log("done.");
}

main().catch((e) => {
  console.error("render failed:", e?.stack ?? e);
  process.exit(1);
});
