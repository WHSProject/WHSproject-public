# Git Workflow

WHSProject는 GitHub Issue를 기준으로 작업을 관리하며,
모든 개발 및 수정 작업은 `dev`에서 분기한 작업 브랜치에서 진행합니다.

---

## 1. Branch Strategy

### main

Release / Demo 가능한 안정 버전을 관리합니다.

- 직접 Push하지 않습니다.
- 일반 작업 브랜치를 `main`에 직접 Merge하지 않습니다.
- Release 시 `dev → main` Pull Request를 통해 반영합니다.
- 추후 Integration / E2E / Release Gate를 Merge 조건으로 적용합니다.

### dev

팀의 통합 개발 브랜치입니다.

- 직접 Push하지 않습니다.
- 모든 작업은 별도의 작업 브랜치에서 진행합니다.
- 작업 브랜치는 최신 `dev`를 기준으로 생성합니다.
- 작업 완료 후 `dev`를 대상으로 Pull Request를 생성합니다.
- Review 및 CI 확인 후 Merge합니다.

### Working Branch

작업 브랜치는 하나의 GitHub Issue를 기준으로 생성합니다.

형식:

```text
<type>/<issue-number>-<short-description>
```

사용 가능한 type:

| Type         | 용도                           |
| ------------ | ------------------------------ |
| `feat`     | 새로운 기능                    |
| `fix`      | 버그 수정                      |
| `refactor` | 기능 변경 없는 코드 개선       |
| `test`     | 테스트 추가 및 수정            |
| `docs`     | 문서 작업                      |
| `chore`    | CI/CD, 설정, 환경 등 기타 작업 |

예시:

```text
feat/23-gateway-request-parser
fix/31-scanner-timeout
test/42-policy-e2e
docs/15-api-spec
chore/1-github-workflow-setup
```

---

## 2. Development Flow

전체 작업 흐름은 다음과 같습니다.

```text
GitHub Issue 생성
        ↓
dev 최신화
        ↓
작업 Branch 생성
        ↓
구현 / 수정
        ↓
Test
        ↓
변경사항 확인
        ↓
Commit / Push
        ↓
Pull Request → dev
        ↓
CI / Code Review
        ↓
Squash Merge
        ↓
dev 통합
```

---

## 3. 작업 시작

### 1) Issue 생성

작업 시작 전에 GitHub Issue를 생성합니다.

Issue에는 가능한 한 다음 내용을 포함합니다.

- 작업 목적
- 구현 / 수정 내용
- 완료 조건
- 관련 Component
- 관련 Requirement / WBS
- Blocker 또는 논의가 필요한 내용

### 2) dev 최신화

```bash
git switch dev
git pull origin dev
```

### 3) 작업 Branch 생성

```bash
git switch -c <type>/<issue-number>-<short-description>
```

예시:

```bash
git switch -c feat/23-gateway-request-parser
```

---

## 4. 작업 중 변경사항 확인

작업 중에는 수시로 현재 상태를 확인합니다.

```bash
git status
git diff
```

관계없는 파일을 같은 작업에 포함하지 않습니다.

---

## 5. Stage

Commit할 파일만 선택하여 Stage합니다.

```bash
git add <file>
```

Stage된 변경사항은 다음 명령어로 확인합니다.

```bash
git diff --cached
```

`git add .`을 사용할 경우 반드시 먼저 `git status`를 확인합니다.

---

## 6. Commit Convention

기본 형식:

```text
<type>: <작업 내용>
```

예시:

```text
feat: Gateway 요청 분류 로직 구현
fix: Scanner timeout 처리 오류 수정
test: REJECT E2E 테스트 추가
docs: API 명세 수정
chore: GitHub 협업 환경 초기 설정
```

Commit은 하나의 의미 있는 작업 단위로 작성합니다.

---

## 7. Push

최초 Push:

```bash
git push -u origin <branch-name>
```

예시:

```bash
git push -u origin feat/23-gateway-request-parser
```

이후 동일 브랜치에서는 다음과 같이 사용할 수 있습니다.

```bash
git push
```

---

## 8. Pull Request

작업 브랜치에서 `dev`를 대상으로 Pull Request를 생성합니다.

```text
Working Branch
      ↓
     dev
```

PR에는 다음 내용을 작성합니다.

- 관련 Issue
- 작업 목적
- 주요 변경사항
- Test / 검증 결과
- Contract 변경 여부
- Reviewer 확인사항
- 미해결 사항 또는 후속 작업

일반 작업 PR의 Base Branch는 반드시 `dev`인지 확인합니다.

---

## 9. Review & Merge

- Reviewer의 의견을 확인하고 필요한 내용을 반영합니다.
- CI가 구성된 이후에는 필수 Check가 모두 통과해야 합니다.
- 미해결 Review가 있는 상태에서는 Merge하지 않습니다.
- 기본 Merge 방식은 **Squash Merge**를 사용합니다.

Merge가 끝난 작업 브랜치는 삭제합니다.

---

## 10. Release Flow

일반 작업 브랜치에서 `main`으로 직접 Merge하지 않습니다.

```text
Working Branch
      ↓
     dev
      ↓
Integration / E2E / Release Check
      ↓
dev → main Pull Request
      ↓
     main
```

`main`은 항상 Release / Demo 가능한 상태를 유지하는 것을 목표로 합니다.

---

## 11. Direct Push

다음 브랜치에는 직접 Push하지 않습니다.

```text
main
dev
```

모든 변경은 원칙적으로 Pull Request를 통해 반영합니다.

긴급 복구 등 예외 상황에서는 팀 내 합의 후 진행합니다.

---

## 12. Sensitive Information

다음 정보는 Repository에 Commit하지 않습니다.

- API Key
- Access Token
- Password
- 실제 DB Credential
- Secret Key
- 개인 `.env`

공유가 필요한 환경변수의 이름과 예시는 `.env.example`을 통해 관리합니다.

---

## 13. AI Coding Agent

Claude Code 등 AI Coding Agent를 사용하는 경우에도 동일한 Git Workflow를 따릅니다.

- 작업 전 Issue와 범위를 확인합니다.
- 현재 Branch를 확인합니다.
- `main` / `dev`에서 직접 작업하지 않습니다.
- 기존 팀원의 변경사항을 임의로 삭제하거나 되돌리지 않습니다.
- 관계없는 파일을 수정하거나 Stage하지 않습니다.
- 실제 변경사항 및 Test 결과를 기준으로 Commit / PR을 작성합니다.
- 명시적 승인 없이 Force Push 등 위험한 Git 명령을 실행하지 않습니다.

AI Agent의 세부 규칙은 `AGENTS.md` 및 `CLAUDE.md`에서 별도로 관리합니다.
