# Tier2 CFF 탐지·정적 복원·평가 검증 통합

관련 Issue: #484. 선행 #433 / #436에서 제외한 CFF 복원 후속 작업이다. 이 디렉터리는 최종 근거만 보관하며 데이터셋 원본·중간 실패 결과·로컬 node_modules는 포함하지 않는다.

## 구현 범위

- **정적 순서표 후보:** helper가 없어도 정적으로 확인한 순열·커서·switch 반복 구조를 후보로 선정한다. 변수명·표본 ID 예외나 기존 helper 임계값 하향은 없다.
- **표현에 덜 의존하는 helper 집계:** 문자열 정규식 대신 AST에서 인자를 전달하는 함수 구조를 센다. 키 따옴표·서식 차이를 허용하며 일반 Babel export getter와 코드 모양 주석·문자열을 제외한다.
- **제한적인 정적 복원:** 기존 webcrack 처리 후 독립적인 순서표 펼치기와 이항 helper 단순화를 수행한다. 설치된 webcrack 2.16.0에서 문자열 배열이 없으면 해당 변환에 도달하지 않는 사례를 보완한다.
- **구조 변화 판정:** AST 기반 fingerprint로 공백·주석·키 따옴표·리터럴 표기 변화만 있는 결과는 `NO_CHANGE / NO_STRUCTURAL_CHANGE`로 구분한다. 의미 동등성 증명은 아니다.
- **기존 stage metadata 진단:** 구조 잔존, helper 정의·호출 수, 펼친 dispatcher와 단순화한 호출 수를 기록한다. metadata에 선택적 값이 추가되지만 외부 스키마·상태 enum은 변경하지 않는다.

복원은 분석 사본에만 적용한다. 순서표·커서의 추가 사용/변경, 불명확한 순서, lexical 선언, 분기 대상이 불명확한 break/continue 등은 보수적으로 제외한다. 원래 cursor 진행과 table 읽기는 보존한다. helper는 같은 함수 범위의 순서 보존 이항 연산만 단순화하며, 함수 호출 proxy·단락 연산·객체 escape/변경·동적 키·getter/spread·직접 eval·with 등은 변환하지 않는다.

## Contract와 런타임 영향

API/Evidence/Handoff schema, Gate/Policy 코드, 환경변수, dependency, Docker/CI 구성은 변경하지 않는다. 하지만 **후보 추가와 COMPLETED→NO_CHANGE 보정은 후속 라우팅에 간접 영향을 줄 수 있다.** 기존 metadata의 신규 진단 값과 이 동작 변화를 리뷰해야 한다.

새 정적 pass는 소스를 실행하지 않는다. 기존 webcrack 전체는 격리 디코더 평가를 수행할 수 있으므로 파이프라인 전체를 “코드 실행 없음”으로 표현하지 않는다. 직접 작성한 무해한 테스트 프로그램만 VM에서 비교했으며 데이터셋·패키지 entrypoint 및 lifecycle은 실행하지 않았다.

## 검증 결과

| 검증 | 결과 | 해석 |
| --- | --- | --- |
| 기존 363파일 해시 고정 회귀 | CFF 설정 그룹 25/40→27/40; 난독화 양성 전체 257/280→259/280 | 기존 개발·회귀 표본, 독립 holdout 아님 |
| 원본·압축 대조군 | 0/43, 1/40 유지 | 일반 오탐률 0 보장 아님 |
| 정상 성격 의존성 136파일 | 후보 0→0 | Babel parser/types·semver, 대표 표본 아님 |
| 자동 추가된 p00025·p00032 | 실제 순서표 구조 제거 2/2, RESTORED 2/2, 원본 해시 유지 | 전체 CFF 복원 성공률 아님 |
| 미선정 helper 7건 강제 진단 | 5파일에서 감소, 전체 호출 18→7 | 자동 후보 추가로 합산하지 않음 |
| CFF 40쌍 원본 대조 | dispatcher 11 / helper-only 23 / surface-only 6 | [분류 기준과 전체 표](paired-source-report.md) |
| 표기 변화만 있는 6건 제외 | 27/34=79.4% 후보 선정 | 사후 분모 조정; 새로운 코드 성능 향상 아님 |
| dispatcher 11파일 | 기존 9/11→수정본 11/11 후보 선정 | 이 로컬 표본의 결과; 일반 탐지율·복원 성공률 아님 |

기존 측정의 탐지 시간은 의존성 136파일에 대한 단일 콜드 순차 실행에서 약 8.74ms→276.87ms였다. AST 비용이 증가했으며 이 수치를 운영 SLA로 일반화하지 않는다. 타임아웃 경계는 검사하지만 동기 AST 처리 자체를 중간에 선점하지 못한다.

최신 dev `591c8f1` 반영 후 PR 준비 검증:

- `npm run typecheck`, `npm run build`: 통과.
- `npm run test:unit -- --runInBand`: **88 suites / 1,683 tests** 통과.
- `npm run test:agent-experiment:cli` (API key 빈 값): **2 suites / 13 tests** 통과.
- `node --test scripts/tier2-cff-miss-audit.spec.mjs scripts/tier2-cff-paired-audit.spec.mjs`: **16 tests** 통과.
- 363파일 후보 회귀 재실행: 기존 기록과 동일한 그룹 집계 확인.
- 40파일 보고서 행·원본/난독화본 80개 해시 및 검증 도구·입력 결과 해시 대조: 통과.
- GitHub CI는 PR 생성 후 별도 확인한다. 로컬 검증을 GitHub CI 통과로 표현하지 않는다. Docker 전체 통합 실행·외부 LLM 실험은 수행하지 않았다.

## 근거 파일과 재현

| 파일 | 용도 |
| --- | --- |
| [baseline-file-detection.json](baseline-file-detection.json) | 10/1 기존 detector의 363파일 결과 |
| [candidate-regression.json](candidate-regression.json) | 10/5 수정본 363파일, 소스/빌드 해시, 기존 대비 후보 변화 |
| [restoration-quality.json](restoration-quality.json) | 2개 자동 후보 + 7개 강제 진단의 구조 품질 |
| [controls-and-restore.json](controls-and-restore.json) | 의존성 대조 136파일, 자동 후보 2파일 파이프라인 결과 |
| [paired-source-audit.json](paired-source-audit.json) | 전체 40쌍의 AST 비교, dispatcher·helper 정의 및 사용 지점 |
| [paired-source-report.md](paired-source-report.md) | 분모·분류·발표용 문구 및 전체 파일별 표 |

JSON은 로컬의 최종 산출물을 바이트 그대로 보존한다. 결과 내부의 시간·임시 디렉터리는 당시 측정 기록이며 다른 환경에서 해당 경로가 존재할 필요는 없다. 재실행 시 실행 시간과 출력 해시 등은 달라질 수 있다. `controls-and-restore` 스크립트는 이번 PR 준비 과정에서 OS 임시 디렉터리를 사용하도록 경로만 이식성 보정했다.

데이터셋은 별도로 준비해야 한다. 기존 로컬 `jsdeobs-sample` 구조와 파일 SHA-256을 기준으로 검증하며, 공식 배포 아카이브와의 원본 해시 대조를 새로 수행한 것은 아니다. 원본 소스는 IBM Project CodeNet, 평가 프로젝트는 [JsDeObsBench](https://github.com/Ch3nYe/JsDeObsBench)이며 이 PR에 데이터셋 전체를 재배포하지 않는다.

`apps/scanner`에서 Node 24와 저장소 의존성을 사용한다. 출력에는 존재하지 않는 새 파일 경로를 지정한다.

```sh
npm run build
node --test scripts/tier2-cff-miss-audit.spec.mjs scripts/tier2-cff-paired-audit.spec.mjs
node scripts/tier2-cff-miss-audit.mjs <CORPUS> docs/validation/cff-2026-10-05/baseline-file-detection.json <NEW_AUDIT_JSON>
node scripts/tier2-cff-paired-audit.mjs <CORPUS> <NEW_AUDIT_JSON> <NEW_PAIRED_JSON>
node --no-node-snapshot scripts/tier2-cff-restoration-quality.mjs <CORPUS> <NEW_AUDIT_JSON> <NEW_QUALITY_JSON>
node --no-node-snapshot scripts/tier2-cff-controls-and-restore.mjs <TRUSTED_BASELINE_DETECTOR_JS> <CORPUS> <NEW_AUDIT_JSON> <NEW_CONTROLS_JSON>
```

마지막 명령은 비교용의 **신뢰하는 Scanner 빌드 모듈**을 import한다. 데이터셋 파일을 모듈 인자로 지정하면 안 된다. 현재 설치 의존성의 JS 파일을 대조군으로 사용하므로 버전에 따라 136파일 수가 달라질 수 있다. 과거 빌드·원본 데이터셋은 이 PR에 포함하지 않으며 필요한 경우 해당 기준 버전을 따로 준비해야 한다.

## 남은 범위

- 미사용 원본 코드·다른 난독화기 계열·정상 상태 머신으로 별도 평가.
- 대표 패키지의 지연·메모리·타임아웃과 실질적 재분석 탐지 효과.
- 강한 구조 근거와 약한 helper 복원 후보의 별도 처리 설계. 이번에는 helper 7건을 자동 후보로 올리지 않았다.
- 임의 JavaScript 환경의 의미 보존 보장 없음. 내장 메서드/전역 상태를 호스트가 바꾸는 상황 등은 별도 검토 필요.
