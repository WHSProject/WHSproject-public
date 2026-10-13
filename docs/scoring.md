# Scoring System

현재 Scoring System은 `apps/policy/app/scoring.py`에 구현되어 있으며 Evidence의 `signal.type`, 제한사항, Analyzer 수, 행위 조합을 기준으로 탐지 점수를 계산합니다.

```text
detection_score = Evidence 위험도 합산
score = 100 - detection_score
```

## 판정 기준

- `score >= 80`: `ACCEPT`
- `50 <= score < 80`: `REVIEW`
- `score < 50`: `REJECT`
- 명백한 악성 신호 또는 악성 행위 Chain: 점수와 관계없이 `REJECT`

같은 Signal Type의 Evidence가 여러 개 있어도 기본 위험도는 중복 합산하지 않습니다. 여러 Analyzer가 같은 Signal을 확인하면 추가 위험도를 반영합니다.
동일 Signal과 limitation의 중복도 limitation 점수에 중복 반영하지 않으며, `PARTIAL`, `FAILED`, `TIMEOUT` Scan은
Evidence 유무와 관계없이 `HOLD` 후보로 처리합니다.

Threat Feed가 `SUCCESS`이면 기존과 같이 Advisory의 가장 높은 Severity 점수를 한 번 반영합니다.
Feed가 없으면 Evidence만으로 평가합니다. Scan이 `COMPLETED`이고 Feed 상태가 `FAILED` 또는
`TIMEOUT`이면 점수 계산 전에 `HOLD` 후보를 반환하며, reasonCode는 각각 `FEED_FAILED`,
`FEED_TIMEOUT`입니다. 이 경우 기존 Scan 보류 처리처럼 detectionScore는 0, score는 100이며,
높은 점수가 `ACCEPT`를 의미하지 않습니다. Scan이 미완료이면 기존 `SCAN_*` 사유가 우선합니다.
최종 Policy 판정은 기존 우선순위(`REJECT > HOLD > REVIEW > ACCEPT`)를 따릅니다.
