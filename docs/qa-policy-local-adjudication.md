# Policy #515 — QA 직접 원인 대조

기준: Policy head `23171a32473fa8809c8e41949a68f522b45c14a6`, 운영 image `5eca57...`, 호출당20s/최대2회, 동일 Scanner 결과의 격리 replay. 검증자는 기존 결과와 source를 읽었으며 Provider 재호출·fixture 실행·기존 Decision 변경은 하지 않았다. 내부 QA 해석이며 Policy 변경 또는 PM/PL 위험 수용 승인을 대신하지 않는다.

## 최신 담당자 인수 기준 정정

사용자가 다시 전달한 21:28 기준을 이전 요약보다 우선한다. ts-form은 직접 근거로 CHILD_PROCESS_SPAWNED/EXECUTION_PATH_REACHABLE/BENIGN_ALTERNATIVE_NOT_SUPPORTED의 REJECT-CHILD-PROCESS 충족 기대, mexc는 버전·내부 ground truth와 직접 악성 근거를 확인해 REJECT 또는 근거 부족 HOLD. **nextjs는 OSV 적용 근거의 REVIEW 기대**이며 공개 advisory만으로 REJECT를 기대하지 않는다. uipath는 실제 분석에서 직접 확인한 process 실행·도달 경로가 Rule을 충족하면 REJECT 가능, 결정적 UNKNOWN이면 HOLD 허용. Predicate UNKNOWN 또는 교정 후 Citation 실패의 설치 차단 HOLD는 허용하되, 직접 Evidence가 REJECT 조건을 충족하는데 HOLD면 목표 Decision 불일치로 기록한다.

기존 네 fixture replay는 osvFeed=SKIPPED였다. 따라서 그 결과를 nextjs의 'OSV 적용 상태에서 REVIEW' 기대 검증 결과로 취급하지 않는다. active REVIEW-OSV-HIGH Rule은 OSV_ADVISORY_APPLIES 단일 Predicate이며, Feed를 실제로 평가 입력에 전달·수용하는 조건과 다른 decisive UNKNOWN의 우선순위를 따로 대조해야 한다. Rule/Feed 계약은 임의 변경하지 않는다.

## 직접 확인한 판단표

### nextjs OSV REVIEW 기대 조건 추가 검증

공식 OSV version query를 새로 조회해 MAL-2025-5938를 확보했고 #515 OsvFeed Validator에서 VALID/APPLICABLE 수용을 확인했다. risk_type 미기재는 기존 VULNERABILITY default로 처리, MISSING_SEVERITY는 보존되며 제외 사유가 아니었다. advisory를 변조하거나 REJECT 근거로 바꾸지 않았다.

기존 Scanner 결과13 Evidence와 실제 SUCCESS OSV Feed를 새 `whs-tier3-qa-osv` DB에 1회 제출(#515 image/20s). Evidence13·Decision1 저장, Policy는 20s timeout으로 HOLD/POLICY_LLM_UNAVAILABLE. 따라서 Feed 수용·fail-closed는 확인했지만 **OSV REVIEW 최종 인수는 INCONCLUSIVE**다. timeout 무재시도는 기존 규칙이며 retry/timeout을 임의 완화하지 않는다. 별도 QA 서비스 정지·증적 보존, 운영9healthy.

| 항목 | 저장 근거와 판정 대조 | QA 결론 |
|---|---|---|
| 정상 sasl-x-oauth2 | VERIFIED 인용, SUPPORTED/SATISFIED, POLICY_PASSED, Fresh install | 해당 정상 경로 PASS |
| uipathisfun semantic 오류 | 1·2차 REMOTE_CODE_FETCH=NOT_SUPPORTED인데 evidenceIds 3개씩 인용. 기존 Validator는 NOT_SUPPORTED의 positive citation을 거절 | Validator fail-closed 및 최대1회 교정 확인 PASS. LLM semantic 교정 미성공. 악성 탐지 인수 미통과 |
| mexc timeout | audit 1회 POLICY_LLM_TIMEOUT, retry 없음, 호출20s 경과 후 HOLD | timeout 처리·무재시도 PASS. 해당 run의 악성 판단은 INCONCLUSIVE. 예산을 임의 연장하거나 HOLD를 탐지 PASS로 바꾸지 않음 |
| ts-form exfil UNKNOWN | VERIFIED Assessment가 설치 hook/토큰 획득/조건부 외부 POST 관계를 기록. 원본 setup.sh 정적 읽기에서 access_token 추출 29행 및 token pipe+POST 32행 확인. Policy는 성공한 유출·실행 증거가 없다는 이유로 flow/reachability UNKNOWN | 강한 정적 관계 Evidence의 과소평가 가능성. runtime 미확인이 현재 Predicate의 필수 사실인지와 static path 근거가 충분한지 Review 필요. 악성 REJECT 인수 미통과 |
| nextjs exfil/remote eval UNKNOWN | VERIFIED Assessment가 환경정보 데이터 생성→외부 POST→응답 eval 관계를 기록. 원본 writer 정적 읽기에서 process.env22행/eval44행 확인. 호출자 미확인·복원 불완전 limitation도 있음 | 관계 근거 채택 누락과 limitation 적용 범위 검토 필요. 환경변수 접근/일반 eval을 child-process 실행으로 바꾸지 않음. 악성 REJECT 인수 미통과 |

## UNKNOWN에서 확인한 일관성 문제

현재 활성 Predicate 설명은 DATA_REACHES_EXTERNAL_SINK(외부 sink로의 데이터 도달), EXECUTION_PATH_REACHABLE(분석 경로가 해당 동작에 도달 가능), LIFECYCLE_TRIGGERED(install/lifecycle/startup hook 실행 경로)를 정의한다.

현재 Prompt는 충분한 static/CORRELATED 근거가 관계를 직접 입증하면 dynamic telemetry가 필수는 아니라고 명시한다. 그러나 ts-form Rule rationale는 실제 전송 성공/실제 실행 확인 부재를 UNKNOWN 이유로 제시했다. 같은 Assessment에는 조건부 token→POST 관계 및 호출 구조가 있다. 이는 코드 변경이나 REJECT 강제 대신, **근거의 주장 범위와 Predicate 요구 사실의 불일치 가능성**으로 기록한다. source-to-sink 경로를 읽은 것과 실제 외부 서버 수신 성공을 관측한 것은 구분한다.

nextjs는 환경 수집→POST/응답 eval의 정적 관계가 Assessment에 있으나, consumer 호출자 부재/복원 limitation을 전체 관계에 확장 적용했을 가능성이 있다. 또한 eval은 child-process spawn과 다르므로 그 Rule의 NOT_SUPPORTED를 악성 탐지 성공을 위해 임의 SUPPORTED로 변경하지 않는다.

## 기다리지 않고 QA가 할 수 있는 것 / 책임자 결정

### 직접 재현 및 보완안의 제한된 실제 교정 검증

- `reports/validation/policy-515/reproduce-semantic-error.py`로 저장된 실제 1·2차 Judgment를 메모리에서만 읽어 #515 Validator에 적용: **2/2 동일 NOT_SUPPORTED_CANNOT_CITE_POSITIVE_EVIDENCE:REMOTE_CODE_FETCH 재현**. Provider 재요청 없이 재현 가능. 원문 Prompt/응답을 로그·문서에 기록하지 않는다.
- 실제 최종 Decision에서 evidence_ids=[], assessment_ids=[] 확인. 무효 참조가 최종 근거에 들어가지 않았으며 기존 Validator를 완화할 이유가 없다.
- 보완안 `docs/policy-semantic-retry-proposal.patch`: 이 validation code일 때만 NOT_SUPPORTED의 3개 Citation 배열을 빈 배열로 교정하라고 구체적으로 안내. Predicate를 SUPPORTED/UNKNOWN으로 바꿔 Citation을 유지하지 말라고 명시한다. 최대 호출 횟수·timeout·Rule/Resolver/Validator 변경 없음. **운영 미적용 제안 patch**.
- 별도 source variant compile 및 기존 test **111/111 PASS**. 실제 fixture PolicyCase로 retry 생성 후 payload JSON 및 동적 Citation Schema가 원본과 동일함을 검증 PASS.
- 별도 QA image `sha256:43b690b12fda206a7801c7c8d68e537fbb98651d9a218ece8e8e556b9d79e414`(base #515, label qa-proposal-uncommitted)·새 project/DB에서 같은 저장 uipath Scanner input **1회 비교**. 1차는 동일 semantic 오류, 2차는 NOT_SUPPORTED 상태 유지·evidence/assessment/feed Citation 모두0, PRIMARY COMPLETED/failure 없음. Evidence21/Decision1 저장.
- 최종은 HOLD/POLICY_DECISIVE_EVIDENCE_UNKNOWN. **교정 성공 한 사례 확인**이지 악성 REJECT·탐지 인수 PASS 또는 일반적인 성공률 보증 아님. 모델 결과가 확률적이므로 이 1회 비교만으로 보완안의 인과적 효과·안정성을 확정하지 않는다.
- QA services 정지·volume/증적 보존, 운영9healthy/#515 unchanged. 추가 실행 반복 없음. 이 patch와 결과를 Policy 담당자에게 제공하면 원인 재검증 대신 코드 review/반영·인수 판단만 남는다.

- QA가 직접 완료: audit·Predicate 상태·Citation·Assessment·static source 위치·현재 registry/Prompt 대조, 실패 원인 유형 분리, 정상 설치·fail-closed 및 재시도 상한 증거 정리.
- QA가 다음에 수행: 수정 diff의 영향 검토와 새 image/hash 확인, 필요한 재현 회귀만 실행, Inspector/Reviewer가 같은 evidence를 재현할 수 있도록 전달.
- Policy 담당자 변경 소관: semantic correction Prompt/Schema/재시도 처리 또는 근거 해석 개선. QA가 합의 없이 Rule·default·timeout을 완화하지 않음.
- PM/PL 결정 소관: 알려진 악성 탐지가 미통과인 현재 상태에서 HOLD 차단만으로 공개 가능한지 위험 수용/NO-GO. 내부 QA가 대신 GO 선언하지 않음.

따라서 추가로 '원인을 검증해 달라'는 반복 질문 대신, 위 직접 대조 결과와 필요한 변경·인수 판단만 한 번에 전달한다. 현재 Public HOLD.
