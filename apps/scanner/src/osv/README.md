# Scanner OSV Feed Client (W6-SC-G-01 / #259)

## 기준과 범위

이번 구현 기준은 Issue #259와 최신 사용자 구현 요구사항·추가 조건이다.
`docs/osv-policy-integration.md`의 #237은 이전 Policy 구현 이력이며,
최신 Scanner 설계 또는 이번 구현의 기준이 아니다. 기존 HTTP 처리·테스트
사례를 비교할 때만 참고할 수 있다. 이번에는 해당 Policy 구현을 이식하지 않았다.
실제 참고 구현은 Scanner RegistryMetadataClient의 Transport 주입·스트림 크기 제한·
AbortController/전체 timeout 패턴과 package-deadline.ts, 기존 Jest spec 구조다.

독립 TypeScript 모듈과 테스트만 제공한다. OsvFeedResult는 내부 인터페이스 **초안**이다.
Orchestrator, AnalyzerResult, scanStatus, evidences, Policy Python/Endpoint/Scoring,
공유 JSON Schema, Scanner→Policy 전송 Contract, DB Schema에는 연결하거나 변경하지 않는다.

## 호출

```ts
import { OsvFeedClient } from './osv-feed-client';

const client = new OsvFeedClient(); // 운영 설정 및 테스트 Transport는 생성자로 주입
const result = await client.query({
  ecosystem: 'npm',
  packageName: verifiedPackage.name,
  packageVersion: verifiedPackage.version,
  permission: { allowed: true, basis: 'VERIFIED_PUBLIC_NPM' },
  remainingMs: deadline.expired ? 0 : deadline.remainingMs(),
  signal: deadline.signal,
});
```

`permission`은 호출 Scanner 계층의 신뢰된 acquisition 결과·운영 설정에서 생성해야 한다.
공개 npm 출처·패키지 식별정보 검증과 대상 scan/artifact 연결은 호출 계층 책임이다.
사용자 요청 DTO의 허용 플래그나 packageName만으로 공개 출처를 추정해서는 안 된다.
모듈의 이름·정확한 semver 검사는 방어적 문법 검사이며 공개 출처 검증이 아니다.
미허용 입력은 `{ allowed: false, reason }`으로 전달한다.
reason: DISABLED / UNSUPPORTED_TARGET / PRIVATE_PACKAGE / PROVENANCE_UNCONFIRMED.
권한 정보 누락도 출처 미확정으로 생략한다.

기존 PackageDeadline.remainingMs()는 최소 1을 반환하므로 위처럼 expired와 signal을 함께
전달해야 한다. 이 모듈은 해당 기존 클래스는 변경하지 않는다.

## 상태 및 시각

| 상태 | 반환 의미 |
| --- | --- |
| SUCCESS | 모든 페이지 수집 성공. 빈 결과도 성공. complete=true, 원본 advisories 보존 |
| FAILED | HTTP/네트워크/JSON/envelope 오류 또는 수집 한도 초과. complete=false, advisories=[] |
| TIMEOUT | DEADLINE_EXCEEDED / SCAN_BUDGET_EXHAUSTED / PARENT_ABORTED. complete=false, advisories=[] |
| SKIPPED | 비활성화·지원 대상 아님·private·출처 미확정·INVALID_PACKAGE_IDENTITY·INVALID_SCAN_BUDGET. HTTP 미호출 |

모든 결과는 source=OSV, query, feedStatus, advisories, complete, pagesFetched,
collectedAt, completedAt, errorCode, skippedReason을 포함한다. 해당 없는 코드는 null이다.
상위 취소를 TIMEOUT/PARENT_ABORTED로 표현하는 것은 **이 모듈의 초안 선택**이며,
합의 완료된 Policy 전송 Contract가 아니다. 생략 조건은 취소/시간 검사보다 먼저 평가한다.

- collectedAt: 첫 HTTP 시도 직전 UTC ISO 시각. 미호출은 null. TTL 기준으로 사용하지 않는다.
- completedAt: 모든 페이지 수집 성공 이후 UTC ISO 시각. 실패·취소·생략은 반드시 null.
  향후 수집 freshness/TTL 기준은 성공 completedAt을 사용해야 하며 시작·실패 시각으로 대체하면 안 된다.
- pagesFetched: 본문·JSON·envelope 검사까지 끝낸 페이지 수. 이후 실패해도 진단용 수는 유지한다.
- complete: 수집 완료만 의미한다. Policy의 advisory 의미 검증 완료를 의미하지 않는다.
- Advisory affected version, withdrawn, severity 의미를 판단하거나 점수 계산·Evidence 변환하지 않는다.
  Policy Evaluation 요청에서는 기존 `evidences`와 별도 최상위 `osvFeed` 필드로 전달한다.
  순서·중복·원본 필드를 그대로 보존한다.

## 외부 통신과 수집 제한

[OSV 공식 POST /v1/query 문서](https://google.github.io/osv.dev/post-v1-query/)에 따라
package.name/ecosystem, version과 후속 page_token을 전송한다.
엔드포인트는 https://api.osv.dev/v1/query 고정이며 사용자 URL 입력은 없다.
기본 Node fetch는 redirect=manual을 사용하고 3xx를 HTTP_ERROR로 처리한다.
재시도 루프는 없으며 429/5xx도 재시도하지 않는다.
주입 Transport 역시 단일 시도·리다이렉트 금지·사전 전체 버퍼링 금지·AbortSignal 준수를 지켜야 한다.
실제 OSV 네트워크를 사용하는 테스트는 없다.

전체 시간은 min(2000ms, 설정 timeoutMs, 남은 Scan 시간)이다.
연결·응답 본문 수신·모든 페이지·파싱이 같은 단조 시계 deadline을 공유한다.
타이머 race와 단계별 시각 검사로 지연된 타이머 또는 비협조적인 Mock도 실패로 처리한다.
동기 JSON 처리는 JS 실행 중 강제 중단할 수 없으므로 수집 한도로 작업량을 제한하고
처리 후 deadline을 다시 검사한다. 시간 초과/실패 시 요청을 abort하고 본문을 cancel한다.

| 생성자 설정 | 기본값 | 근거 |
| --- | ---: | --- |
| timeoutMs | 2000 | 요구사항의 상한; 설정으로 단축만 가능 |
| maxPages | 10 | 임시 기본값 |
| maxPageBytes | 2097152 (2 MiB) | 기존 METADATA_MAX_RESPONSE_BYTES 기본 크기를 참고한 OSV 임시값 |
| maxTotalBytes | 4194304 (4 MiB) | 임시 기본값 |
| maxJsonDepth | 64 | 임시 기본값, 루트 object/array 깊이 1 |
| maxJsonStringLength | 262144 | 임시 기본값, JSON 문자열 내부 원문 UTF-16 code unit 수 |

기존 main.ts는 FastifyAdapter 기본 요청 제한을 사용하며 별도 bodyLimit을 지정하지 않는다.
Scanner config에는 OSV용 JSON 깊이·문자열 제한이 없었다. 요청 본문 제한은 외부 Feed
응답 크기를 정하는 합의 근거가 아니므로 위 OSV 수집 한도는 운영 확정값으로 표현하지 않는다.
모든 값은 생성자의 Partial<OsvLimits>로 설정 가능하며 양의 safe integer만 허용한다.
환경변수/공유 설정 Contract는 추가하지 않는다.

바이트 수는 fetch가 제공하는 디코딩된 본문 Uint8Array의 byteLength를 수신 중 합산한다.
초과 청크는 문자열/페이지 버퍼에 추가하지 않는다. JSON 깊이·문자열은 스트리밍 UTF-8
디코더와 lexical guard로 JSON.parse 전에 제한한다. 문자열 키도 제한하며 이스케이프는
원문 길이로 보수적으로 계산한다(예: \\u0061은 6). 잘못된 UTF-8은 INVALID_JSON이다.
후속 페이지 실패·반복 토큰·페이지 수·누적 바이트 등 어떤 제한 초과도 부분 Advisory를 반환하지 않는다.

## 후속 작업

Orchestrator 연결, 신뢰된 출처와 scan/artifact 연결, 공유 전송 Contract와 Policy 수신 연동은
별도 합의·구현 대상이다. 운영 한도와 취소 상태 매핑도 연결 전에 확정해야 한다.
동시 조회 병합·동시성 제한·Circuit Breaker·운영 모드 선택·Cache·Snapshot·백그라운드 갱신·
재평가는 후속 작업이며 최종 고도화 범위에서 제외된 기능이 아니다.
