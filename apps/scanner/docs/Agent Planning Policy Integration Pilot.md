# Agent Planning → Tier 3 → Policy 연동 파일럿

## 범위

이 파일럿은 정적 필터 0.4.0과 Planning 입력 0.1.0을 변경하지 않고, 동일한 로컬
개발 표본 15개를 생산 `Orchestrator.execute()`와 `ScanService.scan()` 경로로 처리했다.
탐지 정확도나 모델 품질을 평가하는 실험이 아니라 라우팅, Tier 3 입력/실행,
Evidence 계약, 저장·Policy·cleanup 연결을 검증하는 실험이다.

Registry 조회, artifact 다운로드/압축 해제, History 저장소, Evidence 저장소와 Policy
HTTP 전송은 로컬 mock으로 대체했다. Metadata, Custom Rule, GuardDog, Tier 2,
Normalizer, Planning Adapter, 정적 필터, Planning 기반 Tier 3 입력 Builder, v0.3 Runner,
Validator, LLM Evidence Adapter와 Policy request builder는 생산 코드를 사용했다.
Provider는 외부 endpoint가 없는 mock이며 유효한 평가 0건 응답을 반환했다.

산출물은
`experiments/agent-planning-static-filter/2026-10-03-policy-integration-v1`에 있다.
표본별 JSON에는 package identity/hash, 라우팅 상태, 호출 횟수와 후처리 결과만 두고
원시 표본 코드, 매칭 snippet, token 또는 인증정보는 저장하지 않았다.

## 동일 15개 결과

| 항목 | 결과 |
| --- | ---: |
| 완료 / 선택 | 15 / 15 |
| `STATIC_MALICIOUS` | 3 |
| `NO_ESCALATION_SIGNAL` | 3 |
| `STATIC_INCOMPLETE` | 9 |
| `AMBIGUOUS` | 0 |
| v0.3 Runner 실행 | 9 |
| mock Provider 요청 | 9 |
| Tier 3 생략 | 6 |
| Legacy 실행 | 0 |
| Tier 2 GPT 호출 | 0 |
| History / Evidence 저장 | 15 / 15 |
| Policy mock 호출 / cleanup | 15 / 15 |
| 결과 미생성 | 0 |

상태 분포는 pilot-v8 문서의 기대값(3/3/9/0)과 같다. `STATIC_MALICIOUS`와
`NO_ESCALATION_SIGNAL` 6개는 Runner와 Provider를 호출하지 않았다.
`STATIC_INCOMPLETE` 9개는 실제 Runner를 각각 한 번 통과했고 mock Provider 요청도
각각 한 번이었다. Runner 호출 수와 Provider 요청 수는 별도 계수이며 일반적으로
동일하다고 가정하지 않는다.

mock 응답이 평가를 만들지 않았으므로 표본 실행의 LLM Evidence 생성/Policy 반영은
0건이다. 검증된 LLM Evidence의 생성·병합·Policy 수용, 잘못된 참조 격리와 부분 변환은
실제 Runner를 사용하는 계약 fixture 테스트에서 별도로 검증했다. 정적 Evidence,
OSV 결과와 scan status는 모든 Policy 요청에 유지됐다.

## 안전 경계와 환경

- 외부 LLM 및 외부 Policy 네트워크 호출: 0건
- `OBFUSCATION_GPT_MODE=off`, Tier 2 GPT guard 호출: 0건
- package install/import/entry point/lifecycle 실행: 0건
- GuardDog/Semgrep: Docker `--network none` 및 read-only artifact 경계
- 표본 실행: host Node v26.4.0. nested Docker의 host-path mount 제약 때문에 Node 24
  컨테이너 안에서 표본 분석기를 다시 실행하지 않았다.
- 계약·라우팅 테스트, typecheck와 build: Node v24.19.0 컨테이너에서 수행

이 결과는 악성 표본에 대한 오탐률, 전체 정확도, 실제 모델 품질 또는 실제 비용 절감을
입증하지 않는다. 실제 LLM smoke 전에는 승인된 테스트 endpoint/키, 데이터 취급 기준,
운영 timeout·rate limit 및 관측 로그 검토가 필요하다.
