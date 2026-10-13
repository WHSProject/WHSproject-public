# Scanner Performance and Detection Quality Standard v0.1

## 목적

이 문서는 W4-SC-02의 Scanner 성능·탐지 품질 측정 기준과 실행 가능한
측정 유틸리티를 정의한다. 기준은 현재 `dev`의 Scanner 실행 흐름과 W4-SC-01의
대표 source Fixture를 전제로 한다.

이 작업은 GuardDog, Custom Rule, 공통 Analyzer Contract, Evidence schema 또는
Policy 기준을 변경하지 않는다. `ScanResult` API에도 성능 측정값을 추가하지 않으며,
Orchestrator의 내부 실행 결과에만 선택적 `performance` 측정값을 보존한다.

## 적용 범위와 측정 프로필

### 공통 실행 프로필

- Node.js 24.x
- Scanner 단일 process
- 동일 Package의 반복 실행은 cache/dedup하지 않음
- 첫 실행은 warm-up으로 제외하고, 동일 조건을 최소 5회 측정
- 외부 Registry와 Analyzer 도구를 포함하는 통합 측정과, source Fixture를 이용한
  결정론적 Analyzer 품질 측정을 구분

### 성능 측정 범위

Orchestrator는 다음 stage를 각각 측정한다.

`REGISTRY → DOWNLOAD → EXTRACT → HASH → IDENTITY → ANALYZER → NORMALIZATION`

각 Analyzer는 공통 `AnalyzerResult`를 수정하지 않고 호출 경계에서 별도 측정한다.
현재 실행된 Analyzer는 `metadata`, `custom-rule`, `guarddog`이다.

측정 구현은 `src/performance/scanner-performance.ts`의
`ScannerPerformanceMeasurement`가 담당한다. 측정값은 다음을 포함한다.

| 항목 | 정의 |
|---|---|
| Package duration | 측정 객체 생성부터 `finish()`까지의 monotonic clock 경과 시간 |
| Stage duration | 각 Orchestrator stage 호출의 경과 시간 |
| Analyzer duration | 각 Analyzer 호출의 경과 시간과 반환 status |
| RSS | Node process의 resident set size |
| Heap used | V8가 사용 중인 JavaScript heap |
| External / ArrayBuffers | Node 외부 메모리와 ArrayBuffer 메모리 |
| Peak observed | 20ms sample interval과 stage/analyzer 경계에서 관찰된 항목별 최대값 |

`Peak observed`는 heap snapshot이나 운영체제 전체 메모리 계측이 아니다. 따라서
누락될 수 있는 아주 짧은 peak가 있음을 전제로 하며, 장기 누수 분석에는 별도의
heap profiling을 사용한다.

## 성능 기준선과 판정

아래 값은 현재 Minimal Fixture와 30초 Package deadline을 기준으로 한 v0.1 초기
운영 목표다. 외부 Registry 네트워크 지연이 포함된 통합 실행에서는 결과와 함께
환경, 도구 버전, Registry 응답시간을 기록한다.

| 지표 | 목표 | 판정 |
|---|---:|---|
| Package p50 | ≤ 5,000ms | 통과 |
| Package p95 | ≤ 15,000ms | 통과 |
| Package p99 | ≤ 25,000ms | 통과 |
| Package hard timeout | 30,000ms | 초과 시 `TIMEOUT` |
| Heap growth | ≤ 64MiB | 대표 실행의 종료 heap - 시작 heap |
| RSS growth | ≤ 256MiB | 대표 실행의 종료 RSS - 시작 RSS |

Percentile은 nearest-rank 방식으로 계산한다. 정렬된 N개 값에 대해 p 값의 위치는
`ceil(p / 100 × N)`이며, 1-based 위치를 사용한다. 구현은
`summarizeDurations()`와 `evaluatePerformanceTargets()`로 고정한다.

성능 목표 판정은 다음 조건을 모두 만족해야 한다.

1. p50, p95, p99가 각각 목표 이하
2. 대표 실행 시간이 Package timeout 이하
3. 종료 heap/RSS 증가량이 각각 메모리 목표 이하

## Timeout 기준

현재 timeout 정책은 변경하지 않고 측정·판정 기준만 명시한다.

1. `SCANNER_PACKAGE_TIMEOUT_MS` 기본값은 240,000ms이며 Package 전체의 hard deadline이다. 위 성능 목표의 Package hard timeout(30,000ms)과는 별개 값이다.
2. Metadata timeout 기본값은 10,000ms다.
3. Custom Rule(Semgrep) timeout은 현재 AnalyzerModule 구성에서 10,000ms다.
4. GuardDog timeout 기본값은 60,000ms지만 Package deadline의 남은 시간이 더 작으면
   Package deadline이 유효한 상한이다.
5. Analyzer가 `TIMEOUT`을 반환하거나 Package deadline이 만료되면 전체 결과는
   기존 규칙에 따라 `TIMEOUT`으로 집계한다.
6. timeout 이후 결과를 정상 완료로 재분류하거나 timeout 값을 자동 조정하지 않는다.

측정 결과는 timeout 여부와 Analyzer status를 함께 기록한다. timeout된 실행은
성능 p50/p95/p99 정상 완료 표본에 포함하지 않고, 별도 timeout rate로 보고한다.

## 탐지 품질 기준

### 측정 단위

탐지 품질은 Finding 전체 객체가 아니라 안정적인 detection identity 집합으로
비교한다. 현재 구현에서는 `finding.ruleId`를 identity로 사용한다.

- 같은 identity가 한 케이스에서 여러 번 반환되면 한 번으로 deduplicate
- `expected`와 `actual`의 교집합은 TP
- expected에만 있는 identity는 FN
- actual에만 있는 identity는 FP
- 명시적인 `universe`에서 양쪽에 없는 identity만 TN
- `precision = TP / (TP + FP)`
- `recall = TP / (TP + FN)`
- `F1 = 2 × precision × recall / (precision + recall)`
- 분모가 0인 precision/recall은 정상적인 무탐지로 간주하여 1로 계산
- `exactMatch`는 deduplicate된 expected/actual 집합이 같은지 여부

구현은 `compareDetections()`와 `summarizeDetectionQuality()`에 있다. TN은 닫힌
분류 universe가 제공될 때만 계산하며, universe가 없는 오픈월드 탐지 결과에서
정확도(accuracy)를 임의로 계산하지 않는다.

### 현재 골든 코퍼스

W4-SC-01의 source Fixture 중 Metadata Analyzer가 책임지는 관찰만 골든 코퍼스로
사용한다.

| Fixture | 기대 detection identity |
|---|---|
| `normal-unscoped` | 없음 |
| `normal-scoped` | 없음 |
| `lifecycle-scripts` | `metadata.lifecycle.preinstall`, `metadata.lifecycle.install`, `metadata.lifecycle.postinstall` |
| `identity-mismatch` | 없음 |
| `metadata-consistent` | 없음 (license 및 repository 표현 정규화 후 일치) |
| `metadata-mismatch` | `metadata.license.mismatch`, `metadata.repository.mismatch` |

현재 코퍼스의 완료 기준은 다음과 같다.

- Metadata precision = 1.0
- Metadata recall = 1.0
- Metadata F1 = 1.0
- Exact-match rate = 1.0

GuardDog와 Custom Rule은 이 작업에서 담당 구현·Fixture·Contract를 수정하지 않는다.
해당 Analyzer의 정량 품질 평가는 오탐/미탐 라벨이 합의된 별도 corpus가 준비된 뒤
동일한 측정 유틸리티에 케이스를 추가한다.

## Known Gap

`extraction byte/file/path depth`는 W4-SC-01에서 확인된 Known Gap으로 유지한다.
이번 작업에서는 해당 limit의 Orchestrator runtime 연결을 구현하지 않는다.

또한 v0.1에서는 성능 측정값을 외부 Metrics backend로 전송하지 않는다. CI 또는
운영 실행에서 `ScanExecutionResult.performance`를 수집하는 후속 작업이 필요하다.

## 검증

관련 검증 명령:

```text
pnpm --filter scanner typecheck
pnpm --filter scanner test -- --runInBand
```

성능 측정 유틸리티, Orchestrator 측정 연결, Metadata 골든 코퍼스 및 percentile/
quality 계산은 Scanner unit test로 검증한다.
