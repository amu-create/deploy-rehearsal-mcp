import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { isGitRepo, getDiffSummary } from "../lib/git.js";

export interface PreflightInput {
  cwd: string;
}

export interface CheckItem {
  name: string;
  status: "pass" | "fail" | "warn" | "skip";
  detail: string;
}

export interface PreflightResult {
  checks: CheckItem[];
  passed: number;
  failed: number;
  warned: number;
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function readJsonSafe(p: string): Promise<any | null> {
  try {
    return JSON.parse(await readFile(p, "utf8"));
  } catch {
    return null;
  }
}

export async function preflightChecklist(input: PreflightInput): Promise<PreflightResult> {
  const { cwd } = input;
  const checks: CheckItem[] = [];

  if (!(await isGitRepo(cwd))) {
    checks.push({ name: "git-repo", status: "warn", detail: "Not a git repository." });
  } else {
    checks.push({ name: "git-repo", status: "pass", detail: "Git repo detected." });
    try {
      const diff = await getDiffSummary(cwd, "HEAD", "WORKING");
      if (diff.files.length === 0) {
        checks.push({ name: "uncommitted", status: "pass", detail: "No uncommitted changes." });
      } else {
        checks.push({
          name: "uncommitted",
          status: "warn",
          detail: `${diff.files.length} uncommitted file(s). Commit before deploy.`,
        });
      }
    } catch (e: any) {
      checks.push({ name: "uncommitted", status: "skip", detail: e.message });
    }
  }

  const pkgPath = join(cwd, "package.json");
  if (await exists(pkgPath)) {
    const pkg = await readJsonSafe(pkgPath);
    if (pkg) {
      if (pkg.scripts?.build) {
        checks.push({ name: "build-script", status: "pass", detail: "`build` script present." });
      } else {
        checks.push({ name: "build-script", status: "warn", detail: "No `build` script." });
      }
      if (pkg.scripts?.test) {
        checks.push({ name: "test-script", status: "pass", detail: "`test` script present." });
      } else {
        checks.push({ name: "test-script", status: "warn", detail: "No `test` script." });
      }
      const lockFiles = ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb"];
      const haveLock = await Promise.all(lockFiles.map((l) => exists(join(cwd, l))));
      if (haveLock.some(Boolean)) {
        checks.push({ name: "lockfile", status: "pass", detail: "Lockfile present." });
      } else {
        checks.push({ name: "lockfile", status: "warn", detail: "No lockfile — reproducible installs at risk." });
      }
    }
  }

  const envExample = ["env.example", ".env.example", ".env.sample"].map((p) => join(cwd, p));
  const foundExample = (await Promise.all(envExample.map(exists))).some(Boolean);
  if (foundExample) {
    checks.push({ name: "env-example", status: "pass", detail: "`.env.example` present." });
  } else if (await exists(join(cwd, ".env"))) {
    checks.push({ name: "env-example", status: "warn", detail: "`.env` exists but no `.env.example` to document required vars." });
  } else {
    checks.push({ name: "env-example", status: "skip", detail: "No env files detected." });
  }

  const gitignorePath = join(cwd, ".gitignore");
  if (await exists(gitignorePath)) {
    const g = await readFile(gitignorePath, "utf8");
    if (/\.env(\b|\s|$)/.test(g) || /\.env\*/.test(g)) {
      checks.push({ name: "env-ignored", status: "pass", detail: "`.env` is gitignored." });
    } else {
      checks.push({ name: "env-ignored", status: "warn", detail: "`.env` not in .gitignore." });
    }
  } else {
    checks.push({ name: "env-ignored", status: "warn", detail: "No .gitignore file." });
  }

  const ciPaths = [".github/workflows", "vercel.json", "render.yaml", "netlify.toml", "Dockerfile"];
  const ciExists = await Promise.all(ciPaths.map((p) => exists(join(cwd, p))));
  if (ciExists.some(Boolean)) {
    checks.push({ name: "ci-config", status: "pass", detail: "Deploy/CI config found." });
  } else {
    checks.push({ name: "ci-config", status: "warn", detail: "No CI / deploy config detected." });
  }

  const passed = checks.filter((c) => c.status === "pass").length;
  const failed = checks.filter((c) => c.status === "fail").length;
  const warned = checks.filter((c) => c.status === "warn").length;
  return { checks, passed, failed, warned };
}
