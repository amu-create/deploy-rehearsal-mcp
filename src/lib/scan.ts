import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";

const DEFAULT_IGNORES = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".turbo",
  "coverage",
  ".cache",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  "out",
]);

const TEXT_EXT = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".rb", ".go", ".rs", ".java", ".kt",
  ".php", ".cs", ".swift", ".c", ".cpp", ".h", ".hpp",
  ".json", ".yaml", ".yml", ".toml", ".ini", ".env",
  ".md", ".html", ".vue", ".svelte", ".astro",
  ".sh", ".bash", ".zsh",
  ".sql", ".prisma",
]);

export interface ScanMatch {
  file: string;
  line: number;
  text: string;
}

export async function walk(
  root: string,
  maxFiles: number = 5000,
): Promise<string[]> {
  const results: string[] = [];
  async function rec(dir: string): Promise<void> {
    if (results.length >= maxFiles) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (results.length >= maxFiles) return;
      if (DEFAULT_IGNORES.has(e.name)) continue;
      if (e.name.startsWith(".") && e.name !== ".env" && !e.name.startsWith(".env.")) {
        if (e.isDirectory()) continue;
      }
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        await rec(full);
      } else if (e.isFile()) {
        const dot = e.name.lastIndexOf(".");
        const ext = dot === -1 ? "" : e.name.slice(dot).toLowerCase();
        if (TEXT_EXT.has(ext) || e.name.startsWith(".env")) {
          results.push(full);
        }
      }
    }
  }
  await rec(root);
  return results;
}

export async function scanPatterns(
  root: string,
  patterns: RegExp[],
): Promise<Map<string, ScanMatch[]>> {
  const files = await walk(root);
  const hits = new Map<string, ScanMatch[]>();
  for (const p of patterns) hits.set(p.source, []);
  for (const file of files) {
    let content: string;
    try {
      const s = await stat(file);
      if (s.size > 2 * 1024 * 1024) continue;
      content = await readFile(file, "utf8");
    } catch {
      continue;
    }
    const rel = relative(root, file).replace(/\\/g, "/");
    const lines = content.split(/\r?\n/);
    for (const p of patterns) {
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const re = new RegExp(p.source, p.flags.includes("g") ? p.flags : p.flags + "g");
        if (re.test(line)) {
          hits.get(p.source)!.push({
            file: rel,
            line: i + 1,
            text: line.trim().slice(0, 240),
          });
        }
      }
    }
  }
  return hits;
}
