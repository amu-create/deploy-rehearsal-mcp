export interface SuppressionEntry {
  fingerprint?: string;
  id?: string;
  until?: string;
  reason?: string;
}

export type RawSuppress = string | SuppressionEntry;

export type SuppressionKind = "fingerprint" | "id" | "string";

export interface ResolvedSuppression {
  kind: SuppressionKind;
  target: string;
  until?: string;
  reason?: string;
}

export interface ExpiredSuppression {
  kind: "fingerprint" | "id";
  target: string;
  until: string;
  reason?: string;
}

export interface InvalidSuppression {
  target?: string;
  reason: "missing-target" | "invalid-date";
  detail?: string;
}

export interface SuppressionStatus {
  active: ResolvedSuppression[];
  expired: ExpiredSuppression[];
  invalid: InvalidSuppression[];
}

export interface SuppressionSet extends SuppressionStatus {
  activeFingerprints: Map<string, ResolvedSuppression>;
  activeIds: Map<string, ResolvedSuppression>;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(s + "T00:00:00Z");
  if (isNaN(d.getTime())) return false;
  return d.toISOString().slice(0, 10) === s;
}

export function todayString(): string {
  const override = process.env.DEPLOY_REHEARSAL_TODAY;
  if (override && isValidDate(override)) return override;
  return new Date().toISOString().slice(0, 10);
}

export function resolveSuppressions(
  raw: RawSuppress[] | undefined,
  today: string,
): SuppressionSet {
  const activeFingerprints = new Map<string, ResolvedSuppression>();
  const activeIds = new Map<string, ResolvedSuppression>();
  const active: ResolvedSuppression[] = [];
  const expired: ExpiredSuppression[] = [];
  const invalid: InvalidSuppression[] = [];

  // Within a map, prefer object-form (kind="fingerprint" or "id") over string-form
  // when both target the same key, regardless of resolution order.
  function setIfHigherPriority(
    map: Map<string, ResolvedSuppression>,
    key: string,
    candidate: ResolvedSuppression,
  ) {
    const existing = map.get(key);
    if (!existing) {
      map.set(key, candidate);
      return;
    }
    const candidateRank = candidate.kind === "string" ? 0 : 1;
    const existingRank = existing.kind === "string" ? 0 : 1;
    if (candidateRank > existingRank) map.set(key, candidate);
  }

  for (const entry of raw ?? []) {
    if (typeof entry === "string") {
      const resolved: ResolvedSuppression = { kind: "string", target: entry };
      setIfHigherPriority(activeFingerprints, entry, resolved);
      setIfHigherPriority(activeIds, entry, resolved);
      active.push(resolved);
      continue;
    }

    const hasFP = typeof entry.fingerprint === "string" && entry.fingerprint.length > 0;
    const hasID = typeof entry.id === "string" && entry.id.length > 0;
    if (!hasFP && !hasID) {
      invalid.push({ reason: "missing-target" });
      continue;
    }
    const kind: "fingerprint" | "id" = hasFP ? "fingerprint" : "id";
    const target = (hasFP ? entry.fingerprint : entry.id)!;

    if (entry.until != null && entry.until !== "") {
      if (!isValidDate(entry.until)) {
        invalid.push({ target, reason: "invalid-date", detail: entry.until });
        continue;
      }
      if (entry.until < today) {
        expired.push({ kind, target, until: entry.until, reason: entry.reason });
        continue;
      }
      const resolved: ResolvedSuppression = {
        kind,
        target,
        until: entry.until,
        reason: entry.reason,
      };
      if (kind === "fingerprint") setIfHigherPriority(activeFingerprints, target, resolved);
      else setIfHigherPriority(activeIds, target, resolved);
      active.push(resolved);
    } else {
      const resolved: ResolvedSuppression = { kind, target, reason: entry.reason };
      if (kind === "fingerprint") setIfHigherPriority(activeFingerprints, target, resolved);
      else setIfHigherPriority(activeIds, target, resolved);
      active.push(resolved);
    }
  }

  return { active, expired, invalid, activeFingerprints, activeIds };
}

/**
 * Returns the matched suppression rule (if any) for a finding.
 * Precedence (per spec): object-fingerprint > object-id > string-form (either map).
 */
export function matchSuppression(
  f: { id: string; fingerprint: string },
  set: SuppressionSet,
): ResolvedSuppression | null {
  const byFp = set.activeFingerprints.get(f.fingerprint);
  const byId = set.activeIds.get(f.id);
  if (byFp && byFp.kind === "fingerprint") return byFp;
  if (byId && byId.kind === "id") return byId;
  if (byFp && byFp.kind === "string") return byFp;
  if (byId && byId.kind === "string") return byId;
  return null;
}

// Backward-compat alias for code paths that only need a boolean check.
export function isSuppressed(
  f: { id: string; fingerprint: string },
  set: SuppressionSet,
): ResolvedSuppression | null {
  return matchSuppression(f, set);
}

export function publicStatus(set: SuppressionSet): SuppressionStatus {
  return { active: set.active, expired: set.expired, invalid: set.invalid };
}
