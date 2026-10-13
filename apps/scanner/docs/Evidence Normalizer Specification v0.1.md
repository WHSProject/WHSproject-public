# Evidence Normalizer Specification v0.1

- 담당: 희수 최
- 상태: 부분 확정
- 기준: 현재 Scanner Domain 및 `packages/contracts/evidence-v0.1.schema.json`

> 이 문서는 Analyzer Finding을 Evidence로 변환하는 초기 구현 계약을
> 정의한다. 위험도 계산, Policy Decision 및 Correlated Evidence 생성은
> Normalizer의 책임이 아니다.

## 1. 목적과 범위

Evidence Normalizer는 Scanner Analyzer가 생성한 Finding을 공용 Evidence로 변환한다.

```text
Analyzer 실행
→ AnalyzerResult[] 집계
→ Evidence Normalizer
→ Evidence 생성
→ ScanResult 조립
→ History 저장
```

초기 구현 범위:

- Metadata Analyzer Finding
- Custom Rule Analyzer Finding
- GuardDog Analyzer Finding의 등록된 Capability/Threat Rule
- Analyzer Name과 Rule ID 기반 Mapping
- EXACT, PARTIAL, AMBIGUOUS, UNMAPPED, INVALID 처리
- Evidence 생성
- Artifact 기준 Location 정규화
- Finding ID 기반 원본 추적
- 동일 Analyzer 내부 중복 제거
- Normalization Summary와 Mapping Hash 생성
- Metadata license/repository mismatch Mapping

초기 구현 제외 범위:

- GuardDog Risk, ToolAssessment 및 원시 `risks[]`의 직접 Evidence 변환
- Policy 및 Gateway 호출
- DB 저장과 Migration
- Correlated Evidence
- Fingerprint와 과거 Finding 재정규화
- 런타임 JSON Schema validator
- Tier 2 Obfuscation derived Finding의 Atomic Evidence 정규화
- Tier 2 GPT/Gemini Shadow 결과의 Policy Evidence 변환

## 2. 실행 위치

Normalizer는 기존 Tier 1 Analyzer 실행이 종료된 후, ScanResult 생성 전에 실행한다.
현재 Orchestrator는 Obfuscation Analyzer를 먼저 실행하지만, 그 결과와 복원본 재분석
결과를 Normalizer 입력에 포함하지 않는다.

```text
AnalysisContext 생성
→ Tier 1 Analyzer 실행
→ Obfuscation restore/reanalysis 및 Shadow 처리
→ 원본 Tier 1 AnalyzerResult[] 집계
→ Evidence Normalization
→ ScanResult 및 Shadow 결과 조립
→ 선택적 Agent 실행 및 LLM_ASSESSMENT 변환
→ History 저장
→ Policy request 구성
```

Batch 요청에서는 Package별 `scanId`를 기준으로 독립적으로 실행한다. 한 Package의
정규화 결과가 다른 Package의 결과를 제거해서는 안 된다. Orchestrator는
`runAnalyzers()`의 원본 Tier 1 결과로 NormalizationInput을 구성하고, 생성된 Atomic
Evidence를 `ScanResult.evidences`에 포함한다. Obfuscation Analyzer의
`analyzerResult`와 `derivedAnalyzerResults`는 `analyzerSummaries` 및
`shadowAnalyses`에는 기록되지만 현재 NormalizationInput에는 포함되지 않는다.

## 3. 입력

Normalizer는 전체 AnalysisContext 대신 Orchestrator가 구성할 최소 입력을 받는다.

```ts
interface NormalizationInput {
  requestId: string;
  scanId: string;
  subject: {
    ecosystem: 'npm';
    packageName: string;
    packageVersion: string;
    artifactHash: string;
  };
  artifactRoot: string;
  analyzerResults: AnalyzerResult[];
}
```

| 필드 | 기준 |
|---|---|
| `requestId` | Gateway 요청 추적 ID |
| `scanId` | Package별 Scanner 실행 ID |
| `subject` | 검증이 끝난 AnalysisContext의 Package와 Artifact Hash로 구성 |
| `artifactRoot` | `AnalysisContext.artifact.extractedPath` |
| `analyzerResults` | Orchestrator가 전달하는 원본 Tier 1 `AnalyzerResult[]`; 현재 Metadata, Custom Rule, GuardDog 결과 |

Evidence Subject는 Finding의 임의 Package 값이 아니라 검증된 Artifact Identity를
사용한다.

## 4. 실제 Scanner Finding 계약

현재 `AnalyzerResult.analyzer`는 객체가 아니라 Analyzer 이름 문자열이다. Evidence
Source 계약을 충족하기 위해 내부 Analyzer 구현 버전을 별도 문자열로 제공한다.

```ts
interface AnalyzerResult {
  requestId: string;
  scanId: string;
  analyzer: string;
  analyzerVersion: string;
  status: AnalyzerStatus;
  findings: Finding[];
  errors: ScanError[];
  rawResultRef?: string;
}
```

기존 `AnalysisContext`, `AnalyzerResult`, `AnalyzerStatus`, `Finding`,
`FindingLocation`, `ScanError`, `ScanResult`는 중복 정의하지 않는다.

## 5. 출력

```ts
interface NormalizationResult {
  atomicEvidences: AtomicEvidenceV0_1[];
  unmappedFindings: UnmappedFinding[];
  errors: ScanError[];
  summary: {
    inputFindingCount: number;
    normalizedFindingCount: number;
    atomicEvidenceCount: number;
    unmappedFindingCount: number;
    invalidFindingCount: number;
    deduplicatedEvidenceCount: number;
    normalizerVersion: string;
    mappingVersion: string;
    mappingHash: string;
  };
}
```

- `normalizedFindingCount`: 중복 제거 후 Evidence를 하나 이상 새로 생성한
  고유 Finding 수
- `atomicEvidenceCount`: 중복 제거 후 최종 Evidence 수
- `unmappedFindingCount`: AMBIGUOUS 또는 UNMAPPED Finding 수
- `invalidFindingCount`: 필수 필드 또는 Location이 유효하지 않은 Finding 수

Evidence와 대표 Normalization 오류는 후속 Integration 단계에서 ScanResult 및
History에 포함한다. 이번 단계의 독립 Normalizer 구현은 해당 연결을 수행하지 않는다.
Summary와 Unmapped Finding 상세는 외부 ScanResult에 추가하지 않고 후속 저장 계약으로
남긴다.

## 6. Mapping 조회와 구조

Mapping Key는 다음 조합이다.

```text
AnalyzerResult.analyzer + Finding.ruleId
```

Evidence Instance UUID와 공통 Signal ID를 구분한다.

```ts
interface EvidenceMappingTarget {
  signalId: string;
  signalType: string;
  signalCategory: string;
  assertionBasis:
    | 'PATTERN_MATCH'
    | 'METADATA_VALUE'
    | 'CO_OCCURRENCE'
    | 'EXECUTION_LINK'
    | 'DATA_FLOW'
    | 'TOOL_CORRELATION';
  limitations: string[];
}

interface EvidenceMappingRule {
  analyzerName: string;
  ruleId: string;
  mappingStatus: 'EXACT' | 'PARTIAL';
  targets: EvidenceMappingTarget[];
  mappingVersion: string;
}
```

- `evidenceId`: 실행 시 `randomUUID()`로 생성하는 Evidence Instance ID
- `signalId`: `capability.lifecycle.postinstall` 같은 안정적인 의미 식별자
- 한 Finding은 `targets[]`를 통해 하나 이상의 Evidence를 생성할 수 있다.
- Analyzer version은 Mapping Key에 포함하지 않는다.
- Rule ID가 없는 Finding에 Normalizer가 새 Rule ID를 추정하지 않는다.

## 7. 실제 Analyzer와 Rule ID

### 7.1 Metadata Analyzer

- Analyzer name: `metadata`
- 실제 Rule ID:
  - `metadata.lifecycle.preinstall`
  - `metadata.lifecycle.install`
  - `metadata.lifecycle.postinstall`
  - `metadata.license.mismatch`
  - `metadata.repository.mismatch`

Metadata Analyzer는 tarball `package.json`과 registry version manifest에 값이 모두
존재할 때만 license/repository를 비교한다. 비교 가능한 값이 없으면 추정하지 않고
Finding을 생성하지 않는다. 생성되는 mismatch Finding은 다음 공통 구조를 사용한다.

| 필드 | 값 |
|---|---|
| `type` | `METADATA_MISMATCH` |
| `data.field` | `license` 또는 `repository` |
| `data.packageJsonValue` | tarball `package.json` 값 |
| `data.registryMetadataValue` | registry manifest 값 |
| `data.observation` | `MISMATCH` |
| `location` | `METADATA`, `/<field>` |

Normalizer는 두 Rule ID를 모두 `METADATA_MISMATCH` Signal Type으로 정확히 매핑한다.
이 Evidence는 metadata 값의 불일치를 사실로 표현할 뿐, 변조나 악성 의도를 직접
증명하지 않으며 해당 limitation을 유지한다.

### 7.2 Custom Rule Analyzer

- Analyzer name: `custom-rule`
- 실제 최종 Finding Rule ID:
  - `custom.sensitive-file-access`
  - `custom.lifecycle-process-coexistence`
  - `custom.env-network-coexistence`
  - `custom.sensitive-file-network-coexistence`

`custom.signal.*` 값은 Custom Rule Analyzer 내부 Semgrep Signal ID이며 최종 Finding
Mapping Key로 사용하지 않는다.

다음 명세 초안 ID는 현재 Analyzer가 생성하지 않으므로 등록하지 않는다.

```text
custom.process.spawn
custom.network.outbound
custom.environment.read
custom.filesystem.sensitive-read
custom.code.dynamic-execution
custom.code.obfuscation
```

현재 GuardDog Provider와 Orchestrator가 연결되어 있으며, 아래 1차 Mapping 표에
등록된 Rule만 Evidence로 변환한다. Registry에 없는 Rule은 추정하지 않고
`unmappedFindings`에 남긴다.

## 7.3 GuardDog 1차 Evidence Mapping

GuardDog Finding은 기존 `Finding` Contract를 재사용한다. Parser는 JSON 경계 검증과
Finding 변환만 담당하고, Rule 의미 매핑은 기존 `EvidenceMappingRegistry`를 확장하여
수행한다. Orchestrator와 ScanService는 GuardDog Rule 의미를 해석하지 않는다.

Evidence의 공용 `kind`는 `ATOMIC`으로 고정한다. Analyzer Finding의
`CAPABILITY`/`THREAT_INDICATOR` 분류는 Parser 단계에서 유지하되, 최종 Evidence의
`signal.type`은 Policy가 사용하는 세부 Signal Type으로 기록한다. `signal.id`는
Scanner의 안정적인 의미 식별자로 유지한다.

| GuardDog Rule ID | `signal.type` | `signal.id` | 상태 | 비고 |
|---|---|---|---|---|---|
| `capability-process-spawn` | `CHILD_PROCESS` | `capability.process.spawn` | EXACT | 프로세스 실행 가능성 |
| `capability-network-outbound` | `NETWORK_EGRESS` | `capability.network.outbound` | EXACT | 외부 네트워크 접근 가능성 |
| `capability-network-download` | `REMOTE_FETCH` | `capability.network.download` | EXACT | 네트워크 다운로드 가능성 |
| `threat-runtime-environment-read` | `ENV_READ` | `threat.runtime.environment.read` | EXACT | 환경변수 접근 의심 |
| `threat-process-sysinfo` | `FILE_READ` | `threat.process.sysinfo` | PARTIAL | Policy에 시스템 정보 전용 Type이 없어 파일 읽기 범주로 제한 매핑 |
| `threat-runtime-obfuscation-base64exec` | `OBFUSCATED_CODE` | `threat.runtime.obfuscation.base64exec` | EXACT | Base64 기반 난독화·실행 의심 |

`signal.type`은 Policy의 점수표 및 Rule 조건과 직접 일치해야 한다. 표에 없는 Rule은
임의로 등록하지 않고 미매핑으로 남긴다. `signal.id`는 기존 lowercase Registry ID를
변경하지 않는다. 정적 분석은 실행이나 데이터 흐름을 증명하지 않으므로 각 Target에
제한사항을 기록한다.

GuardDog의 `risks[]`, `risk_score`, `issues`, `findings_count`는 공통 Evidence로
변환하지 않는다. 해당 값은 `GuardDogAnalyzerResult`의 내부 `risks`와 `toolAssessment`
로만 보존하고 Policy 최종 점수나 Decision으로 직접 매핑하지 않는다. 현재 Orchestrator와
History에는 Analyzer 확장 결과를 보존하는 Contract가 없으므로 외부 ScanResult에
노출된 것으로 간주하지 않는다.

`UNKNOWN` Rule 또는 Registry 미등록 Rule은 Signal을 추정하지 않고 `unmappedFindings`에
남긴다. Parser Warning과 Registry 미등록은 최종 정규화 결과에서 `PARTIAL` 분석으로
합산한다. `COMPLETED`에 Evidence가 없는 경우는 정상 무탐지이며, `PARTIAL`에 Evidence가
없는 경우는 불완전 분석으로 구분한다.

GuardDog Finding ID인 `guarddog:${ruleId}:${occurrenceIndex}`는 변경하지 않는다.
Evidence Instance의 `evidenceId`는 기존 UUID 규칙을 사용하고 Finding ID는
`EvidenceSource.rawFindingId`로 연결한다. GuardDog 전용 Dedup Key를 도입하기 전에는
기존 Normalizer Dedup 규칙을 적용한다.

GuardDog lifecycle Rule은 이번 Mapping에 포함하지 않는다. `PREINSTALL_SCRIPT`,
`INSTALL_SCRIPT`, `POSTINSTALL_SCRIPT`는 현재 Metadata Analyzer Mapping의 책임이며,
GuardDog 결과가 해당 Signal로 자동 변환된다는 의미가 아니다.

### 7.4 결과 보존 및 상태 결합

`risks[]`, `risk_score`, `issues`, `findings_count`는 Evidence로 변환하지
않는다. ToolAssessment는 Normalizer의 공용 출력에 추가하지 않고 Analyzer 결과 또는
Orchestrator 내부 결과에만 보존하는 안(B)을 채택한다. 현재 `NormalizationResult`는
Evidence, Unmapped Finding, 오류와 Summary만 반환하며 외부 `ScanResult`와
History Contract를 변경하지 않는다.

| 항목 | 상태 | 기준 |
|---|---|---|
| `risks[]` | 확정 | GuardDog 전용 Analyzer 결과의 Risk 메타데이터로 보존, 공통 Evidence로 변환하지 않음 |
| `risk_score` | 확정 | score/label/breakdown/raw를 ToolAssessment로 보존, Policy 점수·Decision으로 직접 매핑하지 않음 |
| `issues` | 확정 | 원본 Analyzer 메타데이터로만 보존, Evidence 개수로 사용하지 않음 |
| `findings_count` | 확정 | Evidence 개수로 사용하지 않음 |
| Capability만 존재 | 확정 | Risk가 없어도 Capability Evidence를 생성 |
| UNKNOWN/미매핑 Rule | 확정 | Signal을 추정하지 않고 `unmappedFindings`와 warning으로 보존, 최소 `PARTIAL` |
| 관계형 추론 | 확정 | GuardDog 결과만으로 `ENV_TO_NETWORK_FLOW`, `DATA_EXFILTRATION` 등을 생성하지 않음 |

Normalizer와 Analyzer/ScanResult 상태는 다음 우선순위로 결합한다.

```text
TIMEOUT > FAILED > PARTIAL > COMPLETED/SUCCESS
```

- Finding이 없고 변환 오류가 없으면 기존 Analyzer 상태를 유지한다.
- `unmappedFindings > 0` 또는 일부 Finding 변환 실패는 최소 `PARTIAL`이다.
- 모든 Finding 변환이 실패해도 입력 JSON과 Analyzer 실행이 유효하면 `PARTIAL`로
  처리한다. Normalizer 자체 실행 예외나 전체 입력 검증 실패만 `FAILED`다.
- 전체 입력 검증 실패 또는 Evidence 생성이 불가능한 경우 `FAILED`다.
- 기존 Analyzer가 `TIMEOUT` 또는 `FAILED`이면 Normalizer가 상태를 낮추지 않는다.
- `COMPLETED + evidences: []`는 정상 무탐지다.
- `PARTIAL + evidences: []`는 불완전 분석이다.

현재 코드의 `AnalyzerStatus`는 `SUCCESS | PARTIAL | FAILED | TIMEOUT | SKIPPED`,
`ScanResultStatus`는 `COMPLETED | PARTIAL | FAILED | TIMEOUT`이므로 위 표기는
Normalizer 내부의 `SUCCESS`와 최종 ScanResult의 `COMPLETED`를 대응시킨다. 상태 결합은
기존 Orchestrator 집계 규칙을 우선하며 공용 Enum은 변경하지 않는다.

### 7.5 Dedup 및 원본 추적

Finding ID와 Evidence ID는 서로 다른 식별자다.

```text
findingId  = Analyzer가 생성한 원본 Finding 식별자
ruleId     = 매핑 규칙 식별자
evidenceId = 정규화된 Evidence 식별자
rawFindingId 또는 derivedFrom = 원본 Finding 연결 정보
```

GuardDog Finding ID `guarddog:${ruleId}:${occurrenceIndex}`는 변경하지 않으며,
Evidence Source의 `rawFindingId`로 참조한다. Evidence `evidenceId`는 기존 UUID 규칙을
사용한다. Dedup 시 canonical key가 같은 경우 첫 번째로 생성된 Evidence와 그 UUID를
유지하고 이후 Finding은 해당 Evidence의 Source에만 추가한다.

동일 Analyzer의 동일 Finding만 중복 제거한다. 서로 다른 Analyzer의 동일 의미
Evidence는 독립 Source로 보존한다. 권장 GuardDog canonical key는 다음과 같다.

```text
analyzer + ruleId + normalized location + match/code + signal.id
```

현재 Normalizer의 전역 Dedup Key는 Analyzer, Rule, 정규화 Location, 전체 Finding
`data`, Mapping Target을 canonical JSON으로 조합한다. 따라서 권장 Key보다 원본
`rawResult`의 부가 필드까지 포함하는 범위가 넓다. 전역 Normalizer 규칙은 변경하지
않고, GuardDog Mapping 구현 시 이 canonical key를 내부 중복 판별에 사용한다. 서로
다른 Analyzer를 독립 보존하는 기준과 충돌하지 않도록 Analyzer 이름을 반드시 포함한다.

### 7.6 Location 및 Lifecycle 경계

Location은 `artifactRoot` 기준의 안전한 상대경로로만 Evidence에 기록한다.

- Artifact Root 밖으로 해석되는 경로는 Evidence 생성을 거부한다.
- 절대경로는 외부 Evidence에 노출하지 않는다.
- `..` 탈출과 검증되지 않은 Symlink 경로는 허용하지 않는다.
- 실제 파일을 읽거나 Location만으로 `realpath`를 수행하지 않는다.
- 원본 Finding은 `rawFindingId` 또는 `derivedFrom`으로 추적 가능해야 한다.

`PREINSTALL_SCRIPT`, `INSTALL_SCRIPT`, `POSTINSTALL_SCRIPT`는 Metadata Analyzer의
Mapping Registry에서 생성한다. `prepare`는 새 Signal Type을 추가하지 않고 기존
`LIFECYCLE_SCRIPT`로 매핑한다. GuardDog Parser가 해당 Rule을 반환하지 않는 한
GuardDog Finding을 Lifecycle Signal로 임의 변환하지 않는다. Lifecycle script의
내용 기반 위험 신호는 Custom Rule P0 static analyzer가 별도의 Atomic Finding으로
생성하며, script의 존재만으로 해당 신호를 만들지 않는다.

### 7.7 Analyzer별 Payload Inventory

`Finding` 공통 계약에는 `findingId`, `ruleId`, `type`, `message`, 선택적 `location`,
`data` 및 선택적 `rawResultRef`만 있다. 공통 `severity` 또는 `detail` 필드는
없으며, Analyzer-specific 정보는 `data`에 남긴다.

| Analyzer | type / rule 식별자 | location 및 주요 `data` | Normalizer 사용 | LLM projection | Policy 영향 |
|---|---|---|---|---|---|
| Metadata | `LIFECYCLE_SCRIPT` / `METADATA_MISMATCH`; `metadata.*` | Metadata `jsonPointer`; lifecycle script 값 또는 `field`, `packageJsonValue`, `registryMetadataValue`, `observation` | `type`, `ruleId`, `message`, `location`; mapping target | Tier 2 bundle의 lifecycle signal 및 message/evidence reference로 제한 사용. Agent path에서는 Finding projection 가능 | lifecycle 또는 `METADATA_MISMATCH` Atomic Evidence |
| Custom Rule | `CAPABILITY_PATTERN` / `CO_OCCURRENCE_SIGNAL`; `custom.*` | source locations; `interpretation`, `signalRuleIds`, `doesNotProve`, optional action/source/sink/context/analysis level/limitations/confidence | `ruleId`, `message`, `data.locations` 또는 location; mapping target | Tier 2 bundle의 evidence, capability 및 strong combination; Agent path의 Finding projection | 등록된 rule의 Atomic Evidence |
| GuardDog | `CAPABILITY` / `THREAT_INDICATOR`; GuardDog rule ID | source location; `identifies`, `code`, `match`, nested `guarddog.resultRuleId/rawResult`; risk metadata는 Analyzer result의 별도 필드 | `ruleId`, `type`, `message`, location, `data.match/code`; registered mapping만 사용 | Tier 2 bundle의 evidence/capability; Agent path에서 normalized Atomic Evidence와 Finding projection | registered rule의 Atomic Evidence; raw risks/risk score는 직접 영향 없음 |
| Obfuscation / derived | `OBFUSCATION*`; `obfuscation.*` 및 `*-deobfuscated` | source path; artifact hash, score/signals, restore status/stages/validation/limitations, derived `origin=DEOBFUSCATED` | 현재 Orchestrator가 Normalizer에 전달하지 않음 | Tier 2 `FileEvidenceBundle`, restore provenance, sourceKind, slices | 현재 직접 영향 없음; shadow summary/analyzer summary에만 기록 |

Analyzer별 `data`는 공통 Schema로 강제 통합하지 않는다. Normalizer는 원본 Finding을
수정하지 않고 Registry mapping과 공통 Location/Source 규칙만 적용한다. LLM Payload는
각 경로의 Builder가 필요한 subset을 projection하며, 전체 `data`를 Policy Contract로
승격하지 않는다.

## 8. 초기 Mapping Registry

Policy에서 실제 지원하는 Signal Type만 사용한다.

| Analyzer | Rule ID | 상태 | Signal ID | Signal Type | Category | Assertion Basis |
|---|---|---|---|---|---|---|
| `metadata` | `metadata.lifecycle.preinstall` | EXACT | `capability.lifecycle.preinstall` | `PREINSTALL_SCRIPT` | `METADATA` | `METADATA_VALUE` |
| `metadata` | `metadata.lifecycle.install` | EXACT | `capability.lifecycle.install` | `INSTALL_SCRIPT` | `METADATA` | `METADATA_VALUE` |
| `metadata` | `metadata.lifecycle.postinstall` | EXACT | `capability.lifecycle.postinstall` | `POSTINSTALL_SCRIPT` | `METADATA` | `METADATA_VALUE` |
| `metadata` | `metadata.lifecycle.prepare` | EXACT | `capability.lifecycle.prepare` | `LIFECYCLE_SCRIPT` | `METADATA` | `METADATA_VALUE` |
| `metadata` | `metadata.license.mismatch` | EXACT | `consistency.metadata.license-mismatch` | `METADATA_MISMATCH` | `METADATA` | `METADATA_VALUE` |
| `metadata` | `metadata.repository.mismatch` | EXACT | `consistency.metadata.repository-mismatch` | `METADATA_MISMATCH` | `METADATA` | `METADATA_VALUE` |
| `custom-rule` | `custom.sensitive-file-access` | PARTIAL | `capability.filesystem.sensitive-read` | `SENSITIVE_FILE_READ` | `FILESYSTEM` | `PATTERN_MATCH` |
| `custom-rule` | `custom.lifecycle-process-coexistence` | PARTIAL | `capability.process.spawn` | `CHILD_PROCESS` | `EXECUTION` | `CO_OCCURRENCE` |
| `custom-rule` | `custom.env-network-coexistence` | PARTIAL | `capability.environment.read` | `ENV_READ` | `ENVIRONMENT` | `CO_OCCURRENCE` |
| `custom-rule` | `custom.env-network-coexistence` | PARTIAL | `capability.network.outbound` | `NETWORK_EGRESS` | `NETWORK` | `CO_OCCURRENCE` |
| `custom-rule` | `custom.sensitive-file-network-coexistence` | PARTIAL | `capability.filesystem.sensitive-read` | `SENSITIVE_FILE_READ` | `FILESYSTEM` | `CO_OCCURRENCE` |
| `custom-rule` | `custom.sensitive-file-network-coexistence` | PARTIAL | `capability.network.outbound` | `NETWORK_EGRESS` | `NETWORK` | `CO_OCCURRENCE` |

`metadata.lifecycle.preinstall`, `metadata.lifecycle.install`, `metadata.lifecycle.postinstall`은
각각 별도의 Policy Signal로 변환하고, `metadata.lifecycle.prepare`는 기존
`LIFECYCLE_SCRIPT` Signal Type으로 변환한다. 네 script의 존재만 관찰하며 실제 실행 여부는
증명하지 않으므로 동일한 limitation을 기록한다. Script command의 remote download,
process execution, credential source, sensitive file read는 Custom Rule P0 Finding으로
별도 기록하고, Tier 1은 lifecycle 존재만으로 malicious verdict를 만들지 않는다.

`custom.lifecycle-process-coexistence`는 Lifecycle 종류를 특정하지 않으므로
`POSTINSTALL_SCRIPT`를 추가 생성하지 않는다.

## 9. Mapping 상태

| 상태 | Evidence 생성 | 처리 |
|---|---:|---|
| EXACT | O | Evidence 생성 |
| PARTIAL | O | Schema의 `additionalProperties: false`를 위반하지 않도록 `limitations`에 제한사항을 기록 |
| AMBIGUOUS | X | unmappedFindings에 보존 |
| UNMAPPED | X | unmappedFindings에 보존 |
| INVALID | X | ScanError로 기록하고 다음 Finding 처리 |

Mapping이 없는 것은 Analyzer 실패가 아니다. Finding이 원래 없는 경우와 Finding이
모두 UNMAPPED인 경우는 Summary로 구분한다.

PARTIAL 상태와 Mapping version/hash는 Evidence 최상위에 추가하지 않는다. 공용 Schema가
허용하는 추가 구조가 없으므로 매핑 제한사항은 `limitations` 배열에 기록한다. 매핑 상태와
Rule ID가 별도로 필요하면 Normalizer 내부 결과에만 보존하며, 공용 Evidence Contract는
변경하지 않는다.

## 10. Evidence 생성

공용 Evidence Contract의 실제 필드를 사용한다.

```ts
{
  schemaVersion: '0.1',
  evidenceId: randomUUID(),
  kind: 'ATOMIC',
  signal: {
    id: mapping.signalId,
    type: mapping.signalType,
    category: mapping.signalCategory,
  },
  subject,
  assertion: {
    summary: finding.message,
    basis: mapping.assertionBasis,
  },
  sources: [{
    analyzer: analyzerResult.analyzer,
    analyzerVersion: analyzerResult.analyzerVersion,
    ruleId: finding.ruleId,
    rawFindingId: finding.findingId,
  }],
  locations,
  provenance: {
    scanId,
    generatedBy: 'EVIDENCE_NORMALIZER',
    observedAt,
  },
  limitations,
}
```

초기 내부 Analyzer 구현 버전은 Metadata와 Custom Rule 모두 `0.1.0`으로 관리한다.
이 값은 Rule 버전이나 Semgrep Tool 버전과 구분한다.

## 11. Location 정규화

실제 필드 이름을 사용한다.

```ts
{
  type: 'SOURCE_FILE',
  path: 'package/src/index.js',
  startLine: 12,
  startColumn: 4,
}
```

- 절대 임시 경로를 Evidence에 저장하지 않는다.
- `artifactRoot` 내부 경로만 허용한다.
- 상대 경로와 Artifact 내부 절대 경로를 Artifact 기준 상대 경로로 변환한다.
- `..` 등 Artifact Root 외부 경로를 거부한다.
- Metadata Location은 `jsonPointer`를 보존한다.
- 값이 없는 Location을 임의 생성하지 않는다.
- `kind`, `line`, `column` 필드는 사용하지 않는다.

## 12. Provenance와 원본 추적

Evidence Provenance에는 현재 Contract가 허용하는 필드만 포함한다.

```text
scanId
generatedBy
observedAt
```

Finding 추적은 `sources[].rawFindingId`를 사용한다.

다음 값은 Evidence Provenance에 넣지 않는다.

```text
mappingVersion
mappingHash
mappingRuleId
mappingStatus
rawResultRef
analyzerVersion
```

`Finding.rawResultRef`와 `AnalyzerResult.rawResultRef`는 타입상 선택값이지만 현재
Analyzer가 실제 값을 생성하지 않는다. 초기 Evidence에는 추가하지 않는다.

## 13. 중복 제거

다음 값이 같은 경우에만 동일 Analyzer 내부 중복 Evidence로 처리한다.

```text
Analyzer Name
+ Rule ID
+ 정규화 Location
+ Finding.data
+ Mapping Target
```

- Mapping Target을 포함해 1:N Mapping의 서로 다른 Evidence를 보존한다.
- 첫 Evidence를 유지한다.
- 중복 Finding ID는 유지된 Evidence의 `sources[].rawFindingId`로 연결한다.
- 서로 다른 Analyzer의 Evidence는 병합하지 않는다.
- 제거된 Evidence 수를 `deduplicatedEvidenceCount`에 기록한다.

## 14. Mapping Hash

Registry의 의미 있는 설정을 canonical serialization한 뒤 SHA-256 lowercase hex로
계산한다.

포함 대상:

- analyzerName
- ruleId
- mappingStatus
- target signalId/type/category/assertionBasis/limitations
- mappingVersion

제외 대상:

- 선언 또는 Map 삽입 순서
- 함수와 런타임 객체 주소
- Evidence UUID
- 생성 시각

Rule은 Analyzer Name과 Rule ID로 정렬하고 Target은 Signal ID와 Signal Type으로
정렬한다. 동일 Registry 내용은 선언 순서와 관계없이 동일 Hash를 생성해야 한다.

## 15. 오류 처리

기존 `ScannerErrorCode`는 이번 단계에서 확장하지 않는다.

Finding 필수 필드, Location 및 Evidence build 오류는 다음 내부 표현을 사용한다.

```text
code: INTERNAL_ERROR
stage: NORMALIZATION:<오류 의미>
retryable: false
```

Mapping 없음과 AMBIGUOUS는 오류가 아니라 `unmappedFindings`에 보존한다. 하나의
Finding 오류가 나머지 Finding 정규화를 중단해서는 안 된다.

Normalizer 전용 공용 Error Code는 추가하지 않는다. 일부 미매핑 또는 정규화 오류는
`PARTIAL`, Normalizer 전체 예외는 `FAILED`로 집계한다. 미매핑 상세는 내부 결과에
유지하고 ScanResult에는 개수가 포함된 대표 오류 하나만 추가한다.

## 16. Schema 검증

Source of Truth는 `packages/contracts/evidence-v0.1.schema.json`이다.

현재 Scanner에는 공용 JSON Schema validator가 없고 새 의존성을 추가하지 않는다.
초기 구현은 해당 Contract와 Policy가 허용하는 필드 이름 및 enum으로 Evidence를
구성한다. 런타임 JSON Schema 검증은 validator와 Contract 정합성 결정 후 추가한다.

Policy Pydantic 모델을 Scanner 내부에 복제하지 않는다.

## 17. Finding, Evidence 및 LLM Payload 경계

현재 구현의 책임 경계는 다음과 같다.

| 계층 | Source of Truth | 책임 | Policy 직접 입력 |
|---|---|---|---:|
| Finding | Analyzer가 생성한 `Finding` | 원시/static observation과 Analyzer-specific `data` 보존 | 아니오 |
| Atomic Evidence | `EvidenceNormalizer` 출력 | Mapping된 사실 기반 근거, Location, 원본 Finding 추적 | 예 |
| LLM Payload | 별도 Builder가 만든 projection | LLM에 필요한 subset, context, slice, validation reference 전달 | 아니오 |
| LLM Output | Provider 응답 | 검증 전 신뢰하지 않는 외부 결과 | 아니오 |
| LLM_ASSESSMENT | 검증된 Agent output의 Adapter 결과 | 검증된 LLM assessment의 Policy-facing 표현 | 예 |

LLM Payload를 만들기 위해 원본 Finding 또는 Atomic Evidence를 수정하지 않는다.
Prompt convenience field와 Evidence Contract field는 별도 계층으로 유지한다.
LLM 응답의 임의 Evidence ID와 path는 provider 응답만으로 신뢰하지 않으며, 각
경로의 validator가 request에 존재하는 ID, slice, path와 대조한 뒤에만 다음 단계로
전달한다.

### 17.1 Tier 2 Obfuscation Shadow

```text
Tier 1 Finding
  + Obfuscation Finding / derived Finding
  → FileEvidenceBundle
  → AgentAnalysisRequestV0_1
  → CodeSlice
  → GPT/Gemini
  → GptShadowOutcome
```

`AgentAnalysisRequestV0_1`에는 package/sample identity, artifactHash, candidate
package-relative path, `sourceKind`, restore provenance, evidence references,
limitations 및 code slices가 포함된다. `GptShadowOutcome`은 Shadow 결과이며 현재
Atomic Evidence 또는 Policy Evidence가 아니다. 특히 Tier 2 derived Finding은
현재 Orchestrator의 EvidenceNormalizer 입력에 포함되지 않는다.

### 17.2 Agent 경로

```text
Tier 1 Finding projection + Atomic Evidence
  → AgentAnalysisRequest
  → AgentCodeSlice
  → LlmAgentRunnerService
  → AgentAnalysisResult
  → AgentOutputValidatorService
  → LlmEvidenceAdapter
  → LLM_ASSESSMENT
  → Policy request
```

Agent request에는 package metadata, Finding projection, Atomic Evidence reference,
initial slice, analysis limit, tool capability 및 missing data가 포함된다. Agent
Runner는 추가 code range를 요청할 수 있다. 검증된 `VERIFIED` assessment만
`LLM_ASSESSMENT`로 변환된다. Tier 2 Shadow request와 Agent request는 현재 별도
계약이며, 이번 문서에서는 이를 통합하지 않는다.

### 17.3 추적성 및 현재 한계

| 연결 | 현재 상태 |
|---|---|
| Package → Artifact | `AnalysisContext`, `ScanResult.subject`, `artifactHash`로 가능 |
| Artifact → Finding | Analyzer 실행 context 및 Finding data에 부분적으로 보존 |
| Finding → Atomic Evidence | `EvidenceSource.rawFindingId`로 가능 |
| Finding/Evidence → Tier 2 Payload | Tier 2 bundle의 evidence ID와 candidate reference로 가능 |
| Finding/Evidence → Agent Payload | Agent request의 finding/evidence ID로 가능 |
| LLM Result → Policy | Agent의 검증 결과만 `analysisId`/`assessmentId`로 가능 |
| Tier 2 Shadow Result → Policy | 현재 직접 연결되지 않음 |

현재 공통 `representation`, `analysisPass`, `lineage`, original↔deobfuscated line
mapping은 존재하지 않는다. `sourceKind`, `RestoreProvenance`, derived Finding의
`data.origin`은 Tier 2 내부 표현이며 공통 Contract로 간주하지 않는다.

## 18. Metadata mismatch Mapping

Metadata Analyzer와 Mapping Registry는 다음 두 Rule을 현재 지원한다.

| Finding Rule ID | Finding type | Evidence signal.id | signal.type | basis |
|---|---|---|---|---|
| `metadata.license.mismatch` | `METADATA_MISMATCH` | `consistency.metadata.license-mismatch` | `METADATA_MISMATCH` | `METADATA_VALUE` |
| `metadata.repository.mismatch` | `METADATA_MISMATCH` | `consistency.metadata.repository-mismatch` | `METADATA_MISMATCH` | `METADATA_VALUE` |

두 mapping은 `EXACT`이며 `METADATA` category를 사용한다. `packageJsonValue`와
`registryMetadataValue`는 Finding message와 data에 보존되고, Evidence assertion은
Finding message를 사용한다. Evidence limitation은 mismatch만으로 tampering이나
malicious intent를 증명하지 않는다는 점을 명시한다.

이 mapping은 Metadata Analyzer와 Evidence Normalizer 테스트로 고정되어 있다. 값이
없거나 비교 형식을 안전하게 정규화할 수 없는 경우에는 mismatch Finding을 추정하지
않는다.

## 19. 후속 결정사항

- Normalization Summary와 Unmapped Finding의 ScanResult 표현
- 공용 JSON Schema와 Policy Pydantic 모델의 차이
- Finding과 Raw Result Reference의 History 보존 방식
- Finding이 0개일 때 Policy 호출 여부
- 내부 Analyzer 버전의 장기 버전 관리 기준

## 20. 초기 독립 Domain 완료 조건

- [x] NormalizationInput과 NormalizationResult 정의
- [x] 실제 Analyzer Name과 Rule ID 기반 Mapping Registry
- [x] EXACT 및 PARTIAL Mapping
- [x] 1:N Mapping Target
- [x] AMBIGUOUS, UNMAPPED, INVALID 분리
- [x] UUID Evidence ID와 Signal ID 분리
- [x] Contract 필드 기반 Evidence Builder
- [x] Artifact Root 기준 Location 정규화 기반
- [x] rawFindingId 기반 추적
- [x] 동일 Analyzer 내 중복 제거
- [x] Mapping Summary와 순서 독립적 Mapping Hash
- [x] 단일 Finding 실패 격리
- [x] Orchestrator의 NormalizationInput 구성 및 연결
- [x] ScanResult 및 기존 History 저장 연결
- [ ] 런타임 JSON Schema 검증
