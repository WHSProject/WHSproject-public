# Policy Engine API 명세

## 책임 범위

이 문서는 Policy Engine API만 정의합니다. CI/CD Gateway의 전체 오케스트레이션과 Decision DB 저장은 이 컴포넌트의 범위가 아닙니다.

전체 흐름은 다음과 같습니다.

```text
CI/CD Gateway
  ├─ Evidence DB API에서 Evidence 조회
  ├─ Policy Engine에 Evidence 전달
  └─ 반환된 Decision을 Decision DB API에 저장

Policy Engine
  ├─ Scoring System으로 score 계산
  ├─ Policy DB API에서 활성 Policy 조회
  ├─ Evidence + score 평가
  └─ Decision 반환
```

## 기본 정보

- Base URL: `http://localhost:8000`
- 요청/응답 형식: JSON
- Policy DB URL: `POLICY_DB_URL`
- 활성 정책 조회 API: `GET {POLICY_DB_URL}/internal/v1/policies/active`

> Policy DB endpoint와 score의 상세 의미는 실제 컴포넌트 Contract 확정 전까지 MVP 가정입니다.

## API 목록

| Method | URL | 설명 |
|---|---|---|
| GET | `/health` | Policy Engine 상태 확인 |
| POST | `/internal/v1/evaluations` | Evidence와 score를 정책으로 평가 |

Policy Engine은 Decision을 저장하지 않으며 Decision 조회 API도 제공하지 않습니다.

## GET `/health`

**Response**

```json
{
  "status": "ok",
  "service": "policy-engine"
}
```

## POST `/internal/v1/evaluations`

Gateway 또는 상위 오케스트레이터가 Scan 상태와 Evidence를 전달합니다. `score`가 생략되면 Policy Engine 내부 Scoring System이 Evidence 기준으로 계산합니다. `evidences`가 비어 있어도 `scanStatus`, `scanId`, `subject`로 평가할 수 있습니다. `subject.artifactHash`는 SHA-256 값이고 `subject.integrity`는 다운로드한 Tarball의 SHA-512 SRI 값입니다. MVP에서는 한 요청에 하나의 npm package/version/artifactHash/integrity/scanId 그룹만 전달합니다.

**Request**

`score`는 외부 Scoring System 결과를 전달할 때만 포함할 수 있습니다. 생략하면 Policy Engine 내부 Scoring System이 자동 계산합니다.

```json
{
  "requestId": "request-001",
  "scanStatus": "COMPLETED",
  "scanId": "scan-001",
  "subject": {
    "ecosystem": "npm",
    "packageName": "demo-package",
    "packageVersion": "1.0.0",
    "artifactHash": "sha256:demo",
    "integrity": "sha512-demo"
  },
  "score": 82.5,
  "expectedArtifactHash": "sha256:demo",
  "evidences": [
    {
      "schemaVersion": "0.1",
      "evidenceId": "evidence-001",
      "kind": "ATOMIC",
      "signal": {
        "id": "PACKAGE_METADATA",
        "type": "PACKAGE_METADATA",
        "category": "METADATA"
      },
      "subject": {
        "ecosystem": "npm",
        "packageName": "demo-package",
        "packageVersion": "1.0.0",
        "artifactHash": "sha256:demo"
      },
      "assertion": {
        "summary": "package metadata observed",
        "basis": "PATTERN_MATCH"
      },
      "sources": [
        {"analyzer": "custom-rule", "analyzerVersion": "0.1.0"}
      ],
      "provenance": {
        "scanId": "scan-001",
        "generatedBy": "EVIDENCE_NORMALIZER",
        "observedAt": "2026-08-20T00:00:00Z"
      }
    }
  ]
}
```

**Response**

```json
{
  "decisionId": "decision-001",
  "requestId": "request-001",
  "score": 82.5,
  "decision": "ACCEPT",
  "reasonCode": "NO_RULE_MATCH",
  "reason": "No policy rule matched the evaluation input.",
  "matchedRuleIds": [],
  "evidenceIds": ["evidence-001"],
  "scanId": "scan-001",
  "policyVersion": "policy-2026-08-20",
  "subject": {
    "ecosystem": "npm",
    "packageName": "demo-package",
    "packageVersion": "1.0.0",
    "artifactHash": "sha256:demo",
    "integrity": "sha512-demo"
  },
  "evaluatedAt": "2026-08-20T00:00:00Z"
}
```

## Policy DB API 계약

Policy Engine은 평가할 때마다 Policy DB API를 호출합니다. 정책은 코드에 하드코딩하지 않습니다.

`GET /internal/v1/policies/active` 응답 예시:

```json
{
  "policyKey": "npm-default",
  "policyVersion": "policy-2026-08-20",
  "ecosystem": "npm",
  "rules": [
    {
      "ruleId": "SCORE-001",
      "decision": "REVIEW",
      "reasonCode": "HIGH_RISK_SCORE",
      "reason": "The scoring system reported a high-risk score.",
      "conditions": {
        "scoreGte": 80
      }
    },
    {
      "ruleId": "CR-001",
      "decision": "REJECT",
      "reasonCode": "INSTALL_SCRIPT_REMOTE_EXECUTION",
      "reason": "An install script fetches remote content and executes a process.",
      "conditions": {
        "signalTypesAll": ["POSTINSTALL_SCRIPT", "REMOTE_FETCH", "CHILD_PROCESS"]
      }
    }
  ]
}
```

지원하는 정책 조건은 `signalTypesAny`, `signalTypesAll`, `signalTypeGroupsAll`, `limitationsAny`, `assertionBasisAny`, `expectedArtifactHashMismatch`, `minAnalyzers`, `scoreGte`, `scoreLt`입니다.

## 오류

- `422 MULTIPLE_SUBJECTS_NOT_SUPPORTED`: 하나의 평가에 여러 package subject가 포함됨
- `422 EVIDENCE_INVALID_CORRELATION`: 잘못된 `CORRELATED` Evidence
- `502 POLICY_DB_INVALID_RESPONSE`: Policy DB 응답이 계약과 다름
- `503 POLICY_DB_UNAVAILABLE`: Policy DB에 연결할 수 없음

Security Decision과 운영 오류는 분리합니다.

- `REJECT`, `HOLD`, `REVIEW`, `ACCEPT`: 정책 평가 결과
- `POLICY_DB_UNAVAILABLE`, `POLICY_DB_INVALID_RESPONSE`: 운영/API 오류
