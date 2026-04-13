import { readFile } from "node:fs/promises";

export interface MiddlewareFinding {
  kind: "matcher-shrunk" | "middleware-unprotected";
  evidence: string;
  route?: string;
  before?: string[];
  after?: string[];
  removed?: string[];
}

function extractMatcherItems(text: string): string[] | null {
  // Looks for either:
  //   export const config = { matcher: [...] }
  //   matcher: '...'
  //   matcher: ["...", "..."]
  // We match inside a balanced-ish `[ ... ]` after `matcher`.
  const re = /matcher\s*:\s*(\[([\s\S]*?)\]|"([^"]+)"|'([^']+)')/;
  const m = text.match(re);
  if (!m) return null;
  if (m[2] !== undefined) {
    return [...m[2].matchAll(/["']([^"']+)["']/g)].map((x) => x[1]);
  }
  return [m[3] ?? m[4] ?? ""];
}

export function analyzeMatcherPatch(patch: string): {
  before: string[] | null;
  after: string[] | null;
} {
  const beforeText = patch
    .split(/\r?\n/)
    .filter((l) => l.startsWith("-") && !l.startsWith("---"))
    .map((l) => l.slice(1))
    .join("\n");
  const afterText = patch
    .split(/\r?\n/)
    .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
    .map((l) => l.slice(1))
    .join("\n");
  return {
    before: extractMatcherItems(beforeText),
    after: extractMatcherItems(afterText),
  };
}

export interface MiddlewareInput {
  middlewareAbsolutePath: string | null;
  middlewarePatch: string;
  middlewareInDiff: boolean;
  newRouteRelPaths: string[];
  criticalRoutes: string[];
  appDirs: string[];
  pagesDirs: string[];
}

function routesForFile(file: string, appDirs: string[], pagesDirs: string[]): string[] {
  const normalized = file.replace(/\\/g, "/");
  const routes: string[] = [];
  for (const dir of appDirs) {
    const prefix = dir.replace(/\/$/, "") + "/";
    if (normalized.startsWith(prefix)) {
      const rest = normalized.slice(prefix.length);
      if (/\/(page|route)\.(ts|tsx|js|jsx)$/.test(rest)) {
        const route = "/" + rest.replace(/\/(page|route)\.(ts|tsx|js|jsx)$/, "");
        routes.push(route === "/" ? "/" : route);
      }
    }
  }
  for (const dir of pagesDirs) {
    const prefix = dir.replace(/\/$/, "") + "/";
    if (normalized.startsWith(prefix)) {
      const rest = normalized.slice(prefix.length);
      if (/\.(ts|tsx|js|jsx)$/.test(rest) && !/^_/.test(rest)) {
        const route = "/" + rest.replace(/\.(ts|tsx|js|jsx)$/, "").replace(/\/index$/, "");
        routes.push(route === "" ? "/" : route);
      }
    }
  }
  return routes;
}

function matcherCoversRoute(matchers: string[], route: string): boolean {
  for (const m of matchers) {
    if (m === route) return true;
    // Convert Next.js matcher glob (approximate) to regex.
    // Order matters: handle `/:param*` (optional trailing segments) before generic `:param`.
    let pattern = m.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    pattern = pattern.replace(/\/:[A-Za-z_][\w]*\*/g, "(?:/.*)?");
    pattern = pattern.replace(/:[A-Za-z_][\w]*\*/g, ".*");
    pattern = pattern.replace(/:[A-Za-z_][\w]*/g, "[^/]+");
    pattern = pattern.replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*");
    try {
      if (new RegExp("^" + pattern + "$").test(route)) return true;
      if (new RegExp("^" + pattern + "/").test(route)) return true;
    } catch {
      continue;
    }
  }
  return false;
}

export async function analyzeMiddlewareCoverage(
  input: MiddlewareInput,
): Promise<MiddlewareFinding[]> {
  const out: MiddlewareFinding[] = [];

  if (input.middlewareInDiff && input.middlewarePatch) {
    const { before, after } = analyzeMatcherPatch(input.middlewarePatch);
    if (before && after) {
      const removed = before.filter((b) => !after.includes(b)).slice().sort();
      if (removed.length > 0 && after.length < before.length) {
        out.push({
          kind: "matcher-shrunk",
          evidence: `matcher shrunk: removed [${removed.join(", ")}]`,
          before,
          after,
          removed,
        });
      }
    }
  }

  let currentMatchers: string[] | null = null;
  if (input.middlewareAbsolutePath) {
    try {
      const text = await readFile(input.middlewareAbsolutePath, "utf8");
      currentMatchers = extractMatcherItems(text);
    } catch {
      currentMatchers = null;
    }
  }

  for (const rel of input.newRouteRelPaths) {
    const routes = routesForFile(rel, input.appDirs, input.pagesDirs);
    for (const route of routes) {
      const isCritical = input.criticalRoutes.some((c) => route === c || route.startsWith(c + "/"));
      if (!isCritical) continue;
      const protectedByMiddleware =
        currentMatchers !== null && matcherCoversRoute(currentMatchers, route);
      if (!protectedByMiddleware) {
        out.push({
          kind: "middleware-unprotected",
          evidence: `New critical route ${route} (${rel}) without middleware coverage.`,
          route,
        });
      }
    }
  }

  return out;
}
