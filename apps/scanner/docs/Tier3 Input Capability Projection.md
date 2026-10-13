# Tier3 입력의 capability 중복 제거 검증 (#416)

> **2026-09-30 관리 통합:** 검증했던 `2cdb3bb`의 전체 코드 조합과 #404 문서를 이제 #417 브랜치에 포함했다. 아래의 “#417 단독 HEAD가 아님” 및 “0edda27 원격 미반영”은 실험 당시 이력이다. 현재 통합 범위·보류 항목·재개 조건은 [통합 인수인계](Tier2%20Consolidation%20Handoff.md)를 기준으로 한다. dev에는 아직 병합하지 않았다.

## 최신 검증: 고정 통합 후보의 139건 회귀 (2026-09-30)

**실행 안정성과 입력 축소는 확인했지만, 후보 선별 성능이 전반적으로 좋아졌다고 볼 수는 없다.** 기존 악성 입력 후보의 추가 이탈은 0건이며, 정상 입력 후보는 2건 늘었다. 실제 LLM 호출·최종 Policy 판정은 검증하지 않았다.

### 검증한 코드와 범위

최신 dev `736761f`에 진단/이미지 ID 지원 `f815759`(#402), 문자열 복원 보강 `0edda27`(#414의 로컬 후속 커밋 포함), 입력 최적화/사전검사 `d805a5e`(#417)를 **별도 로컬 worktree에서 전체 통합**했다. 파일 일부만 복사한 이전 검증과 구분한다.

- 고정 통합 commit: `2cdb3bb7305da198044b65c310b32fecd9030c81`.
- 고정 tree: `9ac7ae3bab5ac4844fccbe1356a620218edc8f32`.
- 충돌 없이 통합됐으며 계측 과정에서 tracked application 소스는 변경하지 않았다.
- **GitHub dev에 merge된 코드도, PR #417 단독 HEAD도 아니다.** 실제 통합 시 이 소스 조합을 포함해야 같은 검증 결과를 근거로 사용할 수 있다. 특히 `0edda27`은 검증 시점에 원격 #414에 아직 반영되지 않은 로컬 후속 커밋이다.
- Node 24.18.0 / isolated-vm 6.2.0, 같은 아카이브 해시·분석기 이미지·룰셋·입력 예산을 확인했다.
- 기존 140개 중 완료됐던 **악성 70·정상 69 = 139개**를 고정했다. 이전 FAILED `katex-0.16.11.tgz`는 계속 제외 기록으로 남긴다. 새 실패 표본을 임의로 제외하는 방식이 아니다.
- GuardDog On만 재실행했다. 같은 실행의 첫 4표본은 이전 Node24 결과와 후보 판단·근거 수·입력 bytes가 모두 일치해야 나머지를 진행하도록 검사했고 통과했다.
- 패키지 전체/설치 스크립트는 실행하지 않았다. 다만 구조 복원기 webcrack은 격리된 V8에서 문자열 디코더 조각을 평가할 수 있으므로, 모든 복원 과정이 AST 변환만으로 이루어진다는 뜻은 아니다.

### 같은 표본에서의 후보 선별 전후 비교

| 지표 | 악성: 이전 → 통합 후보 (70개) | 정상: 이전 → 통합 후보 (69개) |
| --- | ---: | ---: |
| Tier1 Finding ≥ 1 | 69 → 69 | 41 → 41 |
| legacy 입력 생성 | 58 → 58 | 11 → 11 |
| 신규 Shadow 게이트의 심층 분석 후보 | 1 → 1 | 4 → 5 |
| 신규 Shadow 입력 생성 | 1 → 1 | 3 → 5 |
| **둘 중 하나 이상에서 입력 생성** | **58 → 58** | **13 → 15** |

각 행은 다른 단계다. 특히 `69/70`은 Tier1 신호 기준이며 실제 Tier3 입력 생성률이 아니다. legacy와 Shadow도 서로 독립적이므로 58→1을 필터링 전후나 비용 절감으로 해석하지 않는다. `NO_HANDOFF`는 게이트가 안전하다고 판정한 것이 아니라 평가 경로에 들어가지 못한 상태다.

기존 악성 입력 후보 58개는 모두 유지됐다. 하지만 악성 12개는 이전과 동일하게 두 경로 모두 입력이 없었다. 이 중 11개에는 Tier1 신호가 있고 `ajax-cuuu` 1개는 신호도 없다. 이 표본의 **최종 Policy 결정은 미측정**이므로 12개를 전체 시스템 미탐이라고 단정하거나, 반대로 정적 단계에서 모두 차단했다고 주장하지 않는다.

정상 입력이 늘어난 두 사례:

- `@babel/parser@7.26.2`: 미복원/NO_HANDOFF → RESTORED, Tier2 Evidence 5건, 분석기 불일치/의미 관계 미확정 사유로 신규 입력 생성.
- `axios-mock-adapter@2.1.0`: 기존에도 게이트 후보였지만 NO_TARGETS였다. 재분석 Evidence 1건이 생겨 입력 생성 가능해졌다. PARTIAL_RESTORED 상태와 게이트 후보 판단은 그대로다.

이 변화는 게이트 임계값을 수정한 결과가 아니다. 복원·재분석의 입력 변화에 따른 관측이며, 정상 후보 감소 성과는 아니다. 복원 상태가 미복원으로 바뀐 `oj-cropper`, `cxday`, `chokidar-next`도 있었지만, 셋 모두 기존부터 신규 게이트에서는 전달하지 않았고 legacy 입력은 유지됐다. 복원률이 모든 표본에서 개선됐다고도 주장하지 않는다.

### 입력 크기·무결성·실패 검증

139개 중 신규 입력이 생성된 **6개(정상 5·악성 1)** 모두 동일 execution으로 이전/수정 Builder를 비교했다. 이는 과거 4개 입력 합계와 새 6개 합계를 직접 비교한 값이 아니다.

- JSON 합계: **5,463,274 → 2,224,850 bytes, 59.3% 감소**.
- 코드 본문 합계: 전후 **146,638 bytes로 동일**.
- 수정 후 Schema/참조 검사, 전체 입력 역복원 동등성, execution/Resolver/registry 불변: 6개 모두 통과.
- 기존 4표본만 보면 앞서 기록한 60.9% 감소가 그대로 재현된다. 4표본 60.9%와 6표본 59.3%의 분모를 혼용하지 않는다.
- 139/139 COMPLETED. 분석 실패/정규화 오류/재분석기 실패/입력 생성 실패 0건. 복원 진단의 FAILED도 0건이지만 UNRESOLVED·PARTIAL_RESTORED는 존재하며 성공으로 바꾸어 세지 않았다.
- 고정 통합 후보의 Scanner **75 suites / 1,276 tests**, typecheck/build 통과. 별도 오프라인 집계·회귀 검증 **26 tests** 통과.

### 근거와 남은 판단

원본 실험은 덮어쓰지 않았다. 로컬 Git 제외 디렉터리 `reports/validation/`에 다음 자료를 보존한다.

- `omc-139-final-manifest-2026-09-30.json`: 고정 대상과 아카이브 해시.
- `omc-139-final-integrated-2026-09-30.json`: 실제 통합 후보 실행. SHA-256 `cd1a44fca4a6d1b4eb7b808107f9ff1583d812e08da08d39bb11bcc7a6f2de95`.
- 같은 이름의 `.run.json`/`.checkpoint.jsonl`: 실행 출처 및 표본별 중간 결과.
- `omc-139-final-regression-2026-09-30.json`: 지표별 변화·미선별 악성 12개·품질 검사·입력 크기 비교.
- `omc-139-final-snapshot/`: 통합 소스 버전·계측 파일·해시·재현 설명.
- `omc-final-regression.mjs`/`.spec.mjs`: 실패를 정상 제외로 세지 않는 오프라인 비교 도구와 테스트.

이번 회귀 검증은 **기존 후보 보존 및 실행 안정성 확인**이며 “게이트 개선 완료” 판정이 아니다. 다음 정책 검토 대상은 정상 추가 입력 2개와 기존 악성 미입력 12개의 처리다. #359에서 legacy/신규 경로 역할과 정적 Policy 처리 관계를 합의하기 전에는 전달 조건이나 legacy 제거를 임의로 바꾸지 않는다. 이전 실행의 Node/dirty 정보가 부족하므로 개별 변화의 원인을 특정 커밋 하나로 단정하지 않는다.

## 후속 검증: 지원 런타임 Node 24 (2026-09-30)

Scanner의 `engines.node`는 `>=24.0.0 <25`다. 기존 임시 worktree에서 선택된 Node 26 대신 설치된 **Node 24.18.0 실행 파일을 명시**하자 native 모듈이 정상 로딩됐다. 의존성 재설치나 복원 코드 수정 없이 같은 4개 표본을 전부 재검증했다.

| 표본 | 이전 JSON bytes | 수정 JSON bytes | 감소율 |
| --- | ---: | ---: | ---: |
| ejs@3.1.10 | 236,863 | 218,252 | 7.9% |
| stream-transform@3.3.3 | 4,899,407 | 1,707,754 | 65.1% |
| @angular/cdk@19.0.1 | 129,590 | 125,198 | 3.4% |
| vibranced@1.4.45 (악성) | 24,343 | 17,635 | 27.6% |
| **정상 3개 + 악성 1개 합계** | **5,290,203** | **2,068,839** | **60.9%** |

4개 모두 수정 후 Schema/의미 참조 검사, 전체 입력의 역복원 동등성, execution/Resolver/registry 불변을 통과했다. 코드 본문 합계는 전후 모두 87,485 bytes였다. 이 수치는 지원 런타임에서 수행한 동일 실행 내 전후 Builder 비교이며 아래 Node 26의 3표본 결과와 섞어 계산하지 않았다.

`vibranced`는 `lib/custom/spawn.js` 1개 파일이 RESTORED, Tier2 Evidence 4건, 신규 게이트 `shouldEscalate=true`, legacy/Shadow 입력 모두 BUILT였다. 줄 대응은 `LINE_MAPPING_UNMAPPED`이므로 정확한 원본 줄 매핑까지 성공했다고 표현하지 않는다. 실제 LLM 호출은 0회다. “악성 1개가 후보에서 유지되고 입력이 생성됐다”는 확인이지 일반적인 탐지 성능의 증명은 아니다.

후속 원본 보고서: 로컬 `reports/validation/tier3-input-4-replay-node24-2026-09-30.json`, SHA-256 `1b89a32121beea4f0d8d04e7e7a21cb13408870b4850adb42d0102f75f1d5dbc`. 구현·복원·분석기 버전은 아래와 동일하며 계측용 스크립트에 Node 실행 파일/버전·OS·architecture 기록만 추가했다. 이전 실패 보고서는 보존한다.

발표에는 **이 후속 결과를 우선 사용**한다. 권장 문장: “정상 3개·악성 1개의 고정 표본에서 증거와 코드 연결 정보를 유지하며 Tier3 입력 JSON 합계를 60.9% 줄였고, 악성 사례도 심층 분석 후보로 선별해 입력 생성까지 확인했다. LLM 판단·비용과 일반적인 탐지 성능은 별도 검증 대상이다.”

### 재발 방지와 복원 실패 경로 검증

이 후속 작업은 사용자 요청에 따라 #416 / #417에 통합했다. 중복 생성된 #418은 종료했으며 별도 PR을 만들지 않았다.

- pilot은 `package.json`의 기존 `engines.node` 범위, `--no-node-snapshot` 플래그, webcrack이 사용하는 native sandbox 로딩과 무해한 `1 + 1` 평가를 **표본 추출·Docker 실행 전에** 확인한다.
- 실패 시 `SCANNER_NODE_UNSUPPORTED`, `SCANNER_NODE_SNAPSHOT_FLAG_REQUIRED`, `SCANNER_NATIVE_PREFLIGHT_FAILED` 등으로 중단한다. 지원 버전이나 의존성을 자동으로 변경하지 않는다.
- `npm run pilot:omc-tier1-tier2`에 `--no-node-snapshot`을 반영했다. 먼저 지원 Node를 선택하고 Scanner를 빌드해야 한다. 수동 실행에도 같은 플래그가 필요하다.
- 보고서 `execution.runtimePreflight`에 Node 버전/실행 파일, OS/architecture, 요구 버전 범위, native 버전과 smoke 결과를 기록한다. 임의 환경변수 내용은 복사하지 않는다. 위 4표본 보고서는 이 사전검사 도입 직전에 생성됐으므로 별도 `nodeVersion` 등의 계측 필드를 사용한다.
- Node 24.18.0 / isolated-vm 6.2.0에서 native smoke 통과. 실제 pilot 시작 경로로 Node 26 거부, 플래그 누락 거부, 정상 런타임 통과 후 다음 설정 검사 진입을 확인했다. 표본을 추가로 실행하지 않았다.

실제 Orchestrator·Normalizer·RISK_BASED trigger·legacy input builder에 **복원 예외 / 복원 결과 0개**를 각각 주입한 회귀 테스트를 추가했다. 분석기 출력과 LLM runner는 mock이고, 입력 코드도 직접 만든 무해한 fixture다. 두 경우 모두 Tier1 Evidence ID·신호·출처·위치 보존, legacy 입력/코드 슬라이스 생성, Policy 전달 자격 유지를 확인했다. 신규 경로는 `NO_TIER2_HANDOFF`이고 신규 runner는 호출하지 않았다.

이는 **독립적인 legacy 경로가 유지되는 현재 동작**의 검증이지, 신규 경로가 원본 분석으로 자동 fallback한다는 의미가 아니다. 실제 Policy 결정이나 LLM 판정도 검증하지 않았다. #359의 경로 대체 합의 전에는 legacy를 제거하면 안 된다.

최종 로컬 검증은 Node 24.18.0을 PATH로 명시하여 수행했다.

```sh
npm test -- --runInBand src/performance/scanner-runtime-preflight.spec.ts test/application.spec.ts test/tier3-runtime-integration.spec.ts
npm test -- --runInBand
npm run typecheck
npm run build
```

관련 3 suites / 84 tests, 전체 **73 suites / 1,193 tests**, 타입 검사·빌드·diff 검사 통과. 처음 실행에서는 Scanner 하위 폴더의 셸이 다시 Node 26을 선택해 사전검사가 실패했고, 새 테스트의 legacy `file`/upstream `path` 비교 가정을 수정한 후 지원 런타임에서 재검증했다. 실패 이력을 성공 결과로 바꾸어 기록하지 않는다. GitHub CI 재시도와 merge는 별도다.

### 발표 1~2장에 담을 내용

1. **복원과 재분석:** 원본 → 구조/문자열 복원 → 재분석 → Tier3 후보 선별·입력 생성. `vibranced`의 복원 1파일/재분석 Evidence 4건/후보 선별·입력 생성 사례를 보여준다. 원본 줄 매핑 미완료와 실제 LLM 미호출을 표시한다.
2. **전달 입력 개선:** 정상 3·악성 1의 동일 실행 내 전후 비교에서 JSON 5,290,203 → 2,068,839 bytes, 합계 60.9% 감소. 코드 본문 87,485 bytes 및 근거 연결 보존. “중복 검증 정보 제거”라고 설명하며 코드 축소나 비용 절감률이라고 표현하지 않는다.

이 4개는 과거 Shadow 입력 생성 사례에서 고른 표본이므로 무작위 성능 평가가 아니다. 후보 선별률이나 정상 오탐률을 추정하지 않는다. 전체 139건/600건 평가, 다른 브랜치의 복원 수정, 실제 LLM 검증과 구분한다.

## 최초 검증 기록: Node 26 (아래 결과 및 미완료 사항은 당시 기준)

2026-09-30, 기존 Shadow 입력 생성 표본 4개를 정적으로 재분석했다. 현재 복원 코드에서 입력이 생성된 **3개 정상 표본**에 동일한 execution을 넣어 이전/수정 Builder를 비교한 결과, JSON 합계가 5,265,860 → 2,051,204 bytes로 **61.0% 감소**했다. 증거·코드·연결 정보를 버린 것이 아니라 반복된 파일별 capability 검증 정보를 공통 위치에 보관한 결과다.

이는 입력 직렬화 개선의 소규모 검증이다. 악성 탐지율, Tier3 전달률, LLM 토큰·비용·응답 시간 개선의 증거가 아니다. LLM은 호출하지 않았다. 악성 표본 `vibranced`는 현재 Node 26.5.0/darwin arm64 환경의 native 모듈 빌드 부재로 STRUCTURE 단계가 실패하여 Builder 이전 단계의 Handoff가 없어 비교에서 제외했다. 이를 정상 판정이나 안전성 검증으로 해석하지 않는다. 기존 legacy 입력은 여전히 생성됐다.

## 문제와 수정 범위

Tier2 Evidence마다 전체 파일의 `CapabilityValidation`이 반복되고, 같은 값이 최상위 `capabilityPreservation.files[*].validation`에도 있었다. 특히 `stream-transform`의 수정 전 `atomicEvidences`는 3,424,232 bytes였다.

`AgentInputV0_3Builder`의 입력 투영 단계에서 다음 조건을 모두 만족할 때만 Evidence 내부의 **optional** `capabilityPreservation`을 생략한다.

1. Evidence의 `analysisPass`가 `TIER2`다.
2. Evidence 바인딩이 존재하며 모두 `DEOBFUSCATED` Artifact에 연결된다.
3. 모든 바인딩 경로를 포함하는 공통 파일 보고서와 validation 값이 깊은 비교로 동일하다.
4. 일치하는 공통 보고서가 정확히 하나다.
5. 공통 위치 안내문까지 포함한 JSON 크기가 실제로 줄어든다.

기존 `missingData`에 생략한 Evidence 필드와 공통 보고서의 정확한 배열 인덱스를 기록한다. 값 불일치·누락·모호한 연결·Tier1·미상 pass·작은 보고서는 그대로 남긴다. Evidence 자체와 ID, 위치, findings, 바인딩, 계획, 코드 슬라이스, Artifact/line mapping, 전체 Resolver는 삭제하거나 축약하지 않는다. upstream execution도 변경하지 않는다.

### 기존 스키마 불일치도 수정

실제 표본에서 이전 Builder의 최상위 capability 보고서가 JSON Schema 검증에 실패했다. upstream/Evidence 0.1의 observation은 `derivedFrom.path`를 사용하지만, Agent 0.3.0의 해당 최상위 보고서는 `derivedFrom.file`을 요구한다. 기존 의미 참조 Validator만으로는 이 차이를 발견하지 못했다.

Agent 전용 타입과 Builder 투영에서 해당 위치만 `path → file`로 변환했다. Evidence 내부 형식과 upstream 데이터는 그대로다. 공통 위치 안내문에도 이 대응을 명시한다. JSON Schema 파일·버전, Policy/Gate, DB, Docker 설정은 변경하지 않았다. 소비자가 각 Evidence의 optional 보고서를 항상 읽는다고 가정하면 안 되며, 생략 안내에 따라 공통 보고서를 읽어야 한다.

## 실제 입력 비교

측정값은 `Buffer.byteLength(JSON.stringify(input), 'utf8')`이며, MB 환산이나 토큰 추정값이 아닌 bytes다. 한 번의 정적 분석에서 얻은 **동일 execution/context/policy**를 이전·수정 Builder에 각각 전달했다. 과거 보고서와 서로 다른 실행 결과를 빼서 계산하지 않았다.

| 표본 | 이전 JSON | 수정 JSON | 감소율 | 공통 위치로 대체한 보고서 |
| --- | ---: | ---: | ---: | ---: |
| ejs@3.1.10 | 236,863 | 218,252 | 7.9% | 6 |
| stream-transform@3.3.3 | 4,899,407 | 1,707,754 | 65.1% | 164 |
| @angular/cdk@19.0.1 | 129,590 | 125,198 | 3.4% | 4 |
| 합계: 비교 가능한 3개 | 5,265,860 | 2,051,204 | 61.0% | 174 |
| vibranced@1.4.45 (악성) | 비교 불가 | NO_HANDOFF | 해당 없음 | 해당 없음 |

3개 입력의 코드 본문 합계는 전후 모두 **87,071 bytes**다. 즉 이 수정으로 코드가 더 잘린 것은 아니다. 총량 감소는 가장 큰 표본에 크게 좌우되므로 일반적인 평균 절감률로 주장하지 않는다.

3개 모두 수정 후 AJV Schema 검증과 의미 참조 검증을 통과했다. 생략한 보고서를 복원하고 `file → path` 대응을 되돌린 **전체 입력 객체**가 이전 입력과 깊은 비교로 동일함을 확인했다. execution/Resolver fingerprint와 slice registry도 유지됐다. 이전 입력은 각각 12/328/24개의 `derivedFrom` 형식 오류가 있었으며 수정 후에는 0개다.

첫 실행은 이 기존 형식 오류를 발견하여 비교 3건이 실패했다. 최초 결과를 삭제하지 않고 보존했으며, 수정 후 재검증 결과를 별도 `v2` 파일에 저장했다. 정적 분석 자체는 두 실행 모두 4건 완료했다.

## 검증 환경과 재현 자료

- 구현 기준 dev: `d3dedb578454cc424981a32575cec2e9edead7f4`.
- 검증 전용 detached snapshot: `f815759150b08c76cc28f7c2ebc85bde469cafdb`의 진단 도구 + `0edda278f8cad2e290656e7a4756e9f6a1c4b6cc`의 고정 문자열 복원 파일 + 이 PR의 입력 투영 3개 소스. 이는 dev 전체 실행 결과가 아니다. 다른 PR의 변경을 이 PR에 합치지 않았다.
- 수정 전 Builder는 위 dev와 snapshot에서 동일한 원본이다. 비교용 복사본에는 수정된 TypeScript 타입을 통과시키기 위한 타입 단언만 추가했으며 실행 동작은 같다.
- 호스트 Node 26.5.0/darwin arm64. STRUCTURE 단계의 native build 부재가 있어 `vibranced`는 `TOOL_FAILED`였다. Docker 분석기 성공이 모든 호스트 복원 도구의 정상 동작을 뜻하지 않는다.
- 기존 Docker 이미지: `sha256:116bf7e6f91ecb9be2be63996678da344d3702f34ce1af078bb9dacad9125e0c`.
- GuardDog 3.1.0 / Semgrep 1.172.0, ruleset SHA-256 `969bb8f9a053a2ec6c1bbb46805cfe0deadbf1aeccc68a129de35a4b9c6138f1`.
- GuardDog On만 실행. `networkMode=NONE`, package/lifecycle 실행 없음, LLM 호출 0. 아카이브 SHA-256을 확인했으며 원본 실험 보고서는 변경하지 않았다.

로컬 `reports/validation/`은 Git 제외 디렉터리다. 실제 패키지 아카이브와 원본 코드를 PR에 포함하지 않는다.

- `tier3-input-4-manifest-2026-09-30.json`: 대상과 아카이브 해시, 실행 출처.
- `tier3-input-4-replay-2026-09-30.json`: 최초 형식 오류 발견 기록.
- `tier3-input-4-replay-v2-2026-09-30.json`: 비교 수치, 전후 입력 해시, 복원 가능성 검증 결과.
- v2 보고서 SHA-256: `43c5284efc4516116d257d38bea3e4c67d906433d5de0f5bd70e6c08718eaf06`.
- `tier3-input-4-replay-snapshot/`: 검증용 tracked diff와 추가 비교 도구, 출처 및 해시. 공유/재실행 시 같은 아카이브와 분석기 이미지가 필요하다.

## 코드 회귀 검증

`apps/scanner`에서 실행했다.

```sh
npm test -- --runInBand test/tier3-agent-input-v0_3.spec.ts test/tier3-runtime-integration.spec.ts test/tier3-llm-evidence-binding.spec.ts
npm test -- --runInBand
npm run typecheck
npm run build
```

- 관련 3 suites / 45 tests 통과.
- 전체 Scanner 72 suites / 1,177 tests 통과. 이 변경의 새 회귀 사례는 14개다.
- 타입 검사·빌드·`git diff --check` 통과.
- 스키마 대응, 동일 데이터의 정확한 복원, ID/바인딩/계획 불변, 불일치·모호한 연결 보존, 작은 보고서의 크기 증가 방지, 객체 키 순서 차이를 검증했다.
- 실제 LLM 응답과 운영 E2E는 검증하지 않았다.

## 남은 과제와 발표 표현

`stream-transform`의 JSON은 개선 후에도 약 1.71 MB이며 `artifactContext`만 1,233,758 bytes다. 이번 수정은 전체 입력의 절대 크기 제한이나 토큰 예산을 보장하지 않는다. Artifact metadata 축약은 ID·경로·mapping·도구 응답 계약을 별도로 검토해야 한다.

우선 별도로 확인할 항목은 native 복원 도구를 사용할 수 있는 지원 런타임에서 `vibranced`를 다시 검증하는 것이다. 이번 환경에서 Tier1 finding 5건과 legacy 입력 생성은 확인했지만 신규 Shadow는 NO_HANDOFF였다. 실패한 복원을 처리하는 경로와 #359의 신규 계획/기존 전달 경로 대체 여부가 미확정이므로, 이 3건을 실제 Tier3 호출 건수나 악성 후보 보존율로 표현하지 않는다. 환경·의존성 수정은 이 PR에 포함하지 않는다.

발표 권장 문장: “동일한 분석 결과를 입력으로 사용한 3개 정상 표본에서, 증거와 코드 연결 정보를 유지한 채 반복된 검증 정보를 공통화하여 Tier3 입력 JSON 합계를 61.0% 줄였다. 실제 LLM 비용 절감과 악성 탐지 성능은 별도 검증 대상이다.”
