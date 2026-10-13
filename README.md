# 공공의 적

## 소개

공공의 적(Argus)은 npm 패키지의 보안 위험을 분석하고, 정책에 따라 패키지 다운로드를 허용하거나 차단하는 NPM Security Platform입니다.

Gateway를 통해 들어온 요청은 기존 판정 여부에 따라 처리되며, 신규 분석이 필요한 경우 Scanner와 Policy Engine을 거쳐 Decision을 저장하고 집행합니다.

### 주요 구성 요소

| 구성 요소 | 역할 |
|---|---|
| Gateway | npm 요청 진입점, 인증 및 Decision 집행 |
| Scanner | 패키지 정적 분석 및 보안 Evidence 생성 |
| Policy Engine | 분석 결과 기반 정책 평가 |
| PostgreSQL / API | Decision, Evidence 및 관련 데이터 관리 |
| Verdaccio | npm Registry Proxy 및 패키지 전달 |
| Dashboard | 요청·판정·로그 조회 |

> 일부 고도화 기능과 최종 E2E 검증은 진행 중입니다. 개별 기능의 검증 상태는 테스트 문서와 릴리스 QA 결과를 참고해 주세요.

## 팀원

| 이름 | 역할 |
|---|---|
| 호서빈 | PM | 
| 정환희 | Gateway | 
| 오지송 | Gateway/DevOps/QA | 
| 백소정 | Verdaccio | 
| 최희수 | Scanner |
| 김혜진 | Scanner | 
| 김한결 | Data/feeds | 
| 조가현 | Data/feeds |

## 프로젝트 구조

| 경로 | 설명 |
|---|---|
| `apps/gateway/` | npm Gateway |
| `apps/scanner/` | 패키지 분석 및 Evidence 생성 |
| `apps/policy/` | 정책 평가 및 관련 서비스 |
| `apps/dashboard/` | 웹 대시보드 |
| `infra/` | Verdaccio 및 인프라 구성 |
| `packages/` | 공통 Contract, Type, Utility |
| `tests/` | Integration 및 E2E 테스트 |
| `docs/` | 기술 문서 및 실행 가이드 |

## 브랜치 규칙

- `main`: 제출/배포용
- `dev`: 개발 통합용
- `feature/*`: 기능 개발용

예시:

```text
feature/login-page
feature/login-api
feature/user-table
```

## 작업 흐름

1. Issue 생성
2. 담당자 지정
3. `feature/*` 브랜치 생성
4. 작업 후 Pull Request 생성
5. 최소 1명 코드 리뷰
6. `dev`에 병합
7. 안정화 후 `main`에 병합

## 커밋 규칙

```text
feat: 기능 추가
fix: 버그 수정
docs: 문서 수정
style: 코드 스타일 수정
refactor: 리팩토링
test: 테스트 추가/수정
chore: 설정, 빌드, 기타 작업
```

예시:

```text
feat: 로그인 API 추가
fix: 회원가입 입력 검증 오류 수정
docs: API 명세 업데이트
```

## 실행 방법

### Scanner 난독화 통합 흐름

Scanner는 패키지 한 건을 다음 순서로 처리합니다.

```text
Registry 조회 → 다운로드·무결성 검증 → 안전 압축 해제·식별 검증
→ Tier 1(Metadata·Custom Rule·GuardDog 병렬 분석)
→ Tier 2(난독화 후보 선택 → webcrack → Babel → 복원본 재분석)
→ 파일별 Tier 1·Tier 2 Evidence 결합 → GPT 후보 선별 → 코드 Slice·Agent 요청 생성
→ Tier 1 Evidence 정규화 → Policy 평가
```

- Tier 2는 현재 Shadow 모드입니다. 상세 결과와 `agent-analysis-request`는 `ScanResult.shadowAnalyses`에 저장하지만 Policy 입력이나 최종 상태를 바꾸지 않습니다.
- 분석 대상 코드는 실행하지 않고, 복원본은 스캔 임시 디렉터리의 `derived/obfuscation/`에 생성한 뒤 기존 정리 절차로 삭제합니다.
- LLM 코드 이해 보조는 기본적으로 `OBFUSCATION_GPT_MODE=off`입니다. `shadow`로 설정한 뒤 `OBFUSCATION_LLM_PROVIDER=gpt|gemini`와 선택한 제공자의 API 키를 지정하면 후보 코드만 분석합니다. 두 모델을 동시에 호출하거나 자동 전환하지 않으며 결과는 Policy 판정에 반영하지 않습니다.
- GPT는 Responses API, Gemini는 OpenAI 호환 Chat Completions API를 사용합니다. 두 구현은 같은 프롬프트·응답 스키마·Evidence 검증기를 공유합니다. 상세 설정과 프롬프트 원칙은 [난독화 LLM 사용 및 프롬프트 설계](docs/obfuscation-llm-prompting.md)를 따릅니다.
- 요청·응답 경계와 후보 조건은 [Obfuscation Agent 분석 요청 계약](docs/obfuscation-agent-analysis-request.md)을 따릅니다.

### Fresh Clone 기준

필수 환경:

- Docker Desktop / Docker Compose
- Python 3.11+
- Node.js / npm 10.x 또는 11.x

저장소를 받은 뒤 프로젝트 루트에서 환경파일을 준비합니다.

```bash
git clone <repository-url>
cd WHSproject
cp .env.example .env
```

`.env`에서 최소한 다음 값을 로컬 환경에 맞게 설정합니다.

```text
POSTGRES_USER=WHS_project
POSTGRES_PASSWORD=<local-password>
SCANNER_ENABLED=true
VERDACCIO_PUBLIC_URL=http://localhost:3000
```

Host의 PostgreSQL 5432 포트가 이미 사용 중이면 `POSTGRES_PORT`만 다른 값으로 변경할 수 있습니다.

설정과 Compose 구성을 확인한 뒤 전체 서비스를 기동합니다.

```bash
docker compose config --quiet
docker compose up -d --build
docker compose ps
```

최초 실행 PC에서는 Verdaccio 계정을 한 번 생성해야 합니다.

Windows PowerShell:

```powershell
.\infra\verdaccio\scripts\setup-local.ps1
```

Git Bash / macOS / Linux:

```bash
sh infra/verdaccio/scripts/setup-local.sh
```

Dashboard(`http://localhost:5173/settings`)에 로그인한 뒤 **npm 토큰**을 발급합니다.
발급된 토큰은 원문이 한 번만 표시되므로 안전하게 보관하고, npm Client에 다음과 같이
설정합니다.

```bash
npm config set registry http://localhost:3000/npm/
npm config set //localhost:3000/npm/:_authToken "<발급된 토큰>"
```

기존 `npm login --auth-type=legacy` 경로는 자격증명 중계를 막기 위해 비활성화되어
`410 NPM_LOGIN_DISABLED`를 반환합니다. 실제 토큰이나 토큰이 포함된 `.npmrc`는
저장소와 로그에 남기지 마세요.

로그인 확인은 Gateway가 지원하는 Metadata 요청으로 수행합니다.

```bash
npm view is-number@7.0.0 version --registry=http://localhost:3000/npm/
```

E2E 실행 시 인증된 npm 설정 파일을 지정합니다.

Git Bash:

```bash
export QA_NPMRC="$(npm config get userconfig)"

python tests/e2e/critical_path.py --preflight-only --npmrc "$QA_NPMRC"
python tests/e2e/critical_path.py --npmrc "$QA_NPMRC"
```

세부 Integration / Failure / E2E 실행법은 다음 문서를 참고합니다.

- `tests/integration/README.md`
- `tests/e2e/README.md`
- `infra/verdaccio/README.md`
- `docs/demo-runbook.md`

## Repository Structure

```text
WHSproject/
│
├─ apps/
│  ├─ gateway/          # npm 요청 진입 및 최종 Decision 집행
│  ├─ policy/           # Policy Engine 및 Data / Feeds
│  ├─ scanner/          # 패키지 분석 및 Evidence 생성
│  └─ dashboard/        # Frontend Dashboard
│
├─ packages/
│  ├─ contracts/        # API 요청·응답, Evidence, Decision 공통 명세
│  ├─ shared-types/     # 공통 Enum 및 Type 정의
│  └─ shared-utils/     # 로깅, 오류 형식, request_id 등 공통 Utility
│
├─ infra/
│  ├─ verdaccio/        # Verdaccio Registry Proxy / Cache
│  ├─ postgres/         # PostgreSQL 관련 설정
│  └─ redis/            # Redis 관련 설정
│
├─ tests/
│  ├─ integration/      # Component 간 통합 테스트
│  ├─ e2e/              # 전체 E2E 테스트
│  └─ fixtures/         # 테스트용 데이터 및 패키지
│
├─ docs/                # 프로젝트 문서
│
├─ .github/
│  ├─ ISSUE_TEMPLATE/   # GitHub Issue Template
│  ├─ workflows/        # GitHub Actions
│  ├─ CODEOWNERS        # Component별 코드 Owner
│  └─ PULL_REQUEST_TEMPLATE.md
│
├─ compose.yaml         # 전체 Component 통합 실행 설정
├─ .env.example         # 환경변수 예시
├─ AGENTS.md            # AI Coding Agent 공통 규칙
├─ CLAUDE.md            # Claude Code 프로젝트 규칙
├─ CONTRIBUTING.md      # Contributor 협업 규칙
├─ GIT_WORKFLOW.md      # Git / Branch / PR 규칙
└─ README.md
```

### Component 코드 위치

| Component | Directory |
|---|---|
| Gateway | `apps/gateway/` |
| Policy / Data / Feeds | `apps/policy/` |
| Scanner | `apps/scanner/` |
| Dashboard | `apps/dashboard/` |
| Verdaccio | `infra/verdaccio/` |
| PostgreSQL | `infra/postgres/` |
| Redis | `infra/redis/` |
| 공통 Contract | `packages/contracts/` |
| 공통 Type | `packages/shared-types/` |
| 공통 Utility | `packages/shared-utils/` |
| 통합 / E2E Test | `tests/` |

> Verdaccio를 로컬에서 처음 실행한다면
> [`infra/verdaccio/README.md`](infra/verdaccio/README.md)의
> **처음 실행하는 사용자** 절에서 계정 생성과 npm 로그인 순서를 확인하세요.

> 각 Component 담당자는 자신의 디렉터리를 기준으로 작업합니다.  
> 다른 Component와 함께 사용하는 API / Evidence / Decision 등의 공통 명세는 `packages/contracts/`에서 관리합니다.

## 보안 및 공개 시 주의사항

- `.env`, `.npmrc`, API Key, Access Token 및 기타 인증정보를 저장소에 커밋하지 마세요.
- 테스트용 npm 설정 파일에도 인증 토큰이 포함될 수 있으므로 별도로 안전하게 관리해야 합니다.
- 의심스럽거나 악성으로 분류된 패키지는 호스트 환경에서 직접 설치하거나 lifecycle script를 실행하지 마세요.
- 실험용 분석 결과와 보안 판정은 검증 상태 및 실행 조건에 따라 달라질 수 있습니다.

## 프로젝트 출처

ARGUS는 한국인터넷진흥원(KISA)이 주관하는 화이트햇스쿨 4기 팀 프로젝트 「공공의 적」의 결과물입니다.

## 라이선스

별도 고지가 없는 ARGUS 자체 작성 코드는 [Apache License 2.0](LICENSE)에 따라 제공됩니다.

외부 자료와 제3자 소프트웨어에는 각각의 원래 라이선스가 적용됩니다. 자세한 내용은 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)를 확인하세요.
