# Policy Engine API Requirements

## 1. 확정된 데이터 계약

Policy Engine 평가 요청은 `PolicyEvaluationV0_1`을 따른다.

- `requestId`: Gateway가 생성한 평가 요청 식별자
- `scanStatus`: Scanner ScanResult 상태 (`COMPLETED`, `PARTIAL`, `FAILED`, `TIMEOUT`)
- `scanId`: 평가 대상 Scanner 실행 ID
- `subject`: 평가 대상 npm Package Subject. `artifactHash`는 SHA-256 hex 값이고 `integrity`는 SHA-512 SRI 값이다.
- `score`: nullable deprecated 필드. 수신할 수 있지만 Policy 판단에는 사용하지 않는다.
- `expectedArtifactHash`: 선택 필드
- `evidences`: `EvidenceV0_1[]`. 정상 스캔에서 Evidence가 없으면 빈 배열을 허용

한 평가 요청의 Evidence는 동일한 npm Package, Version, Artifact Hash를 대상으로 해야 한다.

## 2. Policy Engine의 책임

Policy Engine은 다음을 수행한다.

1. 요청 Evidence의 Subject 일관성 검증
2. Correlated Evidence의 `derivedFrom` 검증
3. Policy DB API에서 active Policy snapshot 조회
4. Policy GPT가 등록된 predicate별 근거 상태를 반환하도록 호출
5. TypeScript Resolver가 rule priority, UNKNOWN, CONFLICT, effect를 평가
6. Decision DB API에 최종 Decision 저장
7. `ACCEPT`, `REJECT`, `HOLD`, `REVIEW` 중 하나의 Decision 반환

Policy Engine은 다음을 수행하지 않는다.

- Evidence DB 직접 조회
- Gateway의 최종 CI/CD 집행
- GPT의 추천 outcome을 최종 결정으로 복사

## 3. 현재 확정된 Endpoint

| Method | Path | 성공 응답 | 주요 실패 |
| --- | --- | --- | --- |
| `GET` | `/health` | `200` | 없음 |
| `POST` | `/internal/v1/evaluations` | `200 Decision` | `422`, `502`, `503` |

## 4. 외부 의존성

Policy Engine은 다음 API를 호출한다.

```http
GET {POLICY_DB_URL}/internal/v1/policies/active
```

응답은 `policyKey`, `policyVersion`, `ecosystem`, `rules`를 포함해야 한다.

## 5. 구현 전 확정할 항목

- 서비스 간 인증 방식
- API Gateway 또는 Service Mesh 경유 여부
- 동기 평가 timeout
- Policy DB API 재시도 횟수와 backoff
- Decision 결과의 `policyKey` 반환 여부
