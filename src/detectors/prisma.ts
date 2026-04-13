import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Finding } from "../tools/runRehearsal.js";
import type { RehearsalConfig, PrismaWeightKey } from "../lib/config.js";
import { DEFAULT_PRISMA_WEIGHTS } from "../lib/config.js";
import { parseSchema } from "../lib/prisma/parseSchema.js";
import { scanMigrationSql, type MigrationKind } from "../lib/prisma/analyzeMigrationSql.js";
import { analyzeDrift } from "../lib/prisma/analyzeSchemaDrift.js";
import { findProviderMismatch } from "../lib/prisma/analyzeProviderMismatch.js";
import { parseEnvFile } from "../lib/env.js";

const MIGRATION_PATH_RE = /(^|\/)prisma\/migrations\/[^/]+\/migration\.sql$/;

const MIGRATION_WEIGHT_KEY: Record<MigrationKind, PrismaWeightKey> = {
  "drop-table": "dropTable",
  "drop-column": "dropColumn",
  truncate: "truncate",
  "set-not-null": "setNotNull",
  "alter-type": "alterType",
  "add-unique": "addUnique",
  "create-unique-index": "createUniqueIndex",
  "drop-index": "dropIndex",
  "rename-column": "renameColumn",
  "rename-table": "renameTable",
};

function hasMitigationHint(sql: string, hints: string[]): boolean {
  return hints.some((h) => {
    try {
      return new RegExp(h, "i").test(sql);
    } catch {
      return sql.toLowerCase().includes(h.toLowerCase());
    }
  });
}

function weight(config: RehearsalConfig, key: PrismaWeightKey): number {
  return config.prisma.weights[key] ?? DEFAULT_PRISMA_WEIGHTS[key];
}

function suggestForMigration(kind: MigrationKind): string {
  switch (kind) {
    case "drop-table":
    case "truncate":
      return "Replace with archive-then-drop across two deploys, or take a verified backup + manual runbook before shipping.";
    case "drop-column":
      return "Deploy code that stops using the column first, verify in prod, then drop in a later migration.";
    case "set-not-null":
      return "Backfill first (ADD COLUMN ... DEFAULT or explicit UPDATE), deploy, then SET NOT NULL in a follow-up migration.";
    case "alter-type":
      return "Use expand-contract: add new column, dual-write, backfill, switch reads, drop old column.";
    case "add-unique":
    case "create-unique-index":
      return "Verify no duplicate rows exist in prod before this deploys, or CREATE INDEX CONCURRENTLY first.";
    case "drop-index":
      return "Confirm no slow-query plans depend on this index in prod before removing.";
    case "rename-column":
    case "rename-table":
      return "Renames break running pods during rollout. Prefer add-new/dual-write/cutover/drop-old across multiple deploys.";
  }
}

export interface DetectPrismaInput {
  cwd: string;
  config: RehearsalConfig;
  diffFiles: Array<{ path: string }>;
  schemaDiffPatch: string;
  envFilesResolved?: string[];
}

export async function detectPrisma(input: DetectPrismaInput): Promise<Finding[]> {
  const { cwd, config, diffFiles, schemaDiffPatch, envFilesResolved } = input;
  if (!config.prisma.enabled) return [];
  const schemaAbs = resolve(cwd, config.prisma.schemaPath);
  const schema = await parseSchema(schemaAbs);
  if (!schema.exists) return [];

  const findings: Finding[] = [];

  // 1) Destructive migration scan on CHANGED migration files
  const changedMigrations = diffFiles
    .map((f) => f.path.replace(/\\/g, "/"))
    .filter((p) => MIGRATION_PATH_RE.test(p));

  for (const relPath of changedMigrations) {
    let sql: string;
    try {
      sql = await readFile(resolve(cwd, relPath), "utf8");
    } catch {
      continue;
    }
    const fileMitigated = hasMitigationHint(sql, config.prisma.mitigationHints);
    const hits = scanMigrationSql(sql);
    for (const h of hits) {
      const weightKey = MIGRATION_WEIGHT_KEY[h.kind];
      const w = weight(config, weightKey);
      let severity = h.severity;
      if (!config.prisma.blockOnDestructiveMigration && severity === "high") severity = "warn";
      findings.push({
        id: `prisma:${h.kind}:${h.target}:${relPath}:${h.line}`,
        fingerprint: `prisma:${h.kind}:${h.target}`,
        severity,
        category: "prisma",
        message: `Destructive migration (${h.kind}) on \`${h.target}\` in ${relPath}`,
        evidence: {
          file: relPath,
          line: h.line,
          sql: h.evidence,
          kind: h.kind,
          mitigated: fileMitigated,
        },
        suggestion: suggestForMigration(h.kind),
        confidence: 0.95,
        weight: w,
      });
    }
  }

  // 2) Schema drift (+ provider-changed)
  if (config.prisma.requireMigrationForSchemaChanges || config.prisma.blockOnProviderChange) {
    const drifts = analyzeDrift(diffFiles, schemaDiffPatch);
    for (const d of drifts) {
      if (d.kind === "provider-changed") {
        const w = weight(config, "providerChanged");
        findings.push({
          id: `prisma:provider-changed`,
          fingerprint: `prisma:provider-changed`,
          severity: config.prisma.blockOnProviderChange ? "high" : "warn",
          category: "prisma",
          message: d.evidence,
          evidence: d.details ?? {},
          suggestion:
            "Changing provider mid-project almost always requires an explicit data migration plan and a coordinated env URL swap.",
          confidence: 0.98,
          weight: w,
        });
      } else if (d.kind === "schema-changed-without-migration") {
        if (!config.prisma.requireMigrationForSchemaChanges) continue;
        const w = weight(config, "schemaDriftNoMigration");
        findings.push({
          id: `prisma:schema-drift:no-migration`,
          fingerprint: `prisma:schema-drift:no-migration`,
          severity: "warn",
          category: "prisma",
          message: d.evidence,
          evidence: {},
          suggestion: "Run `prisma migrate dev --name <change>` and commit the generated migration.sql.",
          confidence: 0.75,
          weight: w,
        });
      } else if (d.kind === "migration-without-schema") {
        const w = weight(config, "migrationWithoutSchema");
        findings.push({
          id: `prisma:schema-drift:migration-without-schema`,
          fingerprint: `prisma:schema-drift:migration-without-schema`,
          severity: "warn",
          category: "prisma",
          message: d.evidence,
          evidence: {},
          suggestion:
            "If this is a data-only migration, confirm it in the PR description. Otherwise regenerate the migration from an updated schema.",
          confidence: 0.7,
          weight: w,
        });
      }
    }
  }

  // 3) Provider mismatch vs env URL
  if (
    schema.datasource?.provider &&
    schema.datasource.urlEnv &&
    envFilesResolved &&
    envFilesResolved.length > 0
  ) {
    const parsed = await Promise.all(
      envFilesResolved.map(async (p) => {
        try {
          return await parseEnvFile(p);
        } catch {
          return null;
        }
      }),
    );
    const envFiles = parsed
      .filter((x): x is NonNullable<typeof x> => !!x)
      .map((ef) => ({
        path: ef.path,
        get: (k: string) => ef.entries.get(k)?.value,
      }));
    const mismatches = findProviderMismatch(
      schema.datasource.provider,
      schema.datasource.urlEnv,
      envFiles,
    );
    for (const m of mismatches) {
      const w = weight(config, "providerMismatch");
      findings.push({
        id: `prisma:provider-mismatch:${m.envKey}:${m.sourcePath}`,
        fingerprint: `prisma:provider-mismatch:${m.provider}:${m.actualScheme ?? "unknown"}`,
        severity: "high",
        category: "prisma",
        message: `schema.prisma provider is \`${m.provider}\` but \`${m.envKey}\` in ${m.sourcePath} uses scheme \`${m.actualScheme}://\`.`,
        evidence: { envKey: m.envKey, provider: m.provider, scheme: m.actualScheme, sourcePath: m.sourcePath },
        suggestion: `Either fix the URL in ${m.sourcePath} to match \`${m.provider}\`, or change the schema's provider to match the URL.`,
        confidence: 0.98,
        weight: w,
      });
    }
  }

  return findings;
}
