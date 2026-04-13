import { scanPatterns } from "../lib/scan.js";

export interface CheckOAuthInput {
  cwd: string;
  expectedDomains?: string[];
}

export interface OAuthRedirect {
  url: string;
  file: string;
  line: number;
  snippet: string;
  domain: string;
  isLocalhost: boolean;
  isHttp: boolean;
  matchesExpected?: boolean;
}

export interface CheckOAuthResult {
  redirects: OAuthRedirect[];
  byDomain: Record<string, number>;
  localhostInNonTestFiles: OAuthRedirect[];
  httpOnlyRedirects: OAuthRedirect[];
  unexpectedDomains: OAuthRedirect[];
  expectedDomains: string[];
}

const REDIRECT_KEY_RE = /redirect[_-]?uri|callback[_-]?url|NEXTAUTH_URL|OAUTH_CALLBACK|oauth\/callback/i;
const URL_RE = /https?:\/\/[A-Za-z0-9._:\-\/?&%=#+]+/g;

function getDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "invalid";
  }
}

export async function checkOAuth(input: CheckOAuthInput): Promise<CheckOAuthResult> {
  const { cwd, expectedDomains = [] } = input;
  const hits = await scanPatterns(cwd, [REDIRECT_KEY_RE]);
  const redirects: OAuthRedirect[] = [];
  const matches = hits.get(REDIRECT_KEY_RE.source) ?? [];
  const seen = new Set<string>();
  for (const m of matches) {
    const urls = m.text.match(URL_RE) ?? [];
    for (const url of urls) {
      const key = `${m.file}|${m.line}|${url}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const domain = getDomain(url);
      const isLocalhost = /^(localhost|127\.0\.0\.1|0\.0\.0\.0)$/.test(domain);
      const isHttp = url.startsWith("http://") && !isLocalhost;
      const matchesExpected =
        expectedDomains.length === 0
          ? undefined
          : expectedDomains.some((d) => domain === d || domain.endsWith("." + d));
      redirects.push({
        url,
        file: m.file,
        line: m.line,
        snippet: m.text,
        domain,
        isLocalhost,
        isHttp,
        matchesExpected,
      });
    }
  }
  const byDomain: Record<string, number> = {};
  for (const r of redirects) byDomain[r.domain] = (byDomain[r.domain] ?? 0) + 1;
  const localhostInNonTestFiles = redirects.filter(
    (r) => r.isLocalhost && !/(test|spec|__tests__|fixtures?)/i.test(r.file),
  );
  const httpOnlyRedirects = redirects.filter((r) => r.isHttp);
  const unexpectedDomains =
    expectedDomains.length === 0
      ? []
      : redirects.filter((r) => !r.isLocalhost && r.matchesExpected === false);
  return {
    redirects,
    byDomain,
    localhostInNonTestFiles,
    httpOnlyRedirects,
    unexpectedDomains,
    expectedDomains,
  };
}
