# Tier2 문자열 상수 치환 수정

관련 Issue: #413. 근거: #403 / PR #404의 미복원 42건 분류.

> 아래 수치와 표는 1차 바인딩 수정 시점의 결과다. 후속 동작 보존 검증에서 치환 조건을 강화했으며, 최신 정적 재검사는 **4파일 RESTORED / 2파일 UNRESOLVED**다. 현재 검증 명령·한계·수치 사용 기준은 [Tier2 String Restore Maintenance](./Tier2%20String%20Restore%20Maintenance.md)를 따른다. 이전 결과를 최신 코드의 측정값으로 사용하지 않는다.

## 원인과 수정 범위

기존 string-restorer는 문자열 값을 변수 이름으로 저장했다. 서로 다른 함수나 블록에 같은 이름의 변수가 있으면 값이 덮어써지고, 파라미터 또는 수정 가능한 다른 변수에도 해당 값이 적용될 수 있었다. 별도로 Babel의 referenced identifier 판정에는 export local 및 일부 쓰기 위치도 포함돼 AST 타입 오류나 유효하지 않은 좌변을 만들 수 있었다.

수정 내용:

- 이름 대신 실제 Babel Binding을 키로 사용한다.
- 일반 식별자와 디코더 호출 인자 모두 참조 위치의 스코프에서 바인딩을 조회한다.
- binding identifier 및 export specifier 위치는 문자열 값으로 치환하지 않는다.
- 기존 리터럴 디코딩, 반복 복원, 라인 매핑을 유지한다.

Scanner 문자열 복원과 회귀 테스트만 변경한다. API/Evidence/Decision Schema, Gate, Policy, Docker, 환경변수 및 LLM 설정은 변경하지 않는다. PR #398과 #402의 코드를 포함하거나 병합하지 않는다.

## 회귀 검증

무해한 fixture로 다음을 검사한다.

- 동일 이름의 함수/블록별 상수 및 빈 문자열
- 파라미터 shadowing, 미선언 식별자, 디코더 인자 바인딩
- postfix/prefix, 대입, 복합 대입, for-in/of, 구조 분해 대입 위치 보존
- export/re-export, 객체 shorthand, 기존 반복 디코딩과 라인 매핑
- 복원 파이프라인의 원본 보존 및 결과 문법 검증

최초 추가한 16개 테스트 중 기존 구현에서 13개가 실패했다. 수정 중 타입 가드의 TypeScript 좁히기 문제도 발견해 boolean 반환 헬퍼로 정리했다. 최종 회귀 테스트는 문자열 복원 22개와 파이프라인 2개를 추가했다.

1차 바인딩 수정 검증(`apps/scanner`, 커밋 `252447e`):

```bash
npm test -- --runInBand
npm run typecheck
npm run build
```

73 suites / 1,187 tests 통과, 타입 검사·빌드 통과. 테스트 중 의도적인 실패 경로 경고가 출력됐지만 테스트 실패는 없었다. GitHub CI 결과는 별도 확인 대상이다.

## 기존 실패 6파일의 1차 정적 재검사

저장된 아카이브와 파일 SHA-256을 기존 분류 결과에 대조하고 동일 소스에 현재 복원 파이프라인을 적용했다. 원본 패키지는 실행하지 않았다. 대상은 5패키지 버전의 6파일이며 고유 파일 해시는 5개다.

| 패키지 | 파일 | 이전 | 수정 후 |
| --- | --- | --- | --- |
| msgpack-lite@0.1.26 | dist/msgpack.min.js | PARSE_FAILED | RESTORED |
| chevrotain@11.0.3 | lib/chevrotain.min.mjs | PARSE_FAILED | RESTORED |
| chevrotain@11.0.3 | lib/chevrotain.mjs | PARSE_FAILED | RESTORED |
| bowser@2.11.0 | bundled.js | PARSE_FAILED | RESTORED |
| esoftplay@0.0.141-n | modules/lib/crypt.js | PARSE_FAILED | PARTIAL_RESTORED |
| esoftplay@0.0.244 | modules/lib/crypt.js | PARSE_FAILED | PARTIAL_RESTORED |

6파일 모두 출력 문법이 유효하다. esoftplay 두 파일은 동일 소스이며 DYNAMIC_DECODE_UNRESOLVED가 남아 부분 복원으로 기록됐다. 단순히 오류를 숨기거나 완전 복원으로 바꾸지 않았다.

이 결과는 **정적 복원 파이프라인 상태**다. 디코더 전반의 의미 동등성을 증명한 것이 아니며, GuardDog/Custom Rule 재분석·Handoff·최종 악성 판정 개선은 이번 재검사에 포함하지 않았다. 새 데이터 흐름 분석이나 초기화 순서·동적 바인딩 변경에 대한 일반적 보장도 추가하지 않는다.

## 재현 근거와 후속 작업

- 기준 dev 커밋: d3dedb578454cc424981a32575cec2e9edead7f4.
- 로컬 결과: `reports/validation/tier2-string-binding-6-recheck-2026-09-30.json`.
- 결과 JSON에는 실제 수정 소스 해시, 기존 파일 해시, 이전 실패, 현재 단계·문법·상태를 보존했다. Git 제외 대상이며 코드 본문을 PR에 포함하지 않는다.
- 검사에서는 기존 manifest의 아카이브 해시와 최종 file-review-v2의 파일 해시를 확인하고, 통제된 임시 파일명으로 runRestorePipeline을 호출한다. 구조 복원 비대상 여부와 원본 보존을 확인한다.
- LLM 호출, 네트워크/API 조회, Docker 실행, 전체 600건 재실행, 샘플/설치 스크립트 실행 없음.
- 후속은 변경된 복원 결과가 실제 재분석 증거와 Handoff에 미치는 영향을 소규모로 확인하는 것이다. 원본부터 파싱되지 않았던 3파일과 미지원 디코더 확장은 별도 작업이다.
