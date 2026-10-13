# Release QA 인계 체크리스트

2026-10-13 두 차례 독립 Reviewer 결과와 후속 수정 범위는
[`independent-qa-2026-10-13.md`](independent-qa-2026-10-13.md)를 기준으로
확인한다. 새 수정 SHA의 재검증과 PM/PL GO 전까지 Public HOLD다.

대상: DevOps/QA 및 독립 Reviewer. **PRE-FREEZE / Public HOLD.** PM 의견상 공개 대상 main 예정, 혜진님·가현님 Reviewer 지정 예정. 최종 지정 및 검증 결과와 구분한다.

## Final 대상 기록

| 필드 | 현재 값 / 최종 작성 조건 |
|---|---|
| Local QA source candidate | dev 2c1d4d9 (#515 병합) + QA 브랜치 커밋/보고서; Final Freeze 미확정 |
| Final Freeze SHA | 미확정; 마지막 변경·회귀 후 확정 |
| Policy local image ID | sha256:d7e813c843d242b9391995a847c58737aa2173a27436e1e18718872a350f8194; revision label23c1fe5 (PR516 교정 문구 보완 포함) |
| Runtime default/failure | ACCEPT/HOLD |
| Runtime policy hash | cbbee46a3125674aadff6fb5c72e17433c3018214f19b64a934de943fbb0f82b |
| Reviewer PC/OS·실행시각 | Reviewer 본인 기록 |
| Reviewer 최신 결과 | `99205db`: Runtime·인증·sasl-plain Fresh ACCEPT·Tier3 Citation·Root PASS. 별도 Reviewer에서 짧은 Assessment ID의 Dashboard 표시 FAIL을 재현해 후속 수정. 악성/REVIEW/REJECT BLOCKED |

참여 가능 회신: 가현님 10/13(화) 시간 무관 및 목요일 가능, 혜진님 10/13(화) 18시 이후 가능. 사용자는 내부 QA 완료 후 리뷰를 요청하기로 결정했으므로 고정 시작 시각을 예약하지 않는다. 완료 시점에 Final SHA/이미지/가이드를 전달하고 각 Reviewer가 가능한 시간에 독립 검증한다.

## 이미지와 소스 대응 절차

배포 전 `git rev-parse HEAD`, `git status`, 관련 Runtime 소스 diff를 확인한다. 실제 Secret 설정값은 출력하지 않는다. Dockerfile에 Commit label이 없으므로 빌드 시각·SHA·소스 변경 여부·빌드 출력 image ID를 함께 기록한다. image ID 자체가 Commit SHA를 증명하지는 않는다.

```powershell
git rev-parse HEAD
git status --short
git diff -- apps/policy/src apps/policy/Dockerfile pnpm-lock.yaml
docker compose config --quiet
docker image inspect whsproject-policy:latest --format '{{.Id}}'
docker inspect whsproject-policy-1 --format '{{.Image}} {{.State.Health.Status}}'
```

로컬 image ID/manifest digest와 Registry RepoDigest는 구분한다. 현재 이미지 Push는 수행하지 않았다. 해당 Commit 소스로 빌드한 이미지 ID와 컨테이너의 `.Image`가 일치해야 한다. 전체 `docker inspect`/Compose config 출력에는 Secret이 포함될 수 있으므로 위 제한 출력만 사용한다.

승인된 Policy 배포 명령은 `docker compose build policy`, `docker compose up -d --no-deps --no-build policy`다. 기존 Decision·Volume을 보존한다. 배포는 Health·실제 defaultDecision·policyHash 및 E2E 확인까지 포함한다.

## 독립 Reviewer 실행 순서

실제 Jev 호출을 요구하는 악성 fixture QA runner에는 TYPESAFE_API_KEY가 필요하다. 빈 키일 때 운영 Scanner는 context check UNAVAILABLE로 Tier3를 계속할 수 있지만, 번들 QA 필수 조건을 통과한 것으로 처리하지 않는다. 기존 .env.example에 정의된 context check·Typesafe 변수가 Compose Scanner에도 전달되는지 확인하고 실제 키는 로컬에만 설정한다.

오래된 DB volume에는 최신 migration이 자동 적용되지 않는다. 새 volume init뿐 아니라 기존 volume의 Evidence kind/generated_by 제약에 LLM_ASSESSMENT/LLM_AGENT가 포함됐는지 확인한다. 이번 로컬 환경은 기존 migration `002_llm_assessment.sql` 누락을 발견·적용해 정상화했다. volume 삭제로 해결하지 않는다.

1. PM 지정·Final SHA·예상 판정을 전달받은 뒤 별도 PC 또는 별도 clone에서 시작한다. 같은 머신이라면 Compose 고정 container_name·host port 충돌 여부부터 검토한다. project name만 변경하면 완전히 격리된다고 가정하지 않는다.
2. 저장소 README에 따라 환경을 준비한다. 실제 Key/token은 Reviewer가 로컬에서 주입하고 문서·캡처·로그에 기록하지 않는다. 기존 운영 볼륨 삭제 금지.
3. 9서비스 Health, Gateway Scanner ON, Timeout, Verdaccio guard, 인증 없는 요청 거절을 확인한다.
4. 임시 인증 설정으로 기존 ACCEPT 재사용 E2E를 실행한다. `python tests/e2e/critical_path.py --npmrc <qa-config> --package is-number --version 7.0.0`.
5. Fresh 대상은 먼저 Decision MISS를 확인한다. 이번 로컬 yoctocolors는 이미 ACCEPT가 저장됐으므로 로컬에서 재실행하면 reusable이며 Fresh 증거로 쓰지 않는다. 기존 Decision 삭제로 Fresh를 만들지 않는다.
6. 승인된 escalation 샘플과 격리 fixture를 수령한 뒤 Tier3 4단계와 차단/실패 회귀를 수행한다. 악성 호스트 설치 및 lifecycle 실행 금지.
7. Root intent·download_events·History·Dashboard의 동일 요청을 교차 확인한다. 기본 E2E script만으로 Root/UI 검증 완료로 기록하지 않는다.
8. 관련 source regression·CI·Failure/Recovery 결과를 해당 SHA에 연결한다. 서비스 중단 테스트는 사용 중인 Runtime과 겹치지 않는 검증 시간/환경에서 수행하고 복구를 보장한다.

| Case | Expected | Reviewer Actual / 증거 |
|---|---|---|
| 인증 없음 | 인증 거절; 현재 로컬 metadata HTTP 401 | 미실행 |
| 기존 ACCEPT | tarball 전달 및 설치 성공 | 미실행 |
| Fresh 정상 미매칭 | ACCEPT/POLICY_DEFAULT, 새 저장 Decision·hash 대응 | 미실행 |
| 기존 REJECT/HOLD/REVIEW | tarball 차단 | 미실행 |
| 악성 근거 충족 | 활성 Rule·Citation에 따른 REJECT 및 차단 | 미실행 |
| 불확실·충돌·coverage 부족 | onUnknown/Resolver 기대 HOLD 또는 REVIEW; 허용 우회 없음 | 미실행 |
| Provider/Validator 실패 | failureDecision 및 오류 근거; 악성 확정과 구분 | 미실행 |
| Scanner/DB 오류·Decision 없음 | API/Scan/Decision 기록, tarball 허용 우회 없음, 복구 확인 | 미실행 |
| Tier3 | 생성·저장 / Policy 입력·수용 / Predicate 인용 / 최종 근거 각각 확인 | 미실행 |
| Root/History/UI | requestId·Decision ID·시간·사용자·outcome 교차 일치 | 내부 QA PASS 증적 제공, Reviewer 독립 재현은 미실행 |

결과는 PASS/FAIL/INCONCLUSIVE/PENDING으로 기록한다. 내부 결과 복사 금지. source+SQL의 Policy 106 PASS와 production image의 SQL fixture 부재 105 PASS/1 FAIL을 구분한다. 런타임 이미지 안의 전체 test command 성공을 현재 인수 조건으로 두려면 fixture 제공 방식에 대한 별도 합의가 필요하다.

## 공개 인계

PR516에 검증된 retry correction3줄이 실제 source로 반영됐으며 local Policy도 해당 image로 배포. code Commit23c1fe5/111회귀/해당CI PASS, 재사용 정상 설치·Health 유지. 동작 기준을 완화하지 않음. 아직 Draft·FinalFreeze 미확정, Policy 의심 근거/위험 인수·라이선스·독립 결과·PM GO는 별도. 라이선스 결정 표는 release-scope-decisions.md를 사용한다.

#515 후속: exact SHA source offline111 PASS, 실제 통합 이미지 revision 확인 및 timeout20s/최대2회 적용. 정상 sasl-x-oauth2@0.1.0이 v3/SATISFIED/ACCEPT/POLICY_PASSED/Fresh install PASS. 동일 악성 Scanner 결과의 새 QA DB Policy replay는 4 HOLD(semantic Validator 교정 실패1, timeout1, decisive UNKNOWN2), REJECT0. 설치 차단 fallback과 악성 탐지 인수는 분리한다. 이 원인/근거 인수는 미완료이며 Reviewer 체크를 내부 결과로 대신하지 않는다.

최신 인계 추가: Jev 전달 후 sasl-plain@0.1.0은 SATISFIED ACCEPT/POLICY_PASSED 및 Assessment Citation·Fresh install까지 내부 실측 PASS. 승인된 4개 격리 fixture는 Jev·Tier3 및 VERIFIED 9건·Evidence 경계 invariants PASS, 실제 QA Evidence/Policy/Decision DB에 80 Evidence·4 Decision 저장. 최종 모두 HOLD(Policy invalid judgment 3, decisive UNKNOWN 1)이며 악성 근거 REJECT 0. 별도 Gateway production 집행 함수+실제 DB probe는 4/4 허용·승인 요청 없음이지만 악성 full HTTP/tarball E2E는 미실행. 이 인수·라이선스·Final/독립 승인 Gate는 남겨 둔다.

정상 샘플 인수 추가 기준(Policy 10/12 회신): 사전 정상 검토한 package@version과 tarball integrity 고정 및 해당 버전 보안 권고 점검, 정확한 artifact Scan COMPLETED와 필수 coverage 누락 없음, 위험 신호의 문서화된 정상 기능 근거, 결정적 UNKNOWN/CONFLICT 없음, SATISFIED ACCEPT Rule 또는 no-match POLICY_DEFAULT, Fresh 실제 install 성공 및 사후 FOUND/ACCEPT·integrity 일치. 실제 설치 PASS를 위 모든 조건의 확인 완료로 확장하지 않는다. make-node의 VERIFIED Assessment는 publisher intent UNKNOWN/BIN 코드 미제공 limitation으로 정상 인수 FAIL이며, 기존 HOLD와 Decision은 보존한다.

최신 내부 증거: DB API Failure/Recovery는 별도 fixture Policy에서 PASS(운영 OpenAI 설정 유지). 최신 yoctocolors Root intent 설치와 download_events↔dependency history 동일 requestId 연결 PASS. 2026-10-13 사용자 제공 로그인된 로컬 Chrome `/requests` 화면에서 `yoctocolors@2.1.2`, 19:27 KST, ACCEPT·전달·admin 표시까지 확인해 최신 UI 교차 검증도 PASS. Reviewer는 이 내부 증거를 복사하지 않고 별도 환경에서 독립 재현한다.

DevOps/QA 결과·Reviewer 결과·데이터 재배포 범위·공개 산출물 범위가 확보되면 PM/PL에 GO/NO-GO 판단을 요청한다. 자체 라이선스는 Apache-2.0으로 확정했고 루트 LICENSE·제3자 고지·공식 출처 문안을 QA 브랜치에 반영했다. 공개 대상 main은 dev→main PR 절차를 따른다. main 병합 및 Visibility 전환은 별도 명시적 승인 후 수행한다.

# 2026-10-13 Final Gate 갱신

- Dashboard 코드 검증 SHA: `273151b47b899212f80e61a3be42f5ccf9e1d900` (이후 문서 전용 커밋은 별도)
- PR #516: Draft/Open, MERGEABLE, 현재 HEAD의 PR CI 전체 SUCCESS
- Dashboard 짧은 Assessment citation ID 보완: 구현·자동 검증 완료, 독립 Reviewer 최소 재검증 대기
- 정상 Fresh/Tier3 Citation/Gateway fail-closed: PASS
- 악성 fixture의 안정적인 REVIEW/REJECT: FAIL/BLOCKED
- Policy 의견: 공개 전 추가 보완 대신 Known Risk 수용 및 공개 후 Scanner·Policy 최적화 제안
- 남은 승인: PM/PL Known Risk 수용, 독립 Reviewer 보완 확인, Final SHA GO

새 REVIEW/REJECT 샘플을 반복 탐색하지 않는다. PM/PL이 Known Risk를 수용하면 악성 탐지
항목을 PASS로 바꾸지 않고 제한사항과 후속 개선 과제로 남긴다. 승인 전 Public HOLD다.

Dashboard 최소 재검증 후속: Reviewer는 `7a11935`와 코드 검증 SHA `273151b`의 차이가
문서 3개뿐임을 확인했고, 짧은 Assessment ID 표시는 코드 동일성 연계 PASS로 판정했다.
미인용 Assessment 제외는 실데이터 표본 부재로 독립 화면 검증 BLOCKED이나, 동일 scan의
인용·미인용 VERIFIED Assessment를 함께 구성한 targeted test는 현재 HEAD에서 7/7 PASS다.
운영 DB에 검증용 Evidence를 추가하지 않는다.
