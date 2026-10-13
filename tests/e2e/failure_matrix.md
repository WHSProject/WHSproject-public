# Failure / Recovery E2E Matrix

WHS npm Critical Path의 장애 상황을 재현하고,
Security Decision과 Runtime / Dependency Failure가 서로 혼동되지 않는지 검증한다.

## Test Principles

모든 Failure Scenario는 아래 원칙을 따른다.

1. 서비스 장애를 임의의 Security `REJECT`로 변환하지 않는다.
2. 장애 발생 시 요청이 안전하게 차단되어야 한다.
3. 장애 서비스 복구 후 전체 Runtime이 정상 상태로 돌아와야 한다.
4. 테스트 종료 시 중지한 Docker Compose Service를 반드시 복구한다.
5. 기존 QA Data 또는 Approval State에 의존하지 않도록 Scenario별 전제조건을 명확히 한다.
6. 실제 확인하지 않은 HTTP Status / Error Code는 문서에서 추측하지 않는다.
7. Gateway 외부 Contract는 실제 E2E 실행 결과를 기준으로 확정한다.

---

# F01 — Policy DB API Outage
**근거:** `tests/integration/failure_recovery.py` — Policy Health 유지, HTTP 503 `POLICY_DB_UNAVAILABLE`, Service Restart / Health Recovery, 복구 후 `ACCEPT` + Persistence 성공. 추가 Manual QA에서 동일 Artifact 기준 장애 전/후 Decision Lookup이 모두 `NOT_FOUND`임을 확인하여 장애 중 잘못된 Security Decision 미저장을 직접 검증함.

## 목적

Policy Engine은 살아 있지만 Policy DB API가 중단된 경우
Dependency Failure가 정상적으로 구분되는지 확인한다.

## 준비

```text
policy            UP
policy-db-api     UP
decision-db-api   UP
```

## 장애 주입

```bash
docker compose stop policy-db-api
```

## 현재 Integration Baseline에서 확인된 Contract

Policy 직접 Evaluation 요청 기준:

```text
HTTP 503
code = POLICY_DB_UNAVAILABLE
```

## 확인 항목

- [x] Policy Engine 자체 Health는 유지
- [x] Evaluation이 정상 ACCEPT/REJECT로 오판되지 않음
- [x] `POLICY_DB_UNAVAILABLE` 확인
- [x] 장애 중 잘못된 Security Decision 저장 없음
- [x] Policy DB API restart
- [x] Health Recovery
- [x] 복구 후 정상 Evaluation 성공

## 복구

```bash
docker compose start policy-db-api
```

---

# F02 — Decision DB API Outage
**근거:** `tests/integration/failure_recovery.py` — Policy Health 유지, Feed Persistence 단계의 HTTP 503 `FEED_PERSISTENCE_UNAVAILABLE` 또는 `FEED_PERSISTENCE_TIMEOUT`, Service Restart / Health Recovery, 복구 후 Evaluation + Persistence 정상화. 2026-10-12 별도 fixture Policy에서 `FEED_PERSISTENCE_TIMEOUT`을 실측했다.

## 목적

Policy Evaluation 결과를 Decision DB에 저장할 수 없는 경우
Dependency Failure가 정상적으로 구분되는지 확인한다.

## 장애 주입

```bash
docker compose stop decision-db-api
```

## 현재 Integration Baseline에서 확인된 Contract

Policy 직접 Evaluation 요청 기준:

```text
HTTP 503
code = FEED_PERSISTENCE_UNAVAILABLE 또는 FEED_PERSISTENCE_TIMEOUT
```

## 확인 항목

- [x] Policy Engine Health 유지
- [x] Evaluation이 정상 Security Decision으로 완료되지 않음
- [x] Feed Persistence 단계의 503 실패 확인 (10/12: `FEED_PERSISTENCE_TIMEOUT`)
- [x] 저장 실패를 ACCEPT로 처리하지 않음
- [x] Decision DB API restart
- [x] Health Recovery
- [x] 복구 후 Evaluation / Persistence 정상화

## 복구

```bash
docker compose start decision-db-api
```

---

# F03 — Scanner Outage

## 목적

Gateway에서 Decision DB MISS가 발생한 상태에서
Scanner를 호출할 수 없는 경우의 External Failure Contract를 확인한다.

## 전제조건

```text
SCANNER_ENABLED=true
Target Artifact = Decision DB MISS
```

기존 Decision이 존재하는 Artifact를 사용하면
Scanner 호출 없이 DDB 결과가 사용될 수 있으므로
새로운 Artifact 또는 명시적으로 정리된 QA Artifact를 사용한다.

## 장애 주입

```bash
docker compose stop scanner
```

## 기대 원칙

```text
Gateway
→ DDB MISS
→ Scanner 호출 실패
→ Request Fail-Safe
```

## 실제 Runtime Contract

- Gateway HTTP Status: `500`
- npm Error: `E500`
- npm install exit code: `1`
- npm Error Body: `500 Internal Server Error ... [object Object]`

## 검증 결과

- [x] Gateway가 Decision DB MISS 후 Scanner 호출을 실제 시도
- [x] Scanner 장애 시 npm install 실패 / exit code 1
- [x] Gateway 외부 응답 HTTP 500 / npm E500 확인
- [x] Scanner 장애를 Security REJECT / HOLD로 저장하지 않음
- [x] Decision DB `left-pad@1.3.0` 조회 결과 0 rows
- [x] Decision DB `left-pad@1.3.0` COUNT = 0
- [x] Verdaccio Tarball Forward 없음
- [x] Scanner restart 성공
- [x] Scanner readiness recovery 성공
- [x] 최종 Scanner healthy 확인

### QA Observation

npm 사용자-facing Error Body가 `[object Object]`로 직렬화되는 현상을 확인했다.

현재 Fail-Safe 및 Security Decision 분리 동작에는 영향이 없으므로
Critical Path Blocker가 아닌 Error Serialization 품질 이슈로 기록한다.

### F03 종료 판정

**F03 Scanner Outage — PASS**

흐름:

`DDB MISS → Scanner unavailable → Gateway 500 / npm E500 → Decision 저장 없음 → Verdaccio Tarball 전달 없음 → Scanner Recovery`

## 복구

```bash
docker compose start scanner
```

---

# F04 — Policy Engine Outage

## 목적

Scanner 분석 완료 후 Policy Evaluation Service를 사용할 수 없는 경우
Scanner / Gateway가 어떻게 Failure를 전달하는지 확인한다.

## 장애 주입

```bash
docker compose stop policy
```

## 기대 원칙

```text
Scanner
→ Policy 호출 실패
→ Security Decision 생성 실패
→ Gateway Fail-Safe
```

## Scanner → Policy Runtime Contract

- Scanner HTTP Status: `500`
- Scanner Response: `Internal Server Error`
- Scanner Request Exit Code: `1`
- Decision DB 저장: `0건`
- Policy Recovery: 성공

## Boundary 검증 결과

- [x] Scanner → Policy 호출 실패 확인
- [x] Policy 장애 시 Scanner HTTP 500 확인
- [x] 임의 ACCEPT 생성 없음
- [x] 임의 Security REJECT / HOLD 생성 없음
- [x] Decision DB `left-pad@1.3.0` COUNT = 0
- [x] Policy restart 성공
- [x] Policy Health Recovery 성공

### F04-A 종료 판정

**F04-A Scanner → Policy Boundary — PASS**

흐름:

`Scanner → Policy unavailable → Scanner HTTP 500 → Decision 저장 없음 → Policy Recovery`

### F04-B Gateway Full Path 검증 결과

- [x] 실제 npm Client → Gateway 경로 사용
- [x] Decision DB MISS 상태에서 Scanner 진입
- [x] Policy Engine unavailable 상태 재현
- [x] npm install 실패 / exit code 1
- [x] Gateway HTTP 500 / npm E500 확인
- [x] Decision DB Before = 0
- [x] Decision DB After = 0
- [x] 임의 ACCEPT / REJECT / HOLD 저장 없음
- [x] Verdaccio Tarball Forward 없음
- [x] Policy restart 성공
- [x] Policy Health Recovery 성공
- [x] Gateway / Scanner 정상 유지

### F04 종료 판정

**F04 Policy Engine Outage — PASS**

확정 흐름:

`Gateway → DDB MISS → Scanner → Policy unavailable → Operational Failure → Decision 저장 없음 → Verdaccio 전달 없음 → npm install 실패 → Policy Recovery`

### QA Observation

Scanner 장애 테스트와 동일하게 npm 사용자-facing 오류가
`[object Object]` 형태로 노출된다.

Fail-Safe 동작에는 영향이 없으므로 Error Serialization 품질 이슈로 별도 관리한다.

## 복구

```bash
docker compose start policy
```

---

# F05 — Verdaccio Outage

## 목적

Security Decision이 ACCEPT이더라도
Registry Backend 자체를 사용할 수 없는 경우
Gateway가 안전하게 실패하는지 확인한다.

## 전제조건

```text
Decision = ACCEPT
```

## 장애 주입

```bash
docker compose stop verdaccio
```

## 기대 원칙

```text
ACCEPT
→ Verdaccio Approval / Forward 시도
→ Registry unavailable
→ npm install 실패
```

Security Decision 자체는 ACCEPT일 수 있지만,
Artifact가 실제로 전달되지 않았으므로
전체 npm install은 성공해서는 안 된다.

## Runtime 검증 결과

Release QA에서 Verdaccio를 실제 중단한 상태로
`is-number@7.0.0` 설치를 재시도했다.

```text
npm Error = E500
npm Exit  = 1
Decision  = ACCEPT 유지
```

Verdaccio 중단 중 npm install은 성공하지 않았으며,
기존 Security Decision은 `ACCEPT` 상태로 유지되었다.

Verdaccio 재기동 후 Health가 `healthy`로 회복되었고,
동일 Artifact에 대한 Full Critical Path가 다시 PASS했다.

## 확인 항목

- [x] 기존 ACCEPT Decision 유지
- [x] Registry 장애와 Security REJECT가 구분됨
- [x] npm install 성공하지 않음
- [x] Verdaccio restart
- [x] Health Recovery
- [x] 필요 시 Approval 재등록
- [x] 복구 후 Tarball 정상 전달

## 복구

```bash
docker compose start verdaccio
```

---

# F06 — Unapproved Tarball Direct Access
**근거:** `infra/verdaccio/scripts/smoke.sh` — Guard 활성 상태에서 Approval 전 Metadata 200, 미승인 Version/Tarball 403, Approval 200 `REGISTERED`, Approval 후 Tarball 200 + integrity 일치.

## 목적

Verdaccio Guard가 활성화된 상태에서
Gateway Approval을 거치지 않은 Tarball을 직접 요청하면
차단되는지 확인한다.

## 전제조건

```text
guard_enabled=true
Target Version = 미승인 상태
```

## 기대 결과

```text
Metadata Request = 허용 가능
Tarball Request  = 차단
```

기존 Verdaccio Smoke에서 미승인 Tarball은
HTTP `403`으로 차단되는 것을 확인했다.

## 확인 항목

- [x] Metadata 요청과 Tarball Enforcement 분리
- [x] 미승인 Tarball HTTP 403
- [x] Approval 등록 전 Tarball 전달 없음
- [x] Approval 후 정상 Tarball 전달

---

# F07 — Invalid / Missing Integrity
**근거:** `apps/gateway/test/registry-forwarding.spec.ts` — Missing integrity 시 HTTP 400 `INVALID_REQUEST`, DDB Lookup/Scanner/Approval/Verdaccio Forward 모두 0 calls.

## 목적

Artifact Integrity가 없거나 유효하지 않은 경우
Gateway Critical Path 진입 전에 Fail-Fast 되는지 확인한다.

## 확정 Contract

Missing / Empty Integrity:

```text
HTTP 400
INVALID_REQUEST
```

## 기대 흐름

```text
npm / Raw Input
→ integrity 없음
→ Gateway Fail-Fast
→ DDB 호출 X
→ Scanner 호출 X
→ Policy 호출 X
→ Verdaccio Approval X
→ Tarball Forward X
```

## 확인 항목

- [x] HTTP 400
- [x] `INVALID_REQUEST`
- [x] Scanner 호출 없음
- [x] Security Decision 생성 경로 진입 없음 (DDB Lookup / Scanner 0 calls)
- [x] Verdaccio Approval 없음

---

# F08 — Verdaccio Restart / Approval Memory Reset

## 목적

Verdaccio Approval State가 Process Local Memory인 조건에서
Verdaccio restart 후 Gateway가 필요한 Approval을 다시 등록하는지 확인한다.

## 전제조건

최초 요청에서:

```text
Decision DB = ACCEPT
Verdaccio Approval = REGISTERED
Tarball = 정상 전달
```

## 장애 / 상태 초기화

```bash
docker compose restart verdaccio
```

## 알려진 Runtime 특성

```text
Approval Memory = Process Local
Verdaccio Restart → Approval Memory 초기화

Storage Volume / Cached Artifact는 유지 가능
```

## 기대 흐름

```text
npm 재요청
→ Gateway DDB ACCEPT 확인
→ Verdaccio Approval 재등록
→ Tarball 정상 전달
```

## Runtime 검증 결과

Release QA에서 Verdaccio를 실제 restart한 뒤
Health가 `starting → healthy`로 회복되는 것을 확인했다.

이후 동일 `is-number@7.0.0` 요청에서 기존 `ACCEPT`
Decision이 유지되는 상태로 Full Critical Path를 다시 실행했다.

Verdaccio Runtime 로그에서 Approval 재등록과
Tarball 정상 전달을 직접 확인했다.

```text
POST /-/whs/approvals = HTTP 200
approval list registered
GET /is-number/-/is-number-7.0.0.tgz = HTTP 200
Full Critical Path = PASS
```

## 확인 항목

- [x] Restart 후 Verdaccio Health Recovery
- [x] 기존 Decision DB ACCEPT 유지
- [x] Gateway가 Decision을 재조회
- [x] Approval 재등록
- [x] Tarball 정상 응답
- [x] npm install 성공

---

# F09 — Existing HOLD / REJECT / REVIEW Decision

**근거:** Gateway Decision Handler 단위 테스트에서 FOUND + REJECT/HOLD/REVIEW 모두 차단되고 Scanner Request가 생성되지 않으며, 차단 사유가 원래 Decision 값으로 유지됨을 확인했다. Registry Forwarding 테스트에서는 세 상태 모두 HTTP 403이며 Verdaccio Approval 및 Tarball Forward가 발생하지 않음을 확인했다.

## 목적

Decision DB에 이미 Non-ACCEPT 상태가 존재하는 Artifact가
Scanner 재분석 또는 Verdaccio 전달 없이 차단되는지 확인한다.

## 대상 상태

```text
REJECT
HOLD
REVIEW
```

## 기대 원칙

```text
Gateway
→ DDB FOUND
→ Decision != ACCEPT
→ 차단
→ Scanner 호출 X
→ Verdaccio Approval X
→ Tarball Forward X
```

## 확인 항목

- [x] REJECT 차단
- [x] HOLD 차단
- [x] REVIEW 차단
- [x] 각 상태가 임의로 다른 Decision으로 변환되지 않음
- [x] Verdaccio까지 전달되지 않음

---

# Recovery Gate

각 Scenario 종료 후 반드시 아래를 확인한다.

```bash
docker compose ps
```

최종적으로 필요한 Service가 모두 Running이어야 한다.

Healthcheck 대상은 모두 `healthy` 상태여야 한다.

## Final Failure / Recovery PASS Criteria

- [x] F01 Policy DB Outage
- [x] F02 Decision DB Outage
- [x] F03 Scanner Outage
- [x] F04 Policy Outage
- [x] F05 Verdaccio Outage
- [x] F06 Unapproved Tarball
- [x] F07 Invalid / Missing Integrity
- [x] F08 Verdaccio Restart / Approval Re-registration
- [x] F09 Non-ACCEPT Existing Decision
- [x] 장애 종료 후 전체 Compose Recovery
- [x] Runtime Failure와 Security Decision이 명확히 구분됨
