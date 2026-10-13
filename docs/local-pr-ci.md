# Local PR CI Runner

GitHub Actions가 실행되지 않거나, PR 작성 전에 변경 범위만 빠르게 확인하고 싶을 때 사용하는 로컬 검증 도구입니다.

> 이 도구는 GitHub-hosted runner를 완전히 대체하지 않습니다. 실제 Actions가 사용 가능한 경우 최종 Merge 판단은 기존 PR CI 결과를 우선합니다.

## 목적

현재 `.github/workflows/pr-ci.yml`은 Component별 Job으로 분리되어 있습니다.

- Dashboard CI
- Gateway CI
- Scanner CI
- Policy CI
- Compose Config
- Policy / Decision DB Integration Smoke
- Component Docker Build

모든 변경에서 전체 Job을 로컬로 실행하지 않고, **변경한 Component와 실제 영향 범위에 필요한 Target만 선택해서 실행**합니다.

## 기본 사용법

프로젝트 루트에서 실행합니다.

```bash
python scripts/local-pr-ci.py gateway
```

여러 Target을 한 번에 실행할 수도 있습니다.

```bash
python scripts/local-pr-ci.py gateway compose
```

전체 Target의 실행 명령만 먼저 확인하려면:

```bash
python scripts/local-pr-ci.py all --dry-run
```

이미 의존성이 설치되어 있고 설치 시간을 줄이고 싶다면:

```bash
python scripts/local-pr-ci.py scanner --skip-install
```

실패 후에도 다른 Target을 계속 확인하려면:

```bash
python scripts/local-pr-ci.py dashboard gateway --keep-going
```

## Target

| Target | 로컬 검증 범위 |
|---|---|
| `dashboard` | npm ci → lint → typecheck → test → build |
| `gateway` | npm ci → test --runInBand → build |
| `scanner` | pnpm 준비/설치 → typecheck → test → build → Agent experiment CLI |
| `policy` | requirements 설치 → pytest |
| `compose` | Verdaccio approval plugin test → docker compose config |
| `integration` | Policy/Decision DB Runtime 기동 → Integration Smoke |
| `docker-scanner` | Scanner runtime stage build + Entrypoint/Cmd 확인 |
| `docker-gateway` | Gateway Docker build |
| `docker-dashboard` | Dashboard Docker build |
| `docker-policy` | Policy Docker build |
| `all` | 위 Target 전체 |

## 변경 유형별 권장 범위

일반 Component 내부 변경은 해당 Component Target부터 실행합니다.

예:

```bash
python scripts/local-pr-ci.py gateway
```

Dockerfile / Runtime 변경이 함께 있다면 Component + Docker Build를 실행합니다.

```bash
python scripts/local-pr-ci.py scanner docker-scanner
```

Compose / Network / Port / Environment Variable / Service Dependency / DB 연결처럼 통합 환경에 영향을 주는 변경이면 `compose`를 추가하고, 필요한 경우 `integration` 또는 기존 E2E를 별도로 실행합니다.

```bash
python scripts/local-pr-ci.py gateway compose
python scripts/local-pr-ci.py integration
```

Critical Path 전체 E2E가 필요한 변경은 기존 자동화를 사용합니다.

```bash
python tests/e2e/critical_path.py --preflight-only --npmrc "$QA_NPMRC"
python tests/e2e/critical_path.py --npmrc "$QA_NPMRC"
```

## 주의사항

### 1. Local 환경은 GitHub-hosted runner와 동일하지 않음

운영체제, 기존 Dependency, Docker Cache, 기존 DB Volume, 환경변수 차이로 결과가 달라질 수 있습니다.

로컬 PASS는 **Actions Green을 영구적으로 대체하는 증거가 아니라 Actions 미실행 기간의 임시 검증 근거**입니다.

### 2. `integration`은 현재 로컬 환경을 사용함

GitHub Actions는 독립 Compose Runtime을 만들지만, 이 도구는 사용자의 현재 `.env`와 Docker 환경을 사용합니다.

기존 개발 데이터를 보호하기 위해 `docker compose down -v` 같은 파괴적 Cleanup은 자동 수행하지 않습니다.

### 3. `--skip-install`은 CI와 완전히 동일하지 않음

GitHub Actions는 clean dependency install을 수행합니다. `--skip-install`은 빠른 반복 검증용 옵션이며, 최종 로컬 검증에서는 가능하면 기본 실행을 권장합니다.

### 4. 실제 실행한 결과만 PR에 기록

`--dry-run`은 명령만 확인하므로 Test 수행으로 기록하지 않습니다.

PR의 Test / 검증 항목에는 실제로 실행한 Target과 PASS / FAIL 결과만 작성합니다.

## GitHub Actions 복구 후

GitHub Actions가 다시 정상 동작하면 기존 PR CI를 최종 기준으로 사용합니다.

로컬 Runner는 이후에도 다음 용도로 유지할 수 있습니다.

- PR 작성 전 빠른 Component Regression
- 변경 범위에 맞는 검증 명령 통일
- CI 실패 재현 전 로컬 Pre-check
