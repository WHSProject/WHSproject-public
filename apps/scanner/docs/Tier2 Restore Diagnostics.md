# Tier2 복원 진단 기록

관련 Issue: #401. #399 집계 작업 및 PR #398과 별도 변경이다.

## 목적과 범위

기존 파일럿은 복원된 파일의 path/status/limitations만 저장하여, 선정됐지만 Handoff가 없는 패키지의 파일별 사유와 단계를 확인할 수 없었다. `tier2.restoreDiagnostics`에 기존 복원 결과를 요약하여 저장한다.

복원 대상 선정, 복원 성공·실패 판정, Gate, API, Evidence/Decision Schema, Policy, Docker 격리 설정은 변경하지 않는다. 재검사를 위해 Docker 검사기의 이미지 참조에 기대 digest와 동일한 전체 로컬 이미지 ID 지원을 추가했다. 단계별 시간은 추가하지 않는다. 기존 단계 결과와 **파일 전체 소요 시간**을 기록하며, 시간 계측을 외부로 전달되는 `stageResults`에 넣지 않는다.

## 새 보고서 항목

| 항목 | 의미 |
| --- | --- |
| `durationMs` | 전체 복원 파이프라인 시간 |
| `budgetExceeded` | 기존 파이프라인이 기록한 예산 초과/취소 상태 |
| `statusCounts` | RESTORED / PARTIAL_RESTORED / UNRESOLVED / SKIPPED / FAILED 파일 수 |
| `reasonCounts` | 사유별 파일 수. 성공 파일은 사유가 없을 수 있음 |
| `files[].path` | 분석 대상의 상대 경로 |
| `files[].status`, `reason`, `limitations` | 기존 복원 결과의 상태·사유·제약 |
| `files[].durationMs` | 해당 파일 처리 시간. 기존 결과에 없거나 유효하지 않으면 null |
| `files[].failedStages` | FAILED 또는 UNAVAILABLE인 변환 단계. 실패가 아닌 미지원 변환·읽기/쓰기 실패에서는 빈 배열일 수 있음 |
| `files[].stageResults` | 단계명·적용 여부·상태·변경 여부·사유 |

미복원 파일에도 처리 시간을 기록한다. 파일 처리를 시작하지 못한 예산 초과/사전 취소 결과는 0ms이며, 이전 기록의 미측정 시간(null)과 구분한다. 파이프라인 전체 시간에는 다른 대상 파일에 쓴 시간 등이 포함되므로 단일 파일 시간과 동일하지 않다.

`failedStages: []`는 성공을 뜻하지 않는다. 최종 `status`와 `reason`을 함께 본다. 예를 들어 `NO_SUPPORTED_TRANSFORM`은 단계를 실행했으나 지원되는 변환을 적용하지 못한 상태다. `SOURCE_READ_FAILED`는 변환 시작 전, `OUTPUT_WRITE_FAILED`는 변환 후 저장 단계의 실패다.

진단 요약에는 원본/복원 코드, 출력 절대 경로, raw `detail`, 상세 validation 및 payload metadata를 복사하지 않는다. 기존 `restoreStatus` 항목도 호환성을 위해 유지한다.

## 검증 명령

`apps/scanner`에서:

```bash
npm test -- --runInBand src/analyzers/obfuscation/restore.pipeline.spec.ts src/performance/tier2-omcbench-aggregation.spec.ts
npm run typecheck
npm run build
npm test -- --runInBand
```

저장소 루트에서:

```bash
node --check apps/scanner/scripts/omc-tier1-tier2-pilot.mjs
```

회귀 검증은 미지원 동적 복원, 읽기/쓰기 실패, 사전 취소, 단계 도구 실패, 부분 복원, 이전 결과의 미상 시간, 불필요한 상세정보 제외를 포함한다.

## 42건과 소규모 재검사

로컬 `reports/validation/`에 다음 자료를 별도로 보존한다. Git 제외 대상이며 원본 600건을 덮어쓰지 않는다.

- `tier2-restore-diagnostics-42-manifest.json`: 유효 비교 표본 중 선정됐지만 Handoff가 없던 42개 패키지와 기존 관측
- `tier2-restore-diagnostics-3-manifest.json`: 기존 JS 바이트가 작은 악성 2개·정상 1개의 진단용 부분 표본

3개는 빠른 진단 기록 검증용이지 통계적으로 대표적인 표본이 아니다. 기존 아카이브와 SHA-256을 사용한다. 새 실행 결과의 reason을 과거 42건 전체의 원인으로 확대 해석하지 않는다.

기존 파일럿의 `OMC_SOURCE_REPORT`, `OMC_ARCHIVE_DIR`, `OMC_EXPECTED_CASES=3`, `OMC_PILOT_OUTPUT`, `OMC_EXTERNAL_IMAGE`, `OMC_EXTERNAL_IMAGE_DIGEST` 설정으로 실행한다. `OMC_PILOT_OUTPUT`은 원본과 다른 새 경로여야 한다. 사전 검증이 성공해야 패키지 분석을 시작한다.

이미지 참조는 두 형식을 지원한다.

- 기존 이미지 이름: 기존과 같이 `이름@expectedImageDigest`를 사용한다. 이름 설정에 `@digest`를 중복해서 넣지 않는다.
- 전체 로컬 이미지 ID `sha256:<64자리>`: `expectedImageDigest`와 정확히 같아야 하며 ID 자체로 조회·진단·검사를 수행한다. 다르거나 짧은 ID는 거부한다.

실제 조회한 이미지의 `Id` 검증, 비루트 사용자, 네트워크 차단, 읽기 전용 마운트, 리소스 제한, 도구 버전 및 규칙 해시 검사는 유지한다. 태그 오류를 무시하거나 임의의 다른 이미지를 사용하는 자동 fallback은 없다. 이는 Runtime 이미지 참조 입력의 추가 지원이며, PR에 관련 변경을 명시해야 한다.

실제 실행에는 저장된 검사 이미지가 필요하다. 이미지 사전 점검을 통과하지 못하면 결과를 성공으로 기록하지 않는다. Socket 재조회, 설치 스크립트 실행, 실제 LLM 호출은 필요하지 않다.
