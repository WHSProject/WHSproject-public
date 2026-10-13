# Dashboard Policy·Package 계약 반영 및 검증 보고서

작성일: 2026-10-02
작업 브랜치: `feat/448-dashboard-contract-implementation`
기준: 최신 `origin/dev`에서 분기한 작업 worktree

## 목적

Dashboard의 Package·Overview 화면과 Policy의 Rule·Version 화면이 실제 Decision DB, Evidence API, Policy DB API를 통해 연결될 수 있도록 화면과 서비스 간 데이터 계약을 구현하는 것이 이번 작업의 목적입니다. 여러 패키지를 한 요청에서 판정할 때 결과가 누락되거나, 서로 다른 화면에서 정책 버전과 Rule 정보를 일관되게 조회하지 못하는 문제를 줄이고, 정책 변경 이력과 사용자 정보를 추적할 수 있도록 연동 방식을 정리했습니다. 구현 과정에서 미확정 질문으로 남아 있던 정책 key와 근거 표시 순서도 명시적인 계약 결정으로 남겼습니다.

## 현황

Decision ID는 요청 단위 대신 패키지별 scan을 식별하도록 `dec_{scanId}` 형식으로 변경했습니다. 이미 사용 중인 ID가 다른 요청·scan·패키지·artifact를 가리키면 성공 처리하지 않고 `409 DECISION_ID_CONFLICT`를 반환합니다. Decision DB에는 Package의 최신 판정 목록, 패키지 버전 이력, 기간별 판정 요약 API를 추가했고, Dashboard의 Package·Overview는 Decision DB와 Evidence API에서 데이터를 읽도록 연결했습니다. 연결이나 응답에 문제가 있으면 화면에서 오류 상태를 안내합니다.

Rule 화면은 Policy에 등록된 predicate 목록을 독립 endpoint에서 읽고, 적용할 때 새 정책 버전 생성과 활성화를 하나의 요청으로 처리합니다. Policy 쪽에서는 낡은 내부 버전이나 DRAFT의 활성화를 차단하고, 판정 사유에 Rule 이름을 저장하도록 반영했습니다. Policy 버전 기록에는 Dashboard 사용자 UUID를 선택적으로 저장하며 Version 화면은 UUID가 있으면 현재 계정 이름을 보여 주고, 기존 UUID 없는 기록은 저장 당시 username으로 표시합니다.

확인 질문에 대해서는 같은 정책의 이름·Rule·버전이 바뀌어도 `policyKey`를 유지하고, 별도 정책을 만들 때 새 key를 발급하기로 결정했습니다. Decision에 저장된 `policyKey`와 `policyVersion`을 통해 과거 판정이 참조한 정책 버전을 보존하기 위해서입니다. `evidenceIds`는 판정을 결정한 Rule의 우선순위와 조건 순서를 따라 대표 근거가 먼저 오도록 했습니다. 이 계약 결정과 API 변경 내용은 Package·Overview 및 Rule·Version 문서에 반영했습니다.

## 검증 현황

| 범위 | 실행 | 결과 |
|---|---|---|
| Dashboard 테스트 | `apps/dashboard: npm test -- --reporter=dot` | 통과: 64개 파일, 502개 테스트 |
| Dashboard 타입 검사 | `apps/dashboard: npm run typecheck` | 통과 |
| Policy TypeScript | `apps/policy: npm run build && npm test` | 통과: 95개 테스트 |
| Policy DB API | `apps/policy: python -m pytest -q` | 통과: 74개 테스트 |
| 변경 공백 검사 | `git diff --check` | 통과 |

Dashboard 테스트는 새로운 HTTP 계약에 맞춰 요청·응답 모의 데이터를 사용합니다. PostgreSQL을 포함한 실제 실행환경의 end-to-end 연동은 이번 검증에 포함되지 않았습니다.

## 주요 문서

- `apps/dashboard/docs/package-decision-contract.md`: Package·Overview 계약과 결정 사항
- `apps/dashboard/docs/policy-rule-contract.md`: Rule·Version 계약 및 구현 현황
- `apps/policy/docs/internal-db-apis.md`: Policy DB API 세부 계약

## 후속 적용 사항

새 DB는 bootstrap이 Policy migration 006을 적용합니다. 기존 DB에서 migration 005(우선순위 범위 조정)가 적용되지 않았다면 먼저 적용한 뒤 006을 적용해야 합니다. 해당 migration 적용 후 기존 DB에서도 actor UUID를 기록할 수 있습니다.
