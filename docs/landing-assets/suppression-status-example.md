# Suppression status — landing excerpt

Pairs with landing section **"숨긴 경고도 운영해야 합니다"**.

This is a lifted excerpt — it's literally a section that appears inside a real PR comment (the full comment template is in [`comment-caution.md`](./comment-caution.md)). On the landing, show this block by itself so the operational-asset angle lands without having to read the whole comment.

---

## Suppression status

### Active (4)
- `nextjs:middleware-unprotected:/legacy-admin` (until 2026-05-15) — Legacy route pending removal, INGEST-98
- `prisma:drop-table:LegacyTable` (until 2026-06-01) — Table sunset plan landed in INGEST-142
- `secret:blocked:sk_live_[A-Za-z0-9]+` (until 2099-01-01) — Test token used during a fire-drill, already rotated
- `env:missing:GOOGLE_CLIENT_SECRET` (indefinite) — Set in Vercel secret manager, not checked into .env.production

### Expired (1)
- `nextjs:matcher-shrunk:/admin/:path*` (expired 2026-03-01) — "Temporary during admin refactor"

### Invalid (1)
- `preflight:ci-config` — invalid-date — detail: `2026-13-99`

_Suppressed 6 finding(s) via config (rules: 5, ignorePatterns: 1)._

---

## Why this section is the unique sell

Most tools give you exactly one dial on suppression: on or off. This one gives teams four things at once — and they're all in the PR, so nobody has to go hunt for them.

| What you see | Why it matters |
| --- | --- |
| **Active with `until`** | Exceptions you chose to carry, with an end date so they can't rot forever. |
| **Expired** | Rules whose `until` has passed. Findings they used to hide are back in the comment, visibly contributing to the verdict — the team notices *because* something reappears, not because someone did a cleanup sprint. |
| **Invalid** | Malformed `until` values caught at parse time. Prevents "I thought I suppressed this" bugs. |
| **Breakdown (rules vs ignorePatterns)** | Tells you whether findings are hidden by explicit team policy or by the project's `ignorePatterns` glob — these usually have different owners. |

## Landing copy hook

> "Most tools let you silence warnings. This one tracks *why* they're silent, *until when*, and shows you the moment that silence should end."

Short version (one line):

> "숨긴 경고도 만료와 사유를 추적합니다."
