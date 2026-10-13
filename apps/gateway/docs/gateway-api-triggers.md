# Gateway가 요청하는 API 명세

- 작성자: 정환희
- 기준 코드: `dev`의 `4e82b0c`
- 작성일: 2026-09-13 / 최신화: 2026-09-24
- 문서 상태: 현재 구현 기준 문서
- 관련 이슈: #330

Gateway가 다른 서비스에 **언제, 무엇을 요청하고 응답을 어떻게 처리하는지** 설명합니다. 제공 API와 사용자에게 반환하는 공통 오류 JSON은 [Gateway 제공 API 명세](gateway-api.md)를 참조합니다.

## 1. 호출 대상

| 대상 | 목적 | Method·경로 |
|---|---|---|
| Decision DB API | 저장된 판정 조회 | `POST /internal/v1/decisions/lookup` |
| Scanner | 미판정 패키지 분석 | `POST /internal/v1/scans` |
| Verdaccio Approval | 허용 패키지 승인 등록 | `POST /-/whs/approvals` |
| Verdaccio Registry | npm 요청 중계 | 등록된 인증·Metadata·Tarball 경로 |
| npm Registry | 의존성 트리 구성용 Metadata 조회 | Arborist 라이브러리가 요청 수행 |

Gateway는 Policy Engine이나 PostgreSQL에 직접 판정을 요청하지 않습니다. 저장된 판정은 **Decision DB API**를 통해 조회합니다.

### 공통으로 전달하는 패키지 정보

Decision 조회·Scanner 분석·Approval 등록의 요청 본문은 같은 필드 구조를 사용합니다. 단, 목록에 포함하는 패키지는 호출 목적에 따라 다릅니다.

```json
{
  "requestId": "00000000-0000-4000-8000-000000000001",
  "packages": [
    {
      "packageName": "is-number",
      "version": "7.0.0",
      "integrity": "sha512-<해당 패키지의 실제 Base64 해시>"
    }
  ]
}
```

- `requestId` — 현재 Gateway HTTP 요청의 UUID입니다. 한 번의 설치 전체를 의미하지 않습니다.
- `packages` — 조회·분석·승인할 패키지 목록입니다.
- `packageName` — Scope가 있으면 포함한 패키지명입니다.
- `version` — 정확한 패키지 버전입니다.
- `integrity` — Arborist가 Registry Metadata에서 얻은 SRI 문자열입니다. Gateway는 null·빈 값이면 트리 구성 단계에서 `400`으로 중단하므로 null이나 빈 값을 보내지 않습니다. 알고리즘은 검사하지 않으므로 `dist.integrity`가 없는 옛 패키지는 `sha1-…` 값이 전달될 수 있습니다.

위 필드는 모두 Gateway 요청 DTO에 필수로 정의되어 있습니다. 요청 본문에는 루트 패키지를 구분하는 필드가 없습니다. Gateway 내부에서는 요청한 패키지(root)를 알고 있지만 외부 요청에는 전달하지 않습니다. UUID는 설명용이며, 해시 자리표시는 실제 요청에 사용할 수 없습니다.

### 분석 이력 캐시와 호출 횟수

Gateway는 트리 분석과 Approval 등록까지 마친 패키지를 프로세스 메모리의 LRU 캐시에 기억합니다. 판정 결과는 기억하지 않습니다.

- 크기: `ANALYSIS_CACHE_MAX_ENTRIES`, 기본 **5000**개
- 기억 시점: Approval 등록이 성공한 뒤. 차단·실패한 패키지는 기억하지 않습니다.
- 캐시에 있는 패키지: 트리 구성과 Scanner를 생략하고, 요청마다 Decision 1건 조회와 Approval 재등록을 수행합니다. 재검증에서 집행이 실패하면 캐시에서 삭제합니다.
- 캐시에 없는 패키지: 프로세스 전체에서 한 번에 하나씩 순서대로 분석합니다.
- Gateway 인스턴스 사이에 공유하지 않으며 재시작하면 비워집니다.

세 POST 요청 모두 `Content-Type: application/json`을 사용하며, npm 사용자의 `Authorization` 헤더를 전달하지 않습니다.

## 2. Decision DB API — 판정 조회

### 목적과 호출 조건

패키지에 저장된 판정이 있는지 확인합니다. 다음 상황에서 호출합니다.

- 처음 처리하는 패키지의 의존성 트리 구성 후: 검사 대상 목록 조회
- Scanner 분석 완료 후: 같은 목록의 판정 재조회
- Gateway가 기억한 패키지의 재요청: 요청한 패키지 하나의 판정 재검증

### 요청

```http
POST {DECISION_DB_URL}/internal/v1/decisions/lookup
Content-Type: application/json
Accept: application/json
```

기본 주소는 `http://decision-db-api:9100`입니다. 본문은 1절의 공통 JSON 형식이며 `packages`에 **조회할 대상**을 넣습니다.

### 응답

정상 조회는 `200`입니다. 아래는 판정이 있는 경우의 주요 필드 예시입니다.

```json
{
  "requestId": "00000000-0000-4000-8000-000000000001",
  "results": [
    {
      "packageName": "is-number",
      "version": "7.0.0",
      "integrity": "sha512-<해당 패키지의 실제 Base64 해시>",
      "lookupStatus": "FOUND",
      "decisionId": "dec_example",
      "decision": "ACCEPT"
    }
  ]
}
```

판정이 없으면 같은 패키지 식별 필드와 `lookupStatus: "NOT_FOUND"`를 반환하고 판정 필드는 생략합니다. **NOT_FOUND는 조회 결과이며 HTTP 404 오류가 아닙니다.**

`FOUND`는 판정이 존재한다는 뜻입니다. 그 판정은 ACCEPT뿐 아니라 REJECT·HOLD·REVIEW일 수도 있습니다. 응답에는 `policyKey`, `policyVersion`, `evaluatedAt`이 추가될 수 있습니다.

### 성공 조건과 응답 검증

Gateway는 HTTP 2xx 여부, JSON 파싱, 다음 응답 검증까지 통과해야 조회 성공으로 처리합니다.

- `results`의 개수와 순서가 요청 목록과 일치해야 합니다.
- 각 항목의 `packageName`, `version`, `integrity`가 요청과 일치해야 합니다.
- `lookupStatus`는 `FOUND` 또는 `NOT_FOUND`여야 합니다.
- `FOUND`에는 비어 있지 않은 `decisionId`와 유효한 판정값이 필요합니다.
- 응답 `requestId`가 있으면 요청 ID와 일치해야 합니다. 현재 Gateway는 누락 자체는 거부하지 않습니다.

`policyKey`, `policyVersion`은 비어 있지 않은 문자열이면 사용합니다. `evaluatedAt`은 문자열이면 사용하고 아니면 내부적으로 빈 문자열을 설정합니다. 현재 Gateway는 날짜 형식까지 검사하지 않습니다.

### 실패와 후속 처리

| 상황 | Gateway 처리 |
|---|---|
| 연결 실패·Timeout·HTTP 2xx 이외 | 중단 후 공통 `500 / GATEWAY_INTERNAL_ERROR` |
| JSON 파싱 또는 응답 검증 실패 | 중단 후 공통 `500 / GATEWAY_INTERNAL_ERROR` |
| 최초 조회에 NOT_FOUND 존재 | Scanner 활성화 시 분석 요청 |
| 분석 후에도 NOT_FOUND 또는 재검증 시 NOT_FOUND | `403 / PACKAGE_NOT_ALLOWED` |
| 집행 대상 모두 ACCEPT | Approval 등록 진행 |
| 집행 대상에 REJECT·HOLD·REVIEW 포함 | `403 / PACKAGE_NOT_ALLOWED` |

판정 집행에는 3절의 Scanner 비활성화 예외가 있으므로, 조회 결과가 항상 즉시 집행되는 것은 아닙니다.

Timeout: `DECISION_DB_TIMEOUT_SECONDS`, 기본 **5초**.

구현: [Client](../src/clients/decision-lookup.client.ts), [DTO](../src/dto/decision-lookup.dto.ts), [응답 검증](../src/services/decision-lookup-adapter.service.ts). 제공 측: [Decision DB API](../../policy/app/decision_db_api.py), [모델](../../policy/app/decision_models.py).

## 3. Scanner — 분석 요청

### 목적과 호출 조건

최초 Decision 조회에서 판정이 없는 패키지들을 분석합니다. `NOT_FOUND` 대상이 있고 `SCANNER_ENABLED`가 문자열 `true`일 때 호출합니다.

### 요청

```http
POST {SCANNER_URL}/internal/v1/scans
Content-Type: application/json
```

기본 주소는 `http://scanner:3001`입니다. 본문은 1절의 공통 JSON 형식이며 `packages`에는 **미판정 대상만** 모아 한 번에 보냅니다.

Scanner는 요청을 다음 조건으로 검증하며, 하나라도 어긋나면 배치 전체를 `400`으로 거부합니다.

- `requestId`: UUID
- `packages`: 1개 이상
- `packageName`: 새 패키지 이름 규칙(`validForNewPackages`) 충족
- `version`: 정확한 Semantic Version
- `integrity`: sha512 SRI 문자열 (null 불가)

### 응답과 성공 조건

현재 Scanner Controller의 정상 응답은 본문 없는 `200`입니다.

```http
HTTP/1.1 200 OK
```

Gateway는 **정확히 200만 분석 완료로 인정**하고, 응답 본문을 읽지 않습니다. 이후 Decision DB를 다시 조회하여 실제 판정을 확인합니다. Scanner는 분석과 필요한 판정 저장이 끝난 뒤 완료 응답을 보내야 합니다.

### 실패 조건

- 연결 실패 또는 Timeout: Gateway 공통 `500 / GATEWAY_INTERNAL_ERROR`
- 200 이외의 응답: Gateway 공통 `500 / GATEWAY_INTERNAL_ERROR`
- **201·202도 실패**입니다. 요청 접수만으로 분석 완료를 판단하지 않습니다.
- Scanner는 배치 중 한 패키지라도 분석 결과가 FAILED·TIMEOUT이거나 처리 중 오류가 나면 `500`을 반환하므로 설치 요청 전체가 실패합니다.
- sha1 integrity 등 Scanner 입력 검증에 맞지 않는 값이 포함되면 Scanner `400`을 거쳐 Gateway 공통 `500`이 됩니다.
- Scanner 오류 본문을 npm 클라이언트에게 그대로 전달하지 않습니다.

Timeout: `SCANNER_TIMEOUT_MS`, 기본 **300000ms (5분)**.

**비활성화 시 현재 동작:** 초기 조회에 미판정 대상이 있으면 분석뿐 아니라 해당 분기의 판정 집행도 생략하고 Registry 중계로 돌아갑니다. 이 경우 함께 조회된 차단 판정도 집행하지 않습니다. 이후 Verdaccio Guard가 거부할 수 있으므로 최종 설치 성공을 뜻하지는 않습니다. 모두 기존 판정이 있거나 기억된 패키지를 재검증하는 경우에는 판정을 집행합니다.

구현: [Client](../src/clients/scanner.client.ts), [DTO](../src/dto/scanner-request.dto.ts), [호출 조건](../src/services/tarball-analysis.service.ts). 제공 측: [Scanner Controller](../../scanner/src/api/scan.controller.ts).

## 4. Verdaccio Approval — 승인 등록

### 목적과 호출 조건

허용 판정을 받은 패키지를 Verdaccio 승인 목록에 등록합니다. 판정 집행 시 대상이 비어 있지 않고 **모두 FOUND / ACCEPT**인 경우 호출합니다.

### 요청

```http
POST {VERDACCIO_URL}/-/whs/approvals
Content-Type: application/json
Authorization: Bearer <token>
x-request-id: <본문의 requestId>
```

기본 주소는 `http://verdaccio:4873`입니다. 본문은 1절의 공통 JSON 형식이며 `packages`에는 **승인할 패키지 목록**을 넣습니다. Gateway는 승인 TTL을 요청 인자로 보내지 않습니다.

`x-request-id`에는 본문의 `requestId`와 같은 값을 전달합니다. 새 ID를 생성하지 않으며, Verdaccio가 본문을 읽기 전에 인증을 거절해도 해당 요청을 추적할 수 있습니다.

Approval API 서비스 인증을 사용하는 환경에서는 Gateway와 Verdaccio에 동일한 `WHS_APPROVAL_SERVICE_TOKEN`을 설정해야 합니다. Gateway는 설정된 토큰의 양끝 공백을 제거한 뒤 `Authorization: Bearer <token>` 헤더로 전달합니다.

토큰이 미설정이거나 빈 값이면 인증 헤더를 생략합니다. Verdaccio의 서비스 인증이 활성화되어 있으면 토큰 누락·불일치 요청은 `401`로 거절되며, Gateway는 이를 승인 등록 실패로 처리합니다. 실제 토큰은 배포 환경에서 주입하고 Repository에 기록하지 않습니다.

### 응답과 성공 조건

Plugin의 정상 응답은 `200`이며 본문은 다음과 같습니다.

```json
{
  "requestId": "00000000-0000-4000-8000-000000000001",
  "status": "REGISTERED",
  "packageCount": 1
}
```

`packageCount`는 등록 요청의 패키지 수입니다. Gateway는 **정확히 200인지 확인하고 본문은 사용하지 않습니다.** 등록 성공 후 패키지 식별 정보를 기억하고 Tarball을 중계합니다.

### 실패 조건

연결 실패·Timeout·200 이외 응답이면 중단하고 Gateway 공통 `500 / GATEWAY_INTERNAL_ERROR`를 반환합니다. 예를 들어 Plugin의 `403`도 이 호출에서는 npm 클라이언트에게 그대로 전달하지 않습니다.

Timeout: `VERDACCIO_TIMEOUT_MS`, 기본 **60000ms (1분)**.

이 경로는 내부 연동용입니다. Gateway 외부 경로인 `/npm/-/whs/approvals`로 호출할 수 없습니다.

구현: [Client](../src/clients/approval.client.ts), [DTO](../src/dto/approval-request.dto.ts). 제공 측: [Approval Plugin](../../../infra/verdaccio/plugins/verdaccio-whs-approval/index.js).

## 5. Verdaccio Registry — npm 요청 중계

### 목적과 호출 조건

등록된 인증·Metadata·Tarball API에서 npm 요청을 전달합니다. Metadata는 패키지명 검증 후, Tarball은 분석 서비스가 예외 없이 반환한 후 중계합니다. 분석 서비스 반환에는 앞서 설명한 Scanner 비활성화 예외도 포함됩니다.

### 요청

`RegistryProxy`가 `VerdaccioClient.forward()`에 다음 인자를 전달합니다.

- `method`: 클라이언트 요청 Method
- `path`: 원본 URL에서 `/npm`만 제거한 경로. Query·Percent Encoding 유지
- `headers`: 원본 요청 헤더에 Gateway의 requestId와 클라이언트 IP를 설정. Client에서 중계 제외 항목 필터링
- `body`: 원본 요청 Buffer. 없으면 생략

Metadata 요청의 변환 예시입니다.

```text
클라이언트 → Gateway
GET /npm/express?x=1

Gateway → Verdaccio
GET {VERDACCIO_URL}/express?x=1
```

기본 주소는 `http://verdaccio:4873`입니다. 인증 PUT의 JSON과 Tarball GET 등도 같은 규칙을 사용합니다. 개별 요청 예시는 [제공 API 명세](gateway-api.md)에 있습니다.

### 응답과 성공·실패 처리

Client는 상위 응답의 `status`, 필터링한 `headers`, 스트림 `body`를 반환하고 Proxy가 클라이언트에 전달합니다. 예를 들어 Metadata는 JSON, Tarball은 바이너리 응답입니다.

- 정상 HTTP 응답을 받으면 상태 코드와 본문을 중계합니다.
- **Verdaccio의 4xx·5xx도 그대로 중계합니다.** 특정 성공 코드만 허용하는 Approval 호출과 다릅니다.
- fetch 연결 실패·Timeout 등 예외는 Gateway 공통 `500`으로 처리합니다.
- 이미 전송을 시작한 뒤의 스트림 오류는 새 오류 JSON으로 교체된다고 보장하지 않습니다.

Timeout: `VERDACCIO_TIMEOUT_MS`, 기본 **60000ms (1분)**. 응답 헤더 수신뿐 아니라 본문 스트림 전송까지 포함하므로, 전송이 1분을 넘는 Tarball은 도중에 끊깁니다.

### 헤더 전달 규칙

- 요청의 `x-request-id`는 Gateway가 생성한 `request.id`로 설정합니다. 사용자 응답에서도 같은 ID를 유지하며, Verdaccio가 반환한 다른 ID로 대체하지 않습니다.
- 요청의 `X-Forwarded-For`는 Gateway의 `request.ip`로 설정합니다. 클라이언트가 보낸 두 추적 헤더는 덮어씁니다.
- npm 사용자의 `Authorization`은 전달합니다.
- 요청에서 `host`, `accept-encoding`, `content-length`를 제외합니다.
- 요청·응답에서 `connection`, `keep-alive`, `proxy-authenticate`, `proxy-authorization`, `te`, `trailer`, `transfer-encoding`, `upgrade`를 제외합니다.
- 상위 응답에 `content-encoding`이 있으면 자동 압축 해제로 불일치할 수 있는 `content-encoding`, `content-length`도 응답에서 제외합니다.

현재 Gateway는 앞단 프록시를 신뢰하도록 설정하지 않으므로 `request.ip`는 직접 연결한 상대의 IP입니다. Gateway 앞에 프록시를 추가하면 신뢰 범위와 클라이언트 IP 처리 방식을 함께 검토해야 합니다. Verdaccio의 `trustProxy`와 Compose의 `whs` 네트워크 대역은 `172.28.0.0/24`로 일치해야 합니다.

구현: [RegistryProxy](../src/http/registry-proxy.ts), [VerdaccioClient](../src/clients/verdaccio.client.ts).

## 6. npm Registry — 의존성 조회

### 현재 Tarball 처리에서 사용하는 호출

`ArboristClient.buildDependencyTree(packageName, version)`는 처음 처리하는 패키지의 트리 구성이 필요할 때 호출됩니다. `{packageName}@{version}`을 Arborist에 전달하고, 라이브러리가 Registry Metadata를 조회합니다.

- 조회 주소: `NPM_REGISTRY_URL`, 코드 기본값 `https://registry.npmjs.org`
- 전달값: 정확한 패키지명·버전, Registry 주소, 임시 작업 경로, Registry 의존성만 허용하는 옵션
- 반환값: 패키지별 `name`, `version`, `integrity` 목록. Registry의 HTTP 응답을 그대로 반환하는 방식이 아님
- 성공 조건: 트리 구성 완료. 이후 Service에서 요청 패키지와 필수 integrity 존재 여부를 별도 검증
- 실패 처리: 트리 구성 실패는 Gateway 공통 `500`. 필수 integrity 누락은 현재 `400 / INVALID_REQUEST`
- Timeout: Gateway가 별도로 지정한 전체 트리 구성 Timeout 없음

이것은 Gateway가 직접 구성하는 고정된 단일 REST 요청이 아니므로 Method·경로·성공 상태 코드를 임의로 정의하지 않습니다. 클라이언트 lockfile을 전달받아 조회하는 API도 아닙니다.

구현: [ArboristClient](../src/clients/arborist.client.ts), [DependencyTreeService](../src/services/dependency-tree.service.ts).

---

각 Timeout은 **해당 외부 호출의 제한**이며 Gateway 요청 전체의 처리 시간 제한이 아닙니다. 직접 작성한 위 HTTP Client에는 재시도 루프가 없으며 npm·Arborist 등 라이브러리의 동작과 구분합니다. 본 문서는 실제 구현 계약을 기록하며 새로운 오류 정책이나 운영 설정을 확정하지 않습니다.
