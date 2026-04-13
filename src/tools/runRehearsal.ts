import { resolve } from "node:path";
import { analyzeDiff, type AnalyzeDiffResult } from "./analyzeDiff.js";
import { compareEnv, type CompareEnvResult } from "./compareEnv.js";
import { checkOAuth, type CheckOAuthResult } from "./checkOAuth.js";
import { preflightChecklist, type PreflightResult } from "./preflightChecklist.js";
import { loadConfig, matchesIgnore, type RehearsalConfig } from "../lib/config.js";
import {
  resolveSuppressions,
  matchSuppression,
  publicStatus,
  todayString,
  type ResolvedSuppression,
  type SuppressionSet,
  type SuppressionStatus,
} from "../lib/suppression.js";

export interface SuppressionMatch {
  kind: "fingerprint" | "id" | "string";
  target: string;
  until?: string;
  reason?: string;
}

export interface SuppressedFindingAudit {
  id: string;
  fingerprint: string;
  category: string;
  severity: "info" | "warn" | "high";
  suppressedBy: SuppressionMatch;
}

export interface SuppressedBreakdown {
  ignorePatterns: number;
  rules: number;
}

function toSuppressionMatch(r: ResolvedSuppression): SuppressionMatch {
  return {
    kind: r.kind,
    target: r.target,
    ...(r.until ? { until: r.until } : {}),
    ...(r.reason ? { reason: r.reason } : {}),
  };
}
import {
  getDiffPatch,
  getFilePatch,
  resolveRef,
  mergeBase,
  createWorktree,
  removeWorktree,
  isShallowRepo,
  isGitRepo,
} from "../lib/git.js";
import { renderMarkdownReport } from "../lib/report.js";
import { detectPrisma } from "../detectors/prisma.js";
import { detectNextjs } from "../detectors/nextjs.js";
import {
  loadBaseline,
  saveBaseline,
  compareBaseline,
  type BaselineComparison,
  type BaselineError,
  type BaselineSnapshot,
  type Verdict,
} from "../lib/baseline.js";

export interface Finding {
  id: string;
  fingerprint: string;
  severity: "info" | "warn" | "high";
  category: string;
  message: string;
  evidence: Record<string, unknown>;
  suggestion?: string;
  confidence: number;
  weight?: number;
  /** Set only on entries inside `suppressedFindings` audit array, never on entries inside `findings`. */
  suppressedBy?: SuppressionMatch;
}

export interface RunRehearsalInput {
  cwd: string;
  baseRef?: string;
  headRef?: string;
  envFiles?: string[];
  configPath?: string;
  report?: "none" | "markdown";
  baselinePath?: string;
  saveBaseline?: boolean;
  baselineRef?: string;
  baselineRefMode?: "direct" | "merge-base";
}

export interface RunRehearsalResult {
  verdict: Verdict;
  verdictReason: "hard-blocker" | "score" | "clean";
  score: number;
  thresholds: { block: number; caution: number };
  branch?: string;
  blockers: Finding[];
  hardBlockers: Finding[];
  warnings: Finding[];
  findings: Finding[];
  suppressedCount: number;
  configSource: string;
  sections: {
    diff: AnalyzeDiffResult;
    env: CompareEnvResult | null;
    oauth: CheckOAuthResult;
    preflight: PreflightResult;
  };
  baseline?: BaselineComparison;
  baselineSource?: "file" | "git-ref";
  baselineDisplayRef?: string;
  baselineResolvedRef?: string;
  baselineMode?: "direct" | "merge-base";
  baselineError?: BaselineError;
  changeVerdict?: Verdict;
  changeVerdictReason?: "new-hard-blocker" | "delta-score" | "clean";
  baselineSaved?: { path: string };
  suppressionStatus: SuppressionStatus;
  suppressedBreakdown: SuppressedBreakdown;
  suppressedFindings: SuppressedFindingAudit[];
  reportMarkdown?: string;
}

export interface CoreAnalysis {
  findings: Finding[];
  score: number;
  verdict: Verdict;
  verdictReason: "hard-blocker" | "score" | "clean";
  blockers: Finding[];
  hardBlockers: Finding[];
  warnings: Finding[];
  suppressedCount: number;
  suppressedBreakdown: SuppressedBreakdown;
  suppressedFindings: SuppressedFindingAudit[];
  sections: {
    diff: AnalyzeDiffResult;
    env: CompareEnvResult | null;
    oauth: CheckOAuthResult;
    preflight: PreflightResult;
  };
  branch?: string;
}

const BASE_SEVERITY_SCORE = { info: 2, warn: 10, high: 25 } as const;

const FINGERPRINT_TO_KIND: Array<[RegExp, string]> = [
  [/^prisma:drop-table:/, "dropTable"],
  [/^prisma:drop-column:/, "dropColumn"],
  [/^prisma:truncate:/, "truncate"],
  [/^prisma:set-not-null:/, "setNotNull"],
  [/^prisma:alter-type:/, "alterType"],
  [/^prisma:add-unique:/, "addUnique"],
  [/^prisma:create-unique-index:/, "createUniqueIndex"],
  [/^prisma:drop-index:/, "dropIndex"],
  [/^prisma:rename-column:/, "renameColumn"],
  [/^prisma:rename-table:/, "renameTable"],
  [/^prisma:provider-changed/, "providerChanged"],
  [/^prisma:provider-mismatch:/, "providerMismatch"],
  [/^prisma:schema-drift:no-migration/, "schemaDriftNoMigration"],
  [/^prisma:schema-drift:migration-without-schema/, "migrationWithoutSchema"],
  [/^nextjs:public-secret:/, "publicSecretExposure"],
  [/^nextjs:public-suspicious:/, "publicSuspiciousExposure"],
  [/^nextjs:client-env-access:/, "clientEnvAccessSecret"],
  [/^nextjs:edge-node-api:/, "edgeNodeApiMismatch"],
  [/^nextjs:edge-prisma:/, "edgePrismaUsage"],
  [/^nextjs:matcher-shrunk:/, "matcherShrunk"],
  [/^nextjs:middleware-unprotected:/, "middlewareUnprotectedCriticalRoute"],
  [/^nextjs:images-remote-patterns-shrunk:/, "imagesRemotePatternsShrunk"],
  [/^nextjs:auth-rewrite-risk/, "authRewriteOrRedirectRisk"],
  [/^nextjs:auth-redirect-risk/, "authRewriteOrRedirectRisk"],
  [/^nextjs:personalized-static:/, "personalizedStatic"],
  [/^nextjs:dynamic-static-conflict:/, "dynamicStaticConflict"],
  [/^nextjs:server-action-drift:/, "serverActionDrift"],
  [/^nextjs:isr-revalidate-conflict:/, "isrRevalidateConflict"],
  [/^nextjs:standalone-output-missing/, "standaloneOutputMissing"],
  [/^nextjs:config-/, "nextConfigRisk"],
];

function kindOf(f: Finding): string | null {
  for (const [re, kind] of FINGERPRINT_TO_KIND) if (re.test(f.fingerprint)) return kind;
  return null;
}

export function isHardBlocker(f: Finding, config: import("../lib/config.js").RehearsalConfig): boolean {
  const k = kindOf(f);
  if (k === null) return false;
  if (config.prisma.hardBlockKinds.includes(k as any)) return true;
  if (config.nextjs.hardBlockKinds.includes(k as any)) return true;
  return false;
}

function baseWeight(f: Finding, config: import("../lib/config.js").RehearsalConfig): number {
  if (typeof f.weight === "number") return f.weight;
  const override = config.severityWeights[f.category];
  return typeof override === "number" ? override : BASE_SEVERITY_SCORE[f.severity];
}

function targetFromPrismaFingerprint(fp: string): string | null {
  const m = fp.match(/^prisma:[^:]+:([^:]+)/);
  return m ? m[1] : null;
}

function matchesCriticalModel(f: Finding, patterns: string[]): boolean {
  if (!f.fingerprint.startsWith("prisma:")) return false;
  const target = targetFromPrismaFingerprint(f.fingerprint);
  if (!target) return false;
  const table = target.split(".")[0].toLowerCase();
  return patterns.some((p) => table === p.toLowerCase());
}

function hasMitigatedEvidence(f: Finding): boolean {
  if (!f.evidence || typeof f.evidence !== "object") return false;
  return (f.evidence as any).mitigated === true;
}

export function computeGroupedScore(
  findings: Finding[],
  config: import("../lib/config.js").RehearsalConfig,
): number {
  const groups = new Map<string, Finding[]>();
  for (const f of findings) {
    const key = f.fingerprint;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(f);
  }
  const ratio = config.prisma.duplicateFingerprintPenaltyRatio;
  const contextBonus = config.prisma.contextBonus;
  const mitigationDiscount = config.prisma.mitigationDiscount;
  const criticalPatterns = config.prisma.criticalModelPatterns;

  let total = 0;
  for (const group of groups.values()) {
    const weights = group.map((g) => baseWeight(g, config));
    const maxW = Math.max(...weights);
    const duplicatePenalty =
      group.length > 1 ? Math.floor((group.length - 1) * maxW * ratio) : 0;
    const bonus = group.some((g) => matchesCriticalModel(g, criticalPatterns)) ? contextBonus : 0;
    const discount = group.some(hasMitigatedEvidence) ? mitigationDiscount : 0;
    const raw = maxW + duplicatePenalty + bonus - discount;
    total += Math.max(0, Math.min(100, raw));
  }
  return total;
}

function computeChangeVerdict(
  newFindings: Finding[],
  deltaScore: number,
  config: import("../lib/config.js").RehearsalConfig,
): { verdict: Verdict; reason: "new-hard-blocker" | "delta-score" | "clean" } {
  const hasNewHard = newFindings.some((f) => isHardBlocker(f, config));
  if (hasNewHard) return { verdict: "BLOCK", reason: "new-hard-blocker" };
  if (deltaScore >= config.baseline.deltaBlockThreshold) return { verdict: "BLOCK", reason: "delta-score" };
  if (deltaScore >= config.baseline.deltaCautionThreshold) return { verdict: "CAUTION", reason: "delta-score" };
  return { verdict: "GO", reason: "clean" };
}

function suggestForDiff(kind: string): string | undefined {
  switch (kind) {
    case "migration":
      return "Dry-run the migration against a prod-like snapshot. Plan for locking, backfill, and a reversible path.";
    case "schema":
      return "Confirm a migration accompanies the schema change. Check for destructive ops (DROP, NOT NULL without default).";
    case "auth":
      return "Run login, logout, token refresh, and session expiry paths in staging before shipping.";
    case "payment":
      return "Smoke test checkout, refund, and webhook delivery in test mode before deploy.";
    case "env-usage":
      return "Verify the new env var exists in every deploy target (.env, Vercel, Render, CI).";
    case "routing":
      return "Check redirects, middleware, and callers; grep the codebase for hardcoded old paths.";
    case "ci":
      return "Review pipeline locally; check secrets, build cache invalidation, and deploy target env.";
    case "lockfile":
      return "Run a clean install and full test suite. Look for transitive deps pulling in breaking changes.";
    case "secret":
      return "Verify no real secret is committed. If it was, rotate immediately.";
    default:
      return undefined;
  }
}

function suggestForPreflight(name: string): string | undefined {
  switch (name) {
    case "uncommitted":
      return "Commit or stash local changes before deploying.";
    case "build-script":
      return "Add `build` script to package.json so CI can reproduce deploy output.";
    case "test-script":
      return "Add `test` script so regressions are caught in CI.";
    case "lockfile":
      return "Commit a lockfile (package-lock.json / pnpm-lock.yaml / yarn.lock).";
    case "env-example":
      return "Create `.env.example` listing every required variable (without secrets).";
    case "env-ignored":
      return "Add `.env` and `.env.*` to .gitignore.";
    case "ci-config":
      return "Add a CI workflow (GitHub Actions) to run tests and rehearsal on every PR.";
    default:
      return undefined;
  }
}

interface SuppressionAccumulator {
  breakdown: SuppressedBreakdown;
  audit: SuppressedFindingAudit[];
}

function addFinding(
  config: RehearsalConfig,
  suppressionSet: SuppressionSet,
  findings: Finding[],
  acc: SuppressionAccumulator,
  f: Finding,
  evidencePath?: string,
) {
  if (evidencePath && matchesIgnore(config.ignorePatterns, evidencePath)) {
    acc.breakdown.ignorePatterns++;
    return;
  }
  const match = matchSuppression(f, suppressionSet);
  if (match) {
    acc.breakdown.rules++;
    acc.audit.push({
      id: f.id,
      fingerprint: f.fingerprint,
      category: f.category,
      severity: f.severity,
      suppressedBy: toSuppressionMatch(match),
    });
    return;
  }
  findings.push(f);
}

export async function runAnalysisCore(
  cwd: string,
  baseRef: string,
  headRef: string,
  config: RehearsalConfig,
  envFilesResolved: string[] | undefined,
  suppressionSet: SuppressionSet,
): Promise<CoreAnalysis> {
  const diff = await analyzeDiff({ cwd, baseRef, headRef });
  const preflight = await preflightChecklist({ cwd });
  const oauth = await checkOAuth({ cwd, expectedDomains: config.allowedDomains });

  let env: CompareEnvResult | null = null;
  const envFilesRaw = envFilesResolved;
  if (envFilesRaw && envFilesRaw.length >= 2) {
    try {
      env = await compareEnv({ files: envFilesRaw });
    } catch {
      env = null;
    }
  }

  const findings: Finding[] = [];
  const acc: SuppressionAccumulator = {
    breakdown: { ignorePatterns: 0, rules: 0 },
    audit: [],
  };

  for (const s of diff.signals) {
    for (const file of s.files) {
      addFinding(
        config,
        suppressionSet,
        findings,
        acc,
        {
          id: `diff:${s.kind}:${file}`,
          fingerprint: `diff:${s.kind}:${file}`,
          severity: s.severity,
          category: s.kind,
          message: `${s.message}`,
          evidence: { file },
          suggestion: suggestForDiff(s.kind),
          confidence: 0.8,
        },
        file,
      );
    }
  }

  if (env) {
    for (const k of env.missingKeys) {
      addFinding(config, suppressionSet, findings, acc, {
        id: `env:missing:${k.key}`,
        fingerprint: `env:missing:${k.key}`,
        severity: k.secretLike ? "high" : "warn",
        category: "env",
        message: `Env key \`${k.key}\` missing in: ${k.missingIn.join(", ")}`,
        evidence: { key: k.key, missingIn: k.missingIn },
        suggestion: `Add ${k.key} to the missing file(s), or document the intentional gap in .env.example.`,
        confidence: 0.95,
      });
    }
    for (const k of env.emptyKeys) {
      addFinding(config, suppressionSet, findings, acc, {
        id: `env:empty:${k.key}`,
        fingerprint: `env:empty:${k.key}`,
        severity: k.secretLike ? "high" : "warn",
        category: "env",
        message: `Env key \`${k.key}\` empty in: ${k.emptyIn.join(", ")}`,
        evidence: { key: k.key, emptyIn: k.emptyIn },
        suggestion: `Set a value for ${k.key} before deploy. Empty secrets crash auth/payment at runtime.`,
        confidence: 0.95,
      });
    }
    for (const k of env.divergentValues) {
      addFinding(config, suppressionSet, findings, acc, {
        id: `env:divergent:${k.key}`,
        fingerprint: `env:divergent:${k.key}`,
        severity: k.secretLike ? "warn" : "info",
        category: "env",
        message: `Env key \`${k.key}\` has different values across env files`,
        evidence: { key: k.key },
        suggestion: k.secretLike
          ? "Secrets diverging across envs is usually correct — confirm each value matches its target environment."
          : undefined,
        confidence: 0.9,
      });
    }
    for (const req of config.requiredEnvKeys) {
      const present = env.detail.find((d) => d.key === req);
      const anywhere = present && Object.values(present.presence).some((s) => s === "present");
      if (!anywhere) {
        addFinding(config, suppressionSet, findings, acc, {
          id: `env:required:${req}`,
          fingerprint: `env:required:${req}`,
          severity: "high",
          category: "env",
          message: `Required env key \`${req}\` not defined in any env file.`,
          evidence: { key: req },
          suggestion: `Add ${req} to every deploy target before shipping.`,
          confidence: 0.99,
        });
      }
    }
  }

  for (const r of oauth.localhostInNonTestFiles) {
    addFinding(
      config,
      suppressionSet,
      findings,
      acc,
      {
        id: `oauth:localhost:${r.file}:${r.line}`,
        fingerprint: `oauth:localhost:${r.file}`,
        severity: "warn",
        category: "oauth",
        message: `Localhost OAuth redirect in non-test file: ${r.url}`,
        evidence: { file: r.file, line: r.line, url: r.url },
        suggestion: "Source the redirect URI from env (e.g., NEXTAUTH_URL) instead of hardcoding localhost.",
        confidence: 0.7,
      },
      r.file,
    );
  }
  for (const r of oauth.httpOnlyRedirects) {
    addFinding(
      config,
      suppressionSet,
      findings,
      acc,
      {
        id: `oauth:http:${r.file}:${r.line}`,
        fingerprint: `oauth:http:${r.url}`,
        severity: "high",
        category: "oauth",
        message: `Plain http:// OAuth redirect: ${r.url}`,
        evidence: { file: r.file, line: r.line, url: r.url },
        suggestion: "Switch to https:// — many OAuth providers reject plain http for non-localhost.",
        confidence: 0.9,
      },
      r.file,
    );
  }
  for (const r of oauth.unexpectedDomains) {
    addFinding(
      config,
      suppressionSet,
      findings,
      acc,
      {
        id: `oauth:unexpected:${r.file}:${r.line}:${r.domain}`,
        fingerprint: `oauth:unexpected:${r.domain}`,
        severity: "warn",
        category: "oauth",
        message: `OAuth redirect to off-allowlist domain: ${r.domain}`,
        evidence: { file: r.file, line: r.line, url: r.url, domain: r.domain },
        suggestion: `Either add '${r.domain}' to allowedDomains, or remove the stale redirect.`,
        confidence: 0.85,
      },
      r.file,
    );
  }

  for (const c of preflight.checks) {
    if (c.status === "pass" || c.status === "skip") continue;
    addFinding(config, suppressionSet, findings, acc, {
      id: `preflight:${c.name}`,
      fingerprint: `preflight:${c.name}`,
      severity: c.status === "fail" ? "high" : "warn",
      category: "preflight",
      message: c.detail,
      evidence: { name: c.name },
      suggestion: suggestForPreflight(c.name),
      confidence: 0.9,
    });
  }

  {
    const schemaPatch = await getFilePatch(
      cwd,
      baseRef,
      headRef,
      config.prisma.schemaPath,
    );
    const prismaFindings = await detectPrisma({
      cwd,
      config,
      diffFiles: diff.files.map((f) => ({ path: f.path })),
      schemaDiffPatch: schemaPatch,
      envFilesResolved: envFilesRaw,
    });
    for (const f of prismaFindings) {
      const evidencePath =
        f.evidence && typeof f.evidence === "object" && "file" in f.evidence
          ? (f.evidence as any).file
          : undefined;
      addFinding(config, suppressionSet, findings, acc, f, evidencePath);
    }
  }

  {
    const nextjsFindings = await detectNextjs({
      cwd,
      config,
      diffFiles: diff.files.map((f) => ({ path: f.path })),
      envFilesResolved: envFilesRaw,
      getFilePatch: (relPath) => getFilePatch(cwd, baseRef, headRef, relPath),
    });
    for (const f of nextjsFindings) {
      const evidencePath =
        f.evidence && typeof f.evidence === "object" && "file" in f.evidence
          ? (f.evidence as any).file
          : undefined;
      addFinding(config, suppressionSet, findings, acc, f, evidencePath);
    }
  }

  if (config.blockedSecretPatterns.length > 0) {
    try {
      const patch = await getDiffPatch(cwd, baseRef, headRef, 500_000);
      const addedLines = patch
        .split("\n")
        .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
        .join("\n");
      for (const pat of config.blockedSecretPatterns) {
        let re: RegExp;
        try {
          re = new RegExp(pat, "g");
        } catch {
          continue;
        }
        const matches = addedLines.match(re);
        if (matches && matches.length > 0) {
          addFinding(config, suppressionSet, findings, acc, {
            id: `secret:blocked:${pat}`,
            fingerprint: `secret:blocked:${pat}`,
            severity: "high",
            category: "secret",
            message: `Diff adds ${matches.length} match(es) for blocked pattern /${pat}/`,
            evidence: { pattern: pat, count: matches.length },
            suggestion: "Remove the secret from the diff and rotate the key if it was pushed anywhere.",
            confidence: 0.95,
          });
        }
      }
    } catch {
      // diff unavailable — skip
    }
  }

  const score = computeGroupedScore(findings, config);
  let adjustedScore = score;
  if (diff.totalFiles > 50) adjustedScore += 10;

  const hardBlockers = findings.filter((f) => isHardBlocker(f, config));

  const { block, caution } = config.thresholds;
  let verdict: Verdict;
  let verdictReason: "hard-blocker" | "score" | "clean";
  if (hardBlockers.length > 0) {
    verdict = "BLOCK";
    verdictReason = "hard-blocker";
  } else if (adjustedScore >= block) {
    verdict = "BLOCK";
    verdictReason = "score";
  } else if (adjustedScore >= caution) {
    verdict = "CAUTION";
    verdictReason = "score";
  } else {
    verdict = "GO";
    verdictReason = "clean";
  }

  findings.sort((a, b) => {
    const rank = { high: 0, warn: 1, info: 2 } as const;
    return rank[a.severity] - rank[b.severity];
  });

  const blockers = findings.filter((f) => f.severity === "high");
  const warnings = findings.filter((f) => f.severity === "warn");

  return {
    findings,
    score: adjustedScore,
    verdict,
    verdictReason,
    blockers,
    hardBlockers,
    warnings,
    suppressedCount: acc.breakdown.ignorePatterns + acc.breakdown.rules,
    suppressedBreakdown: acc.breakdown,
    suppressedFindings: acc.audit,
    sections: { diff, env, oauth, preflight },
    branch: diff.branch,
  };
}

function snapshotFromCore(core: CoreAnalysis): BaselineSnapshot {
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    score: core.score,
    verdict: core.verdict,
    findings: core.findings.map((f) => ({
      id: f.id,
      fingerprint: f.fingerprint,
      category: f.category,
      severity: f.severity,
      message: f.message,
    })),
  };
}

async function computeGitRefBaseline(
  cwd: string,
  config: RehearsalConfig,
  displayRef: string,
  mode: "direct" | "merge-base",
  envFilesResolved: string[] | undefined,
  suppressionSet: SuppressionSet,
): Promise<
  | {
      ok: true;
      snapshot: BaselineSnapshot;
      resolvedRef: string;
      displayRef: string;
      mode: "direct" | "merge-base";
    }
  | { ok: false; error: BaselineError }
> {
  if (!(await isGitRepo(cwd))) {
    return { ok: false, error: { reason: "not-a-repo", detail: cwd, displayRef, mode } };
  }
  if (await isShallowRepo(cwd)) {
    return {
      ok: false,
      error: {
        reason: "shallow-clone",
        detail: "Repository is a shallow clone — cannot resolve historic refs. Run `git fetch --unshallow`.",
        displayRef,
        mode,
      },
    };
  }
  let baseSha: string;
  try {
    const resolved = await resolveRef(cwd, displayRef);
    baseSha = mode === "merge-base" ? await mergeBase(cwd, "HEAD", resolved) : resolved;
  } catch (e: any) {
    const reason = /merge-base/.test(String(e)) ? "merge-base-failed" : "ref-not-found";
    return { ok: false, error: { reason, detail: String(e.message ?? e), displayRef, mode } };
  }
  let wt: string;
  try {
    wt = await createWorktree(cwd, baseSha);
  } catch (e: any) {
    return { ok: false, error: { reason: "worktree-failed", detail: String(e.message ?? e), displayRef, mode } };
  }
  try {
    const core = await runAnalysisCore(wt, "HEAD", "WORKING", config, envFilesResolved, suppressionSet);
    return {
      ok: true,
      snapshot: snapshotFromCore(core),
      resolvedRef: baseSha,
      displayRef,
      mode,
    };
  } catch (e: any) {
    return { ok: false, error: { reason: "analysis-failed", detail: String(e.message ?? e), displayRef, mode } };
  } finally {
    await removeWorktree(cwd, wt);
  }
}

export async function runRehearsal(input: RunRehearsalInput): Promise<RunRehearsalResult> {
  const { cwd, baseRef = "HEAD", headRef = "WORKING" } = input;
  const { config, source: configSource } = await loadConfig(cwd, input.configPath);

  const envFilesRaw =
    input.envFiles && input.envFiles.length >= 2
      ? input.envFiles
      : config.envFiles && config.envFiles.length >= 2
        ? config.envFiles.map((p) => resolve(cwd, p))
        : undefined;

  const today = todayString();
  const suppressionSet = resolveSuppressions(config.suppress, today);

  const current = await runAnalysisCore(
    cwd,
    baseRef,
    headRef,
    config,
    envFilesRaw,
    suppressionSet,
  );

  const result: RunRehearsalResult = {
    verdict: current.verdict,
    verdictReason: current.verdictReason,
    score: current.score,
    thresholds: { block: config.thresholds.block, caution: config.thresholds.caution },
    branch: current.branch,
    blockers: current.blockers,
    hardBlockers: current.hardBlockers,
    warnings: current.warnings,
    findings: current.findings,
    suppressedCount: current.suppressedCount,
    suppressedBreakdown: current.suppressedBreakdown,
    suppressedFindings: current.suppressedFindings,
    configSource,
    sections: current.sections,
    suppressionStatus: publicStatus(suppressionSet),
  };

  const displayRef =
    input.baselineRef ?? (config.baseline.defaultGitRef ?? undefined);
  const useGitRef = displayRef !== undefined;
  const mode: "direct" | "merge-base" =
    input.baselineRefMode ?? config.baseline.gitRefMode;

  if (useGitRef) {
    const g = await computeGitRefBaseline(cwd, config, displayRef!, mode, envFilesRaw, suppressionSet);
    if (g.ok) {
      const comparison = compareBaseline(
        g.snapshot,
        `git-ref:${g.displayRef}@${g.resolvedRef}`,
        current.findings,
        current.score,
        config.baseline.compareBy,
      );
      result.baseline = comparison;
      result.baselineSource = "git-ref";
      result.baselineDisplayRef = g.displayRef;
      result.baselineResolvedRef = g.resolvedRef;
      result.baselineMode = g.mode;
      const cv = computeChangeVerdict(comparison.newFindings, comparison.deltaScore, config);
      result.changeVerdict = cv.verdict;
      result.changeVerdictReason = cv.reason;
    } else {
      result.baselineError = g.error;
    }
  } else if (config.baseline.enabled || input.baselinePath || input.saveBaseline) {
    const loaded = await loadBaseline(cwd, config.baseline, input.baselinePath);
    if (loaded) {
      const comparison = compareBaseline(
        loaded.snapshot,
        loaded.path,
        current.findings,
        current.score,
        config.baseline.compareBy,
      );
      result.baseline = comparison;
      result.baselineSource = "file";
      const cv = computeChangeVerdict(comparison.newFindings, comparison.deltaScore, config);
      result.changeVerdict = cv.verdict;
      result.changeVerdictReason = cv.reason;
    }
  }

  if (input.saveBaseline) {
    const saved = await saveBaseline(
      cwd,
      config.baseline,
      input.baselinePath,
      current.score,
      current.verdict,
      current.findings,
    );
    result.baselineSaved = { path: saved.path };
  }

  if (input.report === "markdown") {
    result.reportMarkdown = renderMarkdownReport(result);
  }

  return result;
}
