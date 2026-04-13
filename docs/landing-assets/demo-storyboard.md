# 3-Frame Demo Storyboard

Pairs with landing section **"어떻게 동작하나" — 처음 PR 하나만 열면, 바로 이해됩니다**.

Each frame is a short, self-contained scene. The three frames together read as one continuous demo (~20–30 s when cut as GIF/video, ~3 screenshots as a static strip).

---

## Frame 1 — PR opened

**Landing map:** Step 1 (*"PR 을 엽니다"*)
**Duration:** ~4–6 s (or one screenshot)
**What's on screen:** GitHub PR view, "Files changed" tab active.

**Scene:**

- Repo: the user's app. A feature branch (e.g. `feat/billing-refactor`) vs `main`.
- The diff visible in the capture includes at least one provocative change — ideally a `prisma/migrations/.../migration.sql` file with a `DROP COLUMN`, or a `NEXT_PUBLIC_STRIPE_SECRET_KEY=…` line in `.env.*`.
- The "Checks" tab shows a new pending check: **Deploy Rehearsal** (🟡 queued).

**Caption (overlay, 1 line):**

> **PR 을 엽니다.** 기존 코드와 변경 코드를 기준선으로 비교합니다.

**Optional voice-over / alt text:**

> "You push a branch. Deploy Rehearsal queues up alongside the rest of CI."

---

## Frame 2 — Action running

**Landing map:** Step 2 (*"Action 이 배포 리허설을 실행합니다"*)
**Duration:** ~6–8 s (or one screenshot of the job log)
**What's on screen:** GitHub Actions job page for the Deploy Rehearsal run.

**Scene:**

- The "Run rehearsal" step is expanded. The visible log lines include:

  ```
  baseRef=origin/main mode=merge-base cwd=.
  ⛔ **BLOCK** — score 266 (via score) | **Change verdict:** BLOCK (delta-score) | Compared against: origin/main @ 3de704519a (mode: merge-base)
  Updated PR comment 1234567890
  verdict=BLOCK and fail-on-block=true → exit 1
  ```

- The check badge flips from 🟡 queued → 🔴 failed (or 🟢 if `verdict=GO`).

**Caption (overlay, 1 line):**

> **Action 이 배포 리허설을 실행합니다.** 새로 생긴 배포 위험, suppress 상태, 예외 사유를 계산합니다.

**Optional voice-over / alt text:**

> "It's comparing your working tree against the PR's base branch via `git worktree`. No checkout, no artifact dance — just a side-by-side snapshot read."

---

## Frame 3 — PR comment updated

**Landing map:** Step 3 (*"PR 코멘트가 한 곳에서 갱신됩니다"*)
**Duration:** ~8–10 s (or one screenshot of the PR conversation tab)
**What's on screen:** PR **Conversation** tab with the Deploy Rehearsal bot comment expanded.

**Scene:**

- The comment body is the exact rendering from [`comment-block.md`](./comment-block.md).
- The top of the comment shows:

  > ⛔ **BLOCK** — score 266 _(via score)_
  > **Change verdict:** BLOCK _(delta-score)_
  > **Compared against:** `origin/main` @ `3de704519a` _(mode: merge-base)_

- Scroll shows `## Hard blockers`, `## Blockers`, `## Warnings`, `## Sections`, `## Prisma risks`, `## Changes since baseline`, `## Suppression status`.
- The merge button is greyed out because `fail-on-block: true` failed the check.

**Caption (overlay, 1 line):**

> **PR 코멘트가 한 곳에서 갱신됩니다.** 팀은 머지 전에 무엇이 문제인지 바로 읽고 수정할 수 있습니다.

**Optional micro-animation (if recording):**
- Developer fixes one hard-blocker (e.g. removes the `sk_live_…` line).
- Pushes a new commit.
- The SAME comment ticks over: ⛔ BLOCK → ⚠️ CAUTION (matches [`comment-caution.md`](./comment-caution.md)).
- Final beat: comment becomes ✅ GO (matches [`comment-go.md`](./comment-go.md)). Merge button lights up.

This micro-animation is the single highest-conversion beat — it shows the whole value loop in under 10 seconds.

---

## Recording recipe (if capturing yourself)

1. Start from the [`examples/github-action.yml`](../../examples/github-action.yml) workflow installed in a sample repo.
2. Use a clean `main` branch + a feature branch that contains the three canonical issues (DROP COLUMN migration, `NEXT_PUBLIC_*SECRET*` env var, `sk_live_…` in source).
3. Capture Frames 1–2 live, then use the pre-rendered [`comment-block.md`](./comment-block.md) for Frame 3 (keeps the screenshot deterministic).
4. For the micro-animation, push two follow-up commits that progressively remove issues. You only need two takes of Frame 3 to show the BLOCK → CAUTION → GO transition.

---

## Fallback (no video)

If you aren't capturing video: use a 3-column layout on the landing page.

| Column | Asset |
| --- | --- |
| 1 | GitHub-style PR "Files changed" screenshot (user-supplied) |
| 2 | Terminal / job-log screenshot (user-supplied) |
| 3 | Embed of [`comment-block.md`](./comment-block.md) rendered as GitHub-flavored markdown |

Under the columns, a single line:

> "In your first PR, the bot posts one comment. Every push updates that same comment."

That matches landing section 5 ("이 코멘트 하나로, 지금 머지해도 되는지 판단합니다").
