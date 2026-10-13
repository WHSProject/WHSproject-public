# E2E Tests

실제 npm Client가 Gateway를 Registry로 사용했을 때 WHS Critical Path가 정상 동작하는지 재실행 가능한 형태로 검증합니다.

## 현재 자동화 범위

`critical_path.py`는 두 가지 모드를 제공합니다.

- Preflight: Runtime / Health / 설정 / npm Metadata를 비파괴적으로 확인합니다.
- Full Critical Path: Preflight 통과 후 실제 npm install을 실행하고 Decision DB의 사전·사후 상태를 검증합니다.

Full Mode의 검증 흐름은 다음과 같습니다.

```text
npm Client
→ Gateway
→ Decision DB Pre-Lookup
→ NOT_FOUND이면 Scanner
→ Policy Evaluation
→ Decision DB Persistence
→ Gateway Decision DB Re-Lookup
→ ACCEPT Enforcement
→ Verdaccio Approval
→ Tarball Forward
→ npm install Success
→ Decision DB Post-Lookup FOUND / ACCEPT
```

기존 Decision이 이미 `FOUND / ACCEPT`인 경우에는 기존 판정을 재검증한 뒤 Approval / Tarball / install 경로를 다시 확인합니다.

기존 Decision이 `REJECT / HOLD / REVIEW`인 경우에는 해당 Security Decision을 삭제하거나 우회하지 않고 Full Mode를 실패 처리합니다.

## 실행 전 조건

전체 Docker Compose Runtime이 실행 중이어야 하며, Gateway를 통해 npm Registry 인증이 완료된 임시 `.npmrc`가 필요합니다.

Git Bash 예시:

```bash
export QA_NPMRC=/tmp/whs-qa/.npmrc
```

평문 Credential은 이 문서나 Git에 기록하지 않습니다.

## Preflight 실행

```bash
python tests/e2e/critical_path.py \
  --preflight-only \
  --npmrc "$QA_NPMRC"
```

Preflight는 다음 항목을 검증합니다.

1. Docker / Docker Compose 실행 가능 여부
2. Compose 설정 유효성
3. 필수 9개 서비스 Running 여부
4. PostgreSQL readiness
5. Policy DB API health
6. Policy Engine health
7. Decision DB API health
8. Evidence API health
9. Scanner readiness
10. Gateway health 및 `x-request-id`
11. Gateway `SCANNER_ENABLED=true`
12. Verdaccio health 및 `guard_enabled=true`
13. Dashboard HTTP 응답
14. npm Client → Gateway Metadata 조회

성공 시 다음 메시지와 exit code `0`이 출력됩니다.

```text
[critical-path] PASS Critical Path E2E preflight
```

## Full Critical Path 실행

기본 Fixture는 현재 재실행 가능한 ACCEPT 경로가 검증된 `is-number@7.0.0`입니다.

```bash
python tests/e2e/critical_path.py \
  --npmrc "$QA_NPMRC"
```

특정 Package / Version을 검증하려면 다음처럼 지정합니다.

```bash
python tests/e2e/critical_path.py \
  --npmrc "$QA_NPMRC" \
  --package yocto-queue \
  --version 1.2.1
```

Full Mode는 다음을 자동 검증합니다.

1. npm Metadata와 `dist.integrity` 조회
2. Decision DB 사전 조회
3. 임시 Workdir 및 Fresh npm Cache 생성
4. Gateway Registry를 통한 실제 `npm install`
5. 설치 패키지 확인
6. Decision DB 사후 조회
7. 최종 `FOUND / ACCEPT` 확인

사전 조회가 `NOT_FOUND`이면 실제 Scanner → Policy → Decision DB 저장 경로가 발생해야 하며, 최종적으로 `FOUND / ACCEPT`가 아니면 테스트는 실패합니다.

사전 조회가 `FOUND / ACCEPT`이면 재사용 경로로 실행되며 Gateway가 최신 Decision을 재확인한 뒤 실제 install이 성공해야 합니다.

## 검증된 Runtime 결과

2026-08-28 기준 다음 경로를 실제 Runtime에서 확인했습니다.

- Reusable path: `is-number@7.0.0`
  - Pre-Lookup `FOUND / ACCEPT`
  - Gateway reverify
  - Verdaccio Approval HTTP 200
  - Tarball HTTP 200
  - npm install 성공
  - Post-Lookup `FOUND / ACCEPT`
- Fresh path: `yocto-queue@1.2.1`
  - Pre-Lookup `NOT_FOUND`
  - Gateway `scannerTargets=1`
  - Scanner 완료
  - Policy Evaluation HTTP 200
  - Decision DB 저장 HTTP 201
  - Gateway Decision DB 재조회
  - Verdaccio Approval HTTP 200
  - Tarball HTTP 200
  - npm install 성공
  - Post-Lookup `FOUND / ACCEPT`

## Safety

이 테스트는 기존 Security Decision을 임의 삭제하거나 변경하지 않습니다.

`REJECT / HOLD / REVIEW`가 이미 존재하는 Artifact를 Full Mode 대상으로 지정하면 해당 Decision을 존중하여 실패 처리합니다.

Fresh Path 검증이 필요하면 먼저 Decision DB 조회로 `NOT_FOUND`인 Package / Version을 선택합니다.

## Windows

Windows Python에서 npm 출력의 UTF-8 문자를 cp949로 읽다가 발생할 수 있는 `UnicodeDecodeError`를 피하기 위해 subprocess 출력은 UTF-8로 명시적으로 decode하고, 해석 불가능한 문자는 replacement 처리합니다.

## 관련 QA 자료

- `tests/e2e/critical_path.py`: Critical Path Preflight / Full 자동화
- `tests/e2e/failure_matrix.md`: Failure / Recovery 실행 근거와 결과
- Gateway `registry-forwarding.spec.ts`: Decision 4상태 및 Regression 검증

Fresh Clone / Fresh Volume Release Gate는 별도 Release 단계에서 최종 재검증합니다.
## Smoke / Failure 재실행

Critical Path 외의 Integration / Smoke / Failure 검증은 기존 자동화와 운영 스크립트를 재사용합니다.

Policy → Decision DB Integration Smoke:

```bash
python tests/integration/policy_decision_db_smoke.py
```

Policy DB / Decision DB 장애 및 복구:

```bash
python tests/integration/failure_recovery.py
```

`failure_recovery.py`는 검증 중 Dependency Service를 일시 중단하며, 테스트 종료 시 가능한 경우 자동으로 복구합니다.

Verdaccio Registry 독립 Smoke:

```bash
sh infra/verdaccio/scripts/smoke.sh
```

Verdaccio Smoke는 최초 `admin` 계정 구성이 끝난 Runtime에서 실행합니다. 계정 생성과 인증 절차는 `infra/verdaccio/README.md`를 따릅니다.

전체 Failure Matrix의 Runtime 근거와 수동 검증 항목은 다음 파일에 유지합니다.

```text
tests/e2e/failure_matrix.md
```

Release 전 권장 재실행 순서는 다음과 같습니다.

```text
Compose / Health
→ Policy + Decision DB Smoke
→ Verdaccio Smoke
→ Critical Path Preflight
→ Critical Path Full
→ Failure / Recovery
→ Regression
```

Failure / Recovery 테스트는 서비스를 의도적으로 중단하므로 발표 Demo 도중에는 실행하지 않습니다.
