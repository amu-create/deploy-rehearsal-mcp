import { readFile } from "node:fs/promises";

export interface RuntimeMismatchFinding {
  kind: "edge-node-api" | "edge-prisma";
  file: string;
  line: number;
  evidence: string;
  module: string;
}

const EDGE_DECL_RE = /export\s+const\s+runtime\s*=\s*["'](edge|experimental-edge)["']/;
const NODE_ONLY_MODULES = [
  "fs",
  "fs/promises",
  "path",
  "child_process",
  "os",
  "net",
  "tls",
  "dns",
  "cluster",
  "worker_threads",
  "stream",
  "zlib",
];

const PRISMA_IMPORTS = [
  "@prisma/client",
];

function findImportLine(lines: string[], modules: string[]): { line: number; mod: string; raw: string } | null {
  const importRe = /(?:import|require)\s*(?:[\s\S]*?from)?\s*['"]([^'"]+)['"]/;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(importRe);
    if (!m) continue;
    const mod = m[1];
    for (const target of modules) {
      if (mod === target || mod.startsWith(target + "/")) {
        return { line: i + 1, mod, raw: lines[i].trim() };
      }
      if (target === "@prisma/client" && /\bprisma\b/i.test(mod) && /prisma/i.test(lines[i])) {
        return { line: i + 1, mod, raw: lines[i].trim() };
      }
    }
  }
  return null;
}

export async function analyzeRuntimeMismatch(
  files: Array<{ absolutePath: string; relPath: string }>,
): Promise<RuntimeMismatchFinding[]> {
  const out: RuntimeMismatchFinding[] = [];
  for (const { absolutePath, relPath } of files) {
    let text: string;
    try {
      text = await readFile(absolutePath, "utf8");
    } catch {
      continue;
    }
    if (!EDGE_DECL_RE.test(text)) continue;
    const lines = text.split(/\r?\n/);

    const nodeHit = findImportLine(lines, NODE_ONLY_MODULES);
    if (nodeHit) {
      out.push({
        kind: "edge-node-api",
        file: relPath,
        line: nodeHit.line,
        evidence: nodeHit.raw,
        module: nodeHit.mod,
      });
    }
    const prismaHit = findImportLine(lines, PRISMA_IMPORTS);
    if (prismaHit) {
      out.push({
        kind: "edge-prisma",
        file: relPath,
        line: prismaHit.line,
        evidence: prismaHit.raw,
        module: prismaHit.mod,
      });
    }
    if (!prismaHit) {
      for (let i = 0; i < lines.length; i++) {
        if (/\bPrismaClient\b|\bprisma\.[a-z]/i.test(lines[i])) {
          out.push({
            kind: "edge-prisma",
            file: relPath,
            line: i + 1,
            evidence: lines[i].trim(),
            module: "@prisma/client",
          });
          break;
        }
      }
    }
  }
  return out;
}
