# Agent Planning → Tier 3 Input

## 범위

`buildPlanningTier3ExecutionInput()`은 `AgentPlanningInputV0_1`과 검증된
`AnalysisContext`를 기존 `Tier3ExecutionInput`으로 투영한다. `Tier2Handoff`가 없어도
원본 artifact를 대상으로 입력을 생성하며, 접근 가능한 복원 artifact가 있으면 동일
resolver에 추가한다.

Orchestrator는 정적 필터가 `STATIC_INCOMPLETE` 또는 `AMBIGUOUS`를 반환하고 실행 설정이
허용할 때 이 생성기를 호출한다. 기존 Gate와 Legacy Agent는 운영 선별·실행 경로에서
제외됐으며, 실험용 공통 코드는 유지된다.

## 함수 계약

```ts
buildPlanningTier3ExecutionInput({
  planningInput: AgentPlanningInputV0_1,
  context: AnalysisContext,
  originalContentSha256?: string,
  restoredArtifact?: {
    descriptor: ArtifactDescriptor,
    root: string,
  },
  restoredArtifactUnavailableReason?:
    | 'RESTORED_ARTIFACT_HASH_FAILED'
    | 'RESTORED_ARTIFACT_PREPARATION_FAILED'
    | 'RESTORED_ARTIFACT_UNAVAILABLE',
}): Tier3ExecutionInput
```

- `planningInput.subject`와 `AnalysisContext`의 request, scan, package, version 및
  artifact hash가 다르면 실패한다.
- 원본 descriptor는 기존 `originalArtifactDescriptor()`를 사용한다. 원본 root와
  복원 root는 `RuntimeArtifactResolver` 안에만 있으며 Agent 입력에 복사하지 않는다.
- Adapter는 파일 읽기, directory hash, LLM 호출 또는 새 Evidence 생성을 수행하지
  않는다. 복원 directory hash와 descriptor 준비는 향후 runtime 연결부의 책임이다.
- 반환 형식은 기존 `Tier3ExecutionInput`이며 `AgentInputV0_3Builder`가 그대로 소비한다.

## Artifact와 binding

| 입력 | artifact | binding |
| --- | --- | --- |
| Tier 1 SOURCE_FILE Finding | ORIGINAL | 원본 artifact ID + package-relative path |
| Tier 2 Obfuscation 진단 Finding | ORIGINAL | 명시적 DEOBFUSCATED provenance가 없는 한 원본 |
| `*-deobfuscated`/derived Finding | DEOBFUSCATED | 복원 descriptor가 있을 때만 연결 |
| Tier 1 또는 pass 미지정 Evidence | ORIGINAL | Evidence SOURCE_FILE location |
| `analysisPass: TIER2` Evidence | DEOBFUSCATED | 복원 descriptor가 있을 때만 연결 |
| Metadata location | 없음 | Finding은 보존하고 limitation 기록 |

Finding은 `analyzer`와 `findingId`를 변경하지 않는다. 현재 v0.3 binding·target 계약은
Finding 참조를 `findingId`만으로 표현하고 중복 ID를 금지한다. 따라서 동일
`findingId`가 여러 Analyzer에 있으면 임의 ID 보정이나 조용한 alias 대신 입력 생성을
명시적으로 실패한다. analyzer-scoped binding을 지원하려면 별도 v0.3 계약 변경이
필요하다.

복원 위치는 descriptor의 검증된 `lineMappings`를 사용한다. Mapping이 없으면
`UNMAPPED`로 유지하며 basename이나 유사 경로로 원본 위치를 추정하지 않는다. 원본과
복원본에 같은 상대 경로가 있어도 artifact ID가 다르므로 별도 target과 slice가 된다.

## Evidence와 제한

정규화 Evidence의 단일 source는 `planningInput.normalization.atomicEvidences`다.
Handoff Evidence를 추가로 병합하거나 새 Evidence를 만들지 않는다. Evidence source에서
Finding을 target에 연결할 때는 `analyzer + rawFindingId`와 artifact/path가 모두
일치해야 한다.

다음 정보는 `validatedPlan.limitations`에 기록한다.

- Tier 2/derived Analyzer의 실패·부분·timeout·오류
- unresolved, skipped, failed 및 partial restore
- restore/validation limitation과 budget 초과
- 복원 artifact 준비·hash 실패 또는 부재
- Finding/Evidence의 잘못된 경로, provenance 또는 artifact 부재
- Normalization error 및 unmapped Finding

연결할 수 없는 Finding은 `findings`에서 삭제하지 않는다. 코드 target만 만들지 않고
제한을 기록한다. Evidence가 없는 Raw Finding도 그대로 보존하며 새 Evidence를 합성하지
않는다. 정상적으로 복원 후보가 없다는 사실만으로 복원 실패 limitation을 만들지 않는다.

## 경로와 수명

모든 코드 읽기는 기존 `ArtifactCodeSliceBuilder`, `RuntimeCodeTool`,
`readArtifactSource()`를 통해 수행된다. 따라서 artifact ID, representation 제한,
package-relative path 검증, root 경계, traversal 방어와 코드 예산을 우회하지 않는다.
Artifact root는 Scanner cleanup 전까지만 유효하다.

## 현재 제약과 다음 단계

- 새 함수는 실행 대상으로 라우팅된 패키지에만 호출한다. 필터 생략 대상에서는 artifact
  directory hash, resolver, slice 준비를 하지 않는다.
- 복원 descriptor/hash 준비 실패는 runtime 호출부가 명시적인 unavailable reason으로
  전달해야 한다.
- 검증된 v0.3 Evidence와 summary는 기존 ScanResult/Policy 계약으로 전달된다.
- 정적 필터 0.4.0과 Planning 입력 0.1.0 계약은 변경하지 않았다.
- 기존 Handoff 기반 `buildTier3ExecutionInput()`과 `executeTier3Shadow()`는 실험·회귀를
  위해 유지되지만 운영 Orchestrator는 Handoff를 생성하거나 이 경로를 호출하지 않는다.
- 준비된 입력은 `executeTier3V0_3()`으로 실행해 검증 Evidence와 summary를 반환할 수
  있다. Orchestrator는 같은 실행 결과를 ScanResult 병합과 Shadow 관측 투영에 함께
  사용하며 Runner를 다시 호출하지 않는다. 상세 계약은
  `Agent Planning Tier 3 Execution Result.md`를 참고한다.
