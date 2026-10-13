# Agent Planning Static Filter v0.4.0

## 목적과 실행 위치

`evaluateStaticFilter(input: AgentPlanningInputV0_1)`는 현재 입력으로 입증할 수 있는
정적 신호만 평가하는 순수 함수다. 파일 읽기, 코드 추출, LLM 호출, 실행, Evidence
생성, Policy Decision 및 입력 변경을 수행하지 않는다.

Orchestrator는 Normalization 성공 후 Planning 입력을 만든 직후 필터를 한 번
평가한다. Handoff가 없는 패키지와 Tier 2 safe fallback도 동일하게 평가한다. 최종
status는 Orchestrator의 유일한 악성 선별 기준이며, 별도의 기존 Gate나 Legacy Trigger가
추가 선별하지 않는다.

## 결과 계약과 우선순위

```ts
interface StaticFilterResult {
  readonly status:
    | 'STATIC_MALICIOUS'
    | 'STATIC_INCOMPLETE'
    | 'AMBIGUOUS'
    | 'NO_ESCALATION_SIGNAL';
  readonly ruleVersion: '0.4.0';
  readonly threat: {
    readonly present: boolean;
    readonly findingRefs: readonly { analyzer: string; findingId: string }[];
  };
  readonly appliedRuleIds: readonly StaticFilterRuleId[];
  readonly reasonCodes: readonly StaticFilterReasonCode[];
  readonly findingRefs: readonly { analyzer: string; findingId: string }[];
  readonly evidenceRefs: readonly { evidenceId: string }[];
  readonly diagnostics: readonly StaticFilterRuleDiagnostic[];
}
```

최종 상태는 M 충족 → `STATIC_MALICIOUS`, M 미충족이며 threat 없음 →
`NO_ESCALATION_SIGNAL`, threat가 있고 I 적용 → `STATIC_INCOMPLETE`, threat가 있고
I가 없으면 → `AMBIGUOUS` 순서로 결정한다. M/A/I 진단은 상태와 별도로 모두 남는다.

`NO_ESCALATION_SIGNAL`은 악성 판단 기준은 충족하지 않았으며, 정적 Raw Finding에서
threat가 탐지되지 않아 추가 Agent 분석을 생략하는 상태다. 분석 완료, 정상 또는
허용 판정을 보장하지 않는다. `NO_THREAT_FINDING` reason으로 생략 근거를 구분한다.
`STATIC_MALICIOUS`는 “유효한 정적 근거가 사전에 정의한 악성 판단 기준을 충족함”을
뜻한다. 완전한 데이터 흐름 증명이나 정확도 입증, Policy 차단 결정을 뜻하지 않는다.

각 규칙 진단은 다음을 기록한다.

- 결과: `SATISFIED`, `UNVERIFIED`, `NOT_APPLICABLE`
- 조건별 `SATISFIED`, `NOT_SATISFIED`, `UNVERIFIED`
- LINKED 필요 여부·확인 상태·근거
- 확정을 막은 조건
- 실제 `analyzer + findingId` 참조 및 연결된 Evidence ID

Evidence는 `AtomicEvidenceV0_1.sources`의 `analyzer`와 `rawFindingId`가 모두
일치할 때만 Finding에 연결한다. Evidence signal을 Raw rule hit으로 사용하지 않는다.

## 조건 판정

- `HIT`: Raw Finding의 정확한 `ruleId`로 확인한다. prefix matching은
  `threat-runtime-obfuscation*`과 `metadata.lifecycle.*`에만 사용한다.
- `SAME_FILE`: 전체 경로 또는 `derivedFrom`/Restore line mapping으로 확인한 원본
  경로를 비교한다. basename은 사용하지 않는다.
- `LINKED`: M02~M05의 필수 조건이 아니다. `SAME_FILE_COMBINATION`은 전체 경로 또는
  복원 provenance가 같은 Finding 조합을 뜻하며 데이터 흐름 검증으로 기록하지 않는다.
  M01의 `DIRECT_COMMAND_MATCH`도 실행 여부를 증명하지 않는다.
- `VALID`: Finding location과 구조화된 data가 필요하다. FAILED/TIMEOUT Analyzer의
  Finding은 확정에 사용하지 않는다. derived Finding은 완전 복원, 양쪽 parse 성공,
  limitation 부재 및 MAPPED line mapping이 필요하다.

Custom Rule `relationCandidates`는 전달된 후보 상태 그대로 유지한다. 참조 ID가
실제 Finding과 일치해도 검증된 관계로 보지 않으며 derived 참조 ID를 보정하지 않는다.

## Threat 존재 판별

Tier 1, Tier 2 Obfuscation, Tier 2 derived Snapshot의 Raw Finding 전체를 확인한다.
`ruleId`가 `threat-` prefix이거나 Finding `type`이 `THREAT_INDICATOR` 또는 `THREAT`면
threat로 분류한다. analyzer 이름의 `-deobfuscated` 접미사와 Normalizer 매핑 여부는
조건이 아니다. capability, GuardDog risks/toolAssessment, severity,
relationCandidates 및 message 문자열만으로 threat를 만들지 않는다.

결과의 `threat.present`와 `threat.findingRefs`가 판별 결과를 보존한다. 소비자는 A/I
진단 존재가 아니라 최종 `status`를 향후 라우팅 기준으로 사용해야 한다. 현재 결과는
운영 라우팅은 다음과 같다.

- `STATIC_MALICIOUS`, `NO_ESCALATION_SIGNAL`: Tier 3를 생략하고 정적 Evidence로 공통 저장·Policy 흐름을 계속한다.
- `STATIC_INCOMPLETE`, `AMBIGUOUS`: 실행 설정이 허용하면 Tier 3 v0.3을 한 번 실행한다.
- `LLM_AGENT_ENABLED=false` 또는 `DISABLED`: 추가 분석 상태여도 실행하지 않는다.
- `ALWAYS`와 `RISK_BASED`: 모두 정적 필터 결과를 우회하지 않는다. 두 값은 현재 실행
  허용 모드이며 별도 악성 선별 규칙이 아니다.

`NO_ESCALATION_SIGNAL`은 정상 판정이나 분석 완료를 의미하지 않으며, Policy의
ALLOW/DENY로 직접 변환하지 않는다.

## 규칙 매핑

### 악성 확정 규칙

필수 Raw hit, VALID, 규칙별 의미 조건을 확인한다. M02~M05는 SAME_FILE 조합을
사전에 정의한 휴리스틱으로 사용하며 import/require, 전송 인자, 변수 흐름은 요구하지
않는다. 정상 용도가 실제 근거에서 확인된 경우에만 제외한다.

| 규칙 | 실제 확인 필드 | 확인 가능 | 확인 불가 및 처리 |
| --- | --- | --- | --- |
| M01 REVERSE_SHELL | Finding `ruleId/location/data.code`, Analyzer status | 매칭 문맥의 실제 reverse-shell 명령 (`DIRECT_COMMAND_MATCH`) | 실행 연결은 주장하지 않으며 이름·주석·명시적 example은 제외 |
| M02 DESTRUCTIVE_EXECUTION | 두 exact hit, 같은 원본 경로, `data.code` | 중요 경로 파괴 명령 + SAME_FILE spawn | 임시/cache/build 정리와 대상 불명 제외; 명령→spawn 연결은 미검증 |
| M03 SENSITIVE_FILE_EXFILTRATION | 세 exact hit, 같은 원본 경로, `data.code` | 민감 파일 read 호출 + SAME_FILE outbound | 경로 문자열만 존재하면 제외; 읽은 내용→전송 연결은 미검증 |
| M04 ENV_CREDENTIAL_EXFILTRATION | 두 exact hit, 같은 원본 경로, `data.code` | credential/full-env 수집 + SAME_FILE outbound | 일반 설정값과 명시적 정상 인증 header 제외; 요청 데이터 연결은 미검증 |
| M05 DNS_OR_MESSENGER_EXFILTRATION | DNS/messenger hit, 수집 hit, 같은 원본 경로 | 민감 파일/credential/full-env 수집과 SAME_FILE 유출 threat | API 출처·전송 인자 연결은 미검증; 수집 근거 없는 API 이름은 제외 |
| M06 MALICIOUS_PAYLOAD_EXECUTION | download-exec/download/spawn exact hits | 필수 조합 진단 | 독립 확정 비활성. A04 유지; 원격 payload를 읽거나 실행하지 않음 |
| M07 LIFECYCLE_MALICIOUS_EXECUTION | lifecycle hit 및 선행 M01~M05 | lifecycle 명령 범위 안의 직접 악성 명령일 때 설치 맥락 추가 | 단순 공존은 제외하며, 미충족이 선행 M 확정을 취소하지 않음 |
| M08 MALICIOUS_PROPAGATION | propagation/spawn exact hits | 필수 조합 진단 | 독립 확정 비활성. A08 유지 |

M01~M05, M06, M07/M08 순서로 진단을 구성한다. 패키지의 무관한 M hit를 payload,
lifecycle 또는 propagation의 악성 근거로 재사용하지 않는다. 민감 환경 이름은
`TOKEN`, `SECRET`, `PASSWORD/PASSWD`, `PRIVATE_KEY`, `API_KEY`, `AUTH`, `MNEMONIC`,
`SEED/SEED_PHRASE`이며 `NODE_ENV`, `DEBUG`, `CI`, `PORT`, `HOST`, `HOME`, `PATH`,
`PWD`, `SHELL`, `TERM`, `LANG`은 일반 설정으로 제외한다.

### 모호함 규칙

| 규칙 | 실제 확인 필드 | 적용 조건 및 한계 |
| --- | --- | --- |
| A01 | obfuscation prefix Finding, Restore unresolved/limitations, 경로 | 관련 경로의 복원 실패·제한이 있을 때 적용 |
| A02 | filesystem-read + network-outbound exact hits | 수집 → 전송 LINKED가 없어 적용 |
| A03 | environment-read + network-outbound exact hits | 환경 데이터 → 전송 LINKED가 없어 적용 |
| A04 | download-exec 또는 download + spawn exact hits | 다운로드 → 실행/페이로드 악성 확인이 없어 적용 |
| A05 | hook/preinstall/metadata lifecycle + behavior Findings | 호출 연결과 악성 여부가 없어 적용 |
| A06 | DNS/messenger/sysinfo/generic exfil exact hits | 전송 데이터·대상·민감성 연결이 없어 적용 |
| A07 | keylogging/screencapture/memory/cryptomining/autostart/DLL injection | 악용 또는 정상 용도 맥락이 없어 적용 |
| A08 | self-propagation exact hit | 삽입 → 배포 연결이 없어 적용 |
| A09 | 실제 `relationCandidates` | 후보는 LINKED가 아니므로 적용 |
| A10 | semantic representation conflict | 현재 입력에는 conflict assertion이 없어 평가 불가. Finding 수/룰 차이로 추론하지 않음 |

A05의 behavior 목록은 `capability-process-spawn`, `capability-network-outbound`,
`capability-network-download`, `capability-filesystem-read`,
`capability-filesystem-browser`, `threat-filesystem-read`,
`threat-runtime-environment-read`, `threat-process-download-exec`, 네 exfiltration
규칙 및 `threat-network-reverse-shell`이다.

목록 밖 `threat-*` Finding에는 `UNCLASSIFIED_THREAT_REVIEW_REQUIRED` reason을
남긴다. Metadata와 capability만 존재한다는 이유로 모호함을 만들지는 않는다.

### 입력 부족 규칙

| 규칙 | 실제 확인 필드 | 현재 처리 |
| --- | --- | --- |
| I01 | Analyzer status/errors | FAILED/TIMEOUT/PARTIAL/error이면 적용. 영향 범위가 무관함을 입증할 수 없음을 함께 기록 |
| I02 | 관련 Finding location/data | threat/capability 판단에 필요한 context가 없을 때만 적용 |
| I03 | `unmappedFindings`와 Raw Finding index | 관련 unmapped 항목에 대응 Raw Finding이 입력에 없을 때 적용 |
| I04 | 관련 경로의 unresolved/partial/limitations | 정확한 경로·provenance 대응이 있을 때 적용 |
| I05 | `budgetExceeded`와 관련 복원 미완료 | 두 조건이 함께 있을 때 적용 |
| I06 | derived Finding과 Restore line mapping | 관련 derived 근거가 원본에 MAPPED되지 않을 때 적용 |
| I07 | coverage gap 기록 | 현재 필드가 없어 평가하지 않으며 수치로 추론하지 않음 |
| I08 | coverage 정보 존재 여부 | 전체 coverage 계약이 없으므로 현재 항상 적용 |
| I09 | Adapter 전달 손실 | 입증 가능한 손실 필드가 없어 평가하지 않음. relation ID 불일치는 전달 손실이 아님 |

`selection`, Analyzer `SUCCESS`, 빈 Finding만으로 coverage 완료를 인정하지 않는다.
현재 I08 때문에 악성 확정이 없는 생산 입력은 `STATIC_INCOMPLETE`가 되며,
`AMBIGUOUS`와 `NO_ESCALATION_SIGNAL`은 현재 입력 계약만으로 최종 상태에 도달하지
않는다. 상태 결합 함수 자체는 네 상태의 우선순위를 독립적으로 지원한다.

## 검증과 남은 제약

단위 테스트는 SAME_FILE 휴리스틱과 직접 명령, 서로 다른 파일, 의미 조건 부재,
주석·예시, 정상 cache/auth 사례를 검증한다. 무관한 같은 파일 행위도 충족될 수
있다는 한계를 명시적으로 고정하며 SAME_FILE을 LINKED로 기록하지 않는다. 또한 복원·budget·Normalization
누락의 경로 관련성, safe fallback, A/I 동시 보존, invalid derived 근거, Evidence
참조, unclassified threat, deep-frozen 입력과 결정성을 검증한다.

Orchestrator 테스트는 Normalization → Planning 입력 생성 → 필터 평가 순서와 각 1회
호출을 확인한다. 이 테스트 통과는 악성 탐지 정확도를 입증하지 않는다.

데이터셋 실험에서는 규칙별 필수 hit 빈도, 판단 근거 유형, 추가 조건 차단 사유,
I08 집중도, 복원·Normalization 관련성 및 미분류 threat 분포를 우선 확인해야 한다.
향후 구조화된 연결/coverage 계약을 추가할 때는 새 필드를 추측하지 말고 별도 계약
변경과 fixture를 함께 검토해야 한다. v0.4.0의 M 기준은 v0.3.0과 같으며 binding, 재대입, alias, 전송 인자,
함수 간·파일 간 흐름을 검증하지 않는다.
