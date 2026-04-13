import type { RunRehearsalResult, Finding } from "../tools/runRehearsal.js";

export function renderMarkdownReport(r: RunRehearsalResult): string {
  const lines: string[] = [];
  const badge = r.verdict === "GO" ? "✅ GO" : r.verdict === "CAUTION" ? "⚠️ CAUTION" : "⛔ BLOCK";
  lines.push(`# Deploy Rehearsal — ${badge}`);
  lines.push("");
  lines.push(
    `**Score:** ${r.score} (caution ≥ ${r.thresholds.caution}, block ≥ ${r.thresholds.block}) — verdict via \`${r.verdictReason}\``,
  );
  lines.push(`**Branch:** \`${r.branch ?? "n/a"}\``);
  lines.push(
    `**Diff:** ${r.sections.diff.totalFiles} file(s), +${r.sections.diff.totalAdditions} / -${r.sections.diff.totalDeletions}`,
  );
  lines.push(`**Config:** \`${r.configSource}\``);
  lines.push("");

  lines.push(`## Hard blockers (${r.hardBlockers.length})`);
  if (r.hardBlockers.length === 0) lines.push("_None — verdict driven by score, not rule._");
  else for (const f of r.hardBlockers) lines.push(...renderFinding(f));
  lines.push("");

  lines.push(`## Blockers (${r.blockers.length})`);
  if (r.blockers.length === 0) lines.push("_None._");
  else for (const f of r.blockers) lines.push(...renderFinding(f));
  lines.push("");

  lines.push(`## Warnings (${r.warnings.length})`);
  if (r.warnings.length === 0) lines.push("_None._");
  else for (const f of r.warnings) lines.push(...renderFinding(f));
  lines.push("");

  lines.push(`## Sections`);
  const pf = r.sections.preflight;
  lines.push(`- **Preflight:** ${pf.passed} pass, ${pf.warned} warn, ${pf.failed} fail`);
  if (r.sections.env) {
    const e = r.sections.env;
    lines.push(
      `- **Env:** ${e.missingKeys.length} missing, ${e.emptyKeys.length} empty, ${e.divergentValues.length} divergent (across ${e.filesCompared.length} file[s])`,
    );
  } else {
    lines.push(`- **Env:** skipped (no env files supplied)`);
  }
  const o = r.sections.oauth;
  lines.push(
    `- **OAuth:** ${o.redirects.length} redirect(s), ${o.httpOnlyRedirects.length} plain-http, ${o.localhostInNonTestFiles.length} localhost in non-test, ${o.unexpectedDomains.length} off-allowlist`,
  );
  const d = r.sections.diff;
  lines.push(
    `- **Diff signals:** ${d.signals.filter((s) => s.severity === "high").length} high / ${d.signals.filter((s) => s.severity === "warn").length} warn / ${d.signals.filter((s) => s.severity === "info").length} info`,
  );
  lines.push("");

  const prismaFindings = r.findings.filter((f) => f.category === "prisma");
  if (prismaFindings.length > 0) {
    lines.push("");
    lines.push(`## Prisma risks (${prismaFindings.length})`);
    for (const f of prismaFindings) {
      const loc =
        f.evidence && typeof f.evidence === "object" && "file" in f.evidence
          ? ` — \`${(f.evidence as any).file}${(f.evidence as any).line ? ":" + (f.evidence as any).line : ""}\``
          : "";
      const sevTag =
        f.severity === "high" ? "BLOCK" : f.severity === "warn" ? "CAUTION" : "INFO";
      lines.push(`- **[${sevTag}] ${f.fingerprint}** ${f.message}${loc}`);
      if (f.evidence && typeof f.evidence === "object" && "sql" in f.evidence) {
        lines.push(`  - _SQL:_ \`${String((f.evidence as any).sql).slice(0, 160)}\``);
      }
      if (f.suggestion) lines.push(`  - _Fix:_ ${f.suggestion}`);
    }
  }

  if (r.suppressedCount > 0) {
    const b = r.suppressedBreakdown;
    const breakdownNote = b
      ? ` (rules: ${b.rules}, ignorePatterns: ${b.ignorePatterns})`
      : "";
    lines.push(`_Suppressed ${r.suppressedCount} finding(s) via config${breakdownNote}._`);
  }

  const s = r.suppressionStatus;
  if (s && (s.active.length + s.expired.length + s.invalid.length > 0)) {
    lines.push("");
    lines.push(`## Suppression status`);
    lines.push("");
    lines.push(`### Active (${s.active.length})`);
    if (s.active.length === 0) lines.push("_None._");
    else
      for (const a of s.active) {
        const until = a.until ? ` (until ${a.until})` : " (indefinite)";
        lines.push(`- \`${a.target}\`${until}${a.reason ? ` — ${a.reason}` : ""}`);
      }
    lines.push("");
    lines.push(`### Expired (${s.expired.length})`);
    if (s.expired.length === 0) lines.push("_None._");
    else
      for (const e of s.expired)
        lines.push(`- \`${e.target}\` (expired ${e.until})${e.reason ? ` — ${e.reason}` : ""}`);
    lines.push("");
    lines.push(`### Invalid (${s.invalid.length})`);
    if (s.invalid.length === 0) lines.push("_None._");
    else
      for (const i of s.invalid) {
        const tgt = i.target ? `\`${i.target}\`` : "(missing target)";
        const det = i.detail ? ` — detail: \`${i.detail}\`` : "";
        lines.push(`- ${tgt} — ${i.reason}${det}`);
      }
  }

  if (r.baselineError) {
    lines.push("");
    lines.push(`## Baseline unavailable`);
    lines.push(
      `\`${r.baselineError.reason}\`: ${r.baselineError.detail} (ref: \`${r.baselineError.displayRef}\`${r.baselineError.mode ? `, mode=${r.baselineError.mode}` : ""})`,
    );
  }

  if (r.baseline) {
    const b = r.baseline;
    const delta = b.deltaScore >= 0 ? `+${b.deltaScore}` : `${b.deltaScore}`;
    lines.push("");
    lines.push(`## Changes since baseline`);
    if (r.baselineSource === "git-ref") {
      lines.push(
        `**Compared against** \`${r.baselineDisplayRef}\` (mode=\`${r.baselineMode}\`, resolved baseline=\`${r.baselineResolvedRef?.slice(0, 10)}\`).`,
      );
    }
    lines.push(
      `**Baseline:** \`${b.source}\` — score ${b.baselineScore} (${b.baselineVerdict}), ${b.baselineFindingCount} finding(s). Compared by \`${b.compareBy.join(", ")}\`.`,
    );
    lines.push(
      `**Delta:** ${delta} → change verdict \`${r.changeVerdict ?? "n/a"}\`.`,
    );
    lines.push("");
    lines.push(`### New (${b.newFindings.length})`);
    if (b.newFindings.length === 0) lines.push("_None._");
    else for (const f of b.newFindings) lines.push(`- **[${f.severity}/${f.category}]** ${f.message} _(${f.fingerprint})_`);
    lines.push("");
    lines.push(`### Resolved (${b.resolvedFindings.length})`);
    if (b.resolvedFindings.length === 0) lines.push("_None._");
    else for (const f of b.resolvedFindings) lines.push(`- **[${f.severity}/${f.category}]** ${f.message} _(${f.fingerprint})_`);
    lines.push("");
    lines.push(`### Persisting (${b.persistingFindings.length})`);
    if (b.persistingFindings.length === 0) lines.push("_None._");
    else for (const f of b.persistingFindings.slice(0, 20))
      lines.push(`- **[${f.severity}/${f.category}]** ${f.message} _(${f.fingerprint})_`);
    if (b.persistingFindings.length > 20)
      lines.push(`- _... and ${b.persistingFindings.length - 20} more_`);
  }

  if (r.baselineSaved) {
    lines.push("");
    lines.push(`_Baseline snapshot written to \`${r.baselineSaved.path}\`._`);
  }

  return lines.join("\n");
}

function renderFinding(f: Finding): string[] {
  const loc =
    f.evidence && typeof f.evidence === "object" && "file" in f.evidence
      ? ` — \`${(f.evidence as any).file}${(f.evidence as any).line ? ":" + (f.evidence as any).line : ""}\``
      : "";
  const out = [`- **[${f.category}]** ${f.message}${loc}`];
  if (f.suggestion) out.push(`  - _Fix:_ ${f.suggestion}`);
  out.push(`  - _id:_ \`${f.id}\``);
  return out;
}
