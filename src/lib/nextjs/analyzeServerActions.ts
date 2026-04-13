import { readFile } from "node:fs/promises";

export interface ServerActionFinding {
  kind: "use-client-with-use-server";
  file: string;
  clientLine: number;
  serverLine: number;
  evidence: string;
}

const USE_CLIENT_LINE_RE = /^\s*["']use client["']\s*;?\s*$/m;
const USE_SERVER_LINE_RE = /^\s*["']use server["']\s*;?\s*$/m;

function findLine(text: string, re: RegExp): number {
  const m = text.match(re);
  if (!m) return -1;
  const idx = m.index ?? -1;
  if (idx < 0) return -1;
  return (text.slice(0, idx).match(/\n/g)?.length ?? 0) + 1;
}

/**
 * Detects files that mix `"use client"` (file-level) with a `"use server"` directive
 * (file-level OR inside a function body — both appear as a standalone directive line).
 *
 * This combination is a real Next.js bug: Server Actions cannot be defined inside a
 * client component module. Next.js rejects the build in strict mode; in looser setups
 * the action silently bundles to the wrong side of the client/server boundary.
 */
export async function analyzeServerActions(
  files: Array<{ absolutePath: string; relPath: string }>,
): Promise<ServerActionFinding[]> {
  const out: ServerActionFinding[] = [];
  for (const { absolutePath, relPath } of files) {
    let text: string;
    try {
      text = await readFile(absolutePath, "utf8");
    } catch {
      continue;
    }
    const clientLine = findLine(text, USE_CLIENT_LINE_RE);
    if (clientLine < 0) continue;
    const serverLine = findLine(text, USE_SERVER_LINE_RE);
    if (serverLine < 0) continue;
    const lines = text.split(/\r?\n/);
    const evidence = (lines[serverLine - 1] ?? "").trim().slice(0, 160);
    out.push({
      kind: "use-client-with-use-server",
      file: relPath,
      clientLine,
      serverLine,
      evidence,
    });
  }
  return out;
}
