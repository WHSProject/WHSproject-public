# WHSProject Agent Rules

> 이 문서는 WHSProject 저장소에서 AI Coding Agent가 작업할 때 지켜야 할 공통 규칙을 정의합니다.

WHSProject는 Gateway, Scanner, Controller / Policy, Verdaccio, Data / Feeds,
Database, Dashboard, DevOps / QA 등 여러 Component가 함께 동작하는 프로젝트입니다.

AI Agent는 개별 파일의 수정뿐 아니라 다른 Component와의 연결 및
전체 Runtime Workflow에 미치는 영향을 함께 고려해야 합니다.

---

## 1. 작업 시작 전 확인

작업을 시작하기 전에 반드시 현재 Git 상태를 확인합니다.

```bash
git branch --show-current
git status
git diff
git diff --cached
```

그리고 다음 순서로 작업 범위를 파악합니다.

1. 관련 GitHub Issue를 확인합니다.
2. 작업 목적과 완료 조건을 확인합니다.
3. 현재 작업 Branch가 올바른지 확인합니다.
4. 관련 Component의 기존 코드를 먼저 읽습니다.
5. 관련 API / Schema / Test / 설정 파일을 함께 확인합니다.
6. 기존 구현 패턴과 Naming Convention을 우선 따릅니다.
7. 작업에 영향을 주는 Open Decision 또는 미확정 사항이 있는지 확인합니다.

정보가 부족하거나 팀 합의가 필요한 사항은 임의로 결정하지 않습니다.

---

## 2. Git 작업 원칙

- `main`, `dev`에서 직접 기능 작업을 하지 않습니다.
- 작업은 최신 `dev`에서 생성한 별도 Branch에서 수행합니다.
- 가능한 한 GitHub Issue와 Branch를 연결합니다.
- 하나의 Branch는 하나의 Issue 또는 하나의 명확한 변경 목적을 가집니다.
- 관계없는 변경을 같은 Commit / Pull Request에 포함하지 않습니다.
- 기존 Contributor의 변경사항을 임의로 삭제하거나 Rollback하지 않습니다.
- 명시적인 요청 없이 Force Push를 수행하지 않습니다.
- 명시적인 요청 없이 `reset --hard`, 강제 checkout 등 파괴적인 Git 명령을 실행하지 않습니다.

전체 Git Workflow는 `GIT_WORKFLOW.md`를 따릅니다.

---

## 3. Branch Naming

기본 형식:

```text
<type>/<issue-number>-<short-description>
```

사용 가능한 type:

```text
feat
fix
refactor
test
docs
chore
```

예시:

```text
feat/23-gateway-request-parser
fix/31-scanner-timeout
test/42-policy-e2e
docs/15-api-spec
chore/1-github-workflow-setup
```

---

## 4. Component Boundary

AI Agent는 요청받은 Component의 범위를 우선적으로 유지합니다.

주요 Component 예시:

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

작업 중 다른 Component의 변경이 필요해진 경우:

1. 왜 변경이 필요한지 먼저 확인합니다.
2. 최소한의 변경만 수행합니다.
3. 관련 담당자의 코드와 Contract를 확인합니다.
4. Pull Request에 영향 범위를 명시합니다.

요청 범위를 벗어난 대규모 Refactoring은 수행하지 않습니다.

---

## 5. Contract 변경

다음 항목은 Component 간 Contract로 취급합니다.

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

Contract 변경이 발생하는 경우 반드시:

- 관련 코드를 함께 확인합니다.
- 영향받는 Component를 파악합니다.
- 관련 Test 수정 여부를 확인합니다.
- 관련 문서 수정 여부를 확인합니다.
- Pull Request에 Contract 변경 사실을 명시합니다.

기존 Contract를 추측만으로 변경하지 않습니다.

---

## 6. 기존 구현 존중

새 코드를 작성하기 전에 관련 구현을 먼저 읽습니다.

예:

```text
Controller
Service
Repository
DTO / Schema
Test
Configuration
Dockerfile
```

기존 프로젝트의:

- Directory Structure
- Naming
- Error Handling
- Logging
- Test Pattern
- Response Format

을 우선 따릅니다.

단순히 더 좋아 보인다는 이유로 기존 구조를 전면적으로 변경하지 않습니다.

---

## 7. Commit 전 확인

Commit 전 반드시 다음 명령으로 변경사항을 확인합니다.

```bash
git status
git diff
git diff --cached
```

관련 파일만 Stage합니다.

예:

```bash
git add <related-files>
```

`git add .`을 사용할 경우 반드시 먼저 변경 파일 전체를 확인합니다.

관계없는 파일이나 사용자의 작업물을 함께 Stage하지 않습니다.

---

## 8. Commit Message

기본 형식:

```text
<type>: <변경 내용>
```

예시:

```text
feat: Gateway 요청 분류 로직 구현
fix: Scanner timeout 처리 오류 수정
test: REJECT E2E 테스트 추가
docs: API 명세 수정
chore: GitHub Actions CI 설정
```

Commit Message는 실제 Diff를 기준으로 작성합니다.

- 구현하지 않은 내용을 적지 않습니다.
- 의미가 다른 변경은 가능한 한 분리합니다.
- 테스트하지 않은 내용을 테스트 완료로 표현하지 않습니다.

---

## 9. Test 및 검증

변경한 기능과 직접 관련된 Test를 우선 실행합니다.

가능한 Test 유형:

```text
Unit
Integration
E2E
Failure
Regression
Manual
```

다음 원칙을 지킵니다.

- Repository에 정의된 실제 Test Command를 확인한 뒤 실행합니다.
- 존재하지 않는 Test Command를 임의로 만들어 실행했다고 보고하지 않습니다.
- 실패한 Test를 숨기지 않습니다.
- Test를 실행하지 못했다면 이유를 명시합니다.
- Test 결과와 실제 변경사항을 일치시켜 보고합니다.

---

## 10. DevOps / Runtime 관련 변경

다음 항목은 통합 실행환경에 영향을 줄 수 있습니다.

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

위 항목을 변경하는 경우:

1. 기존 설정을 먼저 확인합니다.
2. 해당 Component의 실행 방식과 일치하는지 확인합니다.
3. Docker Compose / CI / E2E 영향 여부를 확인합니다.
4. Pull Request에 변경 내용을 명시합니다.

AI Agent가 임의로 Port 또는 환경변수 이름을 변경하지 않습니다.

---

## 11. Sensitive Information

다음 값은 코드나 문서에 직접 Commit하지 않습니다.

```text
API Key
Access Token
Password
Database Credential
Private Key
Secret Key
Cloud Credential
개인 .env 값
```

필요한 경우 환경변수 이름만 `.env.example`에 작성합니다.

실제 Secret 값을 예시값으로도 삽입하지 않습니다.

---

## 12. Push / Pull Request

Remote Push 또는 Pull Request 생성은
사용자의 요청 또는 팀 Workflow에 따라 수행합니다.

Push 전:

```bash
git status
git diff --cached
```

를 다시 확인합니다.

Pull Request에는 가능한 한 다음 내용을 포함합니다.

- 관련 Issue
- 작업 목적
- 주요 변경사항
- 관련 Component
- Test 결과
- Contract 변경 여부
- 미해결 사항
- 후속 작업

일반 작업 PR의 Base Branch는 `dev`입니다.

---

## 13. 금지 사항

다음 행동은 명시적 승인 없이 수행하지 않습니다.

- `main` / `dev` 직접 수정 또는 직접 Push
- Force Push
- `git reset --hard`
- 기존 Contributor Commit 삭제
- 기존 작업 임의 Rollback
- 관계없는 대규모 Refactoring
- Issue 범위를 벗어난 파일의 무분별한 수정
- 민감정보 Commit
- Test 실패 은폐
- 실행하지 않은 Test를 성공했다고 보고
- 합의되지 않은 API / Schema / Policy 임의 변경
- 사용하지 않는 Dependency의 임의 추가

---

## 14. 관련 문서

AI Agent는 필요에 따라 다음 문서를 함께 참고합니다.

- `GIT_WORKFLOW.md` — Git Branch / Commit / PR / Merge 규칙
- `CONTRIBUTING.md` — Contributor 공통 작업 규칙
- `CLAUDE.md` — Claude Code 전용 프로젝트 지침
- `.github/PULL_REQUEST_TEMPLATE.md` — Pull Request 작성 기준
- `.github/ISSUE_TEMPLATE/` — Issue 작성 기준