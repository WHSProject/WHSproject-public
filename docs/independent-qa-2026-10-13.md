# PR #516 독립 QA 후속 기록

기준 시각은 2026-10-13 KST이며 Public 상태는 HOLD다. 이 문서는 두 Reviewer가
각 지정 SHA에서 여러 차례 직접 수행한 결과와 그 결과에 따른 후속 수정 범위를 기록한다.
Reviewer의 비공개 원본 로그와 스크린샷은 공개 저장소에 포함하지 않는다.

## 추가 Reviewer 결과 — `99205db65ef2e365f03b24b356a8f8f1a414e333`

가현 Reviewer 환경에서는 Runtime, 정상 `sasl-plain@0.1.0` Fresh 설치와 Root 연결이
PASS였으나 Dashboard Assessment 표시는 FAIL이었다. Decision의 `assessmentIds`에는
`assessment-http-metadata-links`가 저장됐고, Evidence API의 단건 조회 키는
`llm:66f57983-e388-44e2-b21b-88df881aef11:assessment-http-metadata-links`였다.
짧은 ID 조회는 404, 전체 Evidence ID 조회는 VERIFIED `LLM_ASSESSMENT` 200이었으며
화면에는 “근거 1건을 찾지 못했습니다”가 표시됐다.

Policy Validator는 Assessment의 전체 `evidenceId`와 `provenance.assessmentId`를 모두
유효 Citation으로 허용하지만 기존 Dashboard는 두 식별자를 같은 조회 키로 취급했다.
Dashboard는 직접 조회가 실패한 Assessment ID에 한해 동일 artifact·scan Evidence를
조회하고, VERIFIED `LLM_ASSESSMENT`의 `provenance.assessmentId`가 실제 인용 ID와
일치할 때만 표시하도록 보완했다. 같은 scan의 미인용 Assessment는 표시하지 않는다.

검증 결과는 Dashboard 전체 68 files / 635 tests, typecheck, ESLint, production build
PASS다. Reviewer 재검증 전까지 Dashboard Gate와 Public 상태는 HOLD다.

## 두 번째 Reviewer 결과 — `99205db65ef2e365f03b24b356a8f8f1a414e333`

별도 clean checkout과 신규 Docker 네트워크·DB·npm cache에서 수행했다. 전달받은
증적 ZIP의 SHA-256은
`3DA2526D84C914AAE1ED56F67D0D1EE2B11A08913C10DD444DFFC953FA9F00E4`이며,
원본은 비공개 QA 증적으로만 보관한다. 증적 내부 manifest와 파일 해시를 대조했고
API Key·npm token·비밀번호 패턴이 포함되지 않았음을 확인했다.

| 항목 | 결과 | 확인 내용 |
| --- | --- | --- |
| Runtime | PASS | 후보 소스 변경 없이 신규 이미지 빌드, 9/9 서비스 healthy |
| 인증 | PASS | Dashboard 토큰 발급·Metadata 성공, 토큰 없음·오류는 401 |
| 정상 Fresh 설치 | PASS | `sasl-plain@0.1.0` MISS → Scan/Tier3 COMPLETED → VERIFIED Assessment 인용 → `RULE-ACCEPT-BENIGN` SATISFIED → ACCEPT/POLICY_PASSED → 실제 설치 → FOUND/ACCEPT |
| 추가 정상 표본 | FAIL | `sasl-x-oauth2@0.1.0` Scan/Tier3 COMPLETED 뒤 `POLICY_LLM_TIMEOUT`; HOLD/POLICY_LLM_UNAVAILABLE과 Gateway 403으로 fail-closed 차단 |
| Scanner 오류 후 저장 Decision | PASS | 통제된 GuardDog timeout에서 저장된 HOLD를 Gateway가 재조회해 403/BLOCKED, Root=true, 동일 Decision ID로 연결; 원래 설정 복구 |
| Dashboard | PASS | 인용 VERIFIED Assessment 표시와 Request·History·Decision 연결 확인 |
| 악성 fixture 및 REVIEW/REJECT | BLOCKED | 승인된 bundle·고정 hash·격리 runner·실행 명령·필수 임시 secret 미확보 |
| 공개 문서 인증 절차 | FAIL → 수정 | README와 runbook의 legacy `npm login`은 실제 410; Dashboard 발급 npm 토큰 방식으로 문서 교정 |

첫 정상 표본은 Assessment 생성·저장, Policy 입력·유효 Citation, Predicate 인용,
최종 Decision과 Gateway 설치까지 한 request/scan 문맥에서 독립 검증됐다. 두 번째
표본의 HOLD는 정상 설치 인수 실패이지만 허용 우회 없이 차단되는 동작은 확인됐다.
동일 표본을 반복해 ACCEPT 결과만 선택하지 않는다.

## 첫 번째 Reviewer 결과 — `328f8aaf7baae7cbf6550a4eaad6cf8d69956f01`

| 항목 | 결과 | 확인 내용 |
| --- | --- | --- |
| Runtime | PASS | 별도 clean checkout에서 신규 이미지 빌드, 9/9 서비스 healthy |
| 정상 Fresh 설치 | FAIL | `sasl-plain@0.1.0` Decision MISS 후 Scan TIMEOUT, Scanner HTTP 500, npm 설치 실패 |
| Tier3 → Policy → Decision | PASS | Agent COMPLETED, VERIFIED Assessment 1건, Policy 입력·유효 Citation·최종 Decision 참조 확인 |
| 악성 Gateway 차단 | BLOCKED | 승인 fixture 번들·해시·격리 명령과 임시 Key가 Reviewer 환경에 없어 미실행 |
| Dashboard | FAIL | package/version/Decision/Reason은 일치했으나 Root 요청과 Assessment·Scan 상태 표시가 누락됨 |

정상 표본의 최종 Decision은 `REVIEW/POLICY_DECISIVE_EVIDENCE_REVIEW`였다.
`RULE-ACCEPT-BENIGN`과 `BENIGN_ALTERNATIVE_SUPPORTED`는 각각
`SATISFIED`와 `SUPPORTED`였으나 Scan coverage에
`SCAN_STATUS_TIMEOUT/UNKNOWN`이 남아 ACCEPT 인수 기준을 충족하지 못했다.
어느 analyzer가 TIMEOUT을 발생시켰는지는 ScanHistory가 메모리 저장이고 당시
로그가 analyzer별 상태를 노출하지 않아 확정할 수 없다.

## 후속 수정

Reviewer 결과에서 코드로 확정할 수 있는 두 경로를 보완했다.

1. Gateway는 Scanner가 non-2xx를 반환해도 Decision DB를 한 번 다시 조회한다.
   분석 과정에서 이미 모든 대상의 Decision이 저장됐다면 그 Decision을 그대로
   집행한다. REVIEW/HOLD/REJECT는 403으로 차단되고 Root·Decision 문맥이
   download event에 유지된다. 하나라도 Decision이 없으면 기존 Scanner 오류를
   유지하며 임의 판정을 만들지 않는다.
2. Dashboard는 Decision의 `evidenceIds`와 `assessmentIds`를 함께 Evidence
   API에서 조회한다. Policy가 인용한 VERIFIED `LLM_ASSESSMENT`가 패키지 상세의
   판정 근거에 표시된다.

Scanner TIMEOUT 판정 기준은 보안·Policy coverage 계약이므로 이번 후속 수정에서
완화하지 않았다. Dashboard의 Scan 상태 표시는 현재 Decision API 응답에 해당
필드가 없어 별도 Contract 변경 대상으로 남긴다.

## 검증

- Gateway 전체 Jest: 24 suites, 358 tests PASS
- Gateway production build: PASS
- Dashboard 전체 Vitest: 68 files, 634 tests PASS
- Dashboard typecheck: PASS
- Dashboard ESLint: PASS
- Dashboard production build: PASS
- `git diff --check`: PASS

## 남은 Gate

- 문서 교정이 반영된 새 후보 SHA에서 변경 범위와 CI를 확인한다. Runtime 동작 변경은
  없으므로 `99205db`의 독립 Runtime·E2E 증적과 구분해 기록한다.
- 승인 fixture, 고정 archive hash, 격리 runner와 새 임시 secret을 Reviewer에게
  전달한 뒤 악성 차단을 재검증한다. 이전 대화에 노출된 Key는 재사용하지 않는다.
- Policy timeout은 fail-closed로 동작했지만 정상 표본 인수 실패로 기록한다. Provider
  안정성 개선 또는 PM/PL의 Known Risk 수용 여부를 확정한다.
- 악성 fixture·REVIEW/REJECT 경로 검증과 PM/PL GO 전까지 Public HOLD를 유지한다.

# 2026-10-13 20:47 KST Policy Known Risk 판정

Scanner 담당자는 승인된 정상·악성 샘플을 반복 실행했으나 다수 악성 fixture가
Policy timeout, 응답 검증 실패 또는 결정적 Predicate UNKNOWN으로 `HOLD`에 머문다고
회신했다. 이는 새로운 샘플 부족보다 Scanner→Policy 판정 안정성의 한계로 판단한다.
따라서 `REVIEW`/`REJECT` 결과가 나오는 샘플을 추가로 탐색하는 반복 검증은 종료한다.

Policy 담당자는 공개 전 추가 보완보다 현재 한계를 Known Risk로 수용하고,
Scanner·Policy 최적화를 공개 후 후속 개선 과제로 진행하는 방안을 제안했다.
최종 수용 권한은 PM/PL에 있으며, 승인 전까지 Public HOLD를 유지한다.

| 구분 | 최종 QA 기록 |
| --- | --- |
| 정상 Fresh 설치 및 Tier3 Assessment→Citation→Decision 연결 | PASS |
| Policy timeout·검증 실패 시 Gateway `HOLD`/403 집행 | PASS — fail-closed |
| 악성 fixture의 안정적인 `REVIEW`/`REJECT` 재현 | FAIL/BLOCKED — 탐지 정확도 Known Risk 후보 |
| 악성 fixture의 `ACCEPT` 및 설치 허용 | 관찰되지 않음 |
| Known Risk 공개 수용 | PM/PL 결정 대기 |

Known Risk가 수용되더라도 악성 탐지 항목을 PASS로 변경하지 않는다. 공개 판단에는
“Gateway 보안 차단 PASS / Policy 탐지 정확도 Known Risk 수용”을 서로 구분해 기록한다.

## 2026-10-13 23:14 KST Dashboard Reviewer 최소 재검증

Reviewer는 PR HEAD `7a11935c67503523743fa5d21db87cd06a5a3640`과 Dashboard 코드
검증 SHA `273151b47b899212f80e61a3be42f5ccf9e1d900` 사이에 문서 3개 외의
실행 코드·빌드 입력·Contract 차이가 없음을 확인했다. 짧은 Assessment ID 인용 표시는
이전 실제 화면 PASS와 코드 동일성을 연결해 PASS로 판정했다.

미인용 Assessment 제외는 보존된 실데이터에 같은 scan의 두 번째 VERIFIED Assessment가
없어 독립 실화면 검증은 BLOCKED다. 다만 Dashboard 회귀 테스트는 동일 scan 목록에
인용 Assessment와 미인용 `unrelated` VERIFIED Assessment를 함께 구성하고, 결과에 실제
인용 Assessment 1건만 포함되는지를 검증한다. 현재 HEAD에서 다음 명령을 재실행해
**1 file / 7 tests PASS**를 확인했다.

`npm test -- test/features/packages/server/packages.test.ts`

따라서 해당 항목은 **자동화 회귀 PASS / 독립 실화면 표본 부재로 BLOCKED**로 구분한다.
운영 DB에 QA용 Evidence를 인위적으로 추가하지 않는다.
