export type DriftKind =
  | "schema-changed-without-migration"
  | "migration-without-schema"
  | "provider-changed";

export interface DriftFinding {
  kind: DriftKind;
  severity: "high" | "warn";
  evidence: string;
  details?: Record<string, unknown>;
}

const MIGRATION_PATH_RE = /(^|\/)prisma\/migrations\/[^/]+\/migration\.sql$/;
const SCHEMA_PATH_RE = /(^|\/)(prisma\/)?schema\.prisma$/;

function hasStructuralChange(schemaPatch: string): boolean {
  const changedLines = schemaPatch
    .split(/\r?\n/)
    .filter((l) => (l.startsWith("+") || l.startsWith("-")) && !/^[+-]{3}/.test(l));
  const joined = changedLines.join("\n");
  return (
    /\b(model|enum)\s+\w+/.test(joined) ||
    /@@(index|unique|id|map)\b/.test(joined) ||
    /@(unique|id|default|relation)\b/.test(joined) ||
    // Field-signature heuristic: "<indent><name> <Type><?|[]>" on a +/- line.
    /^[+-]\s+\w+\s+\w+[?\[\]]*\s*($|@|\/\/)/m.test(joined)
  );
}

function providerChangeInPatch(schemaPatch: string): { from?: string; to?: string } | null {
  const removed = schemaPatch
    .split(/\r?\n/)
    .filter((l) => l.startsWith("-") && !l.startsWith("---"))
    .join("\n")
    .match(/provider\s*=\s*"([^"]+)"/);
  const added = schemaPatch
    .split(/\r?\n/)
    .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
    .join("\n")
    .match(/provider\s*=\s*"([^"]+)"/);
  if (!removed && !added) return null;
  if (removed && added && removed[1] !== added[1]) return { from: removed[1], to: added[1] };
  if (!removed && added) return { to: added[1] };
  if (removed && !added) return { from: removed[1] };
  return null;
}

export function analyzeDrift(
  diffFiles: Array<{ path: string }>,
  schemaDiffPatch: string,
): DriftFinding[] {
  const findings: DriftFinding[] = [];
  const normalize = (p: string) => p.replace(/\\/g, "/");
  const schemaChanged = diffFiles.some((f) => SCHEMA_PATH_RE.test(normalize(f.path)));
  const migrationChanged = diffFiles.some((f) => MIGRATION_PATH_RE.test(normalize(f.path)));

  const structural = schemaChanged && schemaDiffPatch ? hasStructuralChange(schemaDiffPatch) : false;
  const providerChange = schemaChanged && schemaDiffPatch ? providerChangeInPatch(schemaDiffPatch) : null;

  if (schemaChanged && structural && !migrationChanged) {
    findings.push({
      kind: "schema-changed-without-migration",
      severity: "warn",
      evidence: "schema.prisma has structural changes but no migration.sql was added.",
    });
  }
  if (migrationChanged && !schemaChanged) {
    findings.push({
      kind: "migration-without-schema",
      severity: "warn",
      evidence: "New migration present but schema.prisma is untouched.",
    });
  }
  if (providerChange) {
    findings.push({
      kind: "provider-changed",
      severity: "high",
      evidence: providerChange.from && providerChange.to
        ? `Datasource provider changed ${providerChange.from} \u2192 ${providerChange.to}.`
        : `Datasource provider block changed (${providerChange.from ?? "removed"} \u2192 ${providerChange.to ?? "added"}).`,
      details: providerChange,
    });
  }
  return findings;
}
