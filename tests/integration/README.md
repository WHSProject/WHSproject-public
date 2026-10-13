# Integration Tests

실제 Runtime Service 간 연결을 검증하는 Integration QA를 둡니다.

## Policy / Decision DB Smoke

대상:

```text
Policy DB API
  ↓ Active Published Policy
Policy Engine
  ↓ Evaluation
Decision DB API
  ↓ Save / GET / Lookup
PostgreSQL
```

검증 항목:

1. Policy / Policy DB / Decision DB Health
2. Published Policy `qa-npm-policy / 0.1.0` 조회
3. Policy Evaluation 요청
4. ACCEPT Decision 생성
5. 정상 빈 OSV Feed Snapshot/Attempt와 Decision DB 저장 완료 확인
6. 내부 UUID `id` 기준 Decision GET
7. Gateway 방식 Decision Lookup `FOUND`
8. 저장/조회된 `decisionId`, `requestId`, Policy Version 및 Package Identity 정합성 확인

## 실행 전제

Docker Compose Runtime이 실행 중이어야 합니다.

기본 URL:

- Policy: `http://localhost:8000`
- Policy DB API: `http://localhost:9000`
- Decision DB API: `http://localhost:9100`

## 실행

```bash
python tests/integration/policy_decision_db_smoke.py
```

성공 시 프로세스는 exit code `0`으로 종료됩니다.

실패 시 원인을 출력하고 exit code `1`로 종료됩니다.

## Optional Environment Variables

```text
POLICY_BASE_URL
POLICY_DB_BASE_URL
DECISION_DB_BASE_URL
SMOKE_TIMEOUT_SECONDS
EXPECTED_POLICY_KEY
EXPECTED_POLICY_VERSION
```

기본 QA Policy:

```text
qa-npm-policy / 0.1.0
```

테스트는 매 실행마다 고유한 Package / requestId / scanId를 생성하므로
이전 Smoke 실행 결과와 충돌하지 않습니다.

현재 테스트는 API를 통한 Black-box Integration 검증을 목적으로 하며
Decision DB에 생성한 QA Decision을 직접 삭제하지 않습니다.
CI에서는 독립적인 Compose Runtime에서 실행하는 것을 기준으로 합니다.

## Troubleshooting

### `ACTIVE_POLICY_NOT_FOUND`

기존 PostgreSQL volume이 QA fixture 추가 이전에 생성된 경우
`qa-npm-policy / 0.1.0` Published Policy가 존재하지 않을 수 있습니다.

다음 명령으로 repository의 QA fixture migration을 적용할 수 있습니다.

```bash
docker compose exec -T postgres sh -lc \
'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d policy_db -f /migrations/policy/002_qa_fixture.sql'
```

적용 후 Active Policy를 확인합니다.

```bash
curl -sS -w '\nHTTP_STATUS=%{http_code}\n' \
  http://localhost:9000/internal/v1/policies/active
```

정상이라면 `HTTP_STATUS=200`과 함께
`qa-npm-policy / 0.1.0` Published Policy가 조회됩니다.

새로운 독립 Compose 환경에서는 PostgreSQL 초기화 시
repository migration이 정상 적용되는 것을 기준으로 합니다.

## Failure / Recovery Scenario

Policy Engine의 주요 Dependency 장애 및 복구 동작을 Black-box 방식으로 검증합니다.

검증 대상:

```text
Policy Engine
├─ Policy DB API
└─ Decision DB API
```

검증 시나리오:

1. 정상 Runtime에서 Policy Evaluation 성공 확인
2. Policy DB API 중단
3. Policy Engine 자체 Health 유지 확인
4. Evaluation이 `503 / POLICY_DB_UNAVAILABLE`을 반환하는지 확인
5. Policy DB API 재기동 및 Health 복구 확인
6. Evaluation 재성공 확인
7. Decision DB API 중단
8. Policy Engine 자체 Health 유지 확인
9. Feed Attempt를 먼저 저장할 수 없어 Evaluation이 `503 / FEED_PERSISTENCE_UNAVAILABLE`을 반환하는지 확인
10. Decision DB API 재기동 및 Health 복구 확인
11. Evaluation 재성공 및 Decision 저장 확인

실행:

Failure / Recovery QA는 Policy LLM의 외부 Provider 상태가 아니라 Dependency 장애와 복구 Contract를 결정적으로 검증하는 테스트이므로, 로컬 실행 시 Policy를 `fixture` 모드로 재기동합니다.

```bash
POLICY_LLM_MODE=fixture \
docker compose up -d --force-recreate --no-deps policy

python tests/integration/failure_recovery.py
```

Decision DB API를 중단한 동안 Feed Persistence 요청은 transport timing에 따라 `FEED_PERSISTENCE_UNAVAILABLE` 또는 `FEED_PERSISTENCE_TIMEOUT`으로 관찰될 수 있습니다. 두 경우 모두 HTTP 503의 retryable dependency failure로 취급하며, 이후 Decision DB API 재기동과 Evaluation 재성공을 통해 복구 여부를 확인합니다.

테스트 도중 실패하더라도 중단한 Dependency Service는 가능한 경우 자동 재기동합니다.

Optional Environment Variables:

```text
POLICY_BASE_URL
POLICY_DB_BASE_URL
DECISION_DB_BASE_URL
FAILURE_RECOVERY_TIMEOUT_SECONDS
FAILURE_RECOVERY_WAIT_SECONDS
```
