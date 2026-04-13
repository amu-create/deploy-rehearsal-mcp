import { analyzeDiff } from "./analyzeDiff.js";
import { preflightChecklist } from "./preflightChecklist.js";

export interface ScoreRiskInput {
  cwd: string;
  baseRef?: string;
  headRef?: string;
  envFiles?: string[];
}

export interface ScoreRiskResult {
  verdict: "GO" | "CAUTION" | "BLOCK";
  score: number;
  reasons: string[];
  diffSummary: {
    totalFiles: number;
    highSignals: string[];
    warnSignals: string[];
  };
  preflightSummary: {
    passed: number;
    warned: number;
    failed: number;
    topIssues: string[];
  };
}

export async function scoreRisk(input: ScoreRiskInput): Promise<ScoreRiskResult> {
  const { cwd, baseRef = "HEAD", headRef = "WORKING" } = input;

  let score = 0;
  const reasons: string[] = [];
  const highSignals: string[] = [];
  const warnSignals: string[] = [];
  let totalFiles = 0;

  try {
    const diff = await analyzeDiff({ cwd, baseRef, headRef });
    totalFiles = diff.totalFiles;
    for (const s of diff.signals) {
      if (s.severity === "high") {
        score += 25;
        highSignals.push(s.kind);
        reasons.push(`HIGH: ${s.kind} — ${s.message} (${s.files.length} file[s])`);
      } else if (s.severity === "warn") {
        score += 10;
        warnSignals.push(s.kind);
      }
    }
    if (diff.totalFiles > 50) {
      score += 10;
      reasons.push(`Large diff: ${diff.totalFiles} files changed.`);
    }
  } catch (e: any) {
    reasons.push(`Diff analysis skipped: ${e.message}`);
  }

  const pre = await preflightChecklist({ cwd });
  const topIssues: string[] = [];
  for (const c of pre.checks) {
    if (c.status === "fail") {
      score += 20;
      reasons.push(`Preflight FAIL: ${c.name} — ${c.detail}`);
      topIssues.push(c.name);
    } else if (c.status === "warn") {
      score += 5;
      topIssues.push(c.name);
    }
  }

  let verdict: "GO" | "CAUTION" | "BLOCK";
  if (score >= 60) verdict = "BLOCK";
  else if (score >= 25) verdict = "CAUTION";
  else verdict = "GO";

  return {
    verdict,
    score,
    reasons,
    diffSummary: { totalFiles, highSignals, warnSignals },
    preflightSummary: {
      passed: pre.passed,
      warned: pre.warned,
      failed: pre.failed,
      topIssues,
    },
  };
}
