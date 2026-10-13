# Policy Engine API Index

> 작성일: 2026-08-20
> 상태: TypeScript Policy runtime + Python DB adapters
> 범위: Policy Engine이 제공하는 API와 Policy DB API 외부 의존성

## 1. 근거 문서

| 문서 | 경로 |
| --- | --- |
| Policy Engine API 개요 | [`docs/api.md`](../../../docs/api.md) |
| Evaluation Contract | [`packages/contracts/policy-evaluation-v0.1.schema.json`](../../../packages/contracts/policy-evaluation-v0.1.schema.json) |
| Policy Contract | [`packages/contracts/policy-v0.1.schema.json`](../../../packages/contracts/policy-v0.1.schema.json) |
| Evidence Contract | [`packages/contracts/evidence-v0.1.schema.json`](../../../packages/contracts/evidence-v0.1.schema.json) |
| Policy Rule 기준 | [`rules.md`](../rules.md) |

## 2. Component 식별

| Component | 책임 | 제공 Interface | 호출하는 Interface |
| --- | --- | --- | --- |
| Gateway | Evidence 전달, Decision 소비 및 Decision DB 저장 | Policy Engine 평가 API 호출 | Policy Engine, Evidence DB API, Decision DB API |
| Policy Engine | Evidence Case 구성, GPT 판단 검증, Policy Rule 평가, Decision 저장 | Health, Evaluation API | Policy DB API, OpenAI, Decision DB API |
| Policy DB API | 현재 Published Policy와 Rule 반환 | 외부 API | Policy DB PostgreSQL |
| Decision DB API | 최종 Decision 저장·조회 | 별도 Component API | Decision DB PostgreSQL |

## 3. 전체 데이터 흐름

```text
Gateway
  → Evidence DB API에서 Evidence 조회
  → Policy Engine /internal/v1/evaluations
  → Policy DB API에서 active Policy 조회
  → Policy GPT predicate judgment
  → Policy Rule 평가
  → Decision DB API에 저장
  ← Decision 반환
```

Policy Engine은 Decision을 직접 저장하지 않는다.

## 4. API 목록

| API ID | 기능명 | Caller | Method | Path | 상태 |
| --- | --- | --- | --- | --- | --- |
| POL-API-001 | Policy Engine Health Check | DevOps / QA | `GET` | `/health` | `CONFIRMED_API` |
| POL-API-002 | Evidence Policy Evaluation | Gateway | `POST` | `/internal/v1/evaluations` | `CONFIRMED_API` |
| POL-API-003 | Active Policy 조회 | Policy Engine | `GET` | `{POLICY_DB_URL}/internal/v1/policies/active` | `EXTERNAL_DEPENDENCY` |
| POL-API-004 | Predicate registry 조회 | Dashboard | `GET` | `{POLICY_DB_URL}/internal/v1/predicates` | `EXTERNAL_DEPENDENCY` |
| POL-API-005 | Rule 버전 원자 적용 | Dashboard | `POST` | `{POLICY_DB_URL}/internal/v1/policies/{policyKey}/versions` | `EXTERNAL_DEPENDENCY` |
| POL-API-006 | Policy 버전 목록·상세·발행 | Dashboard | `GET/POST` | `{POLICY_DB_URL}/internal/v1/policies/{policyKey}/versions…` | `EXTERNAL_DEPENDENCY` |
| POL-API-007 | Decision 패키지 목록·이력·요약 | Dashboard | `GET` | `{DECISION_DB_URL}/internal/v1/decisions/{packages,package-versions,summary}` | `EXTERNAL_DEPENDENCY` |

## 5. 내부 호출 목록

| 호출 ID | 호출 | 방식 | 설명 |
| --- | --- | --- | --- |
| INT-CALL-001 | Policy GPT Judgment | TypeScript module | 등록된 predicate별 상태와 Evidence 참조를 반환 |
| INT-CALL-002 | Policy Rule Resolution | TypeScript module | priority, UNKNOWN, CONFLICT, effect를 결정적으로 평가 |
| INT-CALL-003 | Decision Persistence | Decision DB API | 최종 Decision과 `persistence` 상태를 저장·반환 |

## 6. 상세 명세

| API ID | 상세 문서 |
| --- | --- |
| POL-API-001 | [`details/01-health.md`](details/01-health.md) |
| POL-API-002 | [`details/02-policy-evaluation.md`](details/02-policy-evaluation.md) |
| POL-API-003 | [`details/03-policy-db-active-policy.md`](details/03-policy-db-active-policy.md) |

## 7. 현재 Open Questions

- [ ] 서비스 간 인증 Header와 인증 방식 확정
- [ ] Gateway와 Policy Engine 간 timeout 및 retry 정책 확정
- [ ] Decision 응답에 `policyKey`를 직접 포함할지 확정
- [x] 빈 Evidence 평가를 위해 `scanStatus`, `scanId`, `subject`와 `evidences`를 전달한다.
- [ ] Policy DB API의 실제 Host/Port 및 배포 Component 확정
- [ ] Policy DB API 장애 시 Gateway의 fallback 또는 재시도 정책 확정

Dashboard가 호출하는 API의 상세 계약과 DB 저장 의미는 [`internal-db-apis.md`](../internal-db-apis.md)에 정리되어 있습니다.
