export type NextConfigChangeKind =
  | "basepath-change"
  | "output-change"
  | "assetprefix-change"
  | "trailingslash-change"
  | "images-remote-patterns-shrunk"
  | "auth-rewrite-risk"
  | "auth-redirect-risk";

export interface NextConfigFinding {
  kind: NextConfigChangeKind;
  severity: "high" | "warn";
  evidence: string;
  removedImageDomains?: string[];
  authPairs?: Array<{ source: string; destination: string }>;
}

function addedLines(patch: string): string[] {
  return patch
    .split(/\r?\n/)
    .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
    .map((l) => l.slice(1));
}
function removedLines(patch: string): string[] {
  return patch
    .split(/\r?\n/)
    .filter((l) => l.startsWith("-") && !l.startsWith("---"))
    .map((l) => l.slice(1));
}

function touchesKey(lines: string[], key: string): boolean {
  const re = new RegExp(`\\b${key}\\s*:`);
  return lines.some((l) => re.test(l));
}

function extractHostnames(lines: string[]): string[] {
  const out: string[] = [];
  for (const l of lines) {
    for (const m of l.matchAll(/hostname\s*:\s*["']([^"']+)["']/g)) out.push(m[1]);
  }
  return out;
}

function extractStringList(lines: string[]): string[] {
  const out: string[] = [];
  const joined = lines.join("\n");
  for (const m of joined.matchAll(/["']([^"']+)["']/g)) out.push(m[1]);
  return out;
}

function extractSourceDestPairs(
  lines: string[],
): Array<{ source: string; destination: string }> {
  const sources: string[] = [];
  const dests: string[] = [];
  for (const l of lines) {
    const s = l.match(/source\s*:\s*["']([^"']+)["']/);
    if (s) sources.push(s[1]);
    const d = l.match(/destination\s*:\s*["']([^"']+)["']/);
    if (d) dests.push(d[1]);
  }
  const n = Math.min(sources.length, dests.length);
  const out: Array<{ source: string; destination: string }> = [];
  for (let i = 0; i < n; i++) out.push({ source: sources[i], destination: dests[i] });
  return out;
}

function anyMatchesAuth(s: string, authRouteHints: string[]): boolean {
  return authRouteHints.some((hint) => {
    const re = new RegExp(hint.replace(/[.+^${}()|[\]\\]/g, "\\$&"));
    return re.test(s);
  });
}

export function analyzeNextConfig(
  patch: string,
  authRouteHints: string[],
): NextConfigFinding[] {
  if (!patch) return [];
  const out: NextConfigFinding[] = [];
  const added = addedLines(patch);
  const removed = removedLines(patch);
  const allChanged = [...added, ...removed];

  if (touchesKey(allChanged, "basePath")) {
    out.push({
      kind: "basepath-change",
      severity: "warn",
      evidence: "next.config changes `basePath`. Update OAuth redirect URIs, sitemap, canonical URLs.",
    });
  }
  if (touchesKey(allChanged, "output")) {
    out.push({
      kind: "output-change",
      severity: "warn",
      evidence: "next.config changes `output` mode. Hosting behaviour changes.",
    });
  }
  if (touchesKey(allChanged, "assetPrefix")) {
    out.push({
      kind: "assetprefix-change",
      severity: "warn",
      evidence: "next.config changes `assetPrefix`. CDN asset paths may break.",
    });
  }
  if (touchesKey(allChanged, "trailingSlash")) {
    out.push({
      kind: "trailingslash-change",
      severity: "warn",
      evidence: "next.config changes `trailingSlash`. Audit internal links, sitemap, redirects.",
    });
  }

  const addedHostnames = extractHostnames(added);
  const removedHostnames = extractHostnames(removed);
  if (
    (touchesKey(allChanged, "remotePatterns") || /remotePatterns/.test(patch)) &&
    removedHostnames.length > addedHostnames.length
  ) {
    const netRemoved = removedHostnames
      .filter((h) => !addedHostnames.includes(h))
      .slice()
      .sort();
    if (netRemoved.length > 0) {
      out.push({
        kind: "images-remote-patterns-shrunk",
        severity: "warn",
        evidence: `images.remotePatterns shrunk: removed [${netRemoved.join(", ")}].`,
        removedImageDomains: netRemoved,
      });
    }
  } else if (/\bdomains\s*:/.test(patch) && !/remotePatterns/.test(patch)) {
    const addedDomains = extractStringList(added);
    const removedDomains = extractStringList(removed);
    const netRemoved = removedDomains
      .filter((d) => !addedDomains.includes(d))
      .slice()
      .sort();
    if (netRemoved.length > 0) {
      out.push({
        kind: "images-remote-patterns-shrunk",
        severity: "warn",
        evidence: `images.domains shrunk: removed [${netRemoved.join(", ")}].`,
        removedImageDomains: netRemoved,
      });
    }
  }

  const isRewritesTouched = /\brewrites\b/.test(patch);
  const isRedirectsTouched = /\bredirects\b/.test(patch);
  if (isRewritesTouched || isRedirectsTouched) {
    const pairs = extractSourceDestPairs(added);
    const authPairs = pairs.filter(
      (p) => anyMatchesAuth(p.source, authRouteHints) || anyMatchesAuth(p.destination, authRouteHints),
    );
    if (authPairs.length > 0) {
      const kind = isRedirectsTouched ? "auth-redirect-risk" : "auth-rewrite-risk";
      out.push({
        kind,
        severity: "high",
        evidence: `next.config ${kind.split("-")[1]} touches auth route(s): ${authPairs
          .map((p) => `${p.source}->${p.destination}`)
          .join(", ")}.`,
        authPairs,
      });
    } else {
      // Fallback: auth-ish lines touched without paired source/destination parseable
      const authHit = authRouteHints.some((hint) => {
        const re = new RegExp(hint.replace(/[.+^${}()|[\]\\]/g, "\\$&"));
        return added.some((l) => re.test(l)) || removed.some((l) => re.test(l));
      });
      if (authHit) {
        const kind = isRedirectsTouched ? "auth-redirect-risk" : "auth-rewrite-risk";
        out.push({
          kind,
          severity: "high",
          evidence: `next.config ${kind.split("-")[1]} touches an auth-related route. OAuth loops likely.`,
        });
      }
    }
  }

  return out;
}
