# Agent Planning Input Contract v0.1.0

## 1. 목적과 현재 구현 범위

`AgentPlanningInputV0_1`은 Tier 1·Tier 2 정적 분석 결과와 전체
`NormalizationResult`를 하나의 Agent Planning 입력으로 조합하는 Scanner 내부
계약이다.

현재 입력은 순수 정적 필터의 입력으로 사용되며, Orchestrator는 최종 filter status로
Tier 3 v0.3 실행 또는 생략을 결정한다. 별도의 Planning LLM 단계는 없다.
별도의 `buildPlanningTier3ExecutionInput()`이 이 계약에서 기존
`Tier3ExecutionInput`을 만드는 원본 기반 경로를 제공하며, 추가 분석 대상으로 분류된
경우에만 Orchestrator가 호출한다.

정적 필터는 Tier 1, Tier 2 Obfuscation 및 derived Snapshot의 Raw Finding을 모두
조회해 threat 존재 여부를 계산한다. `threat-*` rule과 명시적 Finding type
`THREAT_INDICATOR`/`THREAT`만 사용하며 capability, GuardDog 평가, 관계 후보 또는
Normalizer 매핑 상태로 threat를 추정하지 않는다. 입력 계약은 변경하지 않고 계산
결과는 Static Filter 결과 계약에만 보존한다.

## 2. 입력 생성 위치와 책임

`Orchestrator.execute()`는 Evidence Normalization이 결과를 반환한 직후,
`buildTier2Handoff()`를 호출하기 전에 `buildAgentPlanningInput()`을 정확히 한 번
호출한다.

1. `EvidenceNormalizer`는 Tier 1 Findings와 검증된 Tier 2 Evidence 후보를
   Evidence로 정규화한다.
2. Adapter는 `AnalysisContext`, Tier 1 결과, `ObfuscationShadowResult`,
   `NormalizationResult`를 새 입력 계약으로 투영한다.
3. `Tier2Handoff` 유무는 Planning 입력 생성 조건이 아니다.
4. Normalizer가 throw하면 기존 Normalization 실패 경로로 반환하므로 Adapter는
   호출되지 않는다.
5. 생성된 `planningInput`으로 `evaluateStaticFilter()`를 한 번 호출한다.
6. `STATIC_INCOMPLETE`와 `AMBIGUOUS`는 실행 설정이 허용할 때 Tier 3 v0.3으로 전달하고,
   `STATIC_MALICIOUS`와 `NO_ESCALATION_SIGNAL`은 Agent를 생략한다.

Normalizer 안에서 Planning 입력을 조합하지 않으며, Adapter도 정규화나 새로운
Evidence 생성을 수행하지 않는다.

## 3. 전체 입력 계약

실제 TypeScript 계약은 다음과 같다. 새로 정의한 wrapper 필드는 읽기 전용이며,
재사용하는 `RestoreResult`와 `NormalizationResult`의 내부 타입 정의는 변경하지
않는다.

```ts
interface AgentPlanningInputV0_1 {
  readonly schemaVersion: '0.1.0';
  readonly subject: AgentPlanningSubject;
  readonly tier1: {
    readonly analyzers: readonly AgentPlanningAnalyzerSnapshot[];
  };
  readonly tier2: {
    readonly analyzer: AgentPlanningAnalyzerSnapshot;
    readonly derivedAnalyzers: readonly AgentPlanningAnalyzerSnapshot[];
    readonly restore?: RestoreResult;
    readonly selection?: AgentPlanningTier2Selection;
  };
  readonly normalization: NormalizationResult;
}

interface AgentPlanningSubject {
  readonly requestId: string;
  readonly scanId: string;
  readonly ecosystem: 'npm';
  readonly packageName: string;
  readonly packageVersion: string;
  readonly artifactHash: string;
}
```

| 영역/필드 | 타입 | 필수 | 기존 source | 의미 |
| --- | --- | --- | --- | --- |
| `schemaVersion` | `'0.1.0'` | 필수 | Adapter 상수 | Planning 입력 계약 버전 |
| `subject.requestId` | `string` | 필수 | `AnalysisContext.requestId` | 요청 식별자 |
| `subject.scanId` | `string` | 필수 | `AnalysisContext.scanId` | 스캔 식별자 |
| `subject.ecosystem` | `'npm'` | 필수 | Adapter 상수 | 현재 Scanner 생태계 |
| `subject.packageName` | `string` | 필수 | `AnalysisContext.package.name` | 검증된 패키지 이름 |
| `subject.packageVersion` | `string` | 필수 | `AnalysisContext.package.version` | 검증된 패키지 버전 |
| `subject.artifactHash` | `string` | 필수 | `AnalysisContext.artifact.hash` | 분석 artifact 해시 |
| `tier1.analyzers` | `readonly AgentPlanningAnalyzerSnapshot[]` | 필수 | Tier 1 `AnalyzerResult[]` | Metadata, Custom Rule, GuardDog 결과의 Snapshot |
| `tier2.analyzer` | `AgentPlanningAnalyzerSnapshot` | 필수 | `ObfuscationShadowResult.analyzerResult` | Tier 2 Obfuscation 분석 결과 |
| `tier2.derivedAnalyzers` | `readonly AgentPlanningAnalyzerSnapshot[]` | 필수 | `ObfuscationShadowResult.derivedAnalyzerResults` | 복원본 재분석 결과. 없으면 빈 배열 |
| `tier2.restore` | `RestoreResult` | 선택 | `ObfuscationShadowResult.restore` | 복원 파일·미복원 파일과 검증·제약·line mapping |
| `tier2.selection` | `AgentPlanningTier2Selection` | 선택 | `ObfuscationShadowResult.summary` | 관측된 대상 탐색·선정 수치. safe fallback에서는 생략 |
| `normalization` | `NormalizationResult` | 필수 | Normalizer 반환값 | 정규화 결과 전체를 동일 참조로 보존 |

`subject`에는 전체 `AnalysisContext`, registry metadata, package.json, tarball 및
extracted 경로를 넣지 않는다.

## 4. Analyzer Snapshot 계약

```ts
interface AgentPlanningAnalyzerSnapshot {
  readonly analyzer: string;
  readonly analyzerVersion: string;
  readonly status: AnalyzerStatus;
  readonly findings: readonly Finding[];
  readonly errors: readonly ScanError[];
  readonly execution?: AnalyzerExecution;
  readonly rawResultRef?: string;
  readonly guarddog?: {
    readonly risks: readonly GuardDogRawRisk[];
    readonly toolAssessment?: GuardDogToolAssessment;
  };
  readonly customRule?: {
    readonly relationCandidates: readonly CustomRuleRelationCandidate[];
  };
}
```

| 필드 | 타입 | 필수 | 기존 source | 의미 |
| --- | --- | --- | --- | --- |
| `analyzer` | `string` | 필수 | `AnalyzerResult.analyzer` | 원본 이름 또는 `*-deobfuscated` 이름을 그대로 유지 |
| `analyzerVersion` | `string` | 필수 | `AnalyzerResult.analyzerVersion` | 분석기 버전 |
| `status` | `AnalyzerStatus` | 필수 | `AnalyzerResult.status` | Analyzer 실행 상태 |
| `findings` | `readonly Finding[]` | 필수 | `AnalyzerResult.findings` | Finding 전체 참조를 보존 |
| `errors` | `readonly ScanError[]` | 필수 | `AnalyzerResult.errors` | Analyzer 오류 목록 |
| `execution` | `AnalyzerExecution` | 선택 | `AnalyzerResult.execution` | 공통 시작·완료 시각과 실행 시간. 없으면 생략 |
| `rawResultRef` | `string` | 선택 | `AnalyzerResult.rawResultRef` | Analyzer 수준 원본 결과 참조 |
| `guarddog.risks` | `readonly GuardDogRawRisk[]` | 확장 내부 필수 | `GuardDogAnalyzerResult.guarddog.risks` | GuardDog 위험 정보 |
| `guarddog.toolAssessment` | `GuardDogToolAssessment` | 선택 | `GuardDogAnalyzerResult.guarddog.toolAssessment` | GuardDog 도구 평가 |
| `customRule.relationCandidates` | `readonly CustomRuleRelationCandidate[]` | 확장 내부 필수 | `CustomRuleAnalyzerResult.relationCandidates` | 검증 전 정적 관계 후보 |

Adapter는 Finding 객체 전체를 유지하므로 `location`, `data`, Finding 수준
`rawResultRef`와 `data` 안의 매칭 코드·맥락도 보존된다. Metadata lifecycle 정보도
별도 wrapper 없이 기존 Finding의 location과 data에 남는다.

분석기별 확장은 Analyzer 이름과 런타임 구조를 함께 검사한다. 따라서:

- 실제 `risks: []` 또는 `relationCandidates: []`는 “실행 결과 후보 없음”으로
  그대로 보존한다.
- 확장 정보가 존재하지 않거나 구조가 유효하지 않으면 `guarddog` 또는
  `customRule` wrapper 자체를 생략한다.
- 이름만 `*-deobfuscated`인 generic derived failure에는 빈 확장 객체를 만들지
  않는다.
- GuardDog nested process execution과 Custom Rule Analyzer 수준 `rawResult`의
  stdout/stderr는 포함하지 않는다.

Custom Rule 관계는 `status: 'CANDIDATE'`인 정적 후보이며 검증된 연결 또는 확정
Evidence가 아니다. Adapter는 `sourceFindingIds`와 `sinkFindingIds`를 그대로
보존하고, derived Finding ID와 일치하지 않더라도 임의로 보정하거나 LINKED
관계로 승격하지 않는다.

## 5. Tier 2 복원 및 Selection 계약

`tier2.restore`는 기존 `RestoreResult`를 그대로 참조한다. 이를 통해 다음 정보가
보존된다.

- `outputRoot`
- `restored`: `RESTORED`와 `PARTIAL_RESTORED`, validation, limitations,
  stage results, payload, line mapping
- `unresolved`: `UNRESOLVED`, `SKIPPED`, `FAILED` 상태와 reason, limitations
- `durationMs`, `budgetExceeded`, optional capability preservation

Selection 계약은 다음 두 수치만 가진다.

```ts
interface AgentPlanningTier2Selection {
  /** 탐색 과정에서 수집된 JS 계열 파일 수 */
  readonly scannedFiles: number;
  /** 복원 대상으로 선정된 파일 수 */
  readonly selectedFiles: number;
}
```

| 필드 | source | 정확한 의미 |
| --- | --- | --- |
| `scannedFiles` | `ObfuscationShadowResult.summary.scannedFiles` | 파일 탐색 중 수집된 JS 계열 파일 수. 분석 완료 수나 전체 eligible 파일 수가 아님 |
| `selectedFiles` | `ObfuscationShadowResult.summary.selectedFiles` | 복원 대상으로 선정된 파일 수 |

정상 Tier 2 실행에서 복원 대상이 없으면 `selection`은 존재하고 실제
`{ scannedFiles: 0, selectedFiles: 0 }`을 보존한다.

현재 safe fallback 식별 조건은 다음 구현에 의존한다.

```ts
tier2Result.analyzerResult.status === 'FAILED'
  && tier2Result.restore === undefined
```

이 경우 summary의 기본값 0은 관측값이 아니므로 `selection`을 생략한다.

현재 계약에는 `scanLimitHit`, skipped 목록, 제외 경로·사유, verdict, target 목록이
없으며 Adapter가 상태와 unresolved 수로 `scanLimitHit`을 역추론하지도 않는다.
따라서 `selection`이 존재하거나 Analyzer 상태가 `SUCCESS`라는 사실만으로 분석
범위가 충분하거나 완전하다고 판단할 수 없다.

## 6. Normalization 계약

Adapter는 `NormalizationResult` 전체를 `normalization`에 한 번만 둔다.

| 필드 | 의미 |
| --- | --- |
| `atomicEvidences` | 정규화된 Atomic Evidence 목록 |
| `unmappedFindings` | `AMBIGUOUS`, `UNMAPPED`, `INVALID` 등 정규화되지 않은 Finding 정보 |
| `errors` | Normalization 과정의 오류 |
| `summary` | 입력·정규화·Evidence·누락·중복 제거 수와 Normalizer/Mapping 버전 |

정규화 Evidence는 Tier 1 또는 Tier 2 영역에 다시 복사하지 않는다.
`AtomicEvidenceV0_1.sources`의 `analyzer`, `analyzerVersion`, `ruleId`,
`rawFindingId`로 Analyzer Snapshot의 원본 Finding을 연결할 수 있다. 위치는
Evidence의 `locations`와 Finding의 `location`을 함께 확인한다. 정규화되지 않은
항목은 `unmappedFindings.findingId`, analyzer 이름·버전, rule ID와
`rawResultRef`를 사용한다. 이 식별자가 없는 항목에 대해 Adapter가 새로운 연결을
추정하지 않는다.

## 7. 기존 계약과의 관계

| 계약 | 목적 | 주요 범위 | 새 입력에 전체 중첩 여부 |
| --- | --- | --- | --- |
| `Tier2PlanningInput` | Tier 2 복원 정보와 검증된 Evidence 후보 projection | restore file projection, `Tier2PlanningCandidate` | 중첩하지 않음 |
| `Tier2Handoff` | 기존 Tier 3에 복원 artifact와 Evidence를 전달 | artifact descriptor, 복원 provenance, Tier 3용 Evidence | 중첩하지 않음 |
| `AgentPlanningInputV0_1` | 패키지 전체 Tier 1·Tier 2 정적 결과와 Normalization 결과 제공 | Analyzer Snapshots, RestoreResult, Selection, NormalizationResult | 해당 없음 |

기존 `Tier2PlanningInput`과 `Tier2Handoff`의 타입·생성·소비 흐름은 유지된다. 새
입력은 두 계약을 대체하지 않으며, 두 객체나 `evidenceCandidates`, 전체
Obfuscation summary를 내부에 복사하지 않는다.

## 8. 데이터 수명과 불변성

이 계약은 Scanner 프로세스 내부 입력이며 외부 직렬화·영구 보존 계약이 아니다.
Adapter는 새 wrapper와 Analyzer Snapshot 배열을 만들지만 중첩 Finding,
RestoreResult, NormalizationResult는 원본 참조를 공유한다. 독립적인 deep copy나
runtime deep freeze를 하지 않으므로 소비자는 입력과 공유 객체를 수정하면 안 된다.

`RestoreResult`의 `outputRoot`, restored output path와 payload path는 기존 artifact
수명 안에서만 유효하다. artifact 정리 이후 파일 접근을 보장하지 않는다.

이번 구현은 외부 API, `ScanResult`, History, Policy 저장·요청 계약을 변경하지
않는다.

## 9. 검증 및 남은 작업

Adapter 및 Orchestrator 테스트는 다음을 확인한다.

- `Tier2Handoff`가 없는 정상 결과에서도 입력 생성 및 selection의 실제 0 보존
- 복원 성공·부분 복원의 status, validation, limitations, line mapping 보존
- 모든 복원 대상 미해결 상태와 reason 보존
- safe fallback의 `FAILED`, restore 부재 및 selection 생략
- Tier 1과 derived GuardDog/Custom Rule 확장 보존
- 실제 빈 배열과 확장 정보 부재 구분, generic derived failure 처리
- Metadata lifecycle Finding과 관계 후보 참조 ID의 무보정
- Normalization 네 영역 보존 및 Evidence 중복 저장 방지
- deep-frozen 입력을 통한 원본 불변성
- Normalization 이후 Adapter 1회 호출과 기존 Tier 2 실행 횟수 유지

현재 구현에 남은 작업은 다음과 같다.

- 정적 필터 운영 결과의 데이터셋 평가와 관측 개선
- scan limit, skipped 파일과 제외 사유 등 필요한 분석 범위 정보 보완
- derived 관계 후보의 Finding 참조 무결성 보완
- 복원 artifact 준비 실패 및 Finding ID 충돌에 대한 운영 관측 개선
- Tier 3 v0.3 Evidence의 ScanResult/Policy 반환
- Tier 2 GPT Shadow 및 더 이상 운영에서 사용하지 않는 Legacy/Gate 코드의 후속 정리
