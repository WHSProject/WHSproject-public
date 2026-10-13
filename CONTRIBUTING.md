
# Contributing Guide

WHSProject는 여러 Component가 함께 동작하는 npm Supply Chain Security Platform을 개발합니다.

각 파트는 독립적으로 작업하지만,
최종적으로 Gateway, Scanner, Policy/Controller, Verdaccio, Database, Dashboard 등이 하나의 흐름으로 통합되어야 합니다.

따라서 모든 Contributor는 자신의 작업 범위뿐 아니라
다른 Component와의 Interface 및 통합 영향을 함께 고려해야 합니다.

---

## 1. 기본 원칙

- 모든 작업은 가능한 한 GitHub Issue를 기준으로 진행합니다.
- `main`, `dev` 브랜치에서 직접 작업하지 않습니다.
- 하나의 Branch / Pull Request에는 하나의 명확한 작업 목적을 유지합니다.
- 담당하지 않은 Component의 코드를 임의로 대규모 수정하지 않습니다.
- 다른 Component와의 Contract가 변경되는 경우 반드시 PR에 명시합니다.
- 실제 테스트하지 않은 내용을 테스트 완료로 표시하지 않습니다.
- API Key, Password, Token 등 민감정보를 Repository에 Commit하지 않습니다.

Git 사용에 대한 상세 규칙은 `GIT_WORKFLOW.md`를 따릅니다.

---

## 2. 작업 시작 전

작업 전 다음 내용을 확인합니다.

1. 관련 GitHub Issue가 존재하는지 확인합니다.
2. 작업 범위와 완료 조건을 확인합니다.
3. 담당 Component와 영향을 받는 Component를 확인합니다.
4. 관련 Requirement / WBS / API / Schema가 있다면 확인합니다.
5. 아직 합의되지 않은 사항이 구현에 영향을 주는지 확인합니다.

합의가 필요한 내용이 있다면 임의로 결정하여 구현하기보다
Issue, PR 또는 팀 논의를 통해 먼저 확인합니다.

---

## 3. Branch

작업 Branch는 최신 `dev`를 기준으로 생성합니다.

```bash
git switch dev
git pull origin dev
git switch -c <type>/<issue-number>-<description>
```

예시:

```text
feat/23-gateway-request-parser
fix/31-scanner-timeout
test/42-policy-e2e
docs/15-api-spec
chore/1-github-workflow-setup
```

Branch Naming 및 전체 Git Flow는 `GIT_WORKFLOW.md`를 참고합니다.

---

## 4. Component Ownership

각 Contributor는 기본적으로 자신의 담당 Component를 중심으로 작업합니다.

예시:

- Gateway
- Controller / Policy
- Scanner
- Verdaccio
- Data / Feeds
- Database
- Dashboard
- DevOps / QA

다른 Component의 변경이 필요한 경우에는
가능하면 해당 담당자와 먼저 공유하거나 PR Review를 요청합니다.

특히 다음 변경은 관련 담당자와 공유가 필요합니다.

- API Request / Response 변경
- Database Schema 변경
- Evidence Schema 변경
- Decision Schema 변경
- Policy 동작 변경
- 환경변수 추가 / 변경
- Port 변경
- Service Dependency 변경
- Docker 실행 방식 변경

---

## 5. Contract 변경

Component 간 연결에 영향을 주는 변경은 반드시 PR에 표시합니다.

Contract 변경 예시:

```text
API
Database Schema
Evidence Schema
Decision Schema
Policy
Environment Variable
Port
Service Dependency
```

Contract가 변경되면 관련 문서와 테스트도 함께 수정해야 합니다.

관련 Component 담당자가 변경 내용을 알 수 있도록
PR 설명 또는 Review Request를 통해 공유합니다.

---

## 6. Test

코드 변경 시 가능한 범위에서 관련 테스트를 수행합니다.

예시:

```text
Unit Test
Integration Test
E2E Test
Failure Test
Manual Test
```

아직 테스트 환경이 구성되지 않은 경우에는
PR에 수행하지 못한 테스트와 이유를 명시합니다.

테스트를 수행하지 않았는데 완료된 것처럼 작성하지 않습니다.

DevOps / QA 통합 테스트가 필요한 변경은 PR에 표시합니다.

---

## 7. Pull Request

작업 완료 후 `dev`를 대상으로 Pull Request를 생성합니다.

PR에는 가능한 한 다음 내용을 포함합니다.

- 관련 Issue
- 작업 목적
- 주요 변경사항
- 관련 Component
- Test / 검증 결과
- Contract 변경 여부
- Reviewer가 확인해야 할 내용
- 미해결 사항
- 후속 작업

일반 기능 Branch에서 `main`으로 직접 Pull Request를 생성하지 않습니다.

Release 시에만 `dev → main` Pull Request를 사용합니다.

---

## 8. Review

Reviewer는 단순히 코드 문법만 확인하지 않고 다음 내용을 함께 확인합니다.

- Issue의 목적과 변경사항이 일치하는가
- 불필요한 변경이 포함되지 않았는가
- 다른 Component에 영향을 주는 변경이 있는가
- Contract 변경이 명시되어 있는가
- 테스트 또는 검증 근거가 있는가
- 민감정보가 포함되지 않았는가
- 기존 핵심 흐름을 깨뜨릴 가능성이 없는가

필요한 수정사항이 남아 있다면 Merge하지 않습니다.

---

## 9. Environment & Secrets

실제 Secret 값은 Repository에 Commit하지 않습니다.

Commit 금지 예시:

```text
.env
API Key
Access Token
Database Password
Private Key
Secret Key
Cloud Credential
```

공유가 필요한 환경변수 이름 및 예시는 `.env.example`에서 관리합니다.

예:

```env
DATABASE_URL=
REDIS_HOST=
SCANNER_URL=
VERDACCIO_URL=
```

실제 값은 각자의 로컬 환경 또는 추후 정의되는 Secret 관리 방식에 따라 설정합니다.

---

## 10. Docker / Runtime 변경

각 Component의 내부 실행 환경은 해당 Component 담당자가 관리합니다.

Component 담당자는 자신의 서비스에 필요한 다음 정보를 관리하고 공유합니다.

- Runtime
- Build Command
- Start Command
- Test Command
- Port
- Environment Variable
- Dependency
- Health Check
- Dockerfile

DevOps / QA는 이를 기준으로 전체 Docker Compose,
CI/CD 및 Integration / E2E 환경을 구성합니다.

Dockerfile, Port, 환경변수 또는 실행 방식이 변경될 경우
통합 환경에 영향을 줄 수 있으므로 반드시 공유합니다.

---

## 11. Documentation

구현과 문서가 서로 다른 상태로 오래 유지되지 않도록 합니다.

다음 변경이 발생하면 관련 문서 수정 여부를 확인합니다.

- API 변경
- DB Schema 변경
- Policy 변경
- Workflow 변경
- 환경변수 변경
- 실행 방법 변경
- 배포 / 테스트 방법 변경

---

## 12. AI Coding Agent

Claude Code 또는 기타 AI Coding Agent를 사용하는 경우에도
Contributor와 동일한 규칙을 적용합니다.

AI Agent는 다음을 지켜야 합니다.

- 작업 범위와 Issue를 먼저 확인합니다.
- 현재 Branch를 확인합니다.
- `main` / `dev`에 직접 작업하지 않습니다.
- 관계없는 파일을 임의로 수정하지 않습니다.
- 기존 팀원의 변경사항을 임의로 삭제하거나 되돌리지 않습니다.
- 실제 수행하지 않은 테스트 결과를 작성하지 않습니다.
- 민감정보를 코드 또는 문서에 기록하지 않습니다.
- Contract 변경이 발생하면 반드시 명시합니다.

AI Agent의 세부 규칙은 `AGENTS.md` 및 `CLAUDE.md`를 따릅니다.

---

## 13. 참고 문서

- `GIT_WORKFLOW.md` — Branch / Commit / PR / Merge 규칙
- `AGENTS.md` — AI Coding Agent 공통 작업 규칙
- `CLAUDE.md` — Claude Code 프로젝트 지침
- `.github/PULL_REQUEST_TEMPLATE.md` — Pull Request 작성 양식
- `.github/ISSUE_TEMPLATE/` — Issue 작성 양식
