import { readFile } from "node:fs/promises";
import type { NextjsDetectorConfig } from "../config.js";

export interface EnvExposureFinding {
  kind: "public-secret" | "public-suspicious" | "client-env-access";
  key: string;
  file?: string;
  line?: number;
  severity: "high" | "warn";
}

function matchesAny(name: string, hints: string[]): boolean {
  return hints.some((h) => {
    try {
      return new RegExp(h, "i").test(name);
    } catch {
      return name.toLowerCase().includes(h.toLowerCase());
    }
  });
}

export function classifyPublicKey(
  rawKey: string,
  config: NextjsDetectorConfig,
): "safe" | "hard" | "soft" {
  const stripped = rawKey.replace(/^NEXT_PUBLIC_/, "");
  if (matchesAny(stripped, config.safeExposureHints)) return "safe";
  if (matchesAny(stripped, config.hardSecretHints)) return "hard";
  if (matchesAny(stripped, config.softSecretHints)) return "soft";
  return "safe";
}

export function isNonPublicSecretAccess(
  key: string,
  config: NextjsDetectorConfig,
): boolean {
  if (key.startsWith("NEXT_PUBLIC_")) return false;
  return (
    matchesAny(key, config.hardSecretHints) ||
    matchesAny(key, config.softSecretHints)
  );
}

export interface EnvExposureInput {
  clientLikeFiles: Array<{ absolutePath: string; relPath: string }>;
  envFiles: Array<{ path: string; keys: string[] }>;
  envVarsReferencedInDiff?: string[];
  config: NextjsDetectorConfig;
}

const USE_CLIENT_RE = /^\s*["']use client["']\s*;?/m;
const PROCESS_ENV_RE = /process\.env\.([A-Z0-9_]+)/g;

export async function scanEnvExposure(input: EnvExposureInput): Promise<EnvExposureFinding[]> {
  const findings: EnvExposureFinding[] = [];

  for (const ef of input.envFiles) {
    for (const key of ef.keys) {
      if (!key.startsWith("NEXT_PUBLIC_")) continue;
      const tier = classifyPublicKey(key, input.config);
      if (tier === "safe") continue;
      findings.push({
        kind: tier === "hard" ? "public-secret" : "public-suspicious",
        key,
        severity: tier === "hard" ? "high" : "warn",
      });
    }
  }

  for (const { absolutePath, relPath } of input.clientLikeFiles) {
    let text: string;
    try {
      text = await readFile(absolutePath, "utf8");
    } catch {
      continue;
    }
    if (!USE_CLIENT_RE.test(text)) continue;
    const lines = text.split(/\r?\n/);
    const seenKeys = new Set<string>();
    for (let i = 0; i < lines.length; i++) {
      const matches = lines[i].matchAll(/process\.env\.([A-Z0-9_]+)/g);
      for (const m of matches) {
        const key = m[1];
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);
        if (!isNonPublicSecretAccess(key, input.config)) continue;
        findings.push({
          kind: "client-env-access",
          key,
          file: relPath,
          line: i + 1,
          severity: "high",
        });
      }
    }
    void PROCESS_ENV_RE;
  }

  return findings;
}
