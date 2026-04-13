import { getDiffSummary, getDiffPatch, getCurrentBranch, isGitRepo, type DiffFile } from "../lib/git.js";

export interface DiffSignal {
  kind: string;
  severity: "info" | "warn" | "high";
  message: string;
  files: string[];
}

const SIGNAL_RULES: Array<{
  kind: string;
  severity: "info" | "warn" | "high";
  match: RegExp;
  message: string;
}> = [
  { kind: "migration", severity: "high", match: /(^|\/)(migrations?|prisma\/migrations|alembic)\//i, message: "Database migration changed. Review for destructive ops, locking, and rollback." },
  { kind: "schema", severity: "high", match: /schema\.prisma$|schema\.sql$|\.sql$/i, message: "DB schema touched. Verify migration accompanies it." },
  { kind: "auth", severity: "high", match: /(auth|session|jwt|oauth|passport|nextauth)/i, message: "Auth-related file changed. Test login, logout, and token refresh." },
  { kind: "payment", severity: "high", match: /(stripe|payment|billing|checkout|refund|subscription)/i, message: "Payment code touched. Run checkout + refund smoke tests." },
  { kind: "env-usage", severity: "warn", match: /process\.env\.[A-Z0-9_]+|os\.environ\[/i, message: "New env var usage. Ensure values exist in every environment." },
  { kind: "routing", severity: "warn", match: /(pages|app|routes|api)\/.+\.(ts|tsx|js|jsx|py)$/i, message: "Route/API file changed. Check redirects, middleware, and callers." },
  { kind: "ci", severity: "warn", match: /\.github\/workflows\/|Dockerfile|docker-compose|vercel\.json|render\.yaml|netlify\.toml/i, message: "Build/deploy config changed. Deploy may behave differently." },
  { kind: "lockfile", severity: "warn", match: /package-lock\.json$|pnpm-lock\.yaml$|yarn\.lock$|poetry\.lock$|Pipfile\.lock$/i, message: "Lockfile changed. Dependency surface shifted." },
  { kind: "secret", severity: "high", match: /\.env(\..+)?$|credentials?\.json$|id_rsa|\.pem$/i, message: "Secret file appears in diff. Verify nothing is being committed." },
  { kind: "tests", severity: "info", match: /(test|spec|__tests__)/i, message: "Tests touched." },
];

export interface AnalyzeDiffInput {
  cwd: string;
  baseRef?: string;
  headRef?: string;
  includePatch?: boolean;
}

export interface AnalyzeDiffResult {
  branch: string;
  baseRef: string;
  headRef: string;
  totalFiles: number;
  totalAdditions: number;
  totalDeletions: number;
  files: DiffFile[];
  signals: DiffSignal[];
  patchPreview?: string;
}

export async function analyzeDiff(input: AnalyzeDiffInput): Promise<AnalyzeDiffResult> {
  const { cwd, baseRef = "HEAD", headRef = "WORKING", includePatch = false } = input;
  if (!(await isGitRepo(cwd))) {
    throw new Error(`Not a git repository: ${cwd}`);
  }
  const branch = await getCurrentBranch(cwd);
  const summary = await getDiffSummary(cwd, baseRef, headRef);
  const signalBuckets = new Map<string, DiffSignal>();
  for (const file of summary.files) {
    for (const rule of SIGNAL_RULES) {
      if (rule.match.test(file.path)) {
        const key = rule.kind;
        if (!signalBuckets.has(key)) {
          signalBuckets.set(key, {
            kind: rule.kind,
            severity: rule.severity,
            message: rule.message,
            files: [],
          });
        }
        signalBuckets.get(key)!.files.push(file.path);
      }
    }
  }
  const signals = [...signalBuckets.values()].sort((a, b) => {
    const rank = { high: 0, warn: 1, info: 2 } as const;
    return rank[a.severity] - rank[b.severity];
  });
  const result: AnalyzeDiffResult = {
    branch,
    baseRef: summary.baseRef,
    headRef: summary.headRef,
    totalFiles: summary.files.length,
    totalAdditions: summary.totalAdditions,
    totalDeletions: summary.totalDeletions,
    files: summary.files,
    signals,
  };
  if (includePatch) {
    result.patchPreview = await getDiffPatch(cwd, baseRef, headRef, 20_000);
  }
  return result;
}
