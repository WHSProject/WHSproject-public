# verdaccio-whs-audit

보안 추적이 필요한 Registry 행위를 구조화된 JSON 한 줄로 `stdout`에 남기는 Middleware
Plugin입니다.

Verdaccio는 요청 로그를 남기지만 "누가, 언제, 무엇을, 어떤 결과로" 했는지를 일정한
형식으로 확인하기 어렵습니다. 이 Plugin은 감사에 필요한 이벤트만 골라 고정된 Schema로
출력합니다.

현재 범위:

- 로그인 성공·실패 기록
- Package Publish 성공·실패 기록
- Package Unpublish 성공·실패 기록
- Approval 등록·거부·만료 기록
- Version·Tarball Guard 차단과 Integrity 충돌 거부 기록
- Storage(로컬 Volume·S3) 접근 실패 기록
- Uplink(npmjs) 연결·응답 실패 기록
- 공통 Audit Event Schema와 `eventType: audit` 구분자
- 응답 상태가 확정된 뒤 기록 (요청당 한 번)
- 허용 목록 방식의 필드 선택
- `enabled` 설정으로 활성화 여부 제어

현재 제외 범위:

- 정상 Metadata 조회·Tarball 다운로드
- 감사 DB, 로그 수집, 보존 정책, 검색 UI

## 설정

Verdaccio는 `middlewares`의 키 이름으로 Plugin을 찾습니다. `whs-audit` 키가
`verdaccio-whs-audit` Package에 대응합니다.

```yaml
middlewares:
  audit:
    enabled: false
  whs-audit:
    enabled: true
  whs-approval:
    endpoint: /-/whs/approvals
```

`audit`은 Verdaccio가 기본 제공하는 다른 Plugin입니다. 이름이 비슷하지만 관련이
없으므로 함께 두고 각각 설정합니다.

`enabled: false`이면 Middleware를 아예 등록하지 않아 어떤 Event도 출력되지 않습니다.
설정을 생략하면 활성화됩니다.

Guard보다 먼저 등록해야 차단된 요청의 응답 결과까지 관측할 수 있으므로,
`whs-approval` 앞에 두는 것을 권장합니다.

Plugin 디렉터리는 `compose.yaml`이 이미 `/verdaccio/plugins`로 Mount하고 있어 별도
설정이 필요 없습니다.

## Audit Event Schema

### 필수 필드

| 필드 | 값 |
|---|---|
| `eventType` | 항상 `audit` |
| `timestamp` | UTC ISO 8601 문자열 |
| `action` | 아래 「기록하는 요청과 보안 동작」의 Event 이름 |
| `result` | `success` / `failure` |

`result`는 최종 HTTP 상태 코드로 정합니다. `200`~`299`가 `success`, 나머지는
`failure`입니다.

### 선택 필드

값을 신뢰성 있게 확인한 경우에만 포함합니다. 확인하지 못한 필드는 **생략**합니다.
`unknown`이나 빈 문자열로 채우지 않습니다. "확인했더니 없었다"와 "확인할 수 없었다"를
구분할 수 없게 되기 때문입니다.

| 필드 | 확인 방법 |
|---|---|
| `requestId` | `x-request-id` Header |
| `actor` | 로그인은 요청 경로의 사용자 문서, 그 외는 Verdaccio 인증 결과 |
| `actorRole` | 현재 신뢰할 수 있는 출처가 없어 기록하지 않음 |
| `sourceIp` | `request.ip`, 없으면 소켓 주소 |
| `packageName` | 요청 경로 |
| `version` | 현재 경로만으로 확인할 수 없어 기록하지 않음 |
| `statusCode` | 최종 응답 상태 코드. Storage·Uplink 오류는 그 오류의 상태 코드 |
| `reason` | 실패 시 상태 코드에서 만든 짧은 문자열 |
| `operation` | Storage·Uplink 오류에서 실패한 동작 이름 (`readPackage`, `readTarball` 등) |
| `uplink` | Uplink 오류에서 설정의 Uplink 이름 (`npmjs`) |

`reason`은 상태 코드 또는 보안 동작에서 정한 짧은 안전한 코드입니다. 응답 본문이나
Error 메시지를 그대로 쓰지 않습니다.

### 응답을 끝내지 못한 요청

연결이 중간에 끊기면 `finish` 없이 `close`만 발생합니다. 이때 `response.statusCode`는
기본값 `200`으로 남아 있어, 그대로 쓰면 **응답을 보내지도 못한 요청이 성공으로
기록됩니다.**

그래서 응답 완료 여부를 따로 확인해 다음과 같이 남깁니다.

```json
{"eventType":"audit","timestamp":"2026-01-02T03:06:20.000Z","action":"publish","result":"failure","packageName":"example-package","reason":"client_disconnected"}
```

Client가 받지 못한 상태 코드는 신뢰할 수 없으므로 `statusCode`를 생략합니다.

### 출력 예시

Verdaccio Logger가 `level`, `time`, `pid`, `hostname`, `msg`를 함께 붙이므로 실제
출력은 다음과 같은 한 줄입니다.

```json
{"level":30,"time":1767323045000,"pid":8,"hostname":"registry-host","eventType":"audit","timestamp":"2026-01-02T03:04:05.000Z","action":"login","result":"success","requestId":"req-0001","actor":"example-user","sourceIp":"192.0.2.10","statusCode":201,"msg":"[verdaccio-whs-audit] audit event"}
```

`msg`는 `docker logs`로 훑을 때 알아보기 위한 라벨이고, 감사 정보는 `eventType`부터
`reason`까지의 구조화된 필드에 있습니다. 아래 예시는 그 부분만 뽑은 것입니다.

`level`, `time`, `pid`, `hostname`은 Verdaccio Logger가 모든 로그에 붙이는 값입니다.
`time`은 `timestamp`와 같은 시각을 epoch 밀리초로 나타낸 것이라 값이 겹칩니다.
`timestamp`를 따로 두는 이유는 감사 필드만 뽑아냈을 때도 사람이 읽을 수 있는 시각이
남아야 하고, Logger 구현이 바뀌어도 Schema가 유지되어야 하기 때문입니다.

```json
{"eventType":"audit","timestamp":"2026-01-02T03:05:11.000Z","action":"publish","result":"failure","actor":"example-ci","packageName":"example-package","statusCode":403,"reason":"forbidden"}
```

Storage·Uplink 오류는 다음과 같습니다. 요청 맥락이 없어 `actor`와 `requestId`가
빠집니다(「관측 한계」 참고). 아래 두 줄은 실제로 오류를 만들어 받은 기록입니다.

```json
{"eventType":"audit","timestamp":"2026-09-12T06:04:40.407Z","action":"storage.error","result":"failure","packageName":"is-odd","statusCode":403,"reason":"access_denied","operation":"readPackage"}
{"eventType":"audit","timestamp":"2026-09-12T06:02:45.780Z","action":"uplink.error","result":"failure","reason":"connection_failed","operation":"getRemoteMetadata","uplink":"npmjs"}
```

`eventType: audit`으로 Verdaccio 기본 로그와 구분합니다. 로그 수집 단계에서 이 필드로
감사 로그만 걸러낼 수 있습니다.

`type`이 아니라 `eventType`을 쓰는 이유는, 일부 로그 수집 도구가 `type`을 자체
메타데이터로 사용해 값이 덮어써질 수 있기 때문입니다.

## 기록하는 요청과 보안 동작

| 이벤트 | Method / 경로 | 기록 필드 |
|---|---|---|
| 로그인 | `PUT /-/user/{doc}` | `actor`, `sourceIp`, `statusCode` |
| 로그인 | `PUT /-/user/{doc}/-rev/{rev}` | 〃 |
| Publish | `PUT /{package}` | `packageName`, `actor`, `statusCode` |
| Unpublish | `PUT /{package}/-rev/{rev}` | `packageName`, `actor`, `statusCode` |
| Unpublish | `DELETE /{package}/-rev/{rev}` | 〃 |
| Unpublish | `DELETE /{package}/-/{file}/-rev/{rev}` | 〃 |

Approval Plugin도 같은 공통 Schema와 Logger를 사용해 다음 Event를 남깁니다. 두 Plugin이
서로를 직접 불러오지는 않으며 `plugins/shared/audit.js`의 최소 공통 함수만 사용합니다.

| `action` | 발생 시점 | `result` / Level | 선택 필드 |
|---|---|---|---|
| `approval.registered` | Approval API 요청 전체가 등록됨 | `success` / `info` | `requestId` |
| `service_auth.rejected` | Approval API 서비스 Token 검증 실패 | `failure` / `warn` | `requestId`, `statusCode`, `reason` |
| `approval.rejected` | 형식, Version, Metadata Integrity 또는 준비 오류로 등록 실패 | `failure` / `warn` | `requestId`, `packageName`, `version`, `reason` |
| `approval.expired` | TTL 만료 항목이 Memory에서 실제 제거됨 | `failure` / `warn` | `packageName`, `version`, `reason` |
| `approval.revoked` | 취소 API 요청 전부(성공·`400`·`404`) | `success`·`failure` / `info`·`warn` | `requestId`, `packageName`, `version`, `statusCode`, `reason` |
| `guard.blocked` | 미승인 Version/Tarball 또는 현재 Metadata 불일치로 403 차단 | `failure` / `warn` | `requestId`, `packageName`, `version`, `reason` |
| `integrity.conflict` | 같은 Package와 파일명에 다른 Integrity 등록을 거부 | `failure` / `warn` | `requestId`, `packageName`, `version`, `reason` |
| `storage.error` | 저장소(로컬 Volume 또는 S3) 읽기·쓰기 실패 | `failure` / `warn` | `packageName`, `operation`, `statusCode`, `reason` |
| `uplink.error` | Uplink(npmjs) 연결 실패 또는 오류 응답 | `failure` / `warn` | `uplink`, `packageName`, `operation`, `statusCode`, `reason` |

한 Approval API 요청에 Package가 여러 개여도 `approval.registered`는 요청당 한 건만
기록합니다. 만료 Event는 Store에서 실제 삭제된 항목만 한 번 기록합니다. Package와
Version은 요청이나 Store에서 확실히 확인한 경우에만 포함합니다.

Scoped Package는 `/@scope/name`과 `/@scope%2Fname` 두 형태를 모두 처리합니다.

### 로그인 경로가 둘인 이유

`npm login`은 `PUT /-/user/{doc}`으로 자격 증명을 보냅니다. `max_users: -1` 설정
때문에 이 경로는 가입 요청으로 먼저 판정되지만, **`Authorization: Basic` Header를
함께 보내면 기존 계정 인증으로 처리되어 `201`과 Token을 돌려줍니다.** npm CLI는 이
Header를 같이 보내므로 이 경로가 실제 로그인입니다
(`infra/verdaccio/scripts/smoke.sh`의 실측 주석).

Basic Header 없이 시작하면 `409`로 끝나고, Client가 `_rev`를 조회한 뒤
`PUT /-/user/{doc}/-rev/{rev}`로 다시 시도합니다. 이 경로도 자격 증명이 오가는
지점이라 함께 기록합니다.

따라서 한 번의 로그인에서 **실패(`409`)와 성공(`201`)이 잇달아 남을 수 있습니다.**
상태 코드로 구분합니다.

`GET /-/user/{doc}`은 `_rev`를 읽는 조회라 기록하지 않습니다.

### 기록하지 않는 요청

정상 Metadata 조회, Version Metadata 조회, Tarball 다운로드, `GET /-/ping`, Web UI
요청은 기록하지 않습니다. `npm install` 한 번에 수백 건이 발생해 감사 로그가 묻히기
때문입니다. 차단된 Version/Tarball 요청만 `guard.blocked`로 기록하며, 정상 요청 이력이
필요하면 Verdaccio 기본 Access Log에서 확인합니다.

## 민감정보

Event는 위 Schema의 필드만 골라 만듭니다. 요청 객체나 Header를 통째로 넘기는 경로가
없으므로, 목록에 없는 값은 로그에 나갈 수 없습니다.

다음은 어떤 경우에도 기록하지 않습니다.

```text
비밀번호        Authorization Header    Cookie
JWT 전체 값     서비스 Token            Secret Key
요청 본문       응답 본문               Publish Attachment
```

로그인 요청의 본문과 Header를 읽지 않으며, Token을 해석하지 않습니다. `actor`는
로그인 경로의 사용자 문서 이름이나 Verdaccio 인증 Middleware가 채운 값에서만
가져옵니다.

## 관측 한계

**`requestId`는 Gateway가 식별자를 전달해야 채워집니다.** Approval API Event는 Body의
`requestId`를 사용하고, Guard 차단 Event는 `x-request-id` Header를 사용합니다. Gateway가
이 Header를 전달하면 두 Component의 로그를 연결할 수 있습니다. Header가 없는 현재
상태에서도 차단 Event는 기록되지만 `requestId`는 생략됩니다. 새 ID를 임의로 만들지는
않습니다.

**`sourceIp`는 Proxy Header 전달에 의존합니다.** Gateway가 `X-Forwarded-For`를 붙이지
않으면 Gateway IP만 보입니다. `config.yaml`의 `trustProxy`는 이미 설정돼 있으나
전달하는 쪽이 없습니다. Plugin에서 원본 Header를 임의로 해석하지 않습니다.

**`actorRole`은 기록하지 않습니다.** 요청 경로나 사용자명으로 역할을 추측할 수 있지만
근거가 없습니다. 신뢰할 수 있는 역할 정보가 생기면 그때 추가합니다.

**`version`은 기록하지 않습니다.** Publish 대상 버전은 요청 본문에 있고, 본문을 읽지
않기로 했습니다. Unpublish 경로에도 버전이 드러나지 않습니다.

**Storage·Uplink 오류에는 `actor`와 `requestId`가 없습니다.** 이 오류는 HTTP Middleware가
아니라 Verdaccio가 내부에서 부르는 저장소·Uplink 호출에서 잡습니다. 그 지점에는 요청
맥락이 없어 누가 요청했는지, 어떤 요청이었는지 알 수 없습니다. 시각과 Package 이름으로
같은 시점의 요청 로그와 맞춰 봐야 합니다.

**관측 방식과 범위.** Verdaccio가 Plugin에 넘겨주는 `storage` 객체에서 다음을 감싸 실패만
기록합니다. 결과는 바꾸지 않고, 기록에 실패해도 Registry 요청은 그대로 진행됩니다.

| 대상 | 감싸는 것 |
|---|---|
| 저장소 | `getPackageStorage()`가 돌려주는 객체의 `readPackage`, `createPackage`, `savePackage`, `updatePackage`, `deletePackage`, `removePackage`, `readTarball`, `writeTarball` |
| Uplink | `getRemoteMetadata`, `fetchTarball` |

이 경로는 **Verdaccio 내부 속성**을 거칩니다. 업그레이드로 모양이 바뀌면 관측을 붙이지
못하고, 기동 시 `storage.error events are disabled` 경고를 남긴 뒤 Registry는 그대로
동작합니다. 조용히 빠지지 않게 하기 위해서입니다.

**"없음"은 오류로 보지 않습니다.** 캐시에 없는 Package를 받아오는 흐름에서는 파일이 없는
것이 정상입니다. `ENOENT`, `NoSuchKey`, `NotFound`, `404`는 기록하지 않습니다. 이것까지
남기면 평상시 로그가 "없음"으로 가득 차 진짜 오류가 묻힙니다.

**Uplink 상태 코드는 `remoteStatus`에서 읽습니다.** Verdaccio는 Uplink가 2xx가 아닌 응답을
주면 500 내부 오류로 감싸고 실제 상태 코드를 `remoteStatus`에 담습니다(`up-storage.js`
실측). 이 필드를 먼저 보지 않으면 npmjs의 `503`이 전부 `500 server_error`로 뭉개집니다.

**Error 메시지는 남기지 않습니다.** 메시지에는 저장 경로, 버킷 이름, 자격증명이 섞일 수
있습니다. 아래 분류 값과 상태 코드만 기록합니다.

`permission_denied`(`EACCES`·`EPERM`), `read_only`(`EROFS`), `no_space`(`ENOSPC`),
`access_denied`(`403`·`AccessDenied`), `unauthorized`(`401`), `timeout`,
`connection_failed`, `server_error`(5xx), `client_error`(4xx), `unknown_error`

### 실측한 오류 상황

실제로 오류를 만들어 Event가 남는 것을 확인한 경우입니다.

| 만든 상황 | `action` | `reason` | `operation` |
|---|---|---|---|
| 저장 폴더에 쓰기 권한 없음 (로컬) | `storage.error` | `permission_denied` | `savePackage` |
| Volume을 읽기 전용으로 Mount (로컬) | `storage.error` | `read_only` | `savePackage` |
| S3 자격증명 오류 (`403 AccessDenied`) | `storage.error` | `access_denied` | `readPackage` |
| Uplink 주소에 연결 실패 | `uplink.error` | `connection_failed` | `getRemoteMetadata` |

정상 기동·조회, 미인증 `401`, 없는 Package `404` 흐름에서는 이 Event가 하나도 남지
않는 것도 함께 확인했습니다.

Cache 무결성 Event, Metrics, Webhook은 후속 작업으로 남깁니다.

**`PUT /{package}/-rev/{rev}`를 Unpublish로 분류합니다.** 이 요청 자체는 Metadata
수정이며, `npm unpublish pkg@ver`가 사용하는 경로입니다(`infra/verdaccio/config.local.yaml`의
실측 주석). 본문을 읽지 않고는 다른 Metadata 수정과 구분할 수 없어, 경로 기준으로
분류하고 이 한계를 남깁니다.

## 로그 Level과 양

성공 Event는 `info`, 실패 Event는 `warn`으로 출력합니다.

```text
http(25)  <  info(30)  <  warn(40)
```

로그에는 이름이 아니라 **숫자로** 기록됩니다. `25`가 `http`, `30`이 `info`,
`40`이 `warn`입니다. `log.level`에 설정한 값 **이상**이 출력됩니다.

`config.yaml`의 `log.level`에 따라 다음과 같이 달라집니다.

| `log.level` | Verdaccio 요청 로그 | 감사 성공 | 감사 실패 |
|---|---|---|---|
| `http` (현재) | 출력 | 출력 | 출력 |
| `info` | 제외 | 출력 | 출력 |
| `warn` | 제외 | **제외** | 출력 |

`warn`으로 올리면 로그가 크게 줄지만 **"누가 무엇을 배포했는가"를 추적할 수 없습니다.**
감사 로그의 핵심이 그 이력이므로, 양을 줄여야 한다면 `info`를 먼저 검토하시기 바랍니다.
`info`만으로도 요청마다 쌓이는 Verdaccio 기본 로그가 빠져 대부분의 양이 줄어듭니다.

어느 쪽을 택할지는 도입 조직이 정합니다. 현재 설정은 개발 중 요청 흐름을 보기 위해
`http`입니다.

### 감사 로그는 얼마나 쌓이나

행위 횟수에 비례하고 조회량과는 무관합니다. `npm install`을 아무리 실행해도 Event가
늘지 않습니다.

```text
로그인          사용자당 1~2건
Publish         배포 횟수만큼
Unpublish       삭제 횟수만큼
차단된 요청     발생한 만큼
```

## 로그 수집

Plugin은 `stdout`에 출력하는 것까지만 담당합니다. 수집 도구, 저장소, 보존 기간,
검색 화면은 DevOps 범위입니다.

Verdaccio 기본 로그와 같은 스트림으로 나가므로 `eventType: audit` 필드로 구분합니다.

## Test

```bash
cd infra/verdaccio/plugins/verdaccio-whs-audit
npm test
```

시각이 필요한 Test는 고정 시각을 주입해 실제 대기 없이 수행합니다.
