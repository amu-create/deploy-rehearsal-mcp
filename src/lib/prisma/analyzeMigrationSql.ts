export type MigrationKind =
  | "drop-table"
  | "drop-column"
  | "truncate"
  | "set-not-null"
  | "alter-type"
  | "add-unique"
  | "create-unique-index"
  | "drop-index"
  | "rename-column"
  | "rename-table";

export interface MigrationFinding {
  kind: MigrationKind;
  severity: "high" | "warn";
  target: string;
  evidence: string;
  line: number;
}

interface Rule {
  kind: MigrationKind;
  severity: "high" | "warn";
  regex: RegExp;
  extract: (m: RegExpExecArray) => string;
}

const RULES: Rule[] = [
  {
    kind: "drop-table",
    severity: "high",
    regex: /DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?["`]?([A-Za-z_][\w]*)["`]?/gi,
    extract: (m) => m[1],
  },
  {
    kind: "drop-column",
    severity: "high",
    regex:
      /ALTER\s+TABLE\s+["`]?([A-Za-z_][\w]*)["`]?\s+DROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?["`]?([A-Za-z_][\w]*)["`]?/gi,
    extract: (m) => `${m[1]}.${m[2]}`,
  },
  {
    kind: "truncate",
    severity: "high",
    regex: /TRUNCATE\s+(?:TABLE\s+)?["`]?([A-Za-z_][\w]*)["`]?/gi,
    extract: (m) => m[1],
  },
  {
    kind: "alter-type",
    severity: "warn",
    regex:
      /ALTER\s+TABLE\s+["`]?([A-Za-z_][\w]*)["`]?\s+ALTER\s+COLUMN\s+["`]?([A-Za-z_][\w]*)["`]?\s+(?:SET\s+DATA\s+)?TYPE\s+/gi,
    extract: (m) => `${m[1]}.${m[2]}`,
  },
  {
    kind: "set-not-null",
    severity: "warn",
    regex:
      /ALTER\s+TABLE\s+["`]?([A-Za-z_][\w]*)["`]?\s+ALTER\s+COLUMN\s+["`]?([A-Za-z_][\w]*)["`]?\s+SET\s+NOT\s+NULL/gi,
    extract: (m) => `${m[1]}.${m[2]}`,
  },
  {
    kind: "add-unique",
    severity: "warn",
    regex:
      /ALTER\s+TABLE\s+["`]?([A-Za-z_][\w]*)["`]?\s+ADD\s+(?:CONSTRAINT\s+["`]?[A-Za-z_][\w]*["`]?\s+)?UNIQUE\b/gi,
    extract: (m) => m[1],
  },
  {
    kind: "create-unique-index",
    severity: "warn",
    regex: /CREATE\s+UNIQUE\s+INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?([A-Za-z_][\w]*)["`]?/gi,
    extract: (m) => m[1],
  },
  {
    kind: "drop-index",
    severity: "warn",
    regex: /DROP\s+INDEX\s+(?:IF\s+EXISTS\s+)?["`]?([A-Za-z_][\w]*)["`]?/gi,
    extract: (m) => m[1],
  },
  {
    kind: "rename-column",
    severity: "warn",
    regex:
      /ALTER\s+TABLE\s+["`]?([A-Za-z_][\w]*)["`]?\s+RENAME\s+COLUMN\s+["`]?([A-Za-z_][\w]*)["`]?/gi,
    extract: (m) => `${m[1]}.${m[2]}`,
  },
  {
    kind: "rename-table",
    severity: "warn",
    regex: /ALTER\s+TABLE\s+["`]?([A-Za-z_][\w]*)["`]?\s+RENAME\s+TO\s+["`]?([A-Za-z_][\w]*)["`]?/gi,
    extract: (m) => `${m[1]}->${m[2]}`,
  },
];

function lineOf(text: string, index: number): number {
  return (text.slice(0, index).match(/\n/g)?.length ?? 0) + 1;
}

export function scanMigrationSql(sql: string): MigrationFinding[] {
  const out: MigrationFinding[] = [];
  const lines = sql.split(/\r?\n/);
  const seen = new Set<string>();
  for (const rule of RULES) {
    const re = new RegExp(rule.regex.source, rule.regex.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(sql)) !== null) {
      const target = rule.extract(m);
      const line = lineOf(sql, m.index);
      const key = `${rule.kind}:${target}:${line}`;
      if (seen.has(key)) {
        if (m.index === re.lastIndex) re.lastIndex++;
        continue;
      }
      seen.add(key);

      let severity = rule.severity;
      if (rule.kind === "set-not-null") {
        const window = lines.slice(Math.max(0, line - 3), line).join("\n");
        const hasDefault = /DEFAULT\b/i.test(window);
        const hasBackfill = /UPDATE\s+["`]?\w+["`]?\s+SET\b/i.test(window);
        if (!hasDefault && !hasBackfill) severity = "high";
      }

      out.push({
        kind: rule.kind,
        severity,
        target,
        evidence: (lines[line - 1] ?? "").trim().slice(0, 240),
        line,
      });
      if (m.index === re.lastIndex) re.lastIndex++;
    }
  }
  return out;
}
