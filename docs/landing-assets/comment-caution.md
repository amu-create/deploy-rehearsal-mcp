<!-- canonical landing-page asset · caution · regenerate via: node scripts/render-demo-comments.mjs -->

<!--
This file is the exact body that the GitHub Action posts as a PR comment,
with the internal `<!-- deploy-rehearsal-mcp:pr-comment -->` marker stripped
for readability. Regenerate with the script above.
-->

> **Scenario:** Same PR as BLOCK, but the team has already tagged the obvious hard-blockers with explicit `suppress` rules — each with a `reason` and an `until` date. Remaining risk is still real, just softer.

⚠️ **CAUTION** — score 56 _(via score)_
**Change verdict:** CAUTION _(delta-score)_
**Compared against:** `HEAD` @ `3de704519a` _(mode: direct)_

# Deploy Rehearsal — ⚠️ CAUTION

**Score:** 56 (caution ≥ 25, block ≥ 60) — verdict via `score`
**Branch:** `master`
**Diff:** 1 file(s), +2 / -0
**Config:** `deploy-rehearsal.demo-caution.json`

## Hard blockers (0)
_None — verdict driven by score, not rule._

## Blockers (0)
_None._

## Warnings (5)
- **[env]** Env key `STRIPE_SECRET_KEY` has different values across env files
  - _Fix:_ Secrets diverging across envs is usually correct — confirm each value matches its target environment.
  - _id:_ `env:divergent:STRIPE_SECRET_KEY`
- **[oauth]** Localhost OAuth redirect in non-test file: http://localhost:3000 — `.env.development:2`
  - _Fix:_ Source the redirect URI from env (e.g., NEXTAUTH_URL) instead of hardcoding localhost.
  - _id:_ `oauth:localhost:.env.development:2`
- **[oauth]** Localhost OAuth redirect in non-test file: http://localhost:3000/api/auth/callback/google — `src/auth/callback.ts:3`
  - _Fix:_ Source the redirect URI from env (e.g., NEXTAUTH_URL) instead of hardcoding localhost.
  - _id:_ `oauth:localhost:src/auth/callback.ts:3`
- **[preflight]** 1 uncommitted file(s). Commit before deploy.
  - _Fix:_ Commit or stash local changes before deploying.
  - _id:_ `preflight:uncommitted`
- **[preflight]** `.env` exists but no `.env.example` to document required vars.
  - _Fix:_ Create `.env.example` listing every required variable (without secrets).
  - _id:_ `preflight:env-example`

## Sections
- **Preflight:** 5 pass, 3 warn, 0 fail
- **Env:** 3 missing, 2 empty, 4 divergent (across 2 file[s])
- **OAuth:** 5 redirect(s), 1 plain-http, 2 localhost in non-test, 1 off-allowlist
- **Diff signals:** 1 high / 0 warn / 0 info

_Suppressed 11 finding(s) via config (rules: 11, ignorePatterns: 0)._

## Suppression status

### Active (11)
- `preflight:ci-config` (indefinite)
- `secret:blocked:sk_live_[A-Za-z0-9]+` (until 2099-01-01) — Test token used during a fire-drill — already rotated.
- `env:empty:NEXTAUTH_SECRET` (until 2099-01-01) — Set in Vercel secret manager, not checked into .env.production.
- `env:missing:GOOGLE_CLIENT_SECRET` (until 2099-01-01) — Set in secret manager for prod.
- `env:required:DOES_NOT_EXIST_ANYWHERE` (until 2099-01-01) — Demo key — stubbed until INGEST-142 lands.
- `diff:auth:src/auth/callback.ts` (until 2099-01-01) — Intentional: touching auth for the OAuth cleanup epic. Re-review in PR.
- `oauth:http:http://old-staging.example.com/cb` (until 2099-01-01) — Legacy redirect removed in follow-up PR INGEST-143.
- `oauth:unexpected:old-staging.example.com` (until 2099-01-01) — Same legacy redirect, different rule.
- `env:missing:DEBUG` (until 2099-01-01) — DEBUG is dev-only — intentional gap.
- `env:empty:DEBUG` (until 2099-01-01) — Empty DEBUG in dev is intentional.
- `env:missing:SENTRY_DSN` (until 2099-01-01) — Sentry is prod-only.

### Expired (0)
_None._

### Invalid (0)
_None._

## Changes since baseline
**Compared against** `HEAD` (resolved `3de704519a`, mode=`direct`).
**Baseline:** `git-ref:HEAD@3de704519acdf6b0ff27006276f202749c2ef2e7` — score 26 (CAUTION), 5 finding(s). Compared by `fingerprint`.
**Delta:** +30 → change verdict `CAUTION` (caution ≥ delta ).

### New (3)
- **[warn/oauth]** Localhost OAuth redirect in non-test file: http://localhost:3000 _(oauth:localhost:.env.development)_
- **[warn/preflight]** 1 uncommitted file(s). Commit before deploy. _(preflight:uncommitted)_
- **[warn/preflight]** `.env` exists but no `.env.example` to document required vars. _(preflight:env-example)_

### Resolved (0)
_None._

### Persisting (5)
- **[warn/env]** Env key `STRIPE_SECRET_KEY` has different values across env files _(env:divergent:STRIPE_SECRET_KEY)_
- **[warn/oauth]** Localhost OAuth redirect in non-test file: http://localhost:3000/api/auth/callback/google _(oauth:localhost:src/auth/callback.ts)_
- **[info/env]** Env key `DATABASE_URL` has different values across env files _(env:divergent:DATABASE_URL)_
- **[info/env]** Env key `GOOGLE_CLIENT_ID` has different values across env files _(env:divergent:GOOGLE_CLIENT_ID)_
- **[info/env]** Env key `NEXTAUTH_URL` has different values across env files _(env:divergent:NEXTAUTH_URL)_
