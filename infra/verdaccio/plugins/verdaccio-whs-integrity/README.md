# verdaccio-whs-integrity

Verdaccio Storage에 저장된 `.tgz` 파일을 직접 해싱해 Package Metadata의 기준값과
대조하는 검증 로직입니다.

Verdaccio는 자기 Cache를 검증하지 않아, 저장된 Tarball이 변조되거나 손상돼도 그대로
반환합니다. Approval 검사도 Metadata의 `dist.integrity` **문자열**만 비교하므로 파일
자체가 바뀐 경우를 알 수 없습니다.

현재 범위:

- 저장된 Tarball을 Stream으로 읽어 해시 계산
- `dist.integrity`(SRI) 해석과 알고리즘 선택
- `PASS` / `FAIL` / `UNVERIFIABLE` 판정
- Package·Version·파일명·기대값·실제값·사유를 담은 결과 반환
- 관리자 전용 수동 검사 API (W4-VD-09)
- 설정 주기 기반 정기 검사 (W4-VD-09)
- 수동·정기 검사 중복 실행 방지

현재 제외 범위:

- Tarball 요청마다 강제 해시 계산
- 불일치 Cache 자동 삭제·재수집·복구
- Metadata까지 함께 변조된 경우의 외부 신뢰원 검증

`config.yaml`의 `middlewares.whs-integrity`로 등록합니다.

```yaml
middlewares:
  whs-integrity:
    endpoint: /-/whs/integrity/checks
    allowed_users: [admin]
    check_interval_seconds: 3600   # 생략하면 정기 검사를 하지 않음
```

`endpoint`가 없으면 경고를 남기고 수동 검사 API만 등록하지 않습니다. 정기 검사는
`check_interval_seconds`만으로 켜고 끕니다.

## 수동 검사 API

```text
POST /-/whs/integrity/checks
Authorization: Bearer <npm login 으로 받은 관리자 Token>
```

```json
{
  "packages": [
    { "packageName": "is-odd", "version": "3.0.1" }
  ]
}
```

```json
{
  "status": "COMPLETED",
  "count": 1,
  "results": [
    { "status": "PASS", "packageName": "is-odd", "version": "3.0.1", "...": "..." }
  ]
}
```

`results`의 각 항목은 아래 「결과 필드」와 같은 `verifyTarball()` 결과 그대로입니다.
일부 항목이 `FAIL`이나 `UNVERIFIABLE`이어도 요청은 `200`이며 나머지 항목도 검사합니다.
같은 요청 안의 같은 Package·Version은 한 번만 검사합니다.

### 권한

Approval API의 서비스 Token이 아니라 **요청자 본인의 npm 로그인 Token**으로
판단합니다. 관리자·일반 유저·CI를 구분해야 하는데, 서비스 Token은 "누가 보냈는지"를
알려주지 않기 때문입니다.

| 요청자 | 응답 |
|---|---|
| 로그인 안 함 | `401 authentication required` |
| `allowed_users`에 없는 계정 (`whs-ci`, 일반 유저) | `403 admin permission required` |
| `allowed_users`에 있는 계정 | 검사 실행 |

Verdaccio는 Plugin Route보다 먼저 JWT를 확인해 `request.remote_user`에 넣어줍니다.
htpasswd에는 Group이 없어 역할이 곧 계정 이름이므로, 허용 계정은 이름 목록으로 둡니다.
생략하면 `admin`만 허용하고, 목록이 잘못돼 있으면 경고를 남기고 `admin`만 허용합니다.
잘못된 설정을 "모두 허용"으로 해석하지 않기 위함입니다.

권한 확인은 본문을 읽기 전에 합니다. 거부된 요청은 Storage를 건드리지 않습니다.

Gateway가 이 API를 중계하게 되더라도 `Authorization` Header를 그대로 넘기면 됩니다.
관리자 판정은 Verdaccio가 합니다.

### 오류 응답

| 상황 | 응답 |
|---|---|
| 본문이 JSON이 아님, `packages`가 비었거나 형식이 틀림 | `400` |
| Storage 밖을 가리킬 수 있는 Package 이름 | `400` |
| 다른 검사가 진행 중 | `409 integrity check already running` |

오류 메시지에는 요청 값을 넣지 않고 위치만 적습니다(`packages[0].packageName ...`).

### 중복 실행 방지

검사는 한 번에 하나만 돌고, 대상도 하나씩 순서대로 해싱합니다. 모든 `npm install`이
거치는 Registry와 같은 Process라, 여러 Tarball을 동시에 읽으면 정상 요청이 느려집니다.
진행 중에 새 요청이 오면 기다리지 않고 `409`로 돌려줍니다. 검사가 성공하든 실패하든
예외로 끝나든 실행 상태는 항상 풀립니다.

수동 검사와 정기 검사가 **같은 실행 상태**를 씁니다. 정기 검사가 도는 동안 수동 요청은
`409`를 받고, 수동 검사가 도는 동안 돌아온 정기 검사는 그 회차를 건너뜁니다. Cache가
크면 정기 검사 한 번이 길어질 수 있고, 그동안 수동 검사는 `409`입니다.

### 로그

요청한 계정 이름과 결과 건수를 남기고, `PASS`가 아닌 항목은 한 줄씩 따로 남깁니다.
결과를 받는 건 요청한 관리자뿐이라, 로그에 없으면 나중에 무엇이 문제였는지 알 수
없습니다. 정기 검사와 같은 형식이며 `source`로 구분합니다.

```text
user=admin source=manual total=2 pass=1 fail=1 unverifiable=0
user=admin source=manual status=FAIL packageName=is-odd version=3.0.1 reason=INTEGRITY_MISMATCH
```

요약 줄은 `FAIL`이나 `UNVERIFIABLE`이 하나라도 있으면 `warn`, 모두 `PASS`면 `info`로
남깁니다. 문제 줄은 항상 `warn`입니다. audit Plugin이 실패를 `warn`으로 남기는 것과 같은
기준이며, `warn` 이상만 보는 운영에서도 전체 몇 개 중 몇 개가 문제였는지 함께 보입니다.

JWT, `Authorization` Header, 기대값·실제값 Hash, `detail`은 로그에 남기지 않습니다.
Hash는 응답에만 담깁니다. `detail`에는 Storage 오류 메시지가 그대로 들어올 수 있습니다.

## 정기 검사

`check_interval_seconds`를 설정하면 그 주기마다 저장된 Cache 전체를 검사합니다.

| 설정 | 동작 |
|---|---|
| 생략, `0`, `false` | 정기 검사 안 함 (기본) |
| `60` 이상 정수 | 그 주기로 실행 |
| 그 밖의 값 (`30`, `"3600"`, `90.5` 등) | 경고를 남기고 정기 검사 안 함 |

잘못된 값을 가까운 값으로 고쳐 돌리지 않습니다. 운영자가 의도하지 않은 주기로 해싱이
돌기 때문입니다. 60초 미만은 모든 `npm install`이 거치는 Registry에서 해싱이 끊이지
않아 받지 않습니다. 상한은 `setInterval`이 받을 수 있는 최대값입니다. 이보다 크면 Node가
1ms로 바꿔 쉬지 않고 실행합니다.

- **기동 직후에는 돌지 않습니다.** 첫 주기가 지난 뒤 처음 실행합니다. 재시작할 때마다
  Cache 전체를 해싱하면 기동 직후 들어오는 요청이 느려집니다.
  재시작하면 타이머도 처음부터 다시 세므로, 자주 재시작하는 환경에서 주기가 길면 한 번도
  돌지 않을 수 있습니다. `config.yaml`의 예시 값을 1시간(`3600`)으로 둔 이유입니다.
- Timer는 Verdaccio 종료를 붙잡지 않습니다(`unref`).
- 한 회차가 예외로 끝나도 Timer는 계속 돌고 다음 회차가 정상 실행됩니다.

### 검사 대상

**Tarball 파일이 실제로 저장된 버전만** 검사합니다. Metadata에는 받지 않은 버전까지 모두
들어 있어서, 전부 검사하면 "파일 없음" 결과만 쏟아집니다. Package마다 Metadata를 한 번만
읽고 버전별로 파일이 있는지만 확인합니다. 있는지 확인하지 못한 버전은 대상에 넣어
`TARBALL_PRESENCE_UNKNOWN`으로 드러나게 합니다.

Package 이름과 Tarball 파일명은 Storage에 넘기기 전에 검사하고, 위험한 이름은 건너뜁니다.

### 캐시 목록을 뽑는 방법과 제약

**Verdaccio에는 캐시된 Package 목록을 주는 공식 API가 없습니다.**

| 방법 | 결과 |
|---|---|
| `storage.getLocalDatabase` | publish한 Package만 나옴. Uplink에서 받아 저장한 Package는 빠짐 |
| `storage.localStorage.storagePlugin.search` | 캐시된 Package와 `@scope/name`까지 나옴 |

실제 Cache Volume으로 확인했을 때, 캐시된 `is-odd`는 로컬 목록(`.verdaccio-db.json`)에
없었고 두 번째 방법으로만 나왔습니다. 그래서 두 번째 방법을 씁니다.

다만 이 경로는 **Verdaccio 내부 속성**을 거치고, 저장소마다 동작도 다릅니다.

| Storage Plugin | 캐시 목록을 뽑는 방법 | 정기 검사 |
|---|---|---|
| 로컬 (`LocalDatabase`) | `search`가 저장 폴더를 직접 훑음. 캐시된 Package 포함 | 켜짐 |
| S3 (`verdaccio-aws-s3-storage`, `S3Database`) | 버킷에서 `<keyPrefix><이름>/package.json` 키를 조회 | 켜짐 |
| 그 밖의 저장소 | 없음 | **꺼짐** |

S3 Plugin에도 `search`는 있지만 `verdaccio-s3-db.json`의 publish 목록만 돌려주고 캐시된
Package는 빠집니다(코드 확인). `search`가 있다는 것만 보고 쓰면 경고 없이 일부만 검사하고
정상처럼 보고하게 됩니다. 그래서 S3에서는 `search`를 쓰지 않고 **버킷을 직접 조회**합니다.
Plugin이 이미 가진 S3 client와 `bucket`·`keyPrefix`를 그대로 쓰므로 인증 정보를 따로 받지
않고, 목록 조회에는 S3 Plugin이 함께 설치한 AWS SDK를 씁니다. WHS Plugin에 Dependency를
추가하지 않습니다. 목록 조회에는 IAM 권한 `s3:ListBucket`이 필요합니다.

목록 이후의 과정(Metadata 읽기, Tarball 존재 확인, 해싱)은 Verdaccio 공식 Storage API만 쓰므로
두 저장소에서 같습니다. 버킷에서 온 이름도 로컬과 같은 기준으로 검사하고, 위험한 이름은
건너뜁니다.

**캐시 목록을 뽑을 수 있다고 확인된 저장소에서만** 정기 검사를 켭니다. 그 밖의 저장소에서는
기동 시 경고를 남기고 정기 검사만 끕니다. 수동 검사 API와 Registry는 저장소와 상관없이 그대로
동작합니다.

```text
{"storagePlugin":"SomeStorage"} storage plugin cannot list cached packages; scheduled check is disabled
```

저장소 종류는 Storage Plugin의 Class 이름으로 구분하고, S3는 `s3.send`와 `config.bucket`이
있는지도 봅니다. Verdaccio나 S3 Plugin 업그레이드로 이 이름이 바뀌거나 내부 속성이 없어지면
정기 검사가 꺼지고 같은 경고가 남습니다.

**새 저장소 지원:** `src/cache-targets.js`의 `CACHE_LISTERS`에 항목을 하나 추가하면 됩니다.
목록을 뽑는 방법만 저장소마다 다르고, 이후 검사는 Verdaccio 공식 Storage API만 쓰므로
그대로 동작합니다.

### 정기 검사 로그

회차마다 시작·종료와 건수를 남깁니다. 요약 줄의 레벨은 수동 검사와 같은 기준입니다.
문제가 하나라도 있으면 `warn`, 모두 `PASS`면 `info`입니다.

```text
source=scheduled packages=12 unreadablePackages=0 skippedPackages=0 total=40 pass=39 fail=1 unverifiable=0
```

결과를 저장하는 곳이 없어 건수만 남기면 어느 Package가 문제인지 알 수 없습니다. 그래서
`PASS`가 아닌 항목은 한 줄씩 따로 남깁니다. 이름·버전·상태·사유만 담고, Hash와 `detail`은
남기지 않습니다.

```text
source=scheduled status=FAIL packageName=is-odd version=3.0.1 reason=INTEGRITY_MISMATCH
```

## 사용

```js
const { verifyTarball } = require('verdaccio-whs-integrity');

const result = await verifyTarball(storage, {
  packageName: '@whs/example',
  version: '1.0.0',
});
```

`storage`는 Verdaccio가 Plugin에 넘겨주는 Storage 객체입니다. `getPackage`,
`getTarball`, `hasLocalTarball` 세 가지를 사용합니다.

## 판정

| 상태 | 의미 |
|---|---|
| `PASS` | 저장된 파일의 해시가 기준값과 일치 |
| `FAIL` | 해시를 계산했고 값이 **다름** |
| `UNVERIFIABLE` | 검증 자체를 끝낼 수 없음 |

`FAIL`은 실제로 해시를 계산해 본 뒤 값이 다른 경우에만 씁니다. 기준값이나 파일이 없어
비교하지 못한 상황은 전부 `UNVERIFIABLE`입니다. 이 둘을 섞으면 "변조됐다"와 "확인하지
못했다"를 구분할 수 없습니다.

### `UNVERIFIABLE` 사유

| `reason` | 상황 |
|---|---|
| `METADATA_UNREADABLE` | 저장된 Metadata를 읽지 못함 |
| `VERSION_NOT_FOUND` | 해당 Version이 Metadata에 없음 |
| `TARBALL_NAME_UNKNOWN` | `dist.tarball`에서 파일명을 얻지 못함 |
| `NO_REFERENCE_HASH` | `dist.integrity`도 `dist.shasum`도 없음 |
| `INVALID_INTEGRITY_FORMAT` | `dist.integrity`가 SRI 형식이 아니거나 digest가 손상됨 |
| `INVALID_SHASUM_FORMAT` | `dist.shasum`이 sha1 hex가 아님 |
| `UNSUPPORTED_ALGORITHM` | 지원하지 않는 알고리즘만 있음 |
| `UNSAFE_PACKAGE_NAME` | Package 이름이 Storage 밖을 가리킬 수 있음 |
| `UNSAFE_TARBALL_NAME` | 파일명이 경로 구분자를 담고 있음 |
| `TARBALL_NOT_FOUND` | 저장된 Tarball이 없음 |
| `TARBALL_PRESENCE_UNKNOWN` | Tarball이 있는지 확인하지 못함 |
| `TARBALL_UNREADABLE` | Tarball을 읽는 중 오류 |

`TARBALL_NOT_FOUND`와 `TARBALL_PRESENCE_UNKNOWN`을 나눈 이유는, 존재 확인 자체가
실패한 것을 "없음"으로 적으면 실제로는 저장돼 있는데 검사에서 빠진 대상을 찾을 수 없기
때문입니다.

`FAIL`의 `reason`은 `INTEGRITY_MISMATCH` 또는 `SHASUM_MISMATCH`입니다.

## 기준값 선택

`dist.integrity`는 SRI 형식(`<알고리즘>-<base64>`)이고 공백으로 여러 개가 올 수
있습니다.

지원 알고리즘은 `sha512`, `sha384`, `sha256`이며, **가장 강한 것 하나로만** 검증합니다.
약한 알고리즘이 맞았다고 통과시키면 강한 쪽 불일치를 놓치기 때문입니다. 같은 알고리즘의
digest가 여러 개면 그중 하나만 맞아도 유효합니다(W3C SRI).

`dist.integrity`가 **아예 없는** 구버전 Package는 `dist.shasum`(sha1, hex)으로
대조합니다. `integrity`가 있는데 `shasum`으로 대신하지는 않습니다.

## 결과 필드

```js
{
  status: 'PASS',
  packageName: '@whs/example',
  version: '1.0.0',
  filename: 'example-1.0.0.tgz',
  algorithm: 'sha512',
  expected: 'sha512-...',
  actual: 'sha512-...',
}
```

확인하지 못한 값은 채우지 않고 생략합니다. `UNVERIFIABLE`이면 검증이 멈춘 지점까지의
필드만 담기며, 원인을 알 수 있는 경우 `detail`에 짧은 메시지가 붙습니다.

수동 검사 API가 이 구조를 그대로 배열로 돌려줍니다.

## 처리 방식

**Stream으로 읽습니다.** 파일 전체를 Memory에 올리지 않아 Tarball이 커도 사용량이 파일
크기를 따라가지 않습니다. Stream 오류가 나면 Handle을 정리하고 `UNVERIFIABLE`로
돌려줍니다.

**읽기만 합니다.** 파일을 만들거나 고치거나 지우지 않습니다.

**Verdaccio Storage API만 사용합니다.** Package 이름이나 파일명을 직접 경로로 이어
붙이지 않으므로 Storage 밖의 파일을 읽을 수 없고, 나중에 Object Storage로 바꿔도 같은
코드가 동작합니다.

**이름을 Storage에 넘기기 전에 먼저 검사합니다.** Package 이름은 `name` 또는
`@scope/name` 형태만 허용하고, 경로 구분자·상위 이동·널 문자가 있으면 Storage를 부르지
않고 `UNSAFE_PACKAGE_NAME`으로 돌려줍니다. Tarball 파일명도 `dist.tarball`을 Decode한
**뒤에** 확인합니다. `%2F`는 URL 파싱으로 걸러지지 않아 Decode 후에야 경로 구분자가
드러나기 때문입니다. Storage 구현이 바뀌어도 이 검사는 남습니다.

**손상된 기준값을 불일치로 보고하지 않습니다.** `dist.integrity`의 digest가 base64가
아니거나 알고리즘의 길이와 다르면 비교하지 않고 `INVALID_INTEGRITY_FORMAT`으로
돌려줍니다. 그대로 대조하면 손상된 Metadata가 "Tarball이 변조됨"처럼 보입니다.
`verify-cache.sh`는 이 경우를 불일치로 판정하므로, 이 지점만 판정이 다릅니다.

**같은 해시를 표기 차이로 불일치 처리하지 않습니다.** base64는 padding(`=`) 없이도
같은 byte를 나타낼 수 있고 npm Metadata에는 그렇게 적힌 값이 들어오기도 합니다. Node의
`hash.digest('base64')`는 항상 padding을 붙이므로, 문자열을 그대로 비교하면 정상
Tarball이 변조된 것처럼 보고됩니다. 비교 직전에 양쪽 표기를 맞춥니다. 결과의
`expected`에는 Metadata에 적힌 원문을 그대로 남깁니다.

**저장된 Metadata만 봅니다.** Uplink를 다시 조회하면 지금 Cache에 있는 파일이 아니라
원격의 최신 Metadata와 비교하게 됩니다.

**Tarball이 없으면 읽지 않습니다.** 없는 파일을 읽으려 하면 Verdaccio가 Uplink에서
내려받아, "저장된 파일"이 아닌 것을 검증하게 됩니다.

**예외를 던지지 않습니다.** 어떤 실패도 결과 객체로 돌려주므로, 여러 대상을 한 번에
검사할 때 하나의 오류가 나머지를 멈추지 않습니다.

## `verify-cache.sh`와의 관계

`infra/verdaccio/scripts/verify-cache.sh`는 그대로 유지합니다. 컨테이너 밖에서 Volume을
직접 훑어 전체를 점검하는 용도가 남아 있고, 이 구현의 판정 기준을 대조하는 기준으로도
씁니다.

판정 기준(알고리즘 우선순위, 여러 digest 처리, `shasum` 대체)은 Script와 같게
맞췄습니다. 같은 Fixture로 대조한 결과는 다음과 같습니다.

| 대상 | `verify-cache.sh` | 이 구현 |
|---|---|---|
| 정상 Tarball | `[OK]` | `PASS` |
| 변조된 Tarball | `[FAIL]` integrity mismatch | `FAIL` / `INTEGRITY_MISMATCH` |
| Scoped Package | `[OK]` | `PASS` |

다만 범위가 다릅니다. Script는 Storage 전체를 훑고 대상이 없으면 `NO_TARGET`을
돌려주지만, 이 구현은 **지정한 Package·Version 하나**를 검증합니다. Script의
`NO_TARGET`은 실행 대상 자체가 없다는 Script 수준의 결과이므로 `PASS`와 다릅니다.

## 제한사항

**Metadata까지 함께 변조된 경우는 잡지 못합니다.** 저장된 Metadata의 기준값과 저장된
파일을 비교하는 방식이라, 둘이 함께 바뀌면 일치합니다. 그 경우는 Gateway가 Decision에
기록된 값과 대조해야 하는 영역입니다.

**요청 시점에 차단하지 않습니다.** 사후 점검용이며, 수동 검사 API나 정기 검사로 돌립니다.
불일치를 찾아도 Cache를 지우거나 다시 받지 않습니다.

**정기 검사는 Verdaccio 내부 경로에 의존합니다.** 위 「캐시 목록을 뽑는 방법과 제약」
참고.

**Approval 충돌 정책은 바꾸지 않았습니다.** 같은 파일명에 다른 Integrity가 들어올 때
어느 쪽이 맞는지 이 로직으로 판별할 수 있게 됐지만, 정책 변경은 별도 판단이 필요합니다
(#191, #202 참고사항).

## Test

```bash
cd infra/verdaccio/plugins/verdaccio-whs-integrity
npm test
```

`verify-cache-compat.test.js`는 정상/변조/Scoped/구형 `shasum`/기준 Hash 누락
Fixture를 같은 조건으로 검사하여 `verify-cache.sh`와 이 구현의 최종 판정이
일치하는지 확인합니다.
