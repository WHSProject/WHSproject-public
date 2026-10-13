# WHS Demo Runbook

최종 발표 / 데모 직전에 공공의적 NPM Security Platform의 Runtime 상태와 npm Critical Path를 빠르게 확인하기 위한 실행 순서입니다.

## 1. Runtime 확인

```bash
docker compose up -d
docker compose ps
```

필수 서비스가 모두 Running 상태이고 Healthcheck 대상은 `healthy`여야 합니다.

## 2. npm 인증 확인

Dashboard의 Settings 화면에서 발급한 npm 토큰을 npm Client에 설정합니다.

```bash
npm config set registry http://localhost:3000/npm/
npm config set //localhost:3000/npm/:_authToken "<발급된 토큰>"
npm view is-number@7.0.0 version --registry=http://localhost:3000/npm/
```

`npm login --auth-type=legacy`는 지원하지 않으며 Gateway가
`410 NPM_LOGIN_DISABLED`를 반환합니다. 실제 토큰과 토큰이 포함된 `.npmrc`는
저장소·로그·공유 증적에 포함하지 않습니다. `npm whoami`의 `/-/whoami` 경로도
현재 Gateway 외부 Registry Route에서 사용하지 않습니다.

Git Bash에서는 E2E가 사용할 npm 설정 경로를 지정합니다.

```bash
export QA_NPMRC="$(npm config get userconfig)"
```

## 3. Critical Path Preflight

```bash
python tests/e2e/critical_path.py --preflight-only --npmrc "$QA_NPMRC"
```

기대 결과:

```text
PASS Critical Path E2E preflight
```

## 4. 실제 npm Critical Path

```bash
python tests/e2e/critical_path.py --npmrc "$QA_NPMRC"
```

기본 Fixture는 `is-number@7.0.0`이며 기존 `ACCEPT` Decision을 재확인하는 반복 실행 경로입니다.

기대 결과:

```text
PASS Decision pre-lookup: FOUND/ACCEPT reusable path
PASS npm install through Gateway
PASS installed package verification
PASS Decision post-lookup: FOUND/ACCEPT
PASS full Critical Path E2E
```

Fresh Decision 경로를 별도로 보여줄 때는 기존 Decision을 삭제하지 않습니다. DDB 조회에서 `NOT_FOUND`임을 확인한 별도 Package/Version만 사용합니다.

Fresh 경로의 기대 흐름:

```text
npm Client
→ Gateway
→ Decision DB MISS
→ Scanner
→ Policy
→ Decision DB 저장
→ Gateway 재조회
→ ACCEPT
→ Verdaccio Approval
→ Tarball
→ npm install
```

## 5. Runtime 로그 확인

최근 Critical Path의 Service 연동을 확인합니다.

```bash
docker compose logs --since 5m gateway scanner policy decision-db-api verdaccio
```

확인 포인트:

- Gateway Decision DB lookup
- `scannerTargets`
- Scanner completion
- Policy evaluation
- Decision 저장 / 재조회
- Verdaccio Approval 등록
- Tarball HTTP 200

## 6. Demo 중 하지 않는 작업

발표 Demo 도중에는 다음 Failure Test를 실행하지 않습니다.

```text
tests/integration/failure_recovery.py
STEP 8 Failure Matrix 장屠 재현
docker compose down -v
Volume 삭제
기존 Decision 삭제
```

Failure / Recovery 검증은 Release QA 단계에서 별도로 수행합니다.

## 관련 문서

- `README.md` — Fresh Clone 실행
- `tests/e2e/README.md` — Critical Path / QA 재실행
- `tests/integration/README.md` — Integration / Failure 자동화
- `tests/e2e/failure_matrix.md` — Failure Matrix 근거
- `infra/verdaccio/README.md` — Registry 계정 / 운영 절차
