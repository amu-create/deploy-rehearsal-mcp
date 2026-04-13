import { readFile } from "node:fs/promises";

export type IsrConflictKind =
  | "revalidate-ignored-under-force-dynamic"
  | "revalidate-zero-under-force-static"
  | "fetch-cache-no-store-with-revalidate";

export interface IsrRevalidateFinding {
  kind: IsrConflictKind;
  file: string;
  evidence: string;
  details: {
    dynamic?: string;
    revalidate?: number;
    fetchCache?: string;
  };
}

const DYNAMIC_RE = /export\s+const\s+dynamic\s*=\s*["']([^"']+)["']/;
const REVALIDATE_RE = /export\s+const\s+revalidate\s*=\s*(\d+)\b/;
const FETCHCACHE_RE = /export\s+const\s+fetchCache\s*=\s*["']([^"']+)["']/;

export async function analyzeIsrRevalidate(
  files: Array<{ absolutePath: string; relPath: string }>,
): Promise<IsrRevalidateFinding[]> {
  const out: IsrRevalidateFinding[] = [];
  for (const { absolutePath, relPath } of files) {
    let text: string;
    try {
      text = await readFile(absolutePath, "utf8");
    } catch {
      continue;
    }
    const dyn = text.match(DYNAMIC_RE)?.[1];
    const rev = text.match(REVALIDATE_RE);
    const fc = text.match(FETCHCACHE_RE)?.[1];
    const revNum = rev ? Number(rev[1]) : undefined;

    const details = { dynamic: dyn, revalidate: revNum, fetchCache: fc };

    if (dyn === "force-dynamic" && typeof revNum === "number") {
      out.push({
        kind: "revalidate-ignored-under-force-dynamic",
        file: relPath,
        evidence: `dynamic='force-dynamic' + revalidate=${revNum}`,
        details,
      });
    }
    if (dyn === "force-static" && revNum === 0) {
      out.push({
        kind: "revalidate-zero-under-force-static",
        file: relPath,
        evidence: `dynamic='force-static' + revalidate=0`,
        details,
      });
    }
    if (fc === "force-no-store" && typeof revNum === "number" && revNum > 0) {
      out.push({
        kind: "fetch-cache-no-store-with-revalidate",
        file: relPath,
        evidence: `fetchCache='force-no-store' + revalidate=${revNum}`,
        details,
      });
    }
  }
  return out;
}
