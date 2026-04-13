import { readFile } from "node:fs/promises";

export interface CachingFinding {
  kind: "dynamic-static-conflict" | "personalized-static";
  file: string;
  evidence: string;
  severity: "high" | "warn";
  route?: string;
}

const FORCE_STATIC_RE = /export\s+const\s+dynamic\s*=\s*["']force-static["']/;
const FORCE_CACHE_FETCH_RE = /fetch\([^)]*cache\s*:\s*["']force-cache["']/;
const REVALIDATE_RE = /export\s+const\s+revalidate\s*=\s*\d+/;
const DYNAMIC_SIGNALS = [
  /\bcookies\s*\(/,
  /\bheaders\s*\(/,
  /request\.headers\b/,
  /\bauth\s*\(/,
  /\bgetServerSession\s*\(/,
];

function routeFromFile(file: string, appDirs: string[], pagesDirs: string[]): string | null {
  const normalized = file.replace(/\\/g, "/");
  for (const dir of appDirs) {
    const prefix = dir.replace(/\/$/, "") + "/";
    if (normalized.startsWith(prefix)) {
      const rest = normalized.slice(prefix.length);
      const m = rest.match(/^(.*)\/(page|route)\.(ts|tsx|js|jsx)$/);
      if (m) {
        const r = "/" + m[1];
        return r === "/" ? "/" : r;
      }
    }
  }
  for (const dir of pagesDirs) {
    const prefix = dir.replace(/\/$/, "") + "/";
    if (normalized.startsWith(prefix)) {
      const rest = normalized.slice(prefix.length).replace(/\.(ts|tsx|js|jsx)$/, "");
      if (/^_/.test(rest)) return null;
      return "/" + rest.replace(/\/index$/, "");
    }
  }
  return null;
}

export interface CachingInput {
  files: Array<{ absolutePath: string; relPath: string }>;
  appDirs: string[];
  pagesDirs: string[];
  criticalRoutes: string[];
}

export async function analyzeCachingMode(input: CachingInput): Promise<CachingFinding[]> {
  const out: CachingFinding[] = [];
  for (const { absolutePath, relPath } of input.files) {
    let text: string;
    try {
      text = await readFile(absolutePath, "utf8");
    } catch {
      continue;
    }

    const route = routeFromFile(relPath, input.appDirs, input.pagesDirs);
    const isCritical = route != null && input.criticalRoutes.some((c) => route === c || route.startsWith(c + "/"));
    const forceStatic = FORCE_STATIC_RE.test(text);
    const usesDynamicSignal = DYNAMIC_SIGNALS.some((re) => re.test(text));

    if (forceStatic && isCritical && route) {
      out.push({
        kind: "personalized-static",
        file: relPath,
        route,
        severity: "high",
        evidence: `${relPath} (${route}) exports dynamic='force-static' but route is personalized.`,
      });
      continue;
    }

    if ((forceStatic || (REVALIDATE_RE.test(text) && !/dynamic\s*=/.test(text))) && usesDynamicSignal) {
      out.push({
        kind: "dynamic-static-conflict",
        file: relPath,
        severity: "warn",
        evidence: `${relPath} marks static/revalidate but reads cookies/headers/auth — will be treated dynamic or stale.`,
      });
      continue;
    }

    if (FORCE_CACHE_FETCH_RE.test(text) && usesDynamicSignal) {
      out.push({
        kind: "dynamic-static-conflict",
        file: relPath,
        severity: "warn",
        evidence: `${relPath} uses fetch({ cache: 'force-cache' }) alongside dynamic signals (cookies/headers).`,
      });
    }
  }
  return out;
}
