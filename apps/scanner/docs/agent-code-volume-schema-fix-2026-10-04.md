# 코드 제공량 비교 실험 전체 분석 (2026-10-04)

## 결론 요약

저장된 결과 기준으로 25개 논리 조건이 모두 종결됐다. 실제 Provider 요청은 22회이며 모두 HTTP 200으로 수용됐다. DD-NPM-015 L3/L4는 L2, DD-NPM-001 L4는 L3과 최종 요청이 같아 결과를 공유했고 호출·usage를 다시 합산하지 않았다. 실패, UNKNOWN, 미실행은 각각 0건이다.

코드량 증가 효과는 비단조적이었다. DD-NPM-003, 010, 015, 001은 L0에서 이미 실제 코드로 뒷받침되는 악성 행위와 연결을 언급했고 이후 단계는 주로 세부사항만 더했다. DD-NPM-013만 L0의 정상 판단에서 L1의 의심 행위 발견으로 바뀌었지만, L3의 요약만 잠시 `LIKELY_MALICIOUS`였고 L4는 다시 `SUSPICIOUS`였다. 따라서 이번 단회 5표본으로 최소 필요 코드량이나 일반 정확도를 정할 수 없다.

최종 Evidence는 전 조건 0건이다. 이는 22회의 실행/파싱 실패나 Adapter 변환 실패 때문이 아니다. 61개 assessment 중 60개가 limitations/missingContext 때문에 `PARTIALLY_VERIFIED`, 1개가 잘못된 flow 참조 때문에 `REJECTED`였고, Adapter는 `VERIFIED`만 변환한다.

## 실행 완결성과 비교 가능성

- 논리 조건 25개, 고유 최종 요청 22개, 실제 Provider 요청 22회
- 직접 완료 22개, SAME_INPUT 공유 완료 3개
- HTTP 200 22개; 실패 0, UNKNOWN 0, 미실행 0
- Runner: 고유 요청 22개 모두 `PARTIAL` / `COMPLETED_NO_VERIFIED_EVIDENCE`
- JSON parsing 및 schema/artifact validation 파이프라인 진입: 22/22 통과
- timeout, 출력 잘림, parsing 실패, 추가 코드 요청: 모두 0
- 공통 API schema hash: `2e118f46e4185a1a4c86ffb07a1d36cd7d93866f65803ff5772041cd29143d13`
- 모델/effort/출력 예산/timeout/retry/Jev/store 설정은 동일하다. 격리 실행별 `maxProviderRequests`와 config hash는 달라질 수 있어 그 값 자체는 결과 동일성 근거로 사용하지 않았다.
- frozen 입력의 Finding, Evidence, package context, prompt, output schema는 비교 축에서 고정됐고 코드 제공 범위만 단계별로 달랐다.

## 표본별 L0~L4 결과

### DD-NPM-003

| 단계 | 코드 bytes / lines / files | token input/cache/output/reasoning/total | 시간 / 호출 | Runner / parse | assessment / V/P/R / Evidence | 모델 평가와 실제 코드 근거 | 제한 |
|---|---:|---:|---:|---|---:|---|---|
| L0 | 870 / 8 / 4 | in 9861 / cache 0 / out 1982 / reason 457 / total 11843 | 23.998s / 1 | PARTIAL / PASSED | 3 / 0/3/0 / 0 | LIKELY_MALICIOUS — 환경 mnemonic 수집→Telegram 전송 | - |
| L1 | 2405 / 23 / 4 | in 11557 / cache 0 / out 2196 / reason 516 / total 13753 | 20.693s / 1 | PARTIAL / PASSED | 3 / 0/3/0 / 0 | LIKELY_MALICIOUS — 환경 mnemonic 수집→Telegram 전송 | - |
| L2 | 25330 / 355 / 4 | in 17546 / cache 0 / out 2458 / reason 498 / total 20004 | 23.911s / 1 | PARTIAL / PASSED | 3 / 0/3/0 / 0 | LIKELY_MALICIOUS — 환경 mnemonic 수집→Telegram 전송 | - |
| L3 | 200714 / 5094 / 36 | in 78581 / cache 0 / out 2331 / reason 445 / total 80912 | 22.401s / 1 | PARTIAL / PASSED | 3 / 0/3/0 / 0 | LIKELY_MALICIOUS — 환경 mnemonic 수집→Telegram 전송 | - |
| L4 | 428543 / 11325 / 123 | in 171924 / cache 0 / out 2257 / reason 344 / total 174181 | 18.423s / 1 | PARTIAL / PASSED | 3 / 0/3/0 / 0 | LIKELY_MALICIOUS — 환경 mnemonic 수집→Telegram 전송 | - |

L0부터 환경 mnemonic의 수집→Telegram 전송 연결을 찾았다. L4까지 결론은 유지됐지만 VERIFIED Evidence는 늘지 않았다.

### DD-NPM-010

| 단계 | 코드 bytes / lines / files | token input/cache/output/reasoning/total | 시간 / 호출 | Runner / parse | assessment / V/P/R / Evidence | 모델 평가와 실제 코드 근거 | 제한 |
|---|---:|---:|---:|---|---:|---|---|
| L0 | 4173 / 109 / 1 | in 16995 / cache 0 / out 2497 / reason 702 / total 19492 | 21.651s / 1 | PARTIAL / PASSED | 2 / 0/1/1 / 0 | LIKELY_MALICIOUS — 원격 payload 실행 + 환경/시스템 정보 유출 | - |
| L1 | 4389 / 117 / 1 | in 17535 / cache 0 / out 2363 / reason 685 / total 19898 | 25.782s / 1 | PARTIAL / PASSED | 2 / 0/2/0 / 0 | LIKELY_MALICIOUS — 원격 payload 실행 + 환경/시스템 정보 유출 | - |
| L2 | 4573 / 124 / 1 | in 17589 / cache 0 / out 2989 / reason 1034 / total 20578 | 25.770s / 1 | PARTIAL / PASSED | 2 / 0/2/0 / 0 | LIKELY_MALICIOUS — 원격 payload 실행 + 환경/시스템 정보 유출 | - |
| L3 | 4648 / 127 / 2 | in 17934 / cache 0 / out 3422 / reason 1165 / total 21356 | 22.836s / 1 | PARTIAL / PASSED | 3 / 0/3/0 / 0 | LIKELY_MALICIOUS — 설치 수명주기 + payload 실행 + 유출 | - |
| L4 | 5219 / 140 / 3 | in 18410 / cache 0 / out 2787 / reason 516 / total 21197 | 24.682s / 1 | PARTIAL / PASSED | 3 / 0/3/0 / 0 | LIKELY_MALICIOUS — 설치 수명주기 + payload 실행 + 유출 | - |

L0부터 원격 JS 저장·은닉 분리 실행과 환경/시스템 정보 유출 흐름을 찾았다. L0의 두 번째 assessment만 다른 assessment의 flow ref를 써 REJECTED였다.

### DD-NPM-013

| 단계 | 코드 bytes / lines / files | token input/cache/output/reasoning/total | 시간 / 호출 | Runner / parse | assessment / V/P/R / Evidence | 모델 평가와 실제 코드 근거 | 제한 |
|---|---:|---:|---:|---|---:|---|---|
| L0 | 6396 / 148 / 5 | in 15489 / cache 0 / out 2559 / reason 515 / total 18048 | 21.793s / 1 | PARTIAL / PASSED | 3 / 0/3/0 / 0 | NO_MALICIOUS_BEHAVIOR_FOUND — 악성 연결 근거 없음 | - |
| L1 | 14577 / 350 / 5 | in 20394 / cache 0 / out 3294 / reason 980 / total 23688 | 28.834s / 1 | PARTIAL / PASSED | 3 / 0/3/0 / 0 | SUSPICIOUS — 설치 시 temp 검사 + 난독화된 Windows 프로세스 실행 | - |
| L2 | 27371 / 753 / 5 | in 21590 / cache 0 / out 2781 / reason 516 / total 24371 | 23.102s / 1 | PARTIAL / PASSED | 3 / 0/3/0 / 0 | SUSPICIOUS — 번들 DLL 실행 | - |
| L3 | 31016 / 861 / 11 | in 24771 / cache 0 / out 2819 / reason 462 / total 27590 | 23.957s / 1 | PARTIAL / PASSED | 3 / 0/3/0 / 0 | LIKELY_MALICIOUS — 요약은 악성; 관련 assessment intent는 SUSPICIOUS | - |
| L4 | 33236 / 924 / 16 | in 26999 / cache 0 / out 3307 / reason 991 / total 30306 | 30.065s / 1 | PARTIAL / PASSED | 3 / 0/3/0 / 0 | SUSPICIOUS — 전체 패키지에서도 DLL/프로세스 의심에 머묾 | - |

L0은 악성 없음, L1부터 난독화된 Windows 프로세스/DLL 실행을 의심했다. L3 요약만 LIKELY_MALICIOUS였고 L4에서 SUSPICIOUS로 돌아가 전체 코드에서도 확정하지 못했다.

### DD-NPM-015

| 단계 | 코드 bytes / lines / files | token input/cache/output/reasoning/total | 시간 / 호출 | Runner / parse | assessment / V/P/R / Evidence | 모델 평가와 실제 코드 근거 | 제한 |
|---|---:|---:|---:|---|---:|---|---|
| L0 | 12946 / 233 / 3 | in 41325 / cache 0 / out 3053 / reason 467 / total 44378 | 20.149s / 1 | PARTIAL / PASSED | 3 / 0/3/0 / 0 | LIKELY_MALICIOUS — 지속성 payload 실행 + npm 자격정보 수집/게시 | - |
| L1 | 13450 / 252 / 3 | in 42685 / cache 0 / out 2851 / reason 890 / total 45536 | 29.060s / 1 | PARTIAL / PASSED | 2 / 0/2/0 / 0 | LIKELY_MALICIOUS — 지속성 payload 실행 + npm 자격정보 수집/게시 | - |
| L2 | 13863 / 272 / 3 | in 42815 / cache 0 / out 2962 / reason 516 / total 45777 | 23.954s / 1 | PARTIAL / PASSED | 3 / 0/3/0 / 0 | LIKELY_MALICIOUS — 지속성 payload 실행 + npm 자격정보 수집/게시 | - |
| L3 | 13863 / 272 / 3 | 공유 결과(사용량 미중복) | 0s / 0 | PARTIAL / PASSED | 3 / 0/3/0 / 0 | LIKELY_MALICIOUS — 지속성 payload 실행 + npm 자격정보 수집/게시 | SAME_INPUT → DD-NPM-015:L2 |
| L4 | 13863 / 272 / 3 | 공유 결과(사용량 미중복) | 0s / 0 | PARTIAL / PASSED | 3 / 0/3/0 / 0 | LIKELY_MALICIOUS — 지속성 payload 실행 + npm 자격정보 수집/게시 | SAME_INPUT → DD-NPM-015:L2 |

L0부터 인코딩된 원격 payload의 사용자 서비스 지속성/반복 실행과 npm 자격정보 수집·인증 게시를 찾았다. L3/L4는 L2와 동일 입력이라 호출 없이 공유됐다.

### DD-NPM-001

| 단계 | 코드 bytes / lines / files | token input/cache/output/reasoning/total | 시간 / 호출 | Runner / parse | assessment / V/P/R / Evidence | 모델 평가와 실제 코드 근거 | 제한 |
|---|---:|---:|---:|---|---:|---|---|
| L0 | 184672 / 4 / 3 | in 91596 / cache 0 / out 2862 / reason 896 / total 94458 | 30.238s / 1 | PARTIAL / PASSED | 3 / 0/3/0 / 0 | LIKELY_MALICIOUS — shell-profile 지속성 + 파일 수집/압축/Telegram 전송 | - |
| L1 | 185051 / 21 / 3 | in 91884 / cache 0 / out 3678 / reason 1194 / total 95562 | 34.375s / 1 | PARTIAL / PASSED | 4 / 0/4/0 / 0 | LIKELY_MALICIOUS — 지속성 + 파일 수집/압축/Telegram 전송 | - |
| L2 | 218179 / 108 / 3 | in 107315 / cache 0 / out 2389 / reason 610 / total 109704 | 24.568s / 1 | PARTIAL / PASSED | 2 / 0/2/0 / 0 | LIKELY_MALICIOUS — 지속성 + 파일 수집/압축/Telegram 전송 | - |
| L3 | 218367 / 119 / 4 | in 107702 / cache 0 / out 2324 / reason 650 / total 110026 | 20.568s / 1 | PARTIAL / PASSED | 2 / 0/2/0 / 0 | LIKELY_MALICIOUS — 지속성 + 파일 수집/압축/Telegram 전송 | - |
| L4 | 218367 / 119 / 4 | 공유 결과(사용량 미중복) | 0s / 0 | PARTIAL / PASSED | 2 / 0/2/0 / 0 | LIKELY_MALICIOUS — 지속성 + 파일 수집/압축/Telegram 전송 | SAME_INPUT → DD-NPM-001:L3 |

L0부터 shell-profile 지속성과 재귀 파일 수집·압축·Telegram 업로드를 찾았다. 큰 단일행 난독화와 실행/호출 그래프 부재로 L3까지도 부분 검증에 머물렀고 L4는 L3 공유다.

## 전체 토큰·시간과 코드량 비용

22개 고유 호출 합계는 input 1,012,497, cached input 0, output 60,161, reasoning 15,049, total 1,072,658 tokens이며 누적 Provider 시간은 540.810초다. reasoning은 output의 부분집합이므로 total에 다시 더하지 않았다.

| 표본 | 비교 | 코드 bytes 증가 | input token 변화 | total token 변화 | 시간 변화 | 판단/Evidence 변화 |
|---|---|---:|---:|---:|---:|---|
| DD-NPM-003 | L0→L4 | 870→428543 | +162063 | +162338 | -5.575s | 악성 근거는 L0부터 동일, Evidence 0 유지 |
| DD-NPM-010 | L0→L4 | 4173→5219 | +1415 | +1705 | +3.031s | L3부터 수명주기 세부 추가, Evidence 0 유지 |
| DD-NPM-013 | L0→L4 | 6396→33236 | +11510 | +12258 | +8.272s | L1에서 첫 의심 근거; L3 악성 요약 후 L4 의심으로 회귀 |
| DD-NPM-015 | L0→L2 | 12946→13863 | +1490 | +1399 | +3.805s | L0부터 핵심 근거 동일; L3/L4는 L2 공유 |
| DD-NPM-001 | L0→L3 | 184672→218367 | +16106 | +15568 | -9.670s | L0부터 핵심 근거 동일; L4는 L3 공유 |

입력 토큰은 대체로 코드량과 함께 증가했지만 시간은 단회 호출의 출력·reasoning 변동 때문에 단조롭지 않았다. 특히 DD-NPM-003은 870B에서 428,543B로 늘며 total token이 162,338 증가했으나 판정과 Evidence 상태는 개선되지 않았다.

## Evidence 0건 원인

- 모든 응답에는 output 수준 missingContext 또는 limitation이 있었고 모든 assessment에도 limitation이 있었다. 현재 Validator 계약에서는 참조·위치 문제가 없어도 이를 `PARTIALLY_VERIFIED`로 낮춘다.
- 61개 assessment의 정확한 분포는 `VERIFIED 0 / PARTIALLY_VERIFIED 60 / REJECTED 1`이다.
- 유일한 명시적 참조 오류는 DD-NPM-010 L0 두 번째 assessment의 다른 assessment 소속 `flow` 참조다. 이 항목은 `Unknown flow reference`로 REJECTED됐다.
- 나머지 60개에는 저장된 validator issue가 없었다. 주된 제한은 호출자/실행 경로/런타임 성공 여부 부족, 네트워크 성공 증명 부족, 난독화 복원 한계, native/DLL 설치 동작의 의도 불명확성이다.
- Adapter 변환 실패는 0건이다. Adapter는 VERIFIED만 대상으로 삼으므로 61개 모두 변환 전에 제외됐다.
- 따라서 Evidence 0은 곧바로 모델 미탐이 아니다. 반대로 악성이라는 모델 문구만으로 탐지 성공도 아니다. 사후 코드 대조상 003/010/015/001은 L0부터 악성 행위와 source→sink 연결이 뒷받침됐고, 013은 L1부터 의심 근거가 생겼지만 전체 패키지에서도 확정이 안정적이지 않았다.

## 원인별 해석

- **코드 맥락 부족:** DD-NPM-013 L0은 핵심 Windows/DLL 실행 맥락이 없어 정상으로 판단했고 L1 이후에야 의심 근거가 나타났다.
- **코드량을 늘려도 남는 난독화·복원 제한:** DD-NPM-001은 큰 단일행 난독화와 런타임/호출 그래프 부재가 L3까지 남았다. DD-NPM-013도 L4에서 native/DLL 행위의 의도를 확정하지 못했다.
- **충분한 근거가 있는데도 완전 검증하지 못함:** DD-NPM-003/010/015/001은 source와 sink 연결을 코드에서 찾았지만 limitations/missingContext 때문에 VERIFIED가 되지 않았다.
- **참조·출력 형식 오류:** DD-NPM-010 L0의 assessment 간 flow ref 누출 1건만 확인됐다. JSON parsing이나 전체 응답 schema 실패는 없었다.
- **Validator의 부분 검증:** 60건 전체에서 반복된 Evidence 손실의 직접 원인이다.
- **Evidence 변환 문제:** 관측되지 않았다. 변환 대상 VERIFIED가 0건이고 conversion failure도 0건이다.
- **자료 부족:** 1회/조건뿐이므로 시간 차이, 단계별 판정 변동, 일반 정확도와 최소 코드량은 분리·일반화할 수 없다.

## 다음 우선순위

1. Jev 실험에서는 assessment별 ref/flow 소유권과 cross-assessment ref 누출을 우선 점검한다. 악성 판단, Validator 상태, 최종 Evidence를 별도 지표로 유지한다.
2. DD-NPM-013은 install/lifecycle entry point와 native/DLL 실행의 인자·호출 연결을 우선 슬라이싱한다. 코드 전체 증량보다 의도 판별에 필요한 연결을 선택하는 편이 우선이다.
3. DD-NPM-001은 난독화 복원, 단일행 코드 위치 안정화, 호출 그래프 문맥을 우선한다.
4. limitations/missingContext가 있는 강한 코드 근거와 실제 참조 오류를 Jev에서 구분해 측정한다. 이번 결과 분석 자체는 운영 Validator/Policy 계약을 변경하지 않는다.

## 보안 및 해석 범위

공유 보고서에는 키, 전체 요청/응답, 코드 본문, host 절대경로를 포함하지 않았다. GT는 사후 평가에만 사용했다. 본 결과는 Luna 단일 실행의 5표본 비교이며 운영 E2E 성공, 일반 탐지 정확도 또는 최소 필요 코드량을 입증하지 않는다.
