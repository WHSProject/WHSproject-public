# verdaccio-whs-approval

Gateway가 전달한 승인 Package 목록을 바탕으로 Metadata와 Tarball을 Verdaccio
Storage에 준비하고, 준비된 Artifact를 프로세스 메모리에 등록하는 Middleware
Plugin입니다.

현재 범위:

- `requestId`, `packageName`, `version`, `integrity` 요청 형식 검사
- 승인 Package Metadata를 npmjs Uplink에서 조회하고 Verdaccio Storage에 Cache
- 승인된 정확한 Version의 `dist.integrity`와 전달받은 `integrity` 비교
- 승인 Package Tarball 다운로드 및 Verdaccio Storage 저장 확인
- `packageName + version + integrity` 단위의 메모리 저장
- 모든 Package 준비 완료 후 ACK 및 기본 오류 응답
- 성공과 실패 모두 `requestId`를 로그에 기록
- `POST /-/whs/approvals` 승인 목록 API 등록
- `GET /-/whs/approvals` 활성 승인 목록 조회
- `DELETE /-/whs/approvals?packageName=...&version=...` Package/Version별 승인 취소
- Verdaccio 6.10.0 CommonJS Plugin Loader와 호환되는 함수형 진입점
- Package Metadata 요청은 ACCEPT 등록 여부와 관계없이 기존 Registry로 전달
- Package Version Metadata 요청의 Version·`dist.integrity` 재확인
- Metadata 요청 여부와 무관하게 Tarball 요청을 승인 목록과 대조
- `GET`과 `HEAD` 요청에 동일한 승인 검사 적용
- Scoped Package의 일반 경로와 `%2F` 인코딩 경로 처리
- `guard_enabled` 설정으로 Version·Tarball Guard 활성화 여부 제어
- `approval_ttl_seconds` 기준의 승인 유효기간과 만료 승인 차단·정리
- 같은 Package·파일명에 서로 다른 `integrity`가 등록되는 충돌 차단
- Approval 등록·거부·만료와 Guard 차단의 구조화된 Audit Event 출력

현재 제외 범위:

- 실제 Tarball 해시 재계산
- Approval 취소 Event, Storage·Uplink 내부 오류 Event, Metrics, Webhook

## API

Gateway는 Docker 내부 Network에서 다음 API를 직접 호출합니다. 이 경로는 외부
`/npm` Proxy 경로에 노출하지 않습니다.

```text
POST http://verdaccio:4873/-/whs/approvals
```

Approval API는 Docker Network 경계와 별개로 Gateway 서비스 인증을 요구합니다. 등록,
조회, 취소 세 Endpoint에 모두 적용됩니다.
Gateway와 Verdaccio에 같은 Secret을 `WHS_APPROVAL_SERVICE_TOKEN`으로 주입하고,
Gateway는 모든 Approval API 요청에 다음 Header를 보냅니다.

```http
Authorization: Bearer <secret>
```

전용 Header 대신 `Authorization`을 쓰는 이유는 Verdaccio의 요청 로거 때문입니다. 이
로거는 요청 Header를 그대로 출력하지만 `authorization`과 `cookie`는 `<Classified>`로
가립니다. 전용 Header를 쓰면 Secret이 평문으로 로그에 남습니다.

Scheme은 대소문자를 가리지 않으며, `Bearer` 이외의 Scheme(`Basic` 등)은 Token으로 읽지
않습니다. npm Client의 로그인 Header가 Approval API 인증으로 흘러드는 것을 막기
위함입니다.

환경변수 값의 양끝 공백은 제거합니다. Secret을 파일로 주입하면 끝에 개행이 붙는 경우가
있어, 그대로 두면 Gateway가 보낸 값과 조용히 어긋납니다. 값이 공백뿐이면 미설정으로
봅니다.

환경변수가 설정되지 않으면 Plugin 기동 시 경고를 남깁니다. 일반 Registry와 Healthcheck는
정상이라, 경고가 없으면 첫 승인 등록이 실패할 때까지 원인이 드러나지 않습니다.

환경변수가 없거나 Header가 누락/비어 있음/불일치하면 본문과 Storage를 처리하기 전에
다음 고정 응답으로 차단합니다. 누락과 불일치는 응답에서 구분하지 않으며, Audit Event도
`invalid_service_token` 하나로만 남깁니다.

```http
HTTP/1.1 401 Unauthorized
Content-Type: application/json
```

```json
{
  "error": "unauthorized service request"
}
```

실제 Secret은 설정 파일이나 Repository에 기록하지 않고 배포 환경에서 주입합니다.
`POST`/`GET`/`DELETE` Approval API는 모두 동일한 서비스 인증을 적용합니다. 사용자 JWT와
일반 Registry 요청에는 이 Header를 사용하지 않습니다.

인증 코드는 `plugins/shared/service-auth.js`에 있습니다. 다른 Plugin이 관리 API를 추가할
때도 같은 함수로 보호할 수 있도록 Approval Plugin 밖에 둡니다.

### 서비스 인증 끄기

```yaml
whs-approval:
  service_auth_enabled: false
```

저장소 설정은 `true`입니다(Gateway가 `Authorization: Bearer`로 Token을 보내도록 연동됨).
`false`는 연동 문제를 가릴 때 잠깐 쓰는 설정이며, `guard_enabled`와 같은 방식입니다.

- `false`이면 세 API가 Token 없이 동작하고, 기동할 때마다 인증이 꺼져 있다는 경고를 남깁니다.
- 생략하거나 `false` 이외의 값이면 인증이 켜집니다. 실수로 빠뜨려도 API가 열리지 않게 하기 위함입니다.
- 인용부호가 붙은 `"false"`는 문자열이므로 켜진 채로 남습니다.

꺼진 동안의 보안 수준은 인증을 넣기 전과 같습니다. `whs` Network의 모든 Container가
승인 목록을 바꿀 수 있습니다.

```json
{
  "requestId": "req-123",
  "packages": [
    {
      "packageName": "express",
      "version": "5.1.0",
      "integrity": "sha512-..."
    }
  ]
}
```

활성 Approval 조회는 만료 항목을 먼저 정리하고 Package, Version, 등록 시각과 만료
시각만 반환합니다. Integrity와 내부 Tarball 파일명은 관리 응답에 노출하지 않습니다.

```text
GET http://verdaccio:4873/-/whs/approvals
```

```json
{
  "status": "OK",
  "count": 1,
  "approvals": [
    {
      "packageName": "express",
      "version": "5.1.0",
      "registeredAt": "2026-09-10T12:00:00.000Z",
      "expiresAt": "2026-09-10T13:00:00.000Z"
    }
  ]
}
```

Approval 취소는 URL Query의 `packageName + version`을 기준으로 일치하는 활성 Approval을
모두 제거합니다. Scoped Package는 `packageName` 값을 URL Encoding해서 전달합니다.
취소 직후부터 해당 Version Metadata와 Tarball 요청은 Guard에서 차단됩니다.

```text
DELETE http://verdaccio:4873/-/whs/approvals?packageName=express&version=5.1.0
```

```json
{
  "status": "REVOKED",
  "packageName": "express",
  "version": "5.1.0"
}
```

필수 Query가 없거나 빈 문자열이면 `400`, 일치하는 활성 Approval이 없으면 `404`를
반환합니다.

조회는 활성 Approval 전체를 한 번에 반환하며 개수 제한이나 Paging이 없습니다.
`npm install` 한 번에 수백 건이 등록될 수 있어 응답이 커질 수 있습니다.

같은 Package와 Version이 여러 줄로 보일 수 있습니다. Approval은 `packageName +
version + integrity`로 구분하므로 Tarball 파일명이 다르면 함께 존재할 수 있고, 조회
응답에는 `integrity`가 없어 같은 항목처럼 보입니다.

취소는 `packageName + version`이 일치하는 Approval을 남김없이 제거합니다. 일부만 남으면
그 Version이 계속 허용될 수 있기 때문입니다. 둘 이상이 제거되면 Integrity 충돌 차단을
통과한 비정상 상태였다는 뜻이므로 경고 로그를 남깁니다. 제거된 개수는 응답에 넣지
않습니다.

취소는 성공과 실패를 모두 `approval.revoked` Audit Event로 남깁니다. 취소 자체는 Guard를
닫는 동작이지만 진행 중이던 설치가 갑자기 `403`으로 바뀌므로, 원인을 추적할 수 있어야
합니다. 대상이 없어 `404`인 경우와 Query가 잘못돼 `400`인 경우도 남깁니다. 아직 인증이 없어
잘못된 취소 요청이 반복되는 것 자체가 신호일 수 있기 때문입니다. `400`에서는 읽힌 값만
기록해, 한쪽 Query만 빠진 연동 오류와 무작위 탐색을 구분할 수 있게 합니다.

`requestId`는 Body가 없는 요청이라 `x-request-id` Header에서만 읽습니다.

조회(`GET`)는 Audit Event를 남기지 않습니다. 상태를 바꾸지 않고, Verdaccio 기본 Access
Log가 호출 시각·IP·상태 코드를 이미 남깁니다. Dashboard가 이 API를 쓰게 되어 사람이 직접
조회하는 시점에는 다시 판단해야 합니다. 서비스 인증은 후속 작업에서 POST/GET/DELETE 세 API에 함께 적용합니다.

```json
{
  "requestId": "req-123",
  "status": "REGISTERED",
  "packageCount": 1
}
```

Verdaccio 6.10.0은 JWT 인증 Middleware, 이 Plugin, 기존 Registry endpoint 순서로
요청을 처리합니다. Package Metadata(`GET /{package}`)는 ACCEPT 등록 여부와 관계없이
기존 Registry endpoint로 전달합니다. Gateway가 Metadata 응답으로 Version을 확인한 뒤
Tarball 요청 시점에 분석·등록할 수 있도록 하기 위함입니다.

`guard_enabled: true`이면 Package Version Metadata와 Tarball 요청은 승인 목록의
`packageName + version + integrity`와 정확히 일치할 때만 기존 Registry endpoint로
전달됩니다. Tarball은 Metadata 요청을 먼저 거쳤는지와 관계없이 Package명과 파일명으로
ACCEPT Artifact를 찾고, 현재 Metadata의 `dist.integrity`까지 다시 일치해야 반환됩니다.

`guard_enabled: false`이면 ACCEPT 목록 API와 Package 준비·등록은 그대로 동작하지만,
Version·Tarball Guard는 등록하지 않습니다. Gateway의 ACCEPT 등록 연동 전까지 사용하는
임시 설정이며, 연동이 완료되면 `true`로 전환해야 합니다. 설정을 생략한 경우에도
Guard는 활성화됩니다.

```yaml
middlewares:
  whs-approval:
    endpoint: /-/whs/approvals
    guard_enabled: false
```

ACK는 요청 형식 검사만 끝났다는 의미가 아닙니다. 목록의 모든 Package에 대해
Metadata 조회, Version·integrity 확인, Tarball 저장 확인이 끝난 뒤 반환됩니다.
하나라도 실패하면 해당 요청의 승인 목록은 메모리에 등록하지 않습니다. 실패 전에
일부 Package가 Cache될 수는 있지만, 승인 목록에 등록되지 않으므로 후속 접근 통제
구현에서는 허용 대상으로 취급되지 않습니다.

플러그인 API는 Verdaccio 기본 Registry의 JSON Body Parser보다 먼저 실행되므로,
승인 목록의 JSON Body는 플러그인이 직접 읽습니다.

### 오류 응답과 로그

| 상황 | 응답 | 로그 |
|---|---|---|
| 서비스 Token 누락·빈 값·불일치 또는 환경변수 미설정 | `401 unauthorized service request` | `warn` |
| 요청 형식 오류 (빈 목록, 필드 누락, `integrity` 없음) | `400` | `warn` |
| 승인 대조 실패 (`integrity` 불일치, Metadata에 없는 Version) | `403` | `warn` |
| 같은 Package·파일명에 다른 `integrity` 등록 시도 | `403` | `warn` |
| Package 준비 실패 (Metadata 조회·Tarball 저장 실패) | `500` | `error` |
| 그 외 | `500 internal plugin error` | `error` |

### Approval과 Guard Audit Event

Approval Plugin은 Audit Plugin을 직접 참조하지 않고 `plugins/shared/audit.js`의 공통
Schema와 안전한 Logger만 사용합니다. Logger 또는 Event 생성이 실패해도 Approval 등록과
Guard 허용·차단 결과는 바뀌지 않습니다.

| `action` | 기록 조건 | `result` / Level | 선택 필드 |
|---|---|---|---|
| `approval.registered` | API 요청 전체 등록 성공, 요청당 한 건 | `success` / `info` | `requestId` |
| `service_auth.rejected` | 서비스 Token 검증 실패로 `401` 차단 | `failure` / `warn` | `requestId`, `statusCode`, `reason` |
| `approval.rejected` | 형식 오류, Version 없음, Metadata Integrity 불일치, Cache 준비 실패 | `failure` / `warn` | `requestId`, `packageName`, `version`, `reason` |
| `approval.expired` | TTL 만료 Approval이 Store에서 실제 제거됨 | `failure` / `warn` | `packageName`, `version`, `reason` |
| `approval.revoked` | 취소 API 요청 전부. 제거 성공과 `400`·`404` 실패를 모두 남김 | `success`·`failure` / `info`·`warn` | `requestId`, `packageName`, `version`, `statusCode`, `reason` |
| `guard.blocked` | 미승인 Version/Tarball 또는 현재 Metadata 불일치 차단 | `failure` / `warn` | `requestId`, `packageName`, `version`, `reason` |
| `integrity.conflict` | 같은 Package·파일명에 다른 Integrity 등록 거부 | `failure` / `warn` | `requestId`, `packageName`, `version`, `reason` |

확인할 수 없는 선택 필드는 `unknown`으로 채우지 않고 생략합니다. 요청/응답 Body 전체,
Authorization Header, Cookie, JWT, 서비스 Token, Secret과 Integrity 전체 값은 기록하지
않습니다.

`reason`은 아래 값 중 하나입니다. Error 메시지를 그대로 쓰지 않고 고정된 짧은 코드만
씁니다.

| `action` | `reason` | 의미 |
|---|---|---|
| `approval.registered` | (없음) | 성공 Event에는 붙지 않습니다 |
| `approval.rejected` | `invalid_request` | 요청 형식이 Schema에 맞지 않음 |
| 〃 | `version_not_found` | 승인 요청한 Version이 Metadata에 없음 |
| 〃 | `metadata_integrity_mismatch` | Gateway가 보낸 `integrity`가 Metadata와 다름 |
| 〃 | `package_preparation_failed` | Metadata 조회 또는 Tarball Cache 실패 |
| 〃 | `internal_error` | 위에 해당하지 않는 Plugin 내부 오류 |
| `approval.expired` | `ttl_expired` | TTL이 지나 Store에서 제거됨 |
| `approval.revoked` | `invalid_request` | 취소 요청의 필수 Query가 없거나 비어 있음 |
| 〃 | `approval_not_found` | 취소 요청 대상에 활성 Approval이 없음 (성공 시 `reason` 없음) |
| `integrity.conflict` | `integrity_conflict` | 같은 Package·파일명에 다른 `integrity` 등록 시도 |
| `service_auth.rejected` | `invalid_service_token` | Approval API 요청의 서비스 Token이 없거나 다름 |
| `guard.blocked` | `version_not_approved` | 요청 Version의 승인이 없음 |
| 〃 | `tarball_not_approved` | 요청 Tarball의 승인이 없음 |
| 〃 | `version_not_found` | 승인된 Version이 현재 Metadata에서 사라짐 |
| 〃 | `metadata_version_mismatch` | 응답 Metadata의 Version이 요청과 다름 |
| 〃 | `metadata_integrity_missing` | 응답 Metadata에 `dist.integrity`가 없음 |
| 〃 | `metadata_integrity_mismatch` | 승인된 `integrity`가 현재 Metadata와 다름 |

`metadata_integrity_mismatch`는 두 `action`에 모두 나오지만 시점이 다릅니다.
`approval.rejected`는 **등록 시점**에 Gateway가 보낸 값이 Metadata와 어긋난 경우이고,
`guard.blocked`는 **다운로드 시점**에 이미 승인된 값이 현재 Metadata와 어긋난 경우입니다.
`action`을 함께 보아야 구분됩니다.

Guard의 `requestId`는 Gateway가 전달한 `x-request-id` Header에서만 읽습니다. Header가
없어도 Event는 기록되지만 `requestId`는 생략됩니다. Gateway 로그와 연결하려면 Registry
중계 요청에 같은 Header를 전달해야 합니다.

정상 Metadata/Version/Tarball 요청은 로그 폭증을 막기 위해 Audit Event를 남기지
않습니다. 정상 요청은 Verdaccio 기본 Access Log에서 확인합니다.

모든 오류 로그에 `requestId`와 `reason`이 포함됩니다. `requestId`는 Gateway 요청과
Verdaccio 로그를 잇는 유일한 값이므로 형식 검사 전에 본문에서 먼저 확보합니다.
본문 자체를 읽지 못해 `requestId`를 알 수 없는 경우에는 `null`로 남깁니다.

`integrity`는 승인 단위에 포함되는 필수 문자열입니다. Gateway는 `null`인 Artifact를
준비 목록에 포함하지 않아야 하며, 포함하면 요청 전체가 `400 Bad Request`로 거부됩니다.

승인 목록은 프로세스 메모리에만 저장합니다. Verdaccio 재시작 시 초기화되므로 다음
설치 흐름에서 Gateway가 다시 등록해야 합니다. 실제 Tarball 파일의 해시 재계산은
MVP 범위에서 제외하며 npm Client의 기본 integrity 검증을 사용합니다.

### 승인 유효기간

등록된 Approval은 `registeredAt`과 `expiresAt`을 함께 저장합니다. 만료 시각은
`registeredAt + approval_ttl_seconds`이며, 한 요청으로 등록되는 Approval은 모두 같은
기준 시각을 사용합니다.

```yaml
middlewares:
  whs-approval:
    approval_ttl_seconds: 3600
```

기본값은 `3600`(1시간)입니다. 설정을 생략하거나 양의 정수가 아닌 값을 넣으면 기본값이
적용되고 무시된 값이 `warn` 로그에 남습니다. 최종 기본값과 최대값은 Gateway Contract
협의 후 확정합니다.

### 만료 판정과 정리

`expiresAt`이 현재 시각과 **같거나 이전이면 만료**입니다. 만료 시각 직전까지가 유효
구간입니다.

만료된 Approval은 별도의 Cleanup API나 Scheduler 없이 다음 시점에 자동으로 제거됩니다.

| 시점 | 정리 범위 |
|---|---|
| 승인 목록 등록 | 전체 만료 항목 |
| 승인 여부 확인 | 조회한 항목 |
| Package·Tarball 조회 | 순회 중 만난 만료 항목 |
| 승인 개수 확인 | 전체 만료 항목 |

```text
승인 목록 조회
→ expiresAt과 현재 시각 비교
→ 만료된 항목은 메모리에서 제거하고 결과에서 제외
→ 유효한 승인이 없으면 Guard가 403으로 차단
```

Version 요청, Tarball 요청, Version Metadata 응답 필터 모두 같은 조회 경로를 쓰므로
만료된 Approval로는 어느 쪽도 통과할 수 없습니다.

Tarball 요청은 Metadata 조회를 기다리는 동안 승인이 만료될 수 있어, 조회가 끝난 뒤
승인 목록을 다시 확인합니다. Version Metadata도 응답을 내보내기 직전에 다시 확인합니다.

조회되지 않은 만료 Approval은 일시적으로 메모리에 남을 수 있지만 유효한 승인으로
사용되지 않습니다. 이후 Approval 등록, 조회 또는 승인 개수 확인 시 자동으로 제거됩니다.
등록 시점에 전체를 정리하므로, 새 승인이 계속 들어오는 환경에서 오래된 항목이 쌓이지
않습니다.

`expiresAt`을 읽을 수 없는 Approval도 만료로 취급합니다. 등록 경로를 거치면 항상
채워지는 값이지만, 시각을 잃은 승인이 무기한 유효해지지 않도록 차단하는 쪽을
택했습니다.

만료 이후에도 Gateway가 같은 Approval을 다시 등록하면 정상적으로 사용할 수 있습니다.
재등록은 아래 「동일 Approval 재등록」과 같은 절차를 거치며, Cache가 남아 있으면
Tarball을 다시 내려받지 않습니다.

Verdaccio를 재시작하면 승인 목록 전체가 초기화되는 기존 동작은 그대로입니다. 만료
정리는 프로세스가 떠 있는 동안의 통제 수단입니다.

### 동일 Approval 재등록

`packageName + version + integrity`가 모두 같으면 동일한 Approval로 봅니다. 재등록
요청은 다음 순서로 처리합니다.

```text
Metadata 조회
→ Version·integrity 재확인
→ Tarball Cache 확인
   ├─ 있음: 다운로드 생략
   └─ 없음: 다시 준비
→ 모두 성공하면 registeredAt·expiresAt 갱신
```

승인 항목 수는 늘지 않고 시각만 갱신됩니다. Metadata가 바뀌었거나 Cache를 다시
준비하지 못하면 요청이 실패하고 **기존 만료 시각은 그대로 유지**됩니다. 준비가 모두
끝난 뒤에만 등록하므로 실패한 요청이 유효기간을 연장하지 못합니다.

Cache 확인 자체가 실패하면 Cache가 없는 것으로 보고 다시 준비합니다. 확인하지 못한
상태로 다운로드를 건너뛰지 않기 위함입니다.

### 동시 요청 중복 준비 방지

Cache 확인과 다운로드 사이에는 틈이 있어, 동시에 들어온 요청이 각자 "Cache 없음"을
보고 같은 파일을 두 번 내려받을 수 있습니다. 진행 중인 준비 작업을
`packageName + 파일명`으로 보관해 뒤따라온 요청이 같은 작업을 기다리게 합니다.

```text
첫 번째 요청 → Cache 준비 시작
두 번째 동일 요청 → 진행 중인 준비를 기다림
준비 성공 → 두 요청 모두 등록
```

준비가 실패하면 기다리던 요청도 같은 실패를 받습니다. 둘 다 등록되지 않아야 하므로
의도한 동작입니다. 준비가 끝나면 항목이 제거되므로 이후 요청은 Cache를 다시 확인합니다.

진행 중인 준비와 같은 파일이면서 기대하는 `integrity`가 다르면 뒤따라온 요청을
`403`으로 거부합니다. 둘 중 하나는 틀린 승인인데 어느 쪽인지 이 시점에는 알 수 없기
때문입니다. 먼저 시작한 준비는 그대로 진행됩니다.

이 보관소는 Plugin 프로세스 메모리에 있습니다. Verdaccio를 여러 대로 운영하면
인스턴스 사이에서는 중복 준비가 발생할 수 있습니다.

### Integrity 충돌 차단

Tarball 요청 경로에는 Version이 없어 Guard가 `packageName + 파일명`으로 승인을
찾습니다. 그래서 같은 파일에 서로 다른 `integrity`가 함께 등록되면 어느 쪽 기준으로
통과했는지 알 수 없습니다. 이런 조합은 승인 목록에 들이지 않습니다.

충돌 판정은 **`packageName + 파일명`** 기준입니다. Approval Key
(`packageName + version + integrity`)는 그대로입니다.

| 조합 | 처리 |
|---|---|
| 같은 Package·파일명·`integrity` | 허용 (Version이 달라도 됨) |
| 같은 Package·파일명, 다른 `integrity` | 신규 요청 **전체** `403` |
| 다른 Package, 같은 파일명 | 허용 |
| 같은 Package, 다른 파일명 | 허용 |

충돌이 발견되면 기존 승인과 Cache를 그대로 두고 신규 요청만 거부합니다. 기존 승인의
`registeredAt`·`expiresAt`도 갱신하지 않습니다. 요청에 Package가 여럿이면 하나만
충돌해도 전부 등록하지 않고, Tarball도 내려받지 않습니다.

하나의 요청 본문 안에서 같은 파일에 서로 다른 `integrity`가 들어와도 같은 기준으로
거부합니다. 기존 승인이 하나도 없어도 마찬가지입니다.

검사는 세 지점에서 이루어집니다.

```text
Metadata 조회로 파일명 확정
→ ① Cache 준비 전 검사 (요청 안 + 기존 승인)
→ Tarball 준비
→ ② 진행 중인 준비와의 검사 (동시 요청)
→ ③ 등록 직전 재검사
→ 승인 목록에 일괄 등록
```

①이 Tarball을 불필요하게 내려받지 않게 하고, ②가 동시 요청을 막습니다. ③은 검사와
등록 사이에 다른 요청이 끼어들지 못하도록 하는 마지막 관문으로, 등록까지 비동기 작업
없이 이어집니다.

만료된 승인은 충돌 대상이 아닙니다. 등록 시점에 정리된 뒤 활성 승인만 비교하므로,
기존 승인이 만료됐다면 같은 파일에 다른 `integrity`를 새로 등록할 수 있습니다.

실제 Tarball 파일의 Hash를 다시 계산해 어느 `integrity`가 맞는지 판별하는 기능과,
여러 Verdaccio 인스턴스 사이의 충돌 검사는 이번 범위가 아닙니다.

## Test

단위 Test는 Plugin 디렉터리에서 실행합니다.

```bash
cd infra/verdaccio/plugins/verdaccio-whs-approval
npm test
```

실제 Verdaccio에 연결한 ACCEPT 목록 등록, Cache 저장, 허용/차단 동작은 저장소
루트에서 Registry 동작 점검 Script로 확인합니다. 실행에 필요한 계정과 환경변수는
`infra/verdaccio/README.md`를 참고합니다.

```bash
sh infra/verdaccio/scripts/smoke.sh
```
