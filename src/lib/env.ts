import { readFile } from "node:fs/promises";

export interface EnvEntry {
  key: string;
  value: string;
  lineNumber: number;
  isEmpty: boolean;
}

export interface EnvFile {
  path: string;
  entries: Map<string, EnvEntry>;
  raw: string;
}

const SECRET_HINTS = [
  /key/i,
  /secret/i,
  /token/i,
  /password/i,
  /passwd/i,
  /credential/i,
  /private/i,
  /_sk_/i,
  /api[_-]?key/i,
];

export function looksSecret(key: string): boolean {
  return SECRET_HINTS.some((re) => re.test(key));
}

export async function parseEnvFile(path: string): Promise<EnvFile> {
  const raw = await readFile(path, "utf8");
  const entries = new Map<string, EnvEntry>();
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    entries.set(key, {
      key,
      value,
      lineNumber: i + 1,
      isEmpty: value.length === 0,
    });
  }
  return { path, entries, raw };
}

export interface EnvDiffEntry {
  key: string;
  presence: Record<string, "present" | "missing" | "empty">;
  valueDiverges: boolean;
  secretLike: boolean;
}

export function diffEnvFiles(files: EnvFile[]): EnvDiffEntry[] {
  const allKeys = new Set<string>();
  for (const f of files) for (const k of f.entries.keys()) allKeys.add(k);
  const result: EnvDiffEntry[] = [];
  for (const key of [...allKeys].sort()) {
    const presence: Record<string, "present" | "missing" | "empty"> = {};
    const values: string[] = [];
    for (const f of files) {
      const e = f.entries.get(key);
      if (!e) presence[f.path] = "missing";
      else if (e.isEmpty) presence[f.path] = "empty";
      else {
        presence[f.path] = "present";
        values.push(e.value);
      }
    }
    const valueDiverges = new Set(values).size > 1;
    result.push({
      key,
      presence,
      valueDiverges,
      secretLike: looksSecret(key),
    });
  }
  return result;
}
