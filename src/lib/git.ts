import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export interface DiffFile {
  path: string;
  status: string;
  additions: number;
  deletions: number;
}

export interface DiffSummary {
  baseRef: string;
  headRef: string;
  files: DiffFile[];
  totalAdditions: number;
  totalDeletions: number;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, maxBuffer: 50 * 1024 * 1024 });
  return stdout;
}

export async function getDiffSummary(
  cwd: string,
  baseRef: string = "HEAD",
  headRef: string = "WORKING",
): Promise<DiffSummary> {
  const args =
    headRef === "WORKING"
      ? ["diff", "--numstat", baseRef]
      : ["diff", "--numstat", `${baseRef}...${headRef}`];
  const numstat = await git(cwd, args);
  const files: DiffFile[] = [];
  let totalAdditions = 0;
  let totalDeletions = 0;
  for (const line of numstat.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length < 3) continue;
    const added = parts[0] === "-" ? 0 : Number(parts[0]) || 0;
    const deleted = parts[1] === "-" ? 0 : Number(parts[1]) || 0;
    const filePath = parts.slice(2).join(" ");
    files.push({ path: filePath, status: "modified", additions: added, deletions: deleted });
    totalAdditions += added;
    totalDeletions += deleted;
  }
  return { baseRef, headRef, files, totalAdditions, totalDeletions };
}

export async function getDiffPatch(
  cwd: string,
  baseRef: string = "HEAD",
  headRef: string = "WORKING",
  maxBytes: number = 500_000,
): Promise<string> {
  const args =
    headRef === "WORKING"
      ? ["diff", "--unified=2", baseRef]
      : ["diff", "--unified=2", `${baseRef}...${headRef}`];
  const out = await git(cwd, args);
  if (out.length > maxBytes) return out.slice(0, maxBytes) + "\n... (truncated)";
  return out;
}

export async function getFilePatch(
  cwd: string,
  baseRef: string,
  headRef: string,
  filePath: string,
  maxBytes: number = 200_000,
): Promise<string> {
  const args =
    headRef === "WORKING"
      ? ["diff", "--unified=3", baseRef, "--", filePath]
      : ["diff", "--unified=3", `${baseRef}...${headRef}`, "--", filePath];
  try {
    const out = await git(cwd, args);
    if (out.length > maxBytes) return out.slice(0, maxBytes) + "\n... (truncated)";
    return out;
  } catch {
    return "";
  }
}

export async function getCurrentBranch(cwd: string): Promise<string> {
  try {
    return (await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  } catch {
    return "unknown";
  }
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
    return true;
  } catch {
    return false;
  }
}

export async function resolveRef(cwd: string, ref: string): Promise<string> {
  try {
    const out = await git(cwd, ["rev-parse", "--verify", `${ref}^{commit}`]);
    return out.trim();
  } catch (e: any) {
    throw new Error(`Cannot resolve ref '${ref}': ${e.message?.trim() ?? e}`);
  }
}

export async function mergeBase(cwd: string, a: string, b: string): Promise<string> {
  try {
    const out = await git(cwd, ["merge-base", a, b]);
    return out.trim();
  } catch (e: any) {
    throw new Error(`Cannot compute merge-base(${a}, ${b}): ${e.message?.trim() ?? e}`);
  }
}

export async function isShallowRepo(cwd: string): Promise<boolean> {
  try {
    const out = await git(cwd, ["rev-parse", "--is-shallow-repository"]);
    return out.trim() === "true";
  } catch {
    return false;
  }
}

export async function createWorktree(cwd: string, sha: string): Promise<string> {
  const wtRoot = await mkdtemp(join(tmpdir(), "deploy-rehearsal-wt-"));
  try {
    await git(cwd, ["worktree", "add", "--detach", "--force", wtRoot, sha]);
    return wtRoot;
  } catch (e: any) {
    await rm(wtRoot, { recursive: true, force: true }).catch(() => {});
    throw new Error(`git worktree add failed for ${sha}: ${e.message?.trim() ?? e}`);
  }
}

export async function removeWorktree(cwd: string, wtPath: string): Promise<void> {
  try {
    await git(cwd, ["worktree", "remove", "--force", wtPath]);
  } catch {
    // fall back to manual removal
  }
  await rm(wtPath, { recursive: true, force: true }).catch(() => {});
}
