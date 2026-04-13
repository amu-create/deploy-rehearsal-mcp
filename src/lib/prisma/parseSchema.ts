import { readFile } from "node:fs/promises";

export interface PrismaDatasource {
  name: string;
  provider: string;
  urlEnv?: string;
  urlLiteral?: string;
  directUrlEnv?: string;
  shadowDatabaseUrlEnv?: string;
}

export interface ParsedSchema {
  exists: boolean;
  path: string;
  datasource?: PrismaDatasource;
  raw?: string;
}

export async function parseSchema(path: string): Promise<ParsedSchema> {
  try {
    const raw = await readFile(path, "utf8");
    return { exists: true, path, raw, datasource: extractDatasource(raw) };
  } catch {
    return { exists: false, path };
  }
}

export function extractDatasource(raw: string): PrismaDatasource | undefined {
  const m = raw.match(/datasource\s+(\w+)\s*\{([\s\S]*?)\}/);
  if (!m) return undefined;
  const name = m[1];
  const body = m[2];
  const provider = readStringField(body, "provider") ?? "";
  const url = readEnvOrString(body, "url");
  const directUrl = readEnvOrString(body, "directUrl");
  const shadow = readEnvOrString(body, "shadowDatabaseUrl");
  return {
    name,
    provider,
    urlEnv: url?.envName,
    urlLiteral: url?.literal,
    directUrlEnv: directUrl?.envName,
    shadowDatabaseUrlEnv: shadow?.envName,
  };
}

function readStringField(body: string, field: string): string | undefined {
  const re = new RegExp(`\\b${field}\\s*=\\s*"([^"]+)"`);
  const m = body.match(re);
  return m?.[1];
}

function readEnvOrString(body: string, field: string): { envName?: string; literal?: string } | undefined {
  const envRe = new RegExp(`\\b${field}\\s*=\\s*env\\(\\s*"([^"]+)"\\s*\\)`);
  const envM = body.match(envRe);
  if (envM) return { envName: envM[1] };
  const lit = readStringField(body, field);
  if (lit !== undefined) return { literal: lit };
  return undefined;
}
