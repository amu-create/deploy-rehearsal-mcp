<!-- canonical landing-page asset · block · regenerate via: node scripts/render-demo-comments.mjs -->

<!--
This file is the exact body that the GitHub Action posts as a PR comment,
with the internal `<!-- deploy-rehearsal-mcp:pr-comment -->` marker stripped
for readability. Regenerate with the script above.
-->

> **Scenario:** A PR that introduces a `DROP TABLE` migration plus an uncommitted `sk_live_…` token. The hard-blocker rule fires before the score threshold even matters.

⛔ **BLOCK** — score 266 _(via score)_
**Change verdict:** BLOCK _(delta-score)_
**Compared against:** `HEAD` @ `3de704519a` _(mode: direct)_

# Deploy Rehearsal — ⛔ BLOCK

**Score:** 266 (caution ≥ 25, block ≥ 60) — verdict via `score`
**Branch:** `master`
**Diff:** 1 file(s), +2 / -0
**Config:** `deploy-rehearsal.config.json`

## Hard blockers (0)
_None — verdict driven by score, not rule._

## Blockers (6)
- **[auth]** Auth-related file changed. Test login, logout, and token refresh. — `src/auth/callback.ts`
  - _Fix:_ Run login, logout, token refresh, and session expiry paths in staging before shipping.
  - _id:_ `diff:auth:src/auth/callback.ts`
- **[env]** Env key `GOOGLE_CLIENT_SECRET` missing in: .env.production
  - _Fix:_ Add GOOGLE_CLIENT_SECRET to the missing file(s), or document the intentional gap in .env.example.
  - _id:_ `env:missing:GOOGLE_CLIENT_SECRET`
- **[env]** Env key `NEXTAUTH_SECRET` empty in: .env.production
  - _Fix:_ Set a value for NEXTAUTH_SECRET before deploy. Empty secrets crash auth/payment at runtime.
  - _id:_ `env:empty:NEXTAUTH_SECRET`
- **[env]** Required env key `DOES_NOT_EXIST_ANYWHERE` not defined in any env file.
  - _Fix:_ Add DOES_NOT_EXIST_ANYWHERE to every deploy target before shipping.
  - _id:_ `env:required:DOES_NOT_EXIST_ANYWHERE`
- **[oauth]** Plain http:// OAuth redirect: http://old-staging.example.com/cb — `src/auth/callback.ts:11`
  - _Fix:_ Switch to https:// — many OAuth providers reject plain http for non-localhost.
  - _id:_ `oauth:http:src/auth/callback.ts:11`
- **[secret]** Diff adds 1 match(es) for blocked pattern /sk_live_[A-Za-z0-9]+/
  - _Fix:_ Remove the secret from the diff and rotate the key if it was pushed anywhere.
  - _id:_ `secret:blocked:sk_live_[A-Za-z0-9]+`

## Warnings (9)
- **[env]** Env key `DEBUG` missing in: .env.production
  - _Fix:_ Add DEBUG to the missing file(s), or document the intentional gap in .env.example.
  - _id:_ `env:missing:DEBUG`
- **[env]** Env key `SENTRY_DSN` missing in: .env.development
  - _Fix:_ Add SENTRY_DSN to the missing file(s), or document the intentional gap in .env.example.
  - _id:_ `env:missing:SENTRY_DSN`
- **[env]** Env key `DEBUG` empty in: .env.development
  - _Fix:_ Set a value for DEBUG before deploy. Empty secrets crash auth/payment at runtime.
  - _id:_ `env:empty:DEBUG`
- **[env]** Env key `STRIPE_SECRET_KEY` has different values across env files
  - _Fix:_ Secrets diverging across envs is usually correct — confirm each value matches its target environment.
  - _id:_ `env:divergent:STRIPE_SECRET_KEY`
- **[oauth]** Localhost OAuth redirect in non-test file: http://localhost:3000 — `.env.development:2`
  - _Fix:_ Source the redirect URI from env (e.g., NEXTAUTH_URL) instead of hardcoding localhost.
  - _id:_ `oauth:localhost:.env.development:2`
- **[oauth]** Localhost OAuth redirect in non-test file: http://localhost:3000/api/auth/callback/google — `src/auth/callback.ts:3`
  - _Fix:_ Source the redirect URI from env (e.g., NEXTAUTH_URL) instead of hardcoding localhost.
  - _id:_ `oauth:localhost:src/auth/callback.ts:3`
- **[oauth]** OAuth redirect to off-allowlist domain: old-staging.example.com — `src/auth/callback.ts:11`
  - _Fix:_ Either add 'old-staging.example.com' to allowedDomains, or remove the stale redirect.
  - _id:_ `oauth:unexpected:src/auth/callback.ts:11:old-staging.example.com`
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

_Suppressed 1 finding(s) via config (rules: 1, ignorePatterns: 0)._

## Suppression status

### Active (1)
- `preflight:ci-config` (indefinite)

### Expired (0)
_None._

### Invalid (0)
_None._

## Changes since baseline
**Compared against** `HEAD` (resolved `3de704519a`, mode=`direct`).
**Baseline:** `git-ref:HEAD@3de704519acdf6b0ff27006276f202749c2ef2e7` — score 166 (BLOCK), 13 finding(s). Compared by `fingerprint`.
**Delta:** +100 → change verdict `BLOCK` (caution ≥ delta ).

### New (5)
- **[high/auth]** Auth-related file changed. Test login, logout, and token refresh. _(diff:auth:src/auth/callback.ts)_
- **[high/secret]** Diff adds 1 match(es) for blocked pattern /sk_live_[A-Za-z0-9]+/ _(secret:blocked:sk_live_[A-Za-z0-9]+)_
- **[warn/oauth]** Localhost OAuth redirect in non-test file: http://localhost:3000 _(oauth:localhost:.env.development)_
- **[warn/preflight]** 1 uncommitted file(s). Commit before deploy. _(preflight:uncommitted)_
- **[warn/preflight]** `.env` exists but no `.env.example` to document required vars. _(preflight:env-example)_

### Resolved (0)
_None._

### Persisting (13)
- **[high/env]** Env key `GOOGLE_CLIENT_SECRET` missing in: .env.production _(env:missing:GOOGLE_CLIENT_SECRET)_
- **[high/env]** Env key `NEXTAUTH_SECRET` empty in: .env.production _(env:empty:NEXTAUTH_SECRET)_
- **[high/env]** Required env key `DOES_NOT_EXIST_ANYWHERE` not defined in any env file. _(env:required:DOES_NOT_EXIST_ANYWHERE)_
- **[high/oauth]** Plain http:// OAuth redirect: http://old-staging.example.com/cb _(oauth:http:http://old-staging.example.com/cb)_
- **[warn/env]** Env key `DEBUG` missing in: .env.production _(env:missing:DEBUG)_
- **[warn/env]** Env key `SENTRY_DSN` missing in: .env.development _(env:missing:SENTRY_DSN)_
- **[warn/env]** Env key `DEBUG` empty in: .env.development _(env:empty:DEBUG)_
- **[warn/env]** Env key `STRIPE_SECRET_KEY` has different values across env files _(env:divergent:STRIPE_SECRET_KEY)_
- **[warn/oauth]** Localhost OAuth redirect in non-test file: http://localhost:3000/api/auth/callback/google _(oauth:localhost:src/auth/callback.ts)_
- **[warn/oauth]** OAuth redirect to off-allowlist domain: old-staging.example.com _(oauth:unexpected:old-staging.example.com)_
- **[info/env]** Env key `DATABASE_URL` has different values across env files _(env:divergent:DATABASE_URL)_
- **[info/env]** Env key `GOOGLE_CLIENT_ID` has different values across env files _(env:divergent:GOOGLE_CLIENT_ID)_
- **[info/env]** Env key `NEXTAUTH_URL` has different values across env files _(env:divergent:NEXTAUTH_URL)_
