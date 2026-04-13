# Landing assets — index

Assets produced for the landing-page copy structure agreed upstream. Each file here is either (a) a **real engine output** pinned to a reproducible input, or (b) a narrative scaffold (storyboard / excerpt) anchored to real output.

## Files

| File | Type | Source |
| --- | --- | --- |
| [`comment-block.md`](./comment-block.md) | Real engine output | `test/fixture` as-is |
| [`comment-caution.md`](./comment-caution.md) | Real engine output | `test/fixture` + suppress overlay for hard-blockers |
| [`comment-go.md`](./comment-go.md) | Real engine output | Generated clean temp repo |
| [`demo-storyboard.md`](./demo-storyboard.md) | Scaffold | 3-frame demo, maps to landing Steps 1/2/3 |
| [`suppression-status-example.md`](./suppression-status-example.md) | Curated excerpt | Suppression block lifted from a real comment + landing hook |

## Regenerating the verdict comments

```bash
npm run build
node scripts/render-demo-comments.mjs
```

That script:

1. Primes the fixture to a known state (same priming as `test/e2e.mjs`).
2. Runs the engine three times (`BLOCK` / `CAUTION` / `GO`).
3. Sanitises absolute paths so the files are portable.
4. Writes the three `comment-*.md` files in this folder.

Current rendering: **BLOCK 266 / CAUTION 56 / GO 0** (findings 18 / 8 / 0).

## Landing section ↔ asset mapping

| Landing section | Asset | Notes |
| --- | --- | --- |
| **1. 히어로** (헤드라인 + CTA) | [`comment-block.md`](./comment-block.md) | Screenshot the top 20 lines; lead with the ⛔ BLOCK badge. |
| **3. 문제 제기** (린트/테스트 통과해도 터진다) | — | Copy-only section, no asset needed. |
| **4. 어떻게 동작하나** (3 steps) | [`demo-storyboard.md`](./demo-storyboard.md) | Frames 1/2/3 map 1:1 to the three steps. |
| **5. 이 코멘트 하나로 머지 판단** | All three `comment-*.md` | Tab / toggle layout (GO / CAUTION / BLOCK). |
| **6. 차별점** (4 points) | — | Copy-only. |
| **7. suppress 운영성** | [`suppression-status-example.md`](./suppression-status-example.md) | Embed the excerpt verbatim; use the "landing copy hook" line underneath. |
| **8. 누구에게 맞는가** | — | Copy-only. |
| **9. 5 분 시작** | Action / workflow files | Link out to [`../../action/README.md`](../../action/README.md) and [`../../examples/github-action.yml`](../../examples/github-action.yml). |
| **10. 요금제** | — | Copy-only. |
| **11. 마지막 CTA** | [`comment-block.md`](./comment-block.md) | Re-use the hero screenshot with a different caption. |

## Ground rules for using these

- **Don't hand-edit the `comment-*.md` files** — rerun the script. Hand edits will drift from what the engine actually produces, and the "these are real PR comments" promise breaks.
- **The storyboard and suppression excerpt are scaffolds** — they're designed to be hand-copied into the landing layout, not rendered as-is.
- **Screenshots for Frames 1 and 2** must come from a live recording; those are UI surfaces we don't control. Frame 3 should use the rendered markdown here to stay deterministic.
- **If the engine's output shape changes**, rerun the script and visually diff the `comment-*.md` files; anything the landing references by copy needs to stay pinned.
