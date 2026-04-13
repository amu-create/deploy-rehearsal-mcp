import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Finding } from "../tools/runRehearsal.js";
import type { BaselineConfig } from "./config.js";

export type Verdict = "GO" | "CAUTION" | "BLOCK";

export interface BaselineFinding {
  id: string;
  fingerprint: string;
  category: string;
  severity: "info" | "warn" | "high";
  message: string;
}

export interface BaselineSnapshot {
  version: 1;
  createdAt: string;
  score: number;
  verdict: Verdict;
  findings: BaselineFinding[];
}

export type BaselineSource = "file" | "git-ref";

export interface BaselineComparison {
  source: string;
  sourceKind: BaselineSource;
  baselineScore: number;
  baselineVerdict: Verdict;
  baselineFindingCount: number;
  deltaScore: number;
  newFindings: Finding[];
  resolvedFindings: BaselineFinding[];
  persistingFindings: Finding[];
  compareBy: BaselineConfig["compareBy"];
}

export type BaselineErrorReason =
  | "ref-not-found"
  | "shallow-clone"
  | "not-a-repo"
  | "worktree-failed"
  | "merge-base-failed"
  | "analysis-failed";

export interface BaselineError {
  reason: BaselineErrorReason;
  detail: string;
  displayRef: string;
  mode?: "direct" | "merge-base";
}

function resolveBaselinePath(cwd: string, config: BaselineConfig, override?: string): string {
  return resolve(cwd, override ?? config.path);
}

export async function loadBaseline(
  cwd: string,
  config: BaselineConfig,
  override?: string,
): Promise<{ snapshot: BaselineSnapshot; path: string } | null> {
  const path = resolveBaselinePath(cwd, config, override);
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && parsed.version === 1 && Array.isArray(parsed.findings)) {
      return { snapshot: parsed, path };
    }
    return null;
  } catch {
    return null;
  }
}

export async function saveBaseline(
  cwd: string,
  config: BaselineConfig,
  override: string | undefined,
  score: number,
  verdict: Verdict,
  findings: Finding[],
): Promise<{ path: string; snapshot: BaselineSnapshot }> {
  const path = resolveBaselinePath(cwd, config, override);
  const snapshot: BaselineSnapshot = {
    version: 1,
    createdAt: new Date().toISOString(),
    score,
    verdict,
    findings: findings.map((f) => ({
      id: f.id,
      fingerprint: f.fingerprint,
      category: f.category,
      severity: f.severity,
      message: f.message,
    })),
  };
  await writeFile(path, JSON.stringify(snapshot, null, 2), "utf8");
  return { path, snapshot };
}

function keyOf(
  f: { id: string; fingerprint: string; category: string },
  compareBy: BaselineConfig["compareBy"],
): string {
  return compareBy.map((k) => (f as any)[k] ?? "").join("||");
}

export function compareBaseline(
  snapshot: BaselineSnapshot,
  snapshotPath: string,
  currentFindings: Finding[],
  currentScore: number,
  compareBy: BaselineConfig["compareBy"],
): BaselineComparison {
  const baselineKeys = new Set(snapshot.findings.map((f) => keyOf(f, compareBy)));
  const currentKeys = new Set(currentFindings.map((f) => keyOf(f, compareBy)));
  const newFindings = currentFindings.filter((f) => !baselineKeys.has(keyOf(f, compareBy)));
  const resolvedFindings = snapshot.findings.filter(
    (f) => !currentKeys.has(keyOf(f, compareBy)),
  );
  const persistingFindings = currentFindings.filter((f) =>
    baselineKeys.has(keyOf(f, compareBy)),
  );
  return {
    source: snapshotPath,
    sourceKind: snapshotPath.startsWith("git-ref:") ? "git-ref" : "file",
    baselineScore: snapshot.score,
    baselineVerdict: snapshot.verdict,
    baselineFindingCount: snapshot.findings.length,
    deltaScore: currentScore - snapshot.score,
    newFindings,
    resolvedFindings,
    persistingFindings,
    compareBy,
  };
}

export function deltaVerdictFrom(
  deltaScore: number,
  config: BaselineConfig,
): Verdict {
  if (deltaScore >= config.deltaBlockThreshold) return "BLOCK";
  if (deltaScore >= config.deltaCautionThreshold) return "CAUTION";
  return "GO";
}
