export interface MismatchFinding {
  envKey: string;
  provider: string;
  actualScheme: string | null;
  url: string;
  sourcePath: string;
}

const SCHEME_BY_PROVIDER: Record<string, string[]> = {
  postgresql: ["postgres", "postgresql"],
  postgres: ["postgres", "postgresql"],
  mysql: ["mysql"],
  sqlite: ["file", "sqlite"],
  sqlserver: ["sqlserver"],
  mongodb: ["mongodb", "mongodb+srv"],
  cockroachdb: ["postgres", "postgresql", "cockroachdb"],
};

export function schemeOf(url: string): string | null {
  const m = url.match(/^([A-Za-z0-9+]+):/);
  return m ? m[1].toLowerCase() : null;
}

export interface EnvLookup {
  path: string;
  get(key: string): string | undefined;
}

export function findProviderMismatch(
  provider: string,
  urlEnv: string | undefined,
  envFiles: EnvLookup[],
): MismatchFinding[] {
  if (!provider || !urlEnv) return [];
  const expected = SCHEME_BY_PROVIDER[provider.toLowerCase()];
  if (!expected) return [];
  const out: MismatchFinding[] = [];
  for (const f of envFiles) {
    const url = f.get(urlEnv);
    if (!url) continue;
    const scheme = schemeOf(url);
    if (!scheme) continue;
    if (!expected.includes(scheme)) {
      out.push({
        envKey: urlEnv,
        provider,
        actualScheme: scheme,
        url,
        sourcePath: f.path,
      });
    }
  }
  return out;
}
