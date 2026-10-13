# GuardDog Adapter Specification v0.1

- 상태: 4차 Runtime Hardening 완료, Provider·Orchestrator 통합 전
- 대상 Component: Scanner
- 기준 도구: GuardDog 3.1.0
- 관련 Issue: #163

> 이 문서는 GuardDog 3.1.0의 실제 CLI 및 JSON 출력 구현과 현재 Scanner
> Domain Contract를 기준으로 GuardDog Adapter의 초기 구현 범위를 정의한다.
> Raw Result의 장기 보존, GuardDog Finding의 Evidence Mapping 및
> `ScanResult.toolAssessments` 공개 여부는 후속 Contract 합의 대상으로 둔다.

## 1. 목적

GuardDog Adapter는 Scanner가 무결성 및 Package Identity를 검증한 뒤 안전하게
압축 해제한 로컬 npm Artifact를 GuardDog로 분석하고, 실행 결과를 공통
`AnalyzerResult` 구조로 변환한다.

```text
AnalysisContext
→ 입력 경로 검증
→ GuardDog 실행
→ 프로세스 결과 수집
→ JSON 파싱
→ stdout 및 stderr 폐기
→ Finding, Risk, Tool Assessment 구분
→ GuardDogAnalyzerResult 반환
```

Adapter는 GuardDog 원본 출력의 `results`, `risks`, `risk_score`, `errors`,
`issues`, `package`를 서로 다른 의미로 취급한다. GuardDog의 Tool Score를
Scanner 또는 Policy의 최종 판정으로 해석하지 않는다.

## 2. 책임 범위

### 2.1 포함 범위

- GuardDog 실행파일과 인자 배열 구성
- 검증된 로컬 압축 해제 디렉터리 전달
- Sandbox Mode 적용
- exit code, signal, stdout, stderr 수집
- timeout 및 하위 프로세스 종료
- 출력 크기 제한
- GuardDog JSON 출력 파싱
- Capability 및 Threat Finding 추출
- 미분류 Rule 결과 보존
- GuardDog Risk 원본 보존
- Risk Score를 Tool Assessment로 분리
- GuardDog 오류를 공통 `ScanError`로 변환
- 실행 추적정보 생성
- 공통 `AnalyzerResult` 확장 결과 반환

### 2.2 초기 제외 범위

- Tarball 다운로드 및 압축 해제
- Artifact Integrity 및 Package Identity 검증
- GuardDog metadata rule 실행
- Finding을 Atomic Evidence로 의미 정규화
- 다른 Analyzer 결과와의 상관분석
- GuardDog Risk와 Scanner Finding의 강제 연결
- Risk Score 재계산
- ALLOW, REVIEW, REJECT 등 Policy Decision 생성
- Raw stdout, stderr 및 전체 JSON 저장
- Raw Result Storage와 Reference 생성
- Raw Result 조회 API 및 장기 보존 정책
- `ScanResult.toolAssessments` 외부 Contract 확정
- AnalyzerModule Provider 등록
- Orchestrator `runAnalyzers()` 연결
- Evidence Mapping
- ScanResult 및 History 변경
- Dockerfile 및 Compose 변경
- GuardDog 실제 설치

## 3. 현재 Scanner 통합 기준

Adapter는 다음 기존 Scanner Domain Contract를 재사용한다.

```ts
interface AnalysisContext {
  requestId: string;
  scanId: string;
  package: {
    name: string;
    version: string;
  };
  artifact: {
    tarballPath: string;
    extractedPath: string;
    hash: string;
    expectedIntegrity?: string;
    registryIntegrity?: string;
  };
  metadata: {
    registryMetadata: Record<string, unknown>;
    packageJson: Record<string, unknown>;
  };
}
```

`AnalyzerResult.analyzerVersion`에는 외부 도구 버전이 아니라 Adapter 구현 버전을
기록한다. GuardDog 실행파일 버전은 GuardDog 전용 결과의 `tool.version`에 별도로
기록한다.

```text
analyzer             = guarddog
analyzerVersion      = 0.1.0
guarddog.tool.version = 3.1.0
```

## 4. 입력

```ts
interface GuardDogAnalyzerInput {
  context: AnalysisContext;
}

interface GuardDogAnalyzerOptions {
  executable: string;
  toolVersion: string;
  workspaceRoot: string;
  timeoutMs: number;
  killGraceMs: number;
  sandboxMode: 'REQUIRED' | 'DISABLED';
  maxOutputBytes: number;
  rules?: readonly string[];
  excludeRules?: readonly string[];
}
```

분석 대상은 다음 경로만 사용한다.

```text
AnalysisContext.artifact.extractedPath
```

Scanner가 검증한 Tarball을 이미 안전하게 압축 해제하므로 초기 구현에서는
GuardDog에 Tarball을 다시 전달하지 않는다.

`rules`와 `excludeRules`는 동시에 사용할 수 없다. 이 조합은 Package별 분석 오류가
아니라 Scanner 설정 오류다. Scanner Bootstrap 또는 GuardDog Provider 생성 시
검증하여 실패시키고 GuardDog를 실행하지 않는다.

```text
rules + excludeRules 동시 설정
→ 설정 오류
→ GuardDog 실행 금지
→ Scanner Bootstrap 또는 Provider 생성 실패
```

## 5. 초기 실행 범위

GuardDog 3.1.0은 로컬 Directory와 Archive 분석을 지원한다. 로컬 Directory를
`--metadata` 없이 전달하면 source-code rule만 실행한다.

초기 구현은 다음 범위로 고정한다.

```text
입력 형태        로컬 압축 해제 Directory
GuardDog 분석    npm source-code rule
Metadata 분석    실행하지 않음
Network 접근     허용하지 않음
```

GuardDog metadata rule을 실행하려면 Scanner의 Registry Metadata를 별도 JSON
파일로 저장한 뒤 `--metadata` 인자를 전달해야 한다. 일부 metadata rule은 DNS 등
외부 Network를 사용할 수 있으므로 Sandbox 및 Network 정책 검증 전에는 활성화하지
않는다. Scanner의 기존 Metadata Analyzer는 GuardDog와 독립적으로 계속 실행한다.

GuardDog 3.1.0은 source-only local-directory scan에서도 Sandbox 적용 전에 외부 순위
및 Package 목록 Cache 갱신을 시도한다. PoC에서는 GitHub, `hugovk.github.io`,
`packages.ecosyste.ms` 연결 시도가 관찰되었다. 따라서 `REQUIRED` Sandbox만으로 전체
프로세스 수명의 Network 차단을 보장한다고 간주하지 않으며, Provider 연결 전 Runtime
수준의 egress 차단 방식을 별도로 확정해야 한다.

## 6. 명령 구성

기본 명령은 다음과 같다.

```bash
guarddog npm scan {canonicalExtractedPath} --output-format=json
```

Node.js에서는 Shell 문자열을 조합하지 않고 실행파일과 인자 배열을 분리한다.

```ts
spawn(executable, [
  'npm',
  'scan',
  canonicalExtractedPath,
  '--output-format=json',
], {
  shell: false,
  detached: true,
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});
```

이 실행 방식은 초기 지원 대상인 Linux와 macOS에 적용한다. `child.unref()`는 호출하지
않으며 부모 Scanner가 Child lifecycle을 끝까지 관리한다.

Rule 포함 및 제외 옵션은 Rule마다 인자를 반복한다.

```text
--rules capability-network-outbound
--rules threat-runtime-environment-read

--exclude-rules capability-network-outbound
--exclude-rules threat-runtime-environment-read
```

`--exit-non-zero-on-finding`은 사용하지 않는다. 해당 옵션을 사용하면 정상 Finding이
있는 실행도 exit code 1을 반환하여 실행 실패와 탐지를 구분하기 어려워진다.

실제 실행 명령은 다음과 같이 실행파일을 포함한 배열로 기록한다.

```ts
[
  executable,
  'npm',
  'scan',
  canonicalExtractedPath,
  '--output-format=json',
]
```

## 7. Sandbox

```ts
type GuardDogSandboxMode = 'REQUIRED' | 'DISABLED';
```

| Mode | 실행 방식 |
|---|---|
| `REQUIRED` | 별도 비활성화 인자 없이 GuardDog 기본 Sandbox를 요구한다. |
| `DISABLED` | 명시적으로 `--no-sandbox`를 전달한다. |

GuardDog 3.1.0은 Linux에서 Landlock, macOS에서 Seatbelt 기반 Sandbox를 사용한다.
Sandbox를 사용할 수 없는 환경에서는 기본적으로 실행을 실패시킨다.

운영 및 통합 환경은 `REQUIRED`를 원칙으로 한다. `DISABLED`는 로컬 개발 또는
제한된 실험 용도로만 사용한다. Adapter는 요청된 Mode와 실제 명령에 반영된 Mode를
실행 결과에 기록한다.

Docker Container 내부의 Sandbox 지원 여부는 이미지 빌드 성공으로 판단하지 않는다.
실제 local-directory scan을 수행하는 Runtime PoC로 검증한다.

## 8. 입력 경로 검증

Adapter는 실행 전에 주입된 `workspaceRoot`와 `extractedPath`를 검증한다. 현재
Scanner가 생성하는 실제 경로 구조는 다음과 같다.

기대 경로는 다음과 같다.

```text
workspaceRoot/
└── {scanId}/
    └── extracted/
```

Provider 연결 단계에서 현재 Runtime의 `SCANNER_TEMP_DIR` 값을 `workspaceRoot` Option에
연결하면 실제 경로는 `${SCANNER_TEMP_DIR}/${scanId}/extracted`가 된다. Adapter는
`ScannerEnvironment`가 `SCANNER_TEMP_DIR`를 직접 제공한다고 가정하거나 환경변수를
직접 읽지 않는다.

검증 기준:

- `scanId`가 안전한 단일 Path segment인지 확인한다.
- `workspaceRoot`와 `extractedPath`가 존재하는 실제 Directory인지 확인한다.
- `workspaceRoot`와 `extractedPath`를 모두 `realpath`로 canonicalize한다.
- canonical `workspaceRoot`에서 `{scanId}`에 해당하는 Scan Workspace Root를 구하고
  해당 Directory도 `realpath`로 canonicalize한다.
- canonical Scan Workspace Root 자체가 canonical `workspaceRoot` 하위인지 확인한다.
- canonical `extractedPath`가 해당 Scan Workspace Root 하위인지 path-segment 경계로
  확인한다.
- symbolic link를 통해 Scan Workspace Root 밖으로 나가는 경로를 거부한다.
- 검증을 마친 canonical path만 실행 인자로 사용한다.

macOS의 `/tmp`와 `/private/tmp`처럼 운영체제가 제공하는 경로 alias는 `realpath`
기준으로 비교한다.

## 9. 프로세스 결과 수집

Adapter는 다음 값을 독립적으로 수집한다.

```text
실행 명령과 인자
Adapter 버전
GuardDog 버전
프로세스 exit code
종료 signal
stdout
stderr
JSON 파싱 성공 여부
실행 시작 및 종료 시각
실행 소요시간
Sandbox Mode
timeout 여부
출력 크기 제한 초과 여부
```

- stdout은 GuardDog JSON 결과로 사용한다.
- stderr는 GuardDog warning 및 fatal 실행 오류로 사용한다.
- stdout과 stderr를 합치지 않는다.
- stdout은 JSON 파싱에만 사용하고 처리가 끝나면 보존하지 않는다.
- stderr는 오류 분류에만 사용하고 처리가 끝나면 보존하지 않는다.
- stdout과 stderr 원문을 Adapter 반환값, `ScanResult`, History, API 응답 또는 일반
  애플리케이션 로그에 포함하지 않는다.
- stdout과 stderr에는 각각 `maxOutputBytes` 제한을 적용한다.
- 제한을 초과하면 프로세스를 종료하고 `FAILED`로 처리한다.

## 10. Timeout 및 종료 처리

- timeout은 Analyzer별 `timeoutMs`로 주입한다.
- timeout 발생 시 `process.kill(-child.pid, 'SIGTERM')`으로 GuardDog 프로세스 그룹에
  Signal을 전달한다.
- `killGraceMs`인 3000ms 안에 종료되지 않으면 같은 방식으로 `SIGKILL`을 전달한다.
- `child.pid`가 없으면 개별 Child에 Signal 전달을 시도한다.
- 이미 종료된 프로세스에 Signal을 보내 발생한 `ESRCH`는 정상 종료 Race로 처리한다.
- timeout 전에 수집한 불완전한 stdout은 Finding으로 사용하지 않는다.
- `error`와 `close` 이벤트가 모두 발생해도 결과를 한 번만 확정한다.
- spawn 실패와 프로세스 종료를 서로 구분한다.
- 결과 확정 시 timeout timer와 kill grace timer를 모두 정리한다.
- 종료 이후 하위 프로세스가 남지 않아야 한다.

프로세스 그룹 종료는 초기 지원 대상인 Linux 및 macOS 기준으로 구현한다. Windows는
초기 지원 범위에서 제외하며, 지원이 필요하면 별도 종료 전략을 추가한다.

## 11. GuardDog 3.1.0 JSON 출력

JSON Reporter는 전체 결과를 stdout에 하나의 JSON Object로 출력한다. GuardDog
내부 rule 오류도 JSON의 `errors`에 포함되며, JSON Reporter 자체 stderr 출력은
비어 있을 수 있다.

초기 Parser가 처리할 최상위 구조는 다음과 같다.

```ts
interface GuardDogRawOutput {
  package?: unknown;
  issues?: unknown;
  errors?: unknown;
  results?: unknown;
  risk_score?: unknown;
  risks?: unknown;
  [key: string]: unknown;
}
```

GuardDog 3.1.0의 관찰된 상세 형태는 다음과 같다.

```ts
interface GuardDogRawOutputV3_1 {
  package: string;
  issues: number;
  errors: Record<string, string>;
  results: Record<string, unknown>;
  risk_score: {
    score: number;
    label: 'no_risks_detected' | 'low' | 'suspicious' | 'high_risk';
    findings_count: number;
    score_breakdown: Record<string, unknown>;
    risks?: unknown[];
  };
  risks: Record<string, unknown>[];
}
```

`risk_score.risks`는 무탐지 경로 등 일부 출력에 존재할 수 있으므로 알 수 없는
추가 필드를 허용한다.

## 12. Parser 기준

GuardDog는 현재 JSON Schema를 제공하지 않으므로 Parser는 경계에서 필요한 필드만
검증한다. 해석 가능한 원본 Object는 Adapter 확장 결과에 필요한 범위로 보존한다.

```text
JSON Object 여부 확인
→ results Object 여부 확인
→ errors Object 여부 확인
→ risks Array 여부 확인
→ risk_score Object 여부 확인
→ 변환 가능한 값만 typed value로 변환
→ 알 수 없는 값은 관련 파싱 원본 Object에 유지
```

`results` 값은 Rule 종류와 탐지 여부에 따라 다음 형태가 될 수 있다.

```text
Source Rule 탐지      Finding Object 배열
Source Rule 무탐지    빈 Object 또는 빈 Collection
Metadata Rule 탐지    문자열
Metadata Rule 무탐지  null
알 수 없는 형태       원본 보존, Finding 생성 안 함
```

최상위 JSON이 유효하더라도 필요한 구조가 잘못되어 안전하게 해석할 수 없으면
실행·출력·파싱 실패로 처리한다. 개별 Rule 값만 해석할 수 없는 경우 전체 결과를
버리지 않고 `PARTIAL` 처리하며 해당 파싱 원본을 보존한다.

## 13. Finding 변환

GuardDog source-code Finding의 관찰된 원본 구조는 다음과 같다.

```ts
interface GuardDogSourceResult {
  location?: string;
  code?: string;
  match?: string;
  message?: string;
  [key: string]: unknown;
}
```

공통 Finding data는 다음 구조를 사용한다.

```ts
type GuardDogFindingType =
  | 'CAPABILITY'
  | 'THREAT_INDICATOR'
  | 'METADATA_FINDING'
  | 'UNKNOWN';

interface GuardDogFindingData extends Record<string, unknown> {
  identifies?: string;
  code?: string;
  match?: string;
  guarddog: {
    resultRuleId: string;
    rawResult: Record<string, unknown>;
  };
}

type GuardDogFinding = Pick<
  Finding<GuardDogFindingData>,
  'findingId' | 'ruleId' | 'type' | 'message' | 'location' | 'data'
>;
```

| Finding 필드 | 생성 기준 |
|---|---|
| `findingId` | Adapter가 안정적인 순서로 생성 |
| `ruleId` | `results` Object의 key |
| `type` | Rule ID prefix 기반 분류 |
| `message` | 원본 `message`, 없으면 Rule 기반 기본 메시지 |
| `location` | 원본 `location`을 파일 경로와 line으로 분리 |
| `data.code` | 원본 `code` |
| `data.match` | 원본 `match` |
| `data.guarddog.rawResult` | 해당 Finding 원본 Object |

Rule 분류 기준:

| Rule ID | Finding Type |
|---|---|
| `capability-*` | `CAPABILITY` |
| `threat-*` | `THREAT_INDICATOR` |
| 향후 활성화된 Metadata Rule | `METADATA_FINDING` |
| 그 외 | `UNKNOWN` |

분류되지 않은 Rule을 폐기하지 않는다. 변환 가능한 Finding은 `UNKNOWN`으로 보존한다.

이 분류값은 GuardDog Parser 내부 Finding 타입이다. Evidence Normalizer가 최종 Evidence를
생성할 때는 Mapping Registry를 통해 Policy 세부 `signal.type`으로 변환한다. 예를 들어
`capability-process-spawn`은 Finding 타입 `CAPABILITY`를 유지하지만 Evidence의
`signal.type`은 `CHILD_PROCESS`가 된다.

### 13.1 `identifies` 처리

GuardDog 3.1.0의 `results` Finding에는 YARA metadata의 `identifies` 값이 포함되지
않는다. Adapter는 Rule ID만으로 `identifies`를 임의 생성하지 않는다.

초기 구현에서는 `identifies`를 선택값으로 유지하고 JSON에 검증된 값이 없으면
생략한다. 향후 GuardDog 버전에 고정된 Rule Metadata manifest를 도입하는 경우에만
manifest에서 값을 보강할 수 있다.

### 13.2 Location 처리

GuardDog source result의 Location은 일반적으로 다음 형식이다.

```text
relative/path/to/file.js:12
```

마지막 `:<positive integer>`를 line number로 분리하고 나머지를 파일 경로로 사용한다.
파일 경로는 Evidence Normalizer가 Artifact root 기준으로 다시 검증할 수 있도록
상대 경로로 유지한다. Location을 안전하게 분리할 수 없으면 원문은 data에 보존하고
공통 `location`은 생략한다.

### 13.3 Finding ID

기존 Scanner Analyzer 관례를 따라 Hash 기반 신규 형식을 만들지 않고 다음 형식을
사용한다.

```text
guarddog:${ruleId}:${occurrenceIndex}
```

- Rule key를 정렬한다.
- 각 Rule의 Finding 배열 순서는 유지한다.
- `occurrenceIndex`는 각 Rule 배열의 0-based index다.
- 같은 JSON 입력에는 결정적으로 같은 ID를 생성한다.
- `scanId`는 Finding ID에 포함하지 않는다.
- Evidence Normalizer는 이 값을 `rawFindingId`로 참조할 수 있다.
- Scan 간 전역 유일성이 필요하다는 별도 Contract가 생기면 후속 변경한다.

## 14. GuardDog Risk 처리

`risks`는 source result Finding과 구분하여 원본 배열로 보존한다.

GuardDog 3.1.0의 관찰된 Risk 필드는 다음과 같다.

```ts
interface GuardDogRawRisk {
  name?: unknown;
  category?: unknown;
  severity?: unknown;
  mitre_tactics?: unknown;
  threat_identifies?: unknown;
  threat_rule?: unknown;
  threat_description?: unknown;
  threat_location?: unknown;
  threat_code?: unknown;
  threat_match?: unknown;
  capability_identifies?: unknown;
  capability_rule?: unknown;
  file_path?: unknown;
  [key: string]: unknown;
}
```

GuardDog Risk는 Threat Finding만으로 형성되거나 Capability Finding과 상관되어
형성될 수 있다. 그러나 JSON Risk에는 Capability Finding의 정확한 위치가 포함되지
않을 수 있다.

초기 Adapter는 다음을 수행하지 않는다.

- Capability Risk를 임의의 Capability Finding에 연결
- Risk의 severity 또는 score 재계산
- JSON에 없는 specificity 및 sophistication 생성
- Risk를 Policy Decision으로 변환

Risk와 Finding 연결 상태(`EXACT`, `PARTIAL`, `AMBIGUOUS`, `UNRESOLVED`) 계산은
후속 Correlation Contract로 남긴다.

## 15. Risk Score와 Tool Assessment

`risk_score`는 GuardDog가 Package 전체에 대해 계산한 선택적 Tool Assessment로
분리한다.

```ts
interface GuardDogToolAssessment {
  tool: {
    name: 'guarddog';
    version: string;
  };
  score: number;
  label:
    | 'no_risks_detected'
    | 'low'
    | 'suspicious'
    | 'high_risk';
  findingsCount: number;
  scoreBreakdown: Record<string, unknown>;
  raw: Record<string, unknown>;
}
```

변환 기준:

```text
risk_score.score           → score
risk_score.label           → label
risk_score.findings_count  → findingsCount
risk_score.score_breakdown → scoreBreakdown
```

처리 원칙:

- 원본 Score와 Label을 그대로 보존한다.
- Scanner가 Score를 다시 계산하지 않는다.
- GuardDog Label을 ALLOW, REVIEW, REJECT로 직접 변환하지 않는다.
- `no_risks_detected`를 Package가 안전하다는 의미로 해석하지 않는다.
- `findingsCount`를 `results` Finding 개수 또는 Risk 개수로 재해석하지 않는다.
- 원본 `risk_score` Object를 `raw`에 함께 보존한다.

## 16. GuardDog Error 변환

현재 Scanner 공통 Domain에는 GuardDog 전용 Error Code가 없다. 1차 구현은 공용
Contract를 변경하지 않고 기존 Code를 사용한다.

```ts
interface ScanError {
  code: 'INTERNAL_ERROR';
  stage: 'ANALYZER:GUARDDOG';
  analyzer: 'guarddog';
  message: string;
  retryable: false;
}
```

GuardDog의 `errors`는 일반적으로 Rule ID 또는 실행 단계 이름을 key로 하고 오류
메시지를 value로 가지는 Object다. Adapter 내부에서는 spawn 실패, timeout,
non-zero exit, 빈 출력, invalid JSON, GuardDog 보고 오류, Sandbox 미지원, 출력 제한
초과를 구분한다. 이 분류는 공용 Error Code가 아니며 외부 Contract에 노출하지 않는다.

공통 `message`에는 구체적인 실패 원인을 구분할 수 있는 최소 정보만 포함한다. stderr
전체, 인증정보, 절대 작업 경로 등 민감정보는 제거한다. GuardDog 전용 공용 Error
Code 추가는 후속 Domain Contract 변경으로 분리한다.

## 17. 실행 상태 판정

상태 판정은 다음 우선순위를 따른다.

| 우선순위 | 조건 | Analyzer 상태 |
|---|---|---|
| 1 | timeout | `TIMEOUT` |
| 2 | spawn 실패 | `FAILED` |
| 3 | 출력 크기 제한 초과 | `FAILED` |
| 4 | non-zero exit | `FAILED` |
| 5 | stdout 없음 | `FAILED` |
| 6 | JSON 파싱 또는 필수 구조 검증 실패 | `FAILED` |
| 7 | 일부 Rule 결과 해석 실패 또는 `errors` 존재 | `PARTIAL` |
| 8 | exit code 0, JSON 정상, 오류 없음 | `SUCCESS` |

`SKIPPED`는 Adapter의 일반 실행 결과로 만들지 않는다. Analyzer 비활성화 또는 실행
조건 불충족을 Orchestrator가 명시적으로 결정한 경우에만 사용한다.

정상 무탐지는 다음 조건으로 판단한다.

```text
exitCode = 0
JSON parse 성공
errors = {}
risks = []
results에 유효 Finding 없음
```

`risk_score.label = no_risks_detected` 또는 `issues = 0`만으로 성공 여부를 판단하지
않는다.

## 18. Raw Result 처리 범위

1차 구현은 Raw Result Storage를 사용하지 않는다.

- stdout은 GuardDog JSON 파싱에만 사용하고 처리 후 폐기한다.
- stderr는 오류 분류에만 사용하고 처리 후 폐기한다.
- stdout 및 stderr 원문을 Adapter 반환값, `ScanResult`, History, API 응답 또는 일반
  로그에 포함하지 않는다.
- Finding별 해석 가능한 원본 Object는 `data.guarddog.rawResult`에 보존할 수 있다.
- GuardDog `risks` 원본 배열과 `risk_score.raw`는 Adapter 확장 결과에 보존할 수 있다.
- 실행 명령 및 종료정보는 원문 출력과 분리된 구조화된 값으로 기록한다.

전체 stdout, stderr 및 전체 JSON의 장기 저장과 Reference 생성은 후속 Raw Result
Storage Contract로 분리한다. 저장소 부재 또는 저장 실패는 1차 상태 판정 조건이
아니며, Orchestrator 연결의 선행 조건도 아니다.

## 19. Adapter 출력

```ts
type GuardDogAnalyzerResult = Pick<
  AnalyzerResult<GuardDogFinding>,
  | 'requestId'
  | 'scanId'
  | 'analyzer'
  | 'analyzerVersion'
  | 'status'
  | 'findings'
  | 'errors'
  | 'execution'
> & {
  guarddog: {
    tool: {
      name: 'guarddog';
      version: string;
    };
    issuesRaw?: number;
    risks: Record<string, unknown>[];
    toolAssessment?: GuardDogToolAssessment;
    execution: {
      command: string[];
      exitCode: number | null;
      signal: NodeJS.Signals | null;
      jsonParsed: boolean;
      timedOut: boolean;
      outputLimitExceeded: boolean;
      sandboxMode: 'REQUIRED' | 'DISABLED';
    };
  };
};
```

공통 Domain 타입 자체는 변경하지 않는다. 1차 GuardDog 반환 타입은 위 공통 필드만
선택하며 원문 저장용 Reference 필드를 제공하거나 설정하지 않는다.

공통 실행 시간은 기존 `AnalyzerResult.execution`에 기록한다.

```ts
execution: {
  startedAt: string;
  completedAt: string;
  durationMs: number;
}
```

GuardDog 전용 `execution`은 프로세스 추적에 필요한 구조화된 값만 가진다.

## 20. 환경설정

초기 환경변수는 다음을 사용한다.

```env
GUARDDOG_BIN=guarddog
GUARDDOG_VERSION=3.1.0
GUARDDOG_TIMEOUT_MS=60000
GUARDDOG_KILL_GRACE_MS=3000
GUARDDOG_SANDBOX_MODE=REQUIRED
GUARDDOG_MAX_OUTPUT_BYTES=10485760
```

설정 기준:

- `GUARDDOG_TIMEOUT_MS`, `GUARDDOG_KILL_GRACE_MS`, `GUARDDOG_MAX_OUTPUT_BYTES`는
  positive safe integer다.
- `GUARDDOG_KILL_GRACE_MS`의 초기 기본값은 3000ms다.
- `GUARDDOG_SANDBOX_MODE`는 `REQUIRED` 또는 `DISABLED`만 허용한다.
- 빈 실행파일 경로와 버전은 허용하지 않는다.
- Adapter는 설정된 버전뿐 아니라 실제 `guarddog --version` 결과를 검증한다.
- 실제 버전이 설정과 다르면 Scanner readiness 또는 실행을 실패시키는 방안을
  Runtime PoC 후 확정한다.
- `workspaceRoot`는 Adapter Option으로 주입한다. 현재 `ScannerEnvironment`가
  `SCANNER_TEMP_DIR`를 제공한다고 가정하지 않으며, 후속 Provider 연결 단계에서 실제
  Runtime 설정과 연결한다.
- `rules`와 `excludeRules`의 상호 배타성은 Scanner Bootstrap 또는 Provider 생성
  단계에서 검증한다.

## 21. Docker Runtime PoC 관찰 결과

2026-08-26 PoC에서 Node 24 Scanner Runtime image에 GuardDog 3.1.0을 Semgrep과
분리된 `/opt/guarddog` Python virtual environment로 설치했다. Compose 권한과
Security Option은 변경하지 않았다.

확인된 결과:

- Runtime Node 버전은 `v24.19.0`, `guarddog --version` 출력은 `3.1.0`이다.
- `npm scan`은 local directory, JSON output, 반복 가능한 `--rules` 및
  `--exclude-rules`, `--sandbox/--no-sandbox`를 지원한다.
- 정상 및 탐지 Fixture 모두 stdout에 단일 JSON Object를 출력하고 exit code 0으로
  종료했다.
- 최상위 필드는 `package`, `results`, `errors`, `issues`, `risk_score`, `risks`였고,
  무탐지 source rule 값은 빈 Object였다.
- 탐지 결과는 Finding Object 배열이며 `location`, `code`, `match`, `message`가
  포함되었다. 현재 Parser는 실제 출력에서 Warning 없이 Finding, Risk 및 Tool
  Assessment를 변환했다.
- 실제 source Finding에는 `identifies`가 없었다. 탐지 Fixture에서 `issues`는 6,
  `risk_score.findings_count`는 4여서 두 값을 Finding 개수로 동일하게 해석하지 않는
  기존 기준이 확인되었다. 무탐지 출력에는 `risk_score.risks`가 있었지만 탐지
  출력에는 없었으므로 해당 필드는 계속 선택값으로 취급한다.
- `REQUIRED` Mode에서 컨테이너 내부 `/tmp/scanner` 계열 Directory의 Landlock Scan과
  탐지가 성공했다. `--no-sandbox` 실행은
  `Scanning without kernel-level sandbox protection` 경고를 stderr에 출력했다.
- 동일 Runtime에서 nono-py Sandbox 적용 후 loopback TCP 연결은 `EACCES`로
  차단되었다. 이는 Sandbox 적용 이후 Network 차단의 근거이며, 적용 전에 발생하는
  Cache 갱신 시도까지 차단한다는 근거는 아니다.
- 임시 seccomp profile로 Landlock syscall을 차단하면 exit code 1, 빈 stdout 및
  Sandbox unavailable 오류로 명시적으로 실패했다. 자동 `--no-sandbox` 전환은
  발생하지 않았다.
- Docker bind mount를 GuardDog에 직접 전달한 경우 nono-py 0.16.0의 Landlock 적용 후
  Directory 열람과 파일 읽기가 `EACCES`로 거부되었지만 GuardDog는 `errors` 없이
  무탐지 결과를 반환했다. 현재 Compose Scanner는 작업 Directory용 Volume이 없고
  `${SCANNER_TEMP_DIR}`가 Container filesystem에 있으므로 현재 경로에서는 재현되지
  않는다. 향후 Scanner Workspace를 Volume 또는 bind mount로 변경하면 필수 회귀
  검증 대상으로 삼는다.
- 동일한 실험에서 Docker anonymous Named Volume은 Landlock REQUIRED 상태에서도
  파일을 읽고 정적 Finding을 반환했다. 따라서 문제가 모든 Volume 유형에 일반화되는
  것은 아니며, bind mount 도입 여부를 별도로 계약해야 한다.
- `--network none`에서도 source scan은 완료되었으나, Sandbox 적용 전에 외부 Cache
  갱신을 시도하고 실패 내용을 stderr에 기록했다. 현재 Compose의 `whs` bridge는
  `internal` Network가 아니므로 Provider 연결 전 egress 정책을 확정해야 한다.
- 4차 Hardening에서는 공식 `GUARDDOG_TOP_PACKAGES_CACHE_LOCATION`을
  `/opt/guarddog-cache`로 지정하고 Image Build 중 metadata detector를 초기화해
  Cache를 prewarm한다. npm·PyPI·RubyGems Cache가 30일보다 오래된 상태로 남으면
  Image Build를 실패시킨다. Prewarmed Image는 기본 Network에서도 source scan 시
  외부 Cache 갱신 stderr 없이 exit 0으로 동작했다. 이는 Cache 만료 이후의 영구적인
  Runtime 차단 Option이 아니므로 별도 egress 정책은 여전히 필요하다.
- 실제 Analyzer를 10ms timeout으로 실행했을 때 `TIMEOUT`과 `SIGTERM`이 기록되었고,
  250ms 뒤 GuardDog 또는 하위 Python 프로세스가 남지 않았다. 실제 GuardDog가 Grace
  Period 안에 종료되어 Runtime PoC에서는 `SIGKILL` 경로가 발생하지 않았다.

운영 환경에서는 Sandbox 실패 시 자동으로 `--no-sandbox`로 전환하지 않는다.

## 22. 결과 보존 및 후속 통합

1차에서는 GuardDog 확장 결과를 Adapter 반환값까지만 유지한다.

```text
GuardDogAnalyzerResult
├── 공통 AnalyzerResult
│   ├── status
│   ├── findings
│   ├── errors
│   └── execution
└── GuardDog 전용 결과
    ├── tool
    ├── risks
    ├── toolAssessment
    └── process execution
```

현재 Orchestrator가 최종 `ScanResult`를 구성할 때 Analyzer 확장 결과를 보존할 필드가
없다. 따라서 1차에서는 Adapter Unit Test에서만 `risks`, `toolAssessment`와 process
execution을 검증한다.

현재 Evidence Mapping Registry에는 GuardDog Rule이 없다. GuardDog Finding을 그대로
Normalizer에 전달하면 모두 `UNMAPPED`가 되어 정상 Scan도 `PARTIAL`이 될 수 있다.
그러므로 AnalyzerModule Provider 등록과 `runAnalyzers()` 연결은 1차 범위에서 제외한다.
후속 연결 시에는 다음 Contract를 별도로 확인한다.

- GuardDog Finding의 초기 Evidence Mapping 범위
- GuardDog `FAILED` 또는 `TIMEOUT`이 전체 Scan 상태에 미치는 영향
- Tool Assessment 및 Risk의 최종 저장 위치
- Unmapped GuardDog Finding 처리 정책

Adapter는 실패를 throw하여 다른 Analyzer 결과를 유실시키지 않고
`GuardDogAnalyzerResult`의 상태와 오류로 반환해야 한다. 입력 Contract 위반과 같은
프로그래밍 오류만 예외로 처리한다. 단, `rules`와 `excludeRules` 동시 설정은 Package별
결과가 아니라 Bootstrap 또는 Provider 생성 실패로 처리한다.

## 23. 테스트 기준

### 23.1 Command 및 입력

- 기본 명령과 인자 순서
- Rule 포함 및 제외 반복 인자
- `rules`와 `excludeRules` 동시 입력 거부
- `DISABLED`에서만 `--no-sandbox` 추가
- `shell: false`, `detached: true`, `windowsHide: true`와 지정된 `stdio` 사용
- `child.unref()` 미호출
- 허용 root 밖 경로 및 symbolic link 이탈 거부
- `workspaceRoot` 및 `extractedPath`의 canonical path 검증

### 23.2 Process

- 정상 exit code와 stdout/stderr 수집
- executable `ENOENT`
- non-zero exit
- timeout과 프로세스 그룹 종료
- 3000ms grace period 이후 강제 종료
- `child.pid` 부재 fallback 및 `ESRCH` Race 처리
- timeout 및 kill timer 정리
- stdout 및 stderr 크기 제한
- 이벤트 중복 완료 방지

### 23.3 Parser 및 변환

- 정상 무탐지
- 정상 Capability 및 Threat 탐지
- `UNKNOWN` Rule 보존
- 빈 Object 형태의 무탐지 Rule
- GuardDog `errors` Object 변환
- 빈 stdout 및 invalid JSON
- 필수 최상위 구조 오류
- 일부 Rule 결과 형태 오류
- Location 및 line number 분리
- Risk 원본 무손실 보존
- Risk Score snake_case 변환
- JSON에 없는 `identifies`를 생성하지 않는지 확인
- Rule key 정렬, Rule 내부 순서 유지 및 결정적 Finding ID
- stdout 및 stderr가 결과에 포함되지 않는지 확인

### 23.4 상태 및 오류

- timeout은 `TIMEOUT`
- 실행, 출력 및 파싱 실패는 `FAILED`
- 일부 Rule 해석 실패 또는 GuardDog 내부 오류는 `PARTIAL`
- 정상 실행 및 정상 파싱은 `SUCCESS`
- 공통 오류가 `INTERNAL_ERROR`, `ANALYZER:GUARDDOG`, `guarddog`을 사용하는지 확인
- 오류 메시지의 stderr 원문 및 민감정보 제거

AnalyzerModule, Orchestrator, Evidence Normalizer 및 Docker Runtime 검증은 1차 Unit Test
완료 조건에 포함하지 않는다.

## 24. 확정된 1차 구현 범위

### 포함

- `guarddog.types.ts`
- `guarddog-process.runner.ts`
- `guarddog-output.parser.ts`
- `guarddog.analyzer.ts`
- Command 구성
- 경로 검증
- Timeout 및 Process Group 종료
- stdout 및 stderr 크기 제한
- JSON Parser
- Finding, Risk 및 Tool Assessment 분리
- 상태 및 공통 오류 변환
- Unit Test

### 제외

- DI Provider
- Orchestrator 연결
- Evidence Mapping
- `ScanResult` 및 History 변경
- Raw Result Storage
- Dockerfile 및 Compose 변경
- GuardDog 실제 설치
- Metadata Rule
- Retry
- Policy 연동

## 25. 보안 기준

- Package code와 lifecycle script를 직접 실행하지 않는다.
- GuardDog 실행 인자에 사용자 입력을 Shell 문자열로 삽입하지 않는다.
- Artifact 허용 root 밖의 파일을 분석하지 않는다.
- 초기 source scan에서 Network 접근을 허용하지 않는다.
- stdout 및 stderr 원문을 일반 로그와 외부 응답에 노출하지 않는다.
- stdout 및 stderr에 크기 제한을 적용한다.
- timeout 이후 GuardDog와 하위 프로세스를 정리한다.
- GuardDog 및 Python Dependency 버전을 고정한다.
- GuardDog가 생성한 Score를 Scanner의 보안 판정으로 사용하지 않는다.

### 25.1 Runtime 불변식

- 운영 Mode는 `REQUIRED`이며 운영에서 자동 `--no-sandbox` Fallback을 사용하지 않는다.
- 분석 대상은 Scanner가 소유한 내부 `${SCANNER_TEMP_DIR}/${scanId}/extracted`
  Workspace로 제한한다.
- Bind Mount 또는 Named Volume 등 Workspace 유형을 변경하면 Sandbox Smoke Test를
  다시 수행한다. 현재 PoC에서는 Named Volume은 동작했지만 Bind Mount는 Landlock
  이후 무탐지 Silent Miss가 관찰되었다.
- GuardDog Cache 갱신은 Image Build 시 prewarm하고 공식
  `GUARDDOG_TOP_PACKAGES_CACHE_LOCATION` 경로를 사용한다. Cache 만료 및 Runtime
  egress 정책은 Provider 연결 전에 재검증한다.
- 관찰된 비치명적 Cache stderr만 성공 실행에서 허용하며, 알 수 없는 stderr는 원문을
  노출하지 않고 `PARTIAL`로 분류한다.
- GuardDog 3.1.0의 실제 JSON Fixture를 Parser 회귀 기준으로 유지한다.
- GuardDog 버전 또는 `nono-py` 등 Sandbox Dependency를 변경하면 Runtime Scan과
  Sandbox Smoke Test를 다시 수행한다.

## 26. 미확정 사항

다음 항목은 Adapter 초기 구현에서 임의로 확정하지 않는다.

- 전체 stdout, stderr 및 JSON용 Raw Result Storage와 Reference Contract
- Scan 간 전역 유일 Finding ID가 필요한지 여부
- GuardDog 전용 공용 Error Code 도입 여부
- GuardDog metadata rule 활성화 여부
- Metadata 분석에 필요한 제한적 Network 정책
- GuardDog Rule Metadata manifest 도입 여부
- GuardDog Finding의 Evidence Mapping
- GuardDog Risk와 Finding의 연결 상태 계산
- `ScanResult.toolAssessments` 추가 여부
- GuardDog 실패가 전체 Scan 상태에 미치는 최종 정책
- Sandbox 적용 전 GuardDog Cache 갱신 시도를 차단할 Runtime egress 정책
- GuardDog의 비치명적 Cache 갱신 stderr를 Analyzer 상태에 반영할지 여부
- Scanner Workspace를 Volume 또는 bind mount로 전환할 때의 Landlock 호환 방식
- GuardDog 3.2 이상으로 업그레이드하는 기준
