# deploy-rehearsal-mcp

> **Catches deploy-time failures before merge:**
> OAuth / env / payment / auth drift, Prisma migration risks, and Next.js runtime / config / cache mistakes.
>
> 머지 전에 `GO / CAUTION / BLOCK` 으로 판정하고, 왜 위험한지 근거와 수정안까지 돌려줍니다. 로컬 stdio MCP 서버로 돌며 코드·diff는 이 프로세스 밖으로 나가지 않습니다.

---

## What it catches

### Hard blockers — 하나만 있어도 BLOCK

- public secrets exposed via `NEXT_PUBLIC_`
- server secrets accessed from client components
- Edge runtime importing Node-only APIs (`fs`, `path`, `child_process`, …)
- Edge routes importing / using Prisma
- personalized/account routes forced static (`dynamic = 'force-static'`)
- Prisma `DROP TABLE` / `DROP COLUMN` / `TRUNCATE`
- Prisma `provider` change · provider ↔ env URL scheme mismatch

### Scored warnings — 쌓이면 BLOCK, 단독이면 CAUTION

- middleware matcher shrink
- new critical routes not covered by middleware
- risky `next.config` changes (`basePath`, `output`, `assetPrefix`, `trailingSlash`)
- remote image allowlist shrink
- auth-impacting rewrites / redirects (`/auth`, `/login`, `/api/auth`)
- dynamic / static cache conflicts (`force-static` + `cookies()` / `headers()`)
- Prisma `ALTER TYPE`, `ADD UNIQUE`, `SET NOT NULL` without backfill hint
- Prisma schema drift (schema changed w/o migration, or vice versa)
- env drift — missing / empty / divergent keys, secrets that look secret
- OAuth redirects hardcoded to localhost, `http://`, off-allowlist domains
- missing lockfile / `.env.example` / CI config

---

## Verdict shape

```text
verdict:        GO | CAUTION | BLOCK      — 지금 repo 절대 상태
verdictReason:  hard-blocker | score | clean
score:          누적 위험 점수
hardBlockers:   verdict 을 강제 BLOCK 시킨 finding 목록

baseline?:      { newFindings, resolvedFindings, persistingFindings, deltaScore }
changeVerdict?: GO | CAUTION | BLOCK      — 이번 변경이 신규로 만든 위험
changeVerdictReason?: new-hard-blocker | delta-score | clean
```

- **GO** — safe to proceed
- **CAUTION** — review before deploy
- **BLOCK** — stop and fix (either a hard-blocker rule fired, or score ≥ block threshold)
- **changeVerdict** — "repo 가 원래 더러웠는가" 와 "이 PR 이 새로 위험을 만들었는가" 를 분리

---

## 설치 · 빌드

```bash
npm install
# postinstall 이 tsc 를 돌려 dist/index.js 를 만듭니다.
```

## GitHub Action 으로 5 분 안에 시작하기

이 저장소의 [`action/`](action/) 폴더가 그대로 GitHub Action 입니다. PR 마다 한 번 도는 단일 코멘트 형태로, 머지 전에 verdict 를 보여줍니다.

```yaml
# .github/workflows/deploy-rehearsal.yml
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
```

기본 동작:
- PR base 브랜치 (`origin/<base>`) 와 `merge-base` 모드로 비교.
- PR 코멘트 1 개를 marker 로 식별해 push 마다 갱신 (코멘트 폭주 없음).
- absolute verdict 가 `BLOCK` 이면 job 실패 → 머지 차단.
- `outputs.verdict` / `outputs.change-verdict` / `outputs.score` 후속 step 으로 전달.

세부 입력 / 출력 / 권한 / 동작 메모는 [action/README.md](action/README.md), 복사-붙여넣기용 워크플로 샘플은 [examples/github-action.yml](examples/github-action.yml) 참고.

---

## MCP 클라이언트 등록

```json
{
  "mcpServers": {
    "deploy-rehearsal": {
      "command": "node",
      "args": ["D:\\Users\\Portfolio\\MCP_by_claudecode\\dist\\index.js"]
    }
  }
}
```

## 제공 툴

| 이름 | 용도 |
| --- | --- |
| `run_rehearsal` | **원샷 엔트리.** diff + env + OAuth + preflight + Prisma + Next.js 를 돌려 verdict / findings / Markdown 리포트 반환. |
| `analyze_diff` | git diff 에서 migration / auth / payment / env / routing / CI / secret 신호 분류 |
| `compare_env` | 2+ 개 env 파일의 missing / empty / divergent / secretLike 키 감지 |
| `check_oauth_redirects` | 소스에서 redirect URI 스캔, localhost / http / off-allowlist 도메인 플래그 |
| `preflight_checklist` | git 상태, build/test 스크립트, lockfile, `.env.example`, `.gitignore`, CI 설정 점검 |
| `score_deploy_risk` | diff + preflight 만 묶은 간이 score |

---

## 설정 — `deploy-rehearsal.config.json`

프로젝트 루트에 두면 자동 로드. 현재 기본값:

```json
{
  "thresholds": { "block": 90, "caution": 25 },
  "baseline": {
    "enabled": false,
    "path": ".deploy-rehearsal-baseline.json",
    "compareBy": ["fingerprint"],
    "deltaBlockThreshold": 45,
    "deltaCautionThreshold": 15
  },
  "prisma": {
    "weights": {
      "providerChanged": 95, "providerMismatch": 85,
      "dropTable": 85, "truncate": 80, "dropColumn": 70,
      "setNotNull": 38, "schemaDriftNoMigration": 28,
      "alterType": 24, "addUnique": 20, "createUniqueIndex": 18,
      "migrationWithoutSchema": 14, "dropIndex": 10,
      "renameColumn": 10, "renameTable": 12
    },
    "hardBlockKinds": ["providerChanged", "providerMismatch", "dropTable", "truncate", "dropColumn"],
    "criticalModelPatterns": ["User", "Account", "Session", "Payment", "Subscription", "Order", "Invoice"],
    "mitigationHints": ["SET DEFAULT", "backfill", "populate", "UPDATE", "copy data"],
    "duplicateFingerprintPenaltyRatio": 0.2,
    "contextBonus": 12,
    "mitigationDiscount": 14
  },
  "nextjs": {
    "weights": {
      "publicSecretExposure": 90,
      "publicSuspiciousExposure": 32,
      "clientEnvAccessSecret": 80,
      "edgeNodeApiMismatch": 85,
      "edgePrismaUsage": 85,
      "matcherShrunk": 28,
      "middlewareUnprotectedCriticalRoute": 55,
      "nextConfigRisk": 22,
      "imagesRemotePatternsShrunk": 24,
      "authRewriteOrRedirectRisk": 36,
      "dynamicStaticConflict": 30,
      "personalizedStatic": 45
    },
    "hardBlockKinds": [
      "publicSecretExposure", "clientEnvAccessSecret",
      "edgeNodeApiMismatch", "edgePrismaUsage", "personalizedStatic"
    ],
    "criticalRoutes": ["/dashboard", "/billing", "/account", "/admin", "/api/private", "/api/admin"],
    "authRouteHints": ["/auth", "/login", "/logout", "/api/auth", "/signin", "/signout"]
  }
}
```

---

## Scoring — 왜 합계만으로 결정하지 않나

```
verdict = "BLOCK"   if any hardBlocker
        = "BLOCK"   if score ≥ thresholds.block
        = "CAUTION" if score ≥ thresholds.caution
        = "GO"      otherwise

changeVerdict = "BLOCK"   if any baseline.newFindings is a hardBlocker
              = "BLOCK"   if deltaScore ≥ deltaBlockThreshold
              = "CAUTION" if deltaScore ≥ deltaCautionThreshold
              = "GO"      otherwise
```

Score 는 단순 합이 아니라 **fingerprint 그룹** 기준으로 계산:

```
group.score = clamp(0, 100,
    max(weight)
  + floor((count - 1) * max(weight) * duplicatePenaltyRatio)
  + (anyCriticalModel ? contextBonus : 0)
  - (anyMitigationHint ? mitigationDiscount : 0)
)
total = Σ group.score
```

같은 문제를 여러 파일에서 잡아도 과대폭증하지 않고, 핵심 모델 (User / Payment / …) 은 bonus, backfill 흔적이 있으면 discount.

---

## Fingerprint 규칙

`id` 는 디버깅용 (파일 경로 + 라인 포함). **`fingerprint` 는 baseline · suppression · grouping 의 정체성**이라 라인번호를 절대 넣지 않고 "문제의 본질" 을 담는다.

| 카테고리 | fingerprint 정체성 |
| --- | --- |
| env 노출 (`nextjs:public-secret:*`, `public-suspicious:*`, `client-env-access:*`) | **env 키** |
| edge runtime (`nextjs:edge-node-api:<route>:<module>`, `edge-prisma:<route>`) | **라우트 경로** (파일 이동에 흔들리지 않음) |
| middleware (`nextjs:matcher-shrunk:<sorted|removed>`, `middleware-unprotected:<route>`) | **제거된 matcher 집합** 또는 **라우트** |
| next.config (`nextjs:config-basepath-change`, `config-output-change`, …) | **변경 종류** (compact: kind=`nextConfigRisk` 하나로 묶이나 fingerprint 는 구체적) |
| images (`nextjs:images-remote-patterns-shrunk:<sorted|removed>`) | **제거된 도메인 집합** |
| auth rewrite/redirect (`nextjs:auth-rewrite-risk:<from>-><to>`) | **source→destination 쌍** |
| cache (`nextjs:personalized-static:<route>`, `dynamic-static-conflict:<route>`) | **라우트** |
| Prisma 파괴적 migration (`prisma:drop-column:User.email`) | **대상 객체** (`<table>.<column>`) |
| Prisma provider 관련 | `prisma:provider-changed`, `prisma:provider-mismatch:<expected>:<actual>` |

Suppression 예:

```json
{
  "suppress": [
    "nextjs:config-basepath-change",
    {
      "fingerprint": "prisma:drop-table:LegacyTable",
      "until": "2026-06-01",
      "reason": "Legacy table being phased out next sprint"
    },
    {
      "id": "oauth:unexpected:old-staging.example.com:src/auth/callback.ts:14",
      "until": "2026-04-30"
    }
  ]
}
```

- **string** — 무기한 suppression (fingerprint 또는 id 어느 쪽이든 매칭).
- **객체** — `fingerprint` 또는 `id` 중 하나 필수. `until` 은 `YYYY-MM-DD` 당일 포함, 그 다음날부터 만료. `reason` 은 audit 용.
- `fingerprint` 와 `id` 가 동시에 주어지면 fingerprint 우선.
- 같은 finding 에 여러 rule 이 걸리면 **유효한 것 하나라도 있으면 suppress** (예: 만료된 객체 + 무기한 string 동시 → suppress 유지).

### 만료 처리

만료된 suppression 은 finding 을 **다시 살린다.** 즉 expired entry 가 가린 적 있던 finding 은 자동으로 warnings/blockers 로 복귀해서 verdict 에 다시 영향을 준다. 결과의 `suppressionStatus` 가 그 상태를 그대로 보여준다:

```json
{
  "suppressionStatus": {
    "active": [
      { "kind": "fingerprint", "target": "prisma:drop-table:LegacyTable", "until": "2026-06-01", "reason": "..." }
    ],
    "expired": [
      { "kind": "fingerprint", "target": "nextjs:matcher-shrunk:/admin/:path*", "until": "2026-03-01" }
    ],
    "invalid": [
      { "target": "preflight:ci-config", "reason": "invalid-date", "detail": "2026-13-99" }
    ]
  }
}
```

Markdown 리포트에도 **Suppression status** 섹션이 추가되어 active / expired / invalid 가 한눈에 보인다. 만료된 룰은 rotted-out 정책을 식별하는 데 그대로 쓰면 된다.

### "오늘" 기준 override

만료 판정의 "오늘" 은 기본적으로 UTC 의 `YYYY-MM-DD` 다 (`new Date().toISOString().slice(0,10)`). 환경변수 **`DEPLOY_REHEARSAL_TODAY=YYYY-MM-DD`** 가 설정돼 있고 형식이 유효하면 그 값을 대신 쓴다. 용도는 두 가지:

- **CI 의 결정성** — 자정 근처에 도는 작업이 호스트 시계에 따라 결과가 흔들리지 않게 고정.
- **테스트** — 만료 시나리오를 시계 의존 없이 재현 (예: e2e 가 `2099-01-01` / `2020-01-01` 로 명백한 미래·과거를 박아 검증).

값이 잘못된 형식 (`2026-13-99` 등) 이면 무시하고 실제 UTC 날짜로 폴백한다.

---

## Baseline — 절대 vs 변경분

baseline 은 두 가지 모드가 있다. 둘 다 같은 shape 의 `baseline` / `changeVerdict` 를 돌려준다.

### 1) File mode — 저장된 스냅샷 비교

```bash
# 보통 main 병합 직후 / CI 의 main job 에서
run_rehearsal(saveBaseline=true)    # .deploy-rehearsal-baseline.json 저장

# PR / 머지 전
run_rehearsal()                     # baseline 파일이 있으면 자동 비교
```

### 2) Git-ref mode — **추천.** 현재 워킹트리 vs 임의 ref 시점 비교

`baselineRef` 를 넘기면 해당 ref 시점의 worktree 를 임시로 만들어 (git worktree add — working tree 는 절대 건드리지 않음) 거기서 동일한 분석을 돌린 뒤 비교합니다. 즉 파일 저장 안 해도 됩니다.

```json
{ "arguments": { "cwd": ".", "baselineRef": "origin/main" } }
{ "arguments": { "cwd": ".", "baselineRef": "HEAD^" } }
{ "arguments": { "cwd": ".", "baselineRef": "a1b2c3d", "baselineRefMode": "direct" } }
```

- **`baselineRefMode: "merge-base"` (기본)** — `merge-base(HEAD, ref)` 와 비교. 브랜치 작업에서 "이 브랜치가 추가한 위험" 만 보고 싶을 때.
- **`baselineRefMode: "direct"`** — ref 자체와 직접 비교. HEAD^ 같은 단순 비교에 적합.
- `baselineRef` 는 `baselinePath` 보다 우선한다.
- `config.baseline.defaultGitRef` 를 설정하면 매번 넘길 필요 없음.

결과에 붙는 필드:

```json
{
  "baselineSource": "git-ref",
  "baselineDisplayRef": "origin/main",
  "baselineResolvedRef": "abc1234…",
  "baselineMode": "merge-base",
  "baseline": { "newFindings": [...], "resolvedFindings": [...], "persistingFindings": [...], "deltaScore": 25 },
  "changeVerdict": "BLOCK",
  "changeVerdictReason": "new-hard-blocker"
}
```

실패 시 rehearsal 자체는 진행되고 `baselineError` 에 사유가 담깁니다 (`ref-not-found` · `shallow-clone` · `worktree-failed` · `merge-base-failed` · `not-a-repo` · `analysis-failed`).

### 왜 두 축을 분리해서 보나

> **"절대 266 (BLOCK) — 하지만 main 대비 delta 는 +0 이라 신규 위험 없음."**
> **"이번 PR 이 새 hard-blocker 를 1개 추가 → changeVerdict BLOCK, 머지 금지."**

---

## 자체 검증

```bash
node test/e2e.mjs
```

서버를 stdio 로 띄워 JSON-RPC 로 대화. 현재 **150 개 assertion 전부 통과**:

- `initialize` + `tools/list` 프로토콜
- 개별 툴 5 개 (`analyze_diff`, `compare_env`, `check_oauth_redirects`, `preflight_checklist`, `score_deploy_risk`)
- `run_rehearsal` 오케스트레이터 (config 로딩, suppression, 필수 env 키, 블록 패턴, markdown 리포트)
- baseline 5 종 (save → 변화 없음 → 신규 finding → suppress 로 resolved → fingerprint 안정성)
- hard-blocker · score fallback · fingerprint grouping · critical-model bonus · mitigation discount · new-hard-blocker change verdict
- Prisma 12 종 (destructive × 4, drift × 2, mismatch × 2, baseline/persisting, suppression, fingerprint stability, no-op)
- Next.js 12 종 (public-secret, public-suspicious, client-env-access, edge-node-api, edge-prisma, matcher-shrunk, middleware-unprotected, next.config basePath, images shrink, personalized-static, dynamic-static-conflict, auth-rewrite-risk)
- git-ref baseline 8 종 (direct mode, invalid ref, merge-base, new hard-blocker change verdict, resolved finding, ref precedence, markdown provenance, persisting fingerprint stability)
- suppression expiry 9 종 (string 무기한 / fingerprint·id 의 active·expired / fingerprint≻id 우선 / invalid-date 보고 / report 노출 / 다중 룰 any-active)

---

## 무료 / 유료 경계 — 오픈 코어

### Free · OSS (여기 공개된 범위)

- 로컬 stdio MCP 서버 + 6 개 툴 (`run_rehearsal` 포함)
- JSON / Markdown 리포트
- `deploy-rehearsal.config.json` 기반 룰셋 + suppression
- baseline 모드 (file mode)
- Prisma detector · Next.js detector v1
- fixture 기반 e2e 테스트

### Pro · Team (별도 배포 / 플랜)

- GitHub Actions / PR 코멘트 통합 (BLOCK 이면 머지 차단, CAUTION 이면 요약)
- 조직 공통 정책 (allowedDomains, requiredEnvKeys, hardBlockKinds 중앙 배포)
- 리포트 이력 · 두 커밋 간 delta · baseline 비교
- 멀티 레포 대시보드
- suppression 승인 / audit log
- Slack · Discord · Webhook 알림
- baseline `git-ref` · `commit` · `ci-artifact` mode
- MCP Apps 기반 승인 UI
- 프레임워크 detector 심화 (Remix, Vite SSR, SvelteKit …)

**개인 개발자는 무료로 다 쓸 수 있고, 팀 단위 운영에 들어오는 기능은 유료.**

---

## 로드맵

- [x] 6 tool MVP + config
- [x] Markdown 리포트
- [x] baseline 모드 — fingerprint 기반 new/resolved/persisting + delta verdict
- [x] Prisma detector — destructive migration · schema drift · provider mismatch
- [x] Next.js detector v1 — env exposure · edge/node · middleware · next.config · cache
- [x] baseline git-ref mode (`direct` / `merge-base`)
- [x] suppression expiry — `until` (`YYYY-MM-DD` inclusive) + active / expired / invalid 집계
- [x] suppression provenance v1 — `Finding.suppressedBy?` + `suppressedFindings` audit + `suppressedBreakdown.{rules,ignorePatterns}`
- [x] GitHub Action 패키지 — composite action + 단일 PR 코멘트 upsert + verdict outputs
- [ ] Next.js detector v2 — server action drift, ISR revalidate 충돌, standalone output 파일 누락
- [ ] suppression v2 — owner / createdAt / ticket link / 만료 임박 알림
