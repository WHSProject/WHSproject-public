# CLAUDE.md

## Project Overview

WHSProject는 npm 오픈소스 패키지 공급망 공격을 방어하기 위한
Registry Proxy 기반 Security Platform을 개발하는 프로젝트입니다.

개발자 또는 CI의 npm 요청을 Gateway에서 통제하고,
필요한 경우 Scanner와 Policy Engine을 통해 패키지를 분석 및 판정한 뒤
ACCEPT된 패키지만 Verdaccio를 통해 전달하는 구조를 사용합니다.

기본 Runtime Workflow는 다음과 같습니다.

```text
Developer / CI
      ↓
   Gateway
      ↓
Decision Cache 조회
      ↓
필요 시 Scanner
      ↓
   Evidence
      ↓
Scoring / Policy
      ↓
   Decision
      ↓
ACCEPT → Verdaccio → npm
REJECT / HOLD / REVIEW → Gateway에서 통제
```

---

## 1. Before Starting Work

작업을 시작하기 전에 반드시 다음 문서를 확인합니다.

1. `AGENTS.md`
   - AI Coding Agent가 반드시 지켜야 하는 공통 작업 규칙

2. `CONTRIBUTING.md`
   - Repository 공통 협업 및 Contributor 규칙

3. `GIT_WORKFLOW.md`
   - Branch / Commit / Pull Request / Merge 규칙

4. 관련 GitHub Issue
   - 실제 작업 범위와 완료 조건

위 규칙과 현재 사용자 요청이 충돌하는 경우
임의로 판단하지 말고 먼저 확인합니다.

---

## 2. Git Rules

Claude Code도 일반 Contributor와 동일한 Git Workflow를 따릅니다.

- `main`, `dev`에서 직접 기능 작업하지 않습니다.
- 최신 `dev`에서 작업 Branch를 생성합니다.
- 가능한 한 하나의 Issue를 하나의 Branch와 연결합니다.
- 일반 작업 Pull Request의 Base Branch는 `dev`입니다.
- Release 시에만 `dev → main` Pull Request를 사용합니다.
- 명시적인 승인 없이 Force Push 또는 파괴적인 Git 명령을 사용하지 않습니다.

작업 시작 전 최소한 다음을 확인합니다.

```bash
git branch --show-current
git status
git diff
git diff --cached
```

---

## 3. Main Components

현재 프로젝트의 주요 책임 영역은 다음과 같습니다.

```text
Gateway
Controller / Policy
Scanner
Verdaccio
Data / Feeds
Database
Dashboard
DevOps / QA
```

각 Component는 독립적으로 개발될 수 있지만
최종적으로 하나의 Runtime Workflow에서 함께 동작해야 합니다.

따라서 한 Component의 변경이 다른 Component의 Contract를
깨뜨리지 않는지 항상 확인합니다.

---

## 4. Component Responsibility

### Gateway

- npm 요청 진입점
- 요청 식별
- 기존 Decision 조회
- 필요 시 분석 / 판정 요청
- 최종 Decision 집행
- ACCEPT인 요청만 Verdaccio로 전달

### Scanner

- 분석이 필요한 Package Artifact 획득
- Integrity / Identity 확인
- Static Analysis 및 Evidence 생성
- 분석 결과를 Policy 판단에 사용할 수 있는 형태로 제공

Scanner는 최종 ACCEPT / REJECT를 직접 결정하지 않습니다.

### Controller / Policy

- Evidence 및 Policy를 기반으로 Decision 생성
- 정책 및 판정 기준 관리
- ACCEPT / REJECT / HOLD / REVIEW 상태 관리

### Verdaccio

- npm Registry Proxy / Cache 역할
- ACCEPT된 Package Artifact 전달
- Upstream npm Registry 연동

Verdaccio는 보안 판정을 직접 수행하지 않습니다.

### Database / Cache

- PostgreSQL:
  Scan / Evidence / Decision / Policy / Audit 등 영속 데이터 관리

- Gateway 분석 이력 캐시:
   트리 분석과 승인 등록을 마친 Artifact의 신원(name·version·integrity)을 프로세스 내부 LRU 방식으로 보관한다.
   Decision은 캐시하지 않는다. 캐시 적중 시 Arborist 트리 재구성은 생략하지만, Decision 조회와 집행은 요청마다 수행한다.

### Dashboard

- Package / Scan / Decision / Evidence 조회
- Policy 및 Review 관련 운영 화면
- Audit / 상태 확인

### DevOps / QA

- Docker Compose 기반 통합 실행환경
- 환경변수 및 Service Dependency 관리
- Health Check
- CI/CD
- Integration / E2E / Failure / Regression Test
- Release / Demo / Rollback 기준

---

## 5. Contract Awareness

다음 변경은 다른 Component에 영향을 줄 수 있는 Contract 변경으로 봅니다.

```text
API Request / Response
Database Schema
Evidence Schema
Decision Schema
Policy
Environment Variable
Port
Service Dependency
Runtime / Docker 실행 방식
```

Contract 변경이 필요한 경우:

1. 기존 정의를 먼저 확인합니다.
2. 영향받는 Component를 확인합니다.
3. 최소 범위로 수정합니다.
4. 관련 Test 및 문서 수정 여부를 확인합니다.
5. Pull Request에 변경 내용을 명시합니다.

합의되지 않은 Contract를 임의로 변경하지 않습니다.

---

## 6. Current Development Principle

현재 프로젝트는 각 Component를 개별적으로 완성하는 것보다
다음 흐름이 실제로 연결되는 것을 중요하게 봅니다.

```text
npm Request
→ Gateway
→ Decision Cache
→ Scanner / Policy
→ Decision
→ ACCEPT only
→ Verdaccio
→ npm Artifact Delivery
```

구현 시 항상 다음을 확인합니다.

- 이 변경이 전체 Runtime Workflow에서 어떤 위치에 있는가?
- 입력과 출력 Contract는 무엇인가?
- 실패하면 다른 Component가 어떻게 영향을 받는가?
- Integration / E2E Test가 필요한가?

---

## 7. Do Not Guess Open Decisions

아직 팀에서 확정되지 않은 정책이나 동작은
Claude가 임의로 확정하여 구현하지 않습니다.

특히 다음과 같은 영역은 구현 전 최신 팀 문서와 Issue를 확인합니다.

```text
HOLD / REVIEW 상태 전이
Retry 기준
Cache Invalidation
Policy 변경 후 기존 Decision 처리
장애 시 Fail-open / Fail-closed 동작
Metadata 검사 범위
```

관련 기준이 명확하지 않다면
구현 전에 사용자 또는 담당자에게 확인합니다.

---

## 8. Testing

변경한 범위와 관련된 실제 Test Command를 확인하고 실행합니다.

가능한 Test 유형:

```text
Unit
Integration
E2E
Failure
Regression
Manual
```

다음은 금지합니다.

- 존재하지 않는 Test를 실행했다고 보고
- 실패한 Test를 성공으로 표현
- 실행하지 않은 Test를 완료로 체크
- 실제 결과 없이 동작을 보장한다고 표현

테스트하지 못한 경우에는 이유와 미검증 범위를 명확히 남깁니다.

---

## 9. DevOps / Runtime Changes

다음 변경은 DevOps / QA 통합환경에 영향을 줄 수 있습니다.

```text
Dockerfile
Runtime Version
Build Command
Start Command
Test Command
Port
Environment Variable
Volume
Health Check
Service Dependency
```

이 항목을 수정할 경우
Docker Compose, CI 및 Integration / E2E 영향 여부를 함께 확인합니다.

각 Component 내부 Dockerfile은 해당 Component의 실행환경을 기준으로 관리하고,
전체 통합 실행환경은 DevOps / QA 기준과 맞춰야 합니다.

---

## 10. Secrets

다음 값은 Repository에 직접 작성하지 않습니다.

```text
API Key
Access Token
Password
Database Credential
Private Key
Secret Key
Cloud Credential
실제 .env 값
```

공유가 필요한 경우 환경변수 이름만 사용합니다.

예:

```env
DATABASE_URL=
REDIS_HOST=
SCANNER_URL=
VERDACCIO_URL=
```

---

## 11. Scope Control

Claude는 요청받은 범위 안에서 최소한의 변경을 수행합니다.

하지 말아야 할 것:

- 관계없는 파일 수정
- 요청하지 않은 대규모 Refactoring
- 기존 Contributor 코드 임의 삭제
- 기존 Commit Rollback
- 합의되지 않은 Dependency 추가
- Port / 환경변수 이름 임의 변경
- API / Schema / Policy를 추측하여 변경
- main / dev 직접 작업

더 넓은 변경이 필요하다고 판단되면
먼저 이유와 영향 범위를 설명하고 확인합니다.

---

## 12. Work Completion

작업 완료 전 다음을 확인합니다.

```text
[ ] Issue 범위 안의 작업인가
[ ] 현재 Branch가 올바른가
[ ] 관계없는 변경이 포함되지 않았는가
[ ] Contract 변경 여부를 확인했는가
[ ] 필요한 Test를 수행했는가
[ ] Test 실패를 숨기지 않았는가
[ ] 민감정보가 포함되지 않았는가
[ ] 관련 문서 수정이 필요한지 확인했는가
[ ] DevOps / QA 통합 영향이 있는지 확인했는가
```

완료 보고는 실제 변경사항과 검증 결과를 기준으로 작성합니다.