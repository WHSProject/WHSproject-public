# Tier 3 근거 무결성 Validator 분리

## 결론

output 계약 0.3.0 경로의 Validator 기준을 `EVIDENCE_INTEGRITY_V1`로 명명하고, Agent가 기록한 limitation과 global missingContext의 존재 여부를 Evidence 수용 차단 조건에서 분리했다. 이 기준의 `PASSED`는 제공된 근거의 구조와 참조 무결성이 결정적 검사에 통과했다는 뜻이다. 악성 의도, flow 역할의 의미, source-to-sink 의미 연결, 실제 caller 도달성, runtime 실행 또는 전송 성공을 Scanner가 독립적으로 입증했다는 뜻이 아니다.

구형 output 0.2.0은 변경하지 않았다. 자유문장 assessment limitation 또는 응답 전체 missingContext가 있으면 종전처럼 `PARTIALLY_VERIFIED`이며 저장 응답을 새 기준으로 자동 재해석하지 않는다.

## 소비 경계 확인

| 경계 | 실제 소비 | 이번 처리 |
| --- | --- | --- |
| Artifact Output Validator | assessment별 `VERIFIED / PARTIALLY_VERIFIED / REJECTED`와 issue 생성 | 0.3에는 별도 `evidenceIntegrity.criteriaVersion/status/errors/analysisLimitations` 추가 |
| Runner | 하나라도 projected status가 VERIFIED가 아니면 run을 `PARTIAL`로 설정 | 무결성 실패/불완전만 run 상태에 반영. 구조화 한계는 source 표식 문자열로 summary에도 보존 |
| LLM Evidence Adapter | 과거에는 `status === VERIFIED`만 확인 | 0.3은 `EVIDENCE_INTEGRITY_V1/PASSED`를 명시적으로 요구. 0.2는 기존 status 기준 유지 |
| ScanResult/저장 | 생성된 LLM Evidence와 agent summary를 저장 | 외부 형식은 유지. claimScope와 구조화 객체 전체는 외부 Evidence에 없고 내부 validated result/실험 결과에만 완전 보존 |
| Scanner Policy request builder | `verificationStatus === VERIFIED`, provenance, related ID, summary 수치 검증 | 기존 계약 유지. 잘못된 항목만 격리하며 형제 Evidence 유지 |
| Policy Evidence Case | VERIFIED LLM assessment만 수용하고 limitation을 coverage에 포함 | 기존 계약 유지 |
| Policy 판단 | verified assessment를 사용할 수 있으나 predicate 수준의 직접 관계와 limitation을 다시 보도록 prompt/판정 검증이 제한 | `VERIFIED`만으로 악성 확정하거나 자동 점수를 부여하는 결정적 소비는 확인되지 않음. 다만 claimScope가 외부 계약에서 소실되는 위험은 남음 |

외부 Evidence의 `verificationStatus: VERIFIED` 이름은 기존 계약 때문에 유지된다. 의미가 조용히 섞이지 않도록 내부 Adapter는 projected label만 믿지 않고 `EVIDENCE_INTEGRITY_V1/PASSED`를 요구한다. Policy는 이 Evidence를 판단 자료로 사용할 수 있으므로, 보고서와 진단에서는 반드시 “근거 무결성 통과”로 읽어야 한다.

## 결정적 검증 범위

### 보장하는 것

- output 0.3.0의 Zod/API 구조는 Runner 진입 전에 검증된다.
- assessment ref ID 중복, `flow.trigger/source/transforms/sink/conditions`의 assessment-local ref 존재 여부를 검사한다.
- Finding 및 Atomic Evidence ID가 입력에 존재하는지 검사한다.
- slice가 registry에 존재하고 artifact, planning target, representation/lineage가 일치하는지 검사한다.
- ref 라인이 slice와 원본 파일 범위 안인지 검사한다.
- slice/content/source hash와 실제 파일 내용이 일치하는지 검사한다.
- 구조·참조 오류 assessment는 `REJECTED`; Finding/Atomic Evidence 연결이 모두 없는 assessment는 `INCOMPLETE`로 projected `PARTIALLY_VERIFIED`다.
- assessment별 오류 격리와 형제 assessment 보존을 유지한다.

### 보장하지 않는 것

- ref의 `SOURCE`, `SINK`, `TRIGGER` 역할이 실제 코드 의미와 맞는지 검사하지 않는다.
- `reachability.entry/path` 문자열을 assessment-local ref로 검증하지 않는다.
- 인용 라인이 rationale의 의미를 실제로 뒷받침하는지 검사하지 않는다.
- 정적 data flow, caller 도달성, API binding, payload 내부 행위, 악성 intent 또는 runtime 성공을 독립적으로 입증하지 않는다.

## 상태와 limitation 처리

0.3의 내부 상태는 다음과 같다.

| integrity 상태 | projected 기존 상태 | 조건 | Adapter |
| --- | --- | --- | --- |
| `PASSED` | `VERIFIED` | 결정적 issue가 없고 Finding 또는 Atomic Evidence 연결이 하나 이상 있음 | 변환 대상 |
| `INCOMPLETE` | `PARTIALLY_VERIFIED` | 구조 issue는 없지만 두 연결이 모두 없음 | 제외 |
| `REJECTED` | `REJECTED` | ref/artifact/line/source/ID 등 결정적 issue 존재 | 제외 |

assessment limitation, 적용 대상인 global missingContext, output limitation은 위 상태를 바꾸지 않는다. 내용은 삭제하거나 해소된 것으로 바꾸지 않는다.

- 내부 validated result: assessment 한계와 적용 가능한 global 항목을 `analysisLimitations`에 구조화 상태로 보존한다.
- Runner/summary: `[ASSESSMENT][KIND]`, `[GLOBAL_MISSING_CONTEXT][KIND]`, `[OUTPUT_LIMITATION][KIND]` 표식으로 보존한다.
- Evidence: assessment와 해당 assessment에 적용되는 global 항목을 기존 `limitations: string[]`에 같은 source 표식으로 전달한다.
- global `affectedAssessmentIds`가 생략된 항목은 모든 assessment에 연결한다. 명시된 목록은 계약상 비어 있을 수 없으며 존재하지 않는 assessment ID는 parser 계약 오류다.
- 외부 Evidence에는 `claimScope`, limitation 객체, `affectedAssessmentIds` 자체가 없으므로 구조는 문자열로 축약된다. 완전한 정보는 내부 결과와 실험 private replay에 남는다.

Agent가 limitation을 누락하거나 잘못 분류한 경우 Scanner가 자동 보완했다는 뜻은 아니다.

## 4조건 offline replay

저장된 0.3.0 live 응답과 frozen 입력을 수정하지 않고 새 Validator와 Adapter로 재검증했다. Provider 요청, Scanner 재실행, 패키지 실행은 없었다.

| 조건 | 이전 기준 | 이전 Evidence | 무결성 기준 | 새 Evidence | 해석상 주의 |
| --- | --- | ---: | --- | ---: | --- |
| DD-NPM-010 L2 | P 2 / R 1 | 0 | V 2 / R 1 | 2 | 세 번째 assessment의 `Unknown flow reference`는 계속 거부. payload/binding/caller 한계는 두 Evidence에 보존 |
| DD-NPM-013 L1 | P 4 | 0 | V 4 | 4 | 모두 `CODE_BEHAVIOR`; caller 부족이 사라진 것이 아니며 설치 도달성 검증 성공으로 집계하면 안 됨 |
| DD-NPM-013 L3 | P 4 | 0 | V 4 | 4 | DLL assessment의 spawn/caller 핵심 라인 미인용을 현재 결정적 검사가 잡지 못함 |
| DD-NPM-003 L4 | P 3 | 0 | V 3 | 3 | Telegram assessment의 지역 binding limitation 누락과 caller 미확인이 남음 |

합계는 assessment 14개다. 이전은 V 0 / P 13 / R 1 / Evidence 0, replay는 V 13 / P 0 / R 1 / Evidence 13이며 변환 실패는 양쪽 모두 0이다. 이 V는 과거의 limitation까지 없는 상태와 같은 지표가 아니라 `EVIDENCE_INTEGRITY_V1/PASSED`의 기존 상태명 projection이다. Evidence 증가는 탐지 정확도나 악성 패키지 차단 성능 향상을 뜻하지 않는다.

### 사람 검토가 필요한 통과 사례

1. DD-NPM-013 L3 `assessment-install-obfuscated-process-launch`: rationale은 spawn과 lifecycle 연결을 말하지만 ref가 실제 spawn 156~157줄과 top-level caller 191줄을 인용하지 않는다. line/ref 무결성은 통과하지만 의미 뒷받침은 미검증이다.
2. DD-NPM-003 L4 `assessment-index-env-telegram-exfil`: MNEMONIC을 메시지 인자로 넣는 표현은 있으나 지역 `TelegramBot` binding은 확인되지 않는다. Agent는 `BINDING_UNKNOWN`을 누락했다. PRIVATE_KEY는 실제 source로 사용하지 않았다.
3. DD-NPM-013 L1 `assessment-obfuscated-windows-command-001`: 함수 내부 표현 Evidence는 생성되지만 `CALLER_UNKNOWN`, `PAYLOAD_UNKNOWN`, `RUNTIME_UNCONFIRMED`가 그대로 남는다. 설치 진입 경로를 입증한 Evidence가 아니다.

## 소비 경계 영향과 남은 문제

- Policy 외부 schema, scoring, Decision은 변경하지 않았다. Policy는 limitation 문자열을 받지만 `claimScope` 구조는 받지 않는다.
- Policy prompt는 정적 또는 correlated Evidence가 predicate를 직접 만족할 때 runtime telemetry가 없어도 지원 가능하다고 하고, 핵심 관계가 limitation으로 남으면 UNKNOWN을 요구한다. 따라서 limitation 전달은 필수다.
- 현재 Policy가 VERIFIED를 자동 악성 확정으로 바꾸는 결정적 scoring 코드는 확인되지 않았지만, LLM 판단이 assessment 의미를 과신할 가능성은 남는다. 후속 계약 변경을 한다면 `verificationScope: EVIDENCE_INTEGRITY`와 구조화 claimScope/limitations를 Evidence·Policy까지 명시적으로 전달하는 것이 최소 안전안이다. 이번 범위에서는 외부 계약을 확장하지 않았다.
- 다음 우선순위는 limitation 키워드 판별이 아니라 인용 의미 검증이다. Jev/슬라이싱 실험에서는 (1) 주장 핵심 라인의 실제 인용, (2) caller/binding을 필요한 assessment에 공급, (3) Agent가 누락한 limitation의 수동 라벨을 별도 지표로 사용해야 한다.
- 전체 22개 확대 전에 위 세 위험 사례를 회귀 fixture로 고정하고, Policy가 integrity-only VERIFIED를 predicate 직접 근거로 과확정하지 않는 경계 테스트를 추가하는 편이 안전하다.

## 추적 경로

- replay 집계: `experiments/agent-code-volume/2026-10-04-structured-limitations-integrity-replay-v1/aggregation.json`
- replay private 상세: 같은 디렉터리의 `private/<sample>/<level>/replay-result.json`
- replay 도구: `scripts/agent-structured-limitations-integrity-replay.mjs`
- 원본 live 결과: `experiments/agent-code-volume/2026-10-04-structured-limitations-live-v1`
- frozen 입력: `experiments/agent-code-volume/2026-10-04-structured-limitations-input-v1`

원본 요청·응답·refs·limitations와 frozen 입력은 변경하지 않았다.
