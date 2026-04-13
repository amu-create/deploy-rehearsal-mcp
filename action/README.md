# Deploy Rehearsal — GitHub Action

Catch deploy-time failures in PRs: env / OAuth / Prisma / Next.js drift, with baseline-aware change verdicts.

## Quickstart (5 분)

`.github/workflows/deploy-rehearsal.yml` 에 붙여 넣고 PR 을 열면 끝입니다.

```yaml
name: Deploy Rehearsal
on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  contents: read
  pull-requests: write

jobs:
  rehearse:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0   # baseline 비교에 git history 가 필요합니다
      - uses: amu-create/deploy-rehearsal-mcp/action@v1
        # 모든 입력은 옵션입니다. 기본값으로 PR base 브랜치와 비교합니다.
```

PR 에 단일 코멘트가 생기고, 푸시할 때마다 그 코멘트가 갱신됩니다. verdict 가 `BLOCK` 이면 job 이 실패해서 머지를 막습니다.

## 입력

| 이름 | 기본값 | 용도 |
| --- | --- | --- |
| `working-directory` | `.` | `deploy-rehearsal.config.json` 이 있는 디렉터리. 모노레포면 서브패키지 경로. |
| `base-ref` | _(빈 값 → PR base)_ | 비교 대상 git ref. `origin/main`, `HEAD^`, sha 모두 가능. |
| `mode` | `merge-base` | `merge-base` 또는 `direct`. 브랜치 작업이면 merge-base 가 자연스럽습니다. |
| `fail-on-block` | `true` | 절대 verdict 가 `BLOCK` 이면 job 실패. |
| `comment` | `true` | PR 코멘트 작성/갱신. |
| `github-token` | `${{ github.token }}` | 코멘트 작성용 토큰. cross-repo 에서는 PAT 필요. |

## 출력

| 이름 | 의미 |
| --- | --- |
| `verdict` | `GO` / `CAUTION` / `BLOCK` (절대) |
| `change-verdict` | `GO` / `CAUTION` / `BLOCK` (base 대비 신규 위험). baseline 없으면 빈 값. |
| `score` | 절대 점수 (수치). |

## 필요 권한

- `contents: read` — 체크아웃과 git history 접근.
- `pull-requests: write` — `comment: true` 일 때 PR 코멘트 작성/갱신.

## 동작 메모

- `actions/checkout@v4` 는 기본이 `fetch-depth: 1` 입니다. **반드시 `fetch-depth: 0`** 으로 받아야 baseline ref 비교가 가능합니다 (shallow clone 이면 engine 이 `baselineError: shallow-clone` 으로 폴백).
- 코멘트는 marker (`<!-- deploy-rehearsal-mcp:pr-comment -->`) 로 한 PR 당 하나만 유지됩니다. 같은 PR 의 푸시는 코멘트를 갱신.
- BLOCK 판정 (hard-blocker rule 또는 score ≥ block threshold) 이면 exit 1, 아니면 exit 0. PR 코멘트 실패는 job 실패 사유로 만들지 않습니다 (verdict 와 무관하게 망치지 않게).
