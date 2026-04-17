# Deploy Rehearsal MCP — 배포 전 위험 분석 MCP 서버

상태: 진행중
카테고리: 10_진행중
폴더명: mcp-deploy-rehearsal
목적: 배포 전 git diff, env drift, OAuth 리다이렉트, Prisma 마이그레이션, Next.js 런타임 오류를 자동 분석해 GO/CAUTION/BLOCK 판정을 내리는 로컬 stdio MCP 서버
실행 방법: npm run build && node dist/index.js (MCP stdio 서버)
로컬 주소: 해당 없음 (stdio MCP 서버)
주요 기술: TypeScript 5.7, Node.js 18+, @modelcontextprotocol/sdk, Zod. 6개 MCP 툴 제공
다음 할 일: fix: compare pull request head against base ref
주의사항: .env 불필요. npm run build 후 dist/index.js 생성됨. Claude Code MCP 등록 시 dist/index.js 절대 경로 사용
검증 방법: npm run build / node test/e2e.mjs
마지막 확인: 2026-04-16
