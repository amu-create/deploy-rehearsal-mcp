import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

export interface BaselineConfig {
  enabled: boolean;
  mode: "file";
  path: string;
  compareBy: Array<"id" | "fingerprint" | "category">;
  deltaBlockThreshold: number;
  deltaCautionThreshold: number;
  gitRefMode: "direct" | "merge-base";
  defaultGitRef: string | null;
}

export type PrismaWeightKey =
  | "dropTable"
  | "dropColumn"
  | "truncate"
  | "setNotNull"
  | "alterType"
  | "addUnique"
  | "createUniqueIndex"
  | "dropIndex"
  | "renameColumn"
  | "renameTable"
  | "schemaDriftNoMigration"
  | "migrationWithoutSchema"
  | "providerMismatch"
  | "providerChanged";

export interface PrismaDetectorConfig {
  enabled: boolean;
  schemaPath: string;
  blockOnProviderChange: boolean;
  blockOnDestructiveMigration: boolean;
  requireMigrationForSchemaChanges: boolean;
  weights: Partial<Record<PrismaWeightKey, number>>;
  hardBlockKinds: PrismaWeightKey[];
  criticalModelPatterns: string[];
  duplicateFingerprintPenaltyRatio: number;
  mitigationHints: string[];
  contextBonus: number;
  mitigationDiscount: number;
}

import type { RawSuppress } from "./suppression.js";

export interface RehearsalConfig {
  allowedDomains: string[];
  requiredEnvKeys: string[];
  paymentProviders: string[];
  ignorePatterns: string[];
  severityWeights: Partial<Record<string, number>>;
  blockedSecretPatterns: string[];
  suppress: RawSuppress[];
  thresholds: { block: number; caution: number };
  envFiles?: string[];
  baseline: BaselineConfig;
  prisma: PrismaDetectorConfig;
  nextjs: NextjsDetectorConfig;
}

export const DEFAULT_PRISMA_WEIGHTS: Required<PrismaDetectorConfig["weights"]> = {
  providerChanged: 95,
  providerMismatch: 85,
  dropTable: 85,
  truncate: 80,
  dropColumn: 70,
  setNotNull: 38,
  schemaDriftNoMigration: 28,
  alterType: 24,
  addUnique: 20,
  createUniqueIndex: 18,
  migrationWithoutSchema: 14,
  dropIndex: 10,
  renameColumn: 10,
  renameTable: 12,
};

export const DEFAULT_HARD_BLOCK_KINDS: PrismaWeightKey[] = [
  "providerChanged",
  "providerMismatch",
  "dropTable",
  "truncate",
  "dropColumn",
];

export const DEFAULT_CRITICAL_MODEL_PATTERNS = [
  "User",
  "Account",
  "Session",
  "Payment",
  "Subscription",
  "Order",
  "Invoice",
];

export const DEFAULT_MITIGATION_HINTS = [
  "SET DEFAULT",
  "backfill",
  "populate",
  "UPDATE",
  "copy data",
];

export type NextjsWeightKey =
  | "publicSecretExposure"
  | "publicSuspiciousExposure"
  | "clientEnvAccessSecret"
  | "edgeNodeApiMismatch"
  | "edgePrismaUsage"
  | "matcherShrunk"
  | "middlewareUnprotectedCriticalRoute"
  | "nextConfigRisk"
  | "imagesRemotePatternsShrunk"
  | "authRewriteOrRedirectRisk"
  | "dynamicStaticConflict"
  | "personalizedStatic"
  // v2
  | "serverActionDrift"
  | "isrRevalidateConflict"
  | "standaloneOutputMissing";

export interface NextjsDetectorConfig {
  enabled: boolean;
  appDirs: string[];
  pagesDirs: string[];
  middlewarePaths: string[];
  nextConfigPaths: string[];
  dockerfilePaths: string[];
  criticalRoutes: string[];
  authRouteHints: string[];
  hardSecretHints: string[];
  softSecretHints: string[];
  safeExposureHints: string[];
  hardBlockKinds: NextjsWeightKey[];
  weights: Partial<Record<NextjsWeightKey, number>>;
}

export const DEFAULT_NEXTJS_WEIGHTS: Required<NextjsDetectorConfig["weights"]> = {
  publicSecretExposure: 90,
  publicSuspiciousExposure: 32,
  clientEnvAccessSecret: 80,
  edgeNodeApiMismatch: 85,
  edgePrismaUsage: 85,
  matcherShrunk: 28,
  middlewareUnprotectedCriticalRoute: 55,
  nextConfigRisk: 22,
  imagesRemotePatternsShrunk: 24,
  authRewriteOrRedirectRisk: 36,
  dynamicStaticConflict: 30,
  personalizedStatic: 45,
  serverActionDrift: 60,
  isrRevalidateConflict: 25,
  standaloneOutputMissing: 40,
};

export const DEFAULT_NEXTJS_HARD_BLOCK_KINDS: NextjsWeightKey[] = [
  "publicSecretExposure",
  "clientEnvAccessSecret",
  "edgeNodeApiMismatch",
  "edgePrismaUsage",
  "personalizedStatic",
  "serverActionDrift",
];

export const DEFAULT_CONFIG: RehearsalConfig = {
  allowedDomains: [],
  requiredEnvKeys: [],
  paymentProviders: [],
  ignorePatterns: [],
  severityWeights: {},
  blockedSecretPatterns: [],
  suppress: [],
  thresholds: { block: 90, caution: 25 },
  baseline: {
    enabled: false,
    mode: "file",
    path: ".deploy-rehearsal-baseline.json",
    compareBy: ["fingerprint"],
    deltaBlockThreshold: 45,
    deltaCautionThreshold: 15,
    gitRefMode: "merge-base",
    defaultGitRef: null,
  },
  prisma: {
    enabled: true,
    schemaPath: "prisma/schema.prisma",
    blockOnProviderChange: true,
    blockOnDestructiveMigration: true,
    requireMigrationForSchemaChanges: true,
    weights: { ...DEFAULT_PRISMA_WEIGHTS },
    hardBlockKinds: [...DEFAULT_HARD_BLOCK_KINDS],
    criticalModelPatterns: [...DEFAULT_CRITICAL_MODEL_PATTERNS],
    duplicateFingerprintPenaltyRatio: 0.2,
    mitigationHints: [...DEFAULT_MITIGATION_HINTS],
    contextBonus: 12,
    mitigationDiscount: 14,
  },
  nextjs: {
    enabled: true,
    appDirs: ["app", "src/app"],
    pagesDirs: ["pages", "src/pages"],
    middlewarePaths: ["middleware.ts", "middleware.js", "src/middleware.ts", "src/middleware.js"],
    nextConfigPaths: ["next.config.js", "next.config.mjs", "next.config.ts", "next.config.cjs"],
    dockerfilePaths: ["Dockerfile", "Dockerfile.web", "Dockerfile.prod", "docker/Dockerfile"],
    criticalRoutes: ["/dashboard", "/billing", "/account", "/admin", "/api/private", "/api/admin"],
    authRouteHints: ["/auth", "/login", "/logout", "/api/auth", "/signin", "/signout"],
    hardSecretHints: ["secret", "private[_-]?key", "\\btoken\\b", "password", "passwd", "credential"],
    softSecretHints: ["api[_-]?key", "\\bkey\\b", "access", "bearer"],
    safeExposureHints: ["publishable", "public", "anon"],
    hardBlockKinds: [...DEFAULT_NEXTJS_HARD_BLOCK_KINDS],
    weights: { ...DEFAULT_NEXTJS_WEIGHTS },
  },
};

const CONFIG_FILENAMES = [
  "deploy-rehearsal.config.json",
  ".deploy-rehearsal.json",
];

async function fileExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export async function loadConfig(
  cwd: string,
  explicitPath?: string,
): Promise<{ config: RehearsalConfig; source: string }> {
  const candidates = explicitPath
    ? [resolve(cwd, explicitPath)]
    : CONFIG_FILENAMES.map((n) => join(cwd, n));

  for (const path of candidates) {
    if (!(await fileExists(path))) continue;
    try {
      const raw = await readFile(path, "utf8");
      const parsed = JSON.parse(raw);
      return {
        config: mergeConfig(DEFAULT_CONFIG, parsed),
        source: path,
      };
    } catch (e: any) {
      throw new Error(`Invalid config at ${path}: ${e.message}`);
    }
  }
  return { config: DEFAULT_CONFIG, source: "<defaults>" };
}

function mergeConfig(base: RehearsalConfig, patch: any): RehearsalConfig {
  if (!patch || typeof patch !== "object") return base;
  return {
    ...base,
    ...patch,
    severityWeights: { ...base.severityWeights, ...(patch.severityWeights ?? {}) },
    thresholds: { ...base.thresholds, ...(patch.thresholds ?? {}) },
    allowedDomains: patch.allowedDomains ?? base.allowedDomains,
    requiredEnvKeys: patch.requiredEnvKeys ?? base.requiredEnvKeys,
    paymentProviders: patch.paymentProviders ?? base.paymentProviders,
    ignorePatterns: patch.ignorePatterns ?? base.ignorePatterns,
    blockedSecretPatterns: patch.blockedSecretPatterns ?? base.blockedSecretPatterns,
    suppress: patch.suppress ?? base.suppress,
    envFiles: patch.envFiles ?? base.envFiles,
    baseline: { ...base.baseline, ...(patch.baseline ?? {}) },
    prisma: {
      ...base.prisma,
      ...(patch.prisma ?? {}),
      weights: { ...base.prisma.weights, ...((patch.prisma ?? {}).weights ?? {}) },
    },
    nextjs: {
      ...base.nextjs,
      ...(patch.nextjs ?? {}),
      weights: { ...base.nextjs.weights, ...((patch.nextjs ?? {}).weights ?? {}) },
    },
  };
}

// Minimal glob → regex. Supports **, *, ?. Path separator normalized to /.
function globToRegex(glob: string): RegExp {
  const normalized = glob.replace(/\\/g, "/");
  let out = "";
  let i = 0;
  while (i < normalized.length) {
    const c = normalized[i];
    if (c === "*") {
      if (normalized[i + 1] === "*") {
        out += ".*";
        i += 2;
        if (normalized[i] === "/") i++;
      } else {
        out += "[^/]*";
        i++;
      }
    } else if (c === "?") {
      out += ".";
      i++;
    } else if ("\\^$+.()|{}[]".includes(c)) {
      out += "\\" + c;
      i++;
    } else {
      out += c;
      i++;
    }
  }
  return new RegExp("^" + out + "$");
}

export function matchesIgnore(patterns: string[], relPath: string): boolean {
  const norm = relPath.replace(/\\/g, "/");
  for (const p of patterns) {
    const re = globToRegex(p);
    if (re.test(norm)) return true;
  }
  return false;
}
