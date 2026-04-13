import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

export interface StandaloneFinding {
  kind: "standalone-output-missing";
  dockerfile: string;
  configPath?: string;
  evidence: string;
}

const STANDALONE_OUTPUT_RE = /\boutput\s*:\s*["']standalone["']/;
const STANDALONE_HINT_RE = /\.next\/standalone\b/;

async function fileExists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}

function normalize(p: string): string {
  return p.replace(/\\/g, "/");
}

export interface StandaloneInput {
  cwd: string;
  dockerfilePaths: string[];
  nextConfigPaths: string[];
  diffFiles: Array<{ path: string }>;
}

/**
 * Flags Dockerfiles that reference `.next/standalone` (the minimal server output
 * Next.js emits only when `output: 'standalone'` is set), while the project's
 * next.config does not actually enable standalone output. A container shipped in
 * this state boots missing its runtime files.
 *
 * Only emits when the Dockerfile OR the next.config is in the current diff — it's
 * a change-scoped signal, not a full-repo audit.
 */
export async function analyzeStandaloneOutput(input: StandaloneInput): Promise<StandaloneFinding[]> {
  const diffPaths = new Set(input.diffFiles.map((f) => normalize(f.path)));
  const dockerfileInDiff = input.dockerfilePaths.some((p) => diffPaths.has(normalize(p)));
  const configInDiff = input.nextConfigPaths.some((p) => diffPaths.has(normalize(p)));
  if (!dockerfileInDiff && !configInDiff) return [];

  const out: StandaloneFinding[] = [];
  for (const rel of input.dockerfilePaths) {
    const abs = resolve(input.cwd, rel);
    if (!(await fileExists(abs))) continue;
    let dockerText: string;
    try {
      dockerText = await readFile(abs, "utf8");
    } catch {
      continue;
    }
    if (!STANDALONE_HINT_RE.test(dockerText)) continue;

    let configHas = false;
    let matchedConfig: string | undefined;
    for (const cfgRel of input.nextConfigPaths) {
      const cfgAbs = resolve(input.cwd, cfgRel);
      if (!(await fileExists(cfgAbs))) continue;
      matchedConfig = rel === cfgRel ? matchedConfig : cfgRel;
      try {
        const cfgText = await readFile(cfgAbs, "utf8");
        if (STANDALONE_OUTPUT_RE.test(cfgText)) {
          configHas = true;
          matchedConfig = cfgRel;
          break;
        }
        matchedConfig = cfgRel;
      } catch {
        continue;
      }
    }
    if (configHas) continue;

    out.push({
      kind: "standalone-output-missing",
      dockerfile: rel,
      configPath: matchedConfig,
      evidence: matchedConfig
        ? `${rel} references \`.next/standalone\`, but ${matchedConfig} does not set \`output: 'standalone'\`.`
        : `${rel} references \`.next/standalone\`, but no next.config file was found.`,
    });
  }
  return out;
}
