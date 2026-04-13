import { resolve } from "node:path";
import { stat } from "node:fs/promises";
import type { Finding } from "../tools/runRehearsal.js";
import type { RehearsalConfig, NextjsWeightKey } from "../lib/config.js";
import { DEFAULT_NEXTJS_WEIGHTS } from "../lib/config.js";
import { scanEnvExposure } from "../lib/nextjs/scanEnvExposure.js";
import { analyzeRuntimeMismatch } from "../lib/nextjs/analyzeRuntimeMismatch.js";
import { analyzeMiddlewareCoverage } from "../lib/nextjs/analyzeMiddlewareCoverage.js";
import { analyzeNextConfig, type NextConfigChangeKind } from "../lib/nextjs/analyzeNextConfig.js";
import { analyzeCachingMode } from "../lib/nextjs/analyzeCachingMode.js";
import { analyzeServerActions } from "../lib/nextjs/analyzeServerActions.js";
import { analyzeIsrRevalidate } from "../lib/nextjs/analyzeIsrRevalidate.js";
import { analyzeStandaloneOutput } from "../lib/nextjs/analyzeStandaloneOutput.js";
import { parseEnvFile } from "../lib/env.js";

async function fileExists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}

function weight(config: RehearsalConfig, key: NextjsWeightKey): number {
  return config.nextjs.weights[key] ?? DEFAULT_NEXTJS_WEIGHTS[key];
}

function normalize(p: string): string {
  return p.replace(/\\/g, "/");
}

function routeFromFile(file: string, appDirs: string[], pagesDirs: string[]): string | null {
  const n = normalize(file);
  for (const dir of appDirs) {
    const prefix = normalize(dir).replace(/\/$/, "") + "/";
    if (n.startsWith(prefix)) {
      const rest = n.slice(prefix.length);
      const m = rest.match(/^(.*)\/(page|route|layout)\.(ts|tsx|js|jsx)$/);
      if (m) return m[1] === "" ? "/" : "/" + m[1];
    }
  }
  for (const dir of pagesDirs) {
    const prefix = normalize(dir).replace(/\/$/, "") + "/";
    if (n.startsWith(prefix)) {
      const rest = n.slice(prefix.length).replace(/\.(ts|tsx|js|jsx)$/, "");
      if (/^_/.test(rest)) return null;
      const cleaned = rest.replace(/\/index$/, "");
      return cleaned === "" ? "/" : "/" + cleaned;
    }
  }
  return null;
}

export interface DetectNextjsInput {
  cwd: string;
  config: RehearsalConfig;
  diffFiles: Array<{ path: string }>;
  envFilesResolved?: string[];
  getFilePatch: (relPath: string) => Promise<string>;
}

const SOURCE_EXT_RE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const PAGE_OR_ROUTE_RE = /\/(page|route|layout|error|loading|not-found|template)\.(ts|tsx|js|jsx)$/;

function isPageOrRoute(file: string): boolean {
  return PAGE_OR_ROUTE_RE.test(normalize(file));
}
function isWithinAppOrPages(file: string, config: RehearsalConfig): boolean {
  const n = normalize(file);
  return [...config.nextjs.appDirs, ...config.nextjs.pagesDirs].some(
    (dir) => n.startsWith(normalize(dir) + "/"),
  );
}
function isMiddleware(file: string, config: RehearsalConfig): boolean {
  const n = normalize(file);
  return config.nextjs.middlewarePaths.some((p) => n === normalize(p));
}
function isNextConfig(file: string, config: RehearsalConfig): boolean {
  const n = normalize(file);
  return config.nextjs.nextConfigPaths.some((p) => n === normalize(p));
}

export async function detectNextjs(input: DetectNextjsInput): Promise<Finding[]> {
  const { cwd, config, diffFiles } = input;
  if (!config.nextjs.enabled) return [];

  const onDiskChecks = await Promise.all([
    ...config.nextjs.nextConfigPaths.map((p) => fileExists(resolve(cwd, p))),
    ...config.nextjs.middlewarePaths.map((p) => fileExists(resolve(cwd, p))),
    ...config.nextjs.appDirs.map((p) => fileExists(resolve(cwd, p))),
    ...config.nextjs.pagesDirs.map((p) => fileExists(resolve(cwd, p))),
  ]);
  const anyOnDisk = onDiskChecks.some(Boolean);
  const anyInDiff = diffFiles.some(
    (f) =>
      isNextConfig(f.path, config) ||
      isMiddleware(f.path, config) ||
      isWithinAppOrPages(f.path, config),
  );
  if (!anyOnDisk && !anyInDiff) return [];

  const findings: Finding[] = [];

  // ---- 1) Env exposure ----------------------------------------------------
  const envFilesList = input.envFilesResolved ?? [];
  const envFilesParsed = await Promise.all(
    envFilesList.map(async (p) => {
      try {
        const ef = await parseEnvFile(p);
        return { path: ef.path, keys: [...ef.entries.keys()] };
      } catch {
        return null;
      }
    }),
  );
  const validEnvFiles = envFilesParsed.filter((x): x is NonNullable<typeof x> => !!x);
  const changedSourceFiles = diffFiles
    .filter((f) => SOURCE_EXT_RE.test(f.path))
    .map((f) => ({ relPath: normalize(f.path), absolutePath: resolve(cwd, f.path) }));

  const envExposure = await scanEnvExposure({
    clientLikeFiles: changedSourceFiles,
    envFiles: validEnvFiles,
    config: config.nextjs,
  });
  for (const e of envExposure) {
    if (e.kind === "public-secret") {
      findings.push({
        id: `nextjs:public-secret:${e.key}`,
        fingerprint: `nextjs:public-secret:${e.key}`,
        severity: "high",
        category: "nextjs",
        message: `Env key \`${e.key}\` is exposed to the browser via NEXT_PUBLIC_ but looks like a secret.`,
        evidence: { key: e.key },
        suggestion: "Rename without NEXT_PUBLIC_ prefix, or confirm this truly is safe to ship to clients.",
        confidence: 0.9,
        weight: weight(config, "publicSecretExposure"),
      });
    } else if (e.kind === "public-suspicious") {
      findings.push({
        id: `nextjs:public-suspicious:${e.key}`,
        fingerprint: `nextjs:public-suspicious:${e.key}`,
        severity: "warn",
        category: "nextjs",
        message: `Env key \`${e.key}\` ships to the browser and has a suspicious name (API key / token-like).`,
        evidence: { key: e.key },
        suggestion: "Verify this key is genuinely public-safe (publishable, anon). If not, drop the NEXT_PUBLIC_ prefix.",
        confidence: 0.7,
        weight: weight(config, "publicSuspiciousExposure"),
      });
    } else {
      // client-env-access
      findings.push({
        id: `nextjs:client-env-access:${e.key}:${e.file}:${e.line}`,
        fingerprint: `nextjs:client-env-access:${e.key}`,
        severity: "high",
        category: "nextjs",
        message: `Client component \`${e.file}\` reads server-only env \`${e.key}\`.`,
        evidence: { key: e.key, file: e.file, line: e.line },
        suggestion: "Move the access to a server component / route handler, or read via a server API the client calls.",
        confidence: 0.9,
        weight: weight(config, "clientEnvAccessSecret"),
      });
    }
  }

  // ---- 2) Edge / Node runtime mismatch -----------------------------------
  const runtimeFindings = await analyzeRuntimeMismatch(changedSourceFiles);
  for (const rf of runtimeFindings) {
    const route = routeFromFile(rf.file, config.nextjs.appDirs, config.nextjs.pagesDirs) ?? rf.file;
    if (rf.kind === "edge-node-api") {
      findings.push({
        id: `nextjs:edge-node-api:${rf.file}:${rf.module}`,
        fingerprint: `nextjs:edge-node-api:${route}:${rf.module}`,
        severity: "high",
        category: "nextjs",
        message: `Edge runtime route ${rf.file} imports Node-only module \`${rf.module}\`.`,
        evidence: { file: rf.file, line: rf.line, module: rf.module, route, import: rf.evidence },
        suggestion: "Drop `export const runtime = 'edge'` or replace the Node-only import with a Web API.",
        confidence: 0.95,
        weight: weight(config, "edgeNodeApiMismatch"),
      });
    } else {
      findings.push({
        id: `nextjs:edge-prisma:${rf.file}:${rf.module}`,
        fingerprint: `nextjs:edge-prisma:${route}`,
        severity: "high",
        category: "nextjs",
        message: `Edge runtime route ${rf.file} uses Prisma (\`${rf.module}\`) — not supported on edge.`,
        evidence: { file: rf.file, line: rf.line, module: rf.module, route, import: rf.evidence },
        suggestion: "Move Prisma access to a Node runtime route, or use Prisma's edge adapter explicitly.",
        confidence: 0.95,
        weight: weight(config, "edgePrismaUsage"),
      });
    }
  }

  // ---- 3) Middleware coverage --------------------------------------------
  const middlewareInDiff = diffFiles.some((f) => isMiddleware(f.path, config));
  const activeMiddlewareRel = config.nextjs.middlewarePaths.find(
    (p) => diffFiles.some((f) => normalize(f.path) === normalize(p)),
  ) ?? null;
  let middlewareAbsolutePath: string | null = null;
  for (const p of config.nextjs.middlewarePaths) {
    const abs = resolve(cwd, p);
    if (await fileExists(abs)) { middlewareAbsolutePath = abs; break; }
  }
  const middlewarePatch = activeMiddlewareRel ? await input.getFilePatch(activeMiddlewareRel) : "";
  const newRouteRelPaths = diffFiles.map((f) => normalize(f.path)).filter((p) => isPageOrRoute(p));

  const middlewareFindings = await analyzeMiddlewareCoverage({
    middlewareAbsolutePath,
    middlewarePatch,
    middlewareInDiff,
    newRouteRelPaths,
    criticalRoutes: config.nextjs.criticalRoutes,
    appDirs: config.nextjs.appDirs,
    pagesDirs: config.nextjs.pagesDirs,
  });
  for (const mf of middlewareFindings) {
    if (mf.kind === "matcher-shrunk") {
      const removedJoin = (mf.removed ?? []).join("|");
      findings.push({
        id: `nextjs:matcher-shrunk:${activeMiddlewareRel ?? "middleware"}`,
        fingerprint: `nextjs:matcher-shrunk:${removedJoin}`,
        severity: "warn",
        category: "nextjs",
        message: mf.evidence,
        evidence: { before: mf.before, after: mf.after, removed: mf.removed },
        suggestion: "Confirm the removed patterns are truly no longer protected (auth, payment, admin).",
        confidence: 0.85,
        weight: weight(config, "matcherShrunk"),
      });
    } else if (mf.route) {
      findings.push({
        id: `nextjs:middleware-unprotected:${mf.route}`,
        fingerprint: `nextjs:middleware-unprotected:${mf.route}`,
        severity: "warn",
        category: "nextjs",
        message: mf.evidence,
        evidence: { route: mf.route },
        suggestion: `Add ${mf.route} (or its prefix) to the middleware matcher.`,
        confidence: 0.8,
        weight: weight(config, "middlewareUnprotectedCriticalRoute"),
      });
    }
  }

  // ---- 4) next.config risky changes --------------------------------------
  const configFileInDiff = diffFiles.find((f) => isNextConfig(f.path, config));
  if (configFileInDiff) {
    const configPatch = await input.getFilePatch(configFileInDiff.path);
    const configFindings = analyzeNextConfig(configPatch, config.nextjs.authRouteHints);
    for (const cf of configFindings) {
      if (cf.kind === "images-remote-patterns-shrunk") {
        const removedJoin = (cf.removedImageDomains ?? []).join("|");
        findings.push({
          id: `nextjs:images-remote-patterns-shrunk:${configFileInDiff.path}`,
          fingerprint: `nextjs:images-remote-patterns-shrunk:${removedJoin}`,
          severity: cf.severity,
          category: "nextjs",
          message: cf.evidence,
          evidence: { removed: cf.removedImageDomains, configFile: configFileInDiff.path },
          suggestion: "Confirm no production <Image> source now falls outside the allowlist.",
          confidence: 0.85,
          weight: weight(config, "imagesRemotePatternsShrunk"),
        });
      } else if (cf.kind === "auth-rewrite-risk" || cf.kind === "auth-redirect-risk") {
        const pairSig = (cf.authPairs ?? [])
          .map((p) => `${p.source}->${p.destination}`)
          .slice()
          .sort()
          .join("|");
        const fingerprint = pairSig
          ? `nextjs:${cf.kind}:${pairSig}`
          : `nextjs:${cf.kind}`;
        findings.push({
          id: `nextjs:${cf.kind}:${configFileInDiff.path}`,
          fingerprint,
          severity: cf.severity,
          category: "nextjs",
          message: cf.evidence,
          evidence: { pairs: cf.authPairs, configFile: configFileInDiff.path },
          suggestion: "Double-check login → callback → app flow in staging. OAuth loops are the #1 failure mode here.",
          confidence: 0.9,
          weight: weight(config, "authRewriteOrRedirectRisk"),
        });
      } else {
        // Generic nextConfigRisk: basepath / output / assetprefix / trailingslash
        findings.push({
          id: `nextjs:config-${cf.kind}:${configFileInDiff.path}`,
          fingerprint: `nextjs:config-${cf.kind}`,
          severity: cf.severity,
          category: "nextjs",
          message: cf.evidence,
          evidence: { kind: cf.kind, configFile: configFileInDiff.path },
          suggestion: suggestForConfigKind(cf.kind),
          confidence: 0.85,
          weight: weight(config, "nextConfigRisk"),
        });
      }
    }
  }

  // ---- 5) Caching / dynamic mode conflict --------------------------------
  const routeFiles = changedSourceFiles.filter((f) => isPageOrRoute(f.relPath));
  const cachingFindings = await analyzeCachingMode({
    files: routeFiles,
    appDirs: config.nextjs.appDirs,
    pagesDirs: config.nextjs.pagesDirs,
    criticalRoutes: config.nextjs.criticalRoutes,
  });
  for (const cf of cachingFindings) {
    const route =
      cf.route ??
      routeFromFile(cf.file, config.nextjs.appDirs, config.nextjs.pagesDirs) ??
      cf.file;
    if (cf.kind === "personalized-static" && cf.route) {
      findings.push({
        id: `nextjs:personalized-static:${cf.route}:${cf.file}`,
        fingerprint: `nextjs:personalized-static:${cf.route}`,
        severity: "high",
        category: "nextjs",
        message: cf.evidence,
        evidence: { file: cf.file, route: cf.route },
        suggestion: "Drop force-static on personalized pages, or move the personalized UI into a child client component.",
        confidence: 0.9,
        weight: weight(config, "personalizedStatic"),
      });
    } else {
      findings.push({
        id: `nextjs:dynamic-static-conflict:${cf.file}`,
        fingerprint: `nextjs:dynamic-static-conflict:${route}`,
        severity: "warn",
        category: "nextjs",
        message: cf.evidence,
        evidence: { file: cf.file, route },
        suggestion: "Decide: either `export const dynamic = 'force-dynamic'`, or strip the cookies/headers/auth reads.",
        confidence: 0.8,
        weight: weight(config, "dynamicStaticConflict"),
      });
    }
  }

  // ---- 6) v2: Server Action drift ----------------------------------------
  const serverActionFindings = await analyzeServerActions(changedSourceFiles);
  for (const sa of serverActionFindings) {
    findings.push({
      id: `nextjs:server-action-drift:${sa.file}:${sa.serverLine}`,
      fingerprint: `nextjs:server-action-drift:${sa.file}`,
      severity: "high",
      category: "nextjs",
      message: `\`${sa.file}\` declares \`"use client"\` (line ${sa.clientLine}) and also contains a \`"use server"\` directive (line ${sa.serverLine}). Server Actions cannot live in a client module.`,
      evidence: {
        file: sa.file,
        clientLine: sa.clientLine,
        serverLine: sa.serverLine,
        snippet: sa.evidence,
      },
      suggestion: "Move the Server Action to a separate file without `\"use client\"`, and import it from the client component.",
      confidence: 0.95,
      weight: weight(config, "serverActionDrift"),
    });
  }

  // ---- 7) v2: ISR revalidate conflicts -----------------------------------
  const isrFindings = await analyzeIsrRevalidate(routeFiles);
  for (const cf of isrFindings) {
    const route = routeFromFile(cf.file, config.nextjs.appDirs, config.nextjs.pagesDirs) ?? cf.file;
    const fingerprint = `nextjs:isr-revalidate-conflict:${cf.kind}:${route}`;
    findings.push({
      id: `nextjs:isr-revalidate-conflict:${cf.kind}:${cf.file}`,
      fingerprint,
      severity: "warn",
      category: "nextjs",
      message: isrMessage(cf.kind, cf.details),
      evidence: { file: cf.file, route, kind: cf.kind, ...cf.details },
      suggestion: isrSuggestion(cf.kind),
      confidence: 0.9,
      weight: weight(config, "isrRevalidateConflict"),
    });
  }

  // ---- 8) v2: Standalone output missing ----------------------------------
  const standaloneFindings = await analyzeStandaloneOutput({
    cwd,
    dockerfilePaths: config.nextjs.dockerfilePaths,
    nextConfigPaths: config.nextjs.nextConfigPaths,
    diffFiles: diffFiles.map((f) => ({ path: f.path })),
  });
  for (const sf of standaloneFindings) {
    findings.push({
      id: `nextjs:standalone-output-missing:${sf.dockerfile}`,
      fingerprint: `nextjs:standalone-output-missing`,
      severity: "warn",
      category: "nextjs",
      message: sf.evidence,
      evidence: { dockerfile: sf.dockerfile, configPath: sf.configPath },
      suggestion:
        "Add `output: 'standalone'` to next.config.* — otherwise the container starts missing its runtime files.",
      confidence: 0.95,
      weight: weight(config, "standaloneOutputMissing"),
    });
  }

  return findings;
}

function isrMessage(kind: string, d: { dynamic?: string; revalidate?: number; fetchCache?: string }): string {
  switch (kind) {
    case "revalidate-ignored-under-force-dynamic":
      return `\`dynamic = 'force-dynamic'\` ignores \`revalidate = ${d.revalidate}\` — the page is re-rendered on every request regardless.`;
    case "revalidate-zero-under-force-static":
      return `\`revalidate = 0\` with \`dynamic = 'force-static'\` disables ISR entirely — the page is baked at build time and never refreshes.`;
    case "fetch-cache-no-store-with-revalidate":
      return `\`fetchCache = 'force-no-store'\` contradicts \`revalidate = ${d.revalidate}\` — fetches bypass the cache so ISR never fires.`;
    default:
      return "Conflicting ISR / caching configuration.";
  }
}

function isrSuggestion(kind: string): string {
  switch (kind) {
    case "revalidate-ignored-under-force-dynamic":
      return "Drop the `revalidate` export, or switch `dynamic` to `'auto'` / `'force-static'`.";
    case "revalidate-zero-under-force-static":
      return "Remove `revalidate = 0`, or switch `dynamic` to `'force-dynamic'` if you genuinely want no caching.";
    case "fetch-cache-no-store-with-revalidate":
      return "Pick one: either keep `fetchCache='force-no-store'` and drop `revalidate`, or drop `fetchCache` and let `revalidate` run.";
    default:
      return "Resolve the conflicting ISR settings.";
  }
}

function suggestForConfigKind(kind: NextConfigChangeKind): string {
  switch (kind) {
    case "basepath-change":
      return "Update OAuth redirect URIs, sitemap, and canonical URLs to match the new basePath.";
    case "output-change":
      return "Verify the host supports the new output (standalone/export) and rerun smoke tests.";
    case "assetprefix-change":
      return "Invalidate CDN and redeploy assets at the new prefix before flipping.";
    case "trailingslash-change":
      return "Audit all internal links, external redirects, and sitemap to match the new policy.";
    default:
      return "Review this next.config change before deploying.";
  }
}
