# Gateway 제공 API 명세

- 작성자 : 정환희
- 문서 상태: 현재 구현 기준 문서
- 기준 코드: `dev`의 `4e82b0c`
- 작성일: 2026-09-12 / 최신화: 2026-09-24
- 관련 이슈: #141, #330 / WBS: W4-GW-02

Gateway가 외부에 제공하는 API의 현재 요청·응답 계약을 기술합니다. 다른 서비스 호출 계약 및 내부 처리 흐름과 운영 설정은 이 문서의 범위에 포함하지 않습니다. 예시의 사용자명·UUID는 설명용이며, 인증 정보와 integrity 자리표시는 실제 값이 아닙니다.

## 1. 개요

Gateway는 npm 클라이언트의 인증·Metadata·Tarball 요청을 Verdaccio로 중계하며, Tarball 다운로드를 판정에 따라 허용하거나 차단합니다. 상태 점검용 Health를 포함하여 명시적으로 등록된 API는 8개입니다.

Dashboard의 통계·설치 이력·판정 상세 조회 API는 현재 제공하지 않습니다.

### 호출 예시

Gateway와 관련 서비스가 실행되고 Dashboard에서 npm 토큰을 발급한 로컬 환경의 예시입니다.

```bash
curl http://localhost:3000/health
npm config set registry http://localhost:3000/npm/
npm config set //localhost:3000/npm/:_authToken "<발급된 토큰>"
npm install is-number@7.0.0 --registry=http://localhost:3000/npm/
```

Gateway를 거치지 않는 다운로드나 npm 캐시에서만 처리되는 설치는 이 API의 검사 대상이 아닙니다.

## 2. 공통 규칙

| 항목 | 현재 동작 |
|---|---|
| 기본 주소 | 로컬 실행 기본값 `http://localhost:3000` (`GATEWAY_PORT`, 기본 `3000`) |
| Registry 접두사 | `/npm` |
| 인증 | Dashboard 발급 Bearer npm 토큰을 Gateway가 검증. Verdaccio에는 전용 내부 자격증명을 사용 |
| 요청 본문 | npm 요청 본문의 원본 바이트를 전달 |
| 요청 식별자 | Gateway가 HTTP 요청마다 UUID 생성. 클라이언트 헤더를 요청 ID로 채택하지 않음 |
| 추적 헤더 | Registry 중계 요청과 사용자 응답에 Gateway 생성 `x-request-id` 설정 |
| Query·Percent Encoding | 중계 시 원본 URL의 표현 유지 |

`requestId`는 **HTTP 요청 단위**이며, 설치 한 번에서 여러 ID가 생성될 수 있습니다. 설치 전체를 대표하는 식별자가 아닙니다.
현재 한 번의 Tarball 요청당 하나의 `requestId`가 할당됩니다.

Verdaccio가 다른 `x-request-id`를 반환해도 사용자 응답에는 Gateway 생성값을 유지합니다. Gateway 공통 오류 본문의 `requestId`도 Gateway 생성값입니다.

### 응답 형식

| 종류 | 본문 |
|---|---|
| Health | Gateway가 생성한 JSON |
| 인증·Metadata | Verdaccio 응답 본문 |
| Tarball | 바이너리 스트림 |
| Gateway 예외 필터가 처리한 오류 | 공통 오류 JSON |
| Verdaccio가 반환한 HTTP 오류 | Verdaccio 오류 본문과 상태 코드 |

모든 성공·실패 응답이 같은 JSON 형식은 아닙니다. 오류 응답 구분은 4절을 참조합니다.

## 3. Gateway 제공 API

코드에 명시적으로 등록된 경로는 다음 8개입니다. 아래 파일 경로는 모두 `src/controllers/` 기준입니다.

| Method | Path | 파일 / 메서드 |
|---|---|---|
| GET | `/health` | `gateway.controller.ts` / `health` |
| PUT | `/npm/-/user/:userdoc` | `npm-auth.controller.ts` / `login` |
| GET | `/npm/-/user/:userdoc` | `npm-auth.controller.ts` / `userDocument` |
| PUT | `/npm/-/user/:userdoc/-rev/:rev` | `npm-auth.controller.ts` / `loginWithRevision` |
| GET | `/npm/:package` | `metadata.controller.ts` / `metadata` |
| GET | `/npm/@:scope/:name` | `metadata.controller.ts` / `scopedMetadata` |
| GET | `/npm/:package/-/:file` | `tarball.controller.ts` / `tarball` |
| GET | `/npm/@:scope/:name/-/:file` | `tarball.controller.ts` / `scopedTarball` |

### 3.1 Health

Gateway 프로세스가 HTTP 요청에 응답하는지 확인합니다.

```http
GET /health
```

인증·Query·요청 본문은 필요하지 않습니다.

```http
HTTP/1.1 200 OK
Content-Type: application/json
```

```json
{"status":"ok","service":"gateway"}
```

Scanner·Decision DB·Verdaccio 상태는 확인하지 않습니다.

### 3.2 npm 인증 — legacy login 비활성화

Gateway는 계정 비밀번호나 Verdaccio 사용자 자격증명을 중계하지 않습니다. 아래 세
legacy npm login 경로는 모두 `410 Gone`과 동일한 오류를 반환합니다.

- `PUT /npm/-/user/:userdoc`
- `GET /npm/-/user/:userdoc`
- `PUT /npm/-/user/:userdoc/-rev/:rev`

```json
{
  "error": "NPM_LOGIN_DISABLED",
  "message": "Issue an npm token in Dashboard settings and configure /npm/:_authToken in .npmrc"
}
```

Dashboard의 Settings 화면에서 npm 토큰을 발급한 뒤 npm Client에 설정합니다.

```bash
npm config set registry http://localhost:3000/npm/
npm config set //localhost:3000/npm/:_authToken <발급된 토큰>
```

Metadata와 Tarball 요청에서 Gateway는 `Authorization: Bearer <npm 토큰>`을 검증하고
활성 사용자 정보를 확인합니다. 인증되지 않았거나 만료·폐기된 토큰은 `401`로
거절합니다. Registry upstream에는 사용자 토큰 대신 Gateway의 Verdaccio 전용
자격증명을 사용합니다. 실제 토큰과 토큰이 포함된 `.npmrc`는 저장소·로그·공유
증적에 포함하지 않습니다.

### 3.3 Metadata — 일반·Scoped

```http
GET /npm/express
GET /npm/@babel/core
```

본문 없음. `Authorization` 및 Metadata 표현을 요청하는 `Accept` 헤더는 Verdaccio로 전달됩니다.

| Path 필드 | 설명 |
|---|---|
| `package` | 일반 패키지명 |
| `scope` | Scope 이름. 값 자체에는 앞의 `@` 제외 |
| `name` | Scoped 패키지의 이름 |

패키지명은 전체 214자 이하이며 대문자를 허용하지 않습니다. 각 이름 구간은 `.` 또는 `_`로 시작할 수 없고, 코드의 URL-safe 검사에 통과해야 합니다. Scoped 이름은 `@scope/name` 형태입니다.

대문자 금지 규칙은 과거에 등록된 패키지에도 적용됩니다. 따라서 `JSONStream`처럼 대문자가 포함된 레거시 패키지는 현재 Metadata·Tarball 요청 모두 `400`이며 Gateway를 통해 설치할 수 없습니다.

정상 응답은 일반적으로 `200`과 버전·배포 정보를 담은 Metadata JSON입니다. 아래는 일반 패키지 응답의 **필드 발췌 예시**입니다. 실제 필드와 Content-Type은 Verdaccio가 결정합니다.

```json
{
  "name": "express",
  "dist-tags": {"latest": "<현재 버전>"},
  "versions": {
    "4.18.2": {
      "name": "express",
      "version": "4.18.2",
      "dist": {
        "tarball": "http://localhost:3000/npm/express/-/express-4.18.2.tgz",
        "integrity": "sha512-<해당 파일의 Base64 해시>"
      }
    }
  }
}
```

Scoped 응답도 동일한 중계 방식입니다. 예를 들어 `name`은 `@babel/core`, 배포 파일 경로는 `/npm/@babel/core/-/core-<version>.tgz` 형태이며 실제 URL은 Verdaccio 공개 URL 설정에 따릅니다. Gateway가 Metadata 본문을 직접 재작성하지는 않습니다.

Metadata 요청에서는 **패키지명만 검증하고 분석·판정 집행은 하지 않습니다.** 조회 성공은 다운로드 허용을 의미하지 않습니다.

- 잘못된 패키지명: `400 / INVALID_REQUEST`
- Verdaccio의 패키지 없음·인증 실패: 해당 상태·본문 전달
- 중계 연결 예외: `500 / GATEWAY_INTERNAL_ERROR`

### 3.4 Tarball — 일반·Scoped

```http
GET /npm/express/-/express-4.18.2.tgz
GET /npm/@babel/core/-/core-7.24.0.tgz
```

본문 없음. 인증 헤더는 중계됩니다. Path의 `package`, `scope`, `name`은 Metadata와 같으며, `file`에는 `{이름}-{정확한 버전}.tgz`가 들어갑니다. Scoped 패키지 파일명에는 Scope를 포함하지 않습니다.

Gateway는 패키지명, `.tgz` 확장자, 파일명과 패키지명의 일치, 정확한 Semantic Version을 검사합니다. `express-latest.tgz`와 이름이 다른 파일 등은 `400`입니다.

두 경로 모두 정상 다운로드 응답은 일반적으로 다음 형태입니다.

```http
HTTP/1.1 200 OK
Content-Type: application/octet-stream

<Tarball 바이너리 스트림>
```

위 Content-Type은 표현 예시이며 실제 값은 Verdaccio 응답에 따릅니다. JSON 성공 응답이나 판정 상세를 반환하는 API가 아닙니다.

| 상황 | 현재 처리 |
|---|---|
| 검사 대상이 모두 허용됨 | 다운로드 중계. 최종 상태·본문은 Verdaccio 응답에도 의존 |
| `REJECT`, `HOLD`, `REVIEW` 포함 | `403 / PACKAGE_NOT_ALLOWED` |
| 분석 후에도 `NOT_FOUND` | `403 / PACKAGE_NOT_ALLOWED` |
| 잘못된 패키지명·파일명·버전 | `400 / INVALID_REQUEST` |
| 검사에 필요한 패키지 integrity 정보 누락 | 현재 `400 / INVALID_REQUEST` |
| 판정 조회·분석·승인 등록 실패 | Gateway 공통 `500` |
| Verdaccio가 반환한 HTTP 오류 | 상태·본문 그대로 전달 |

위 판정 차단 규칙은 판정 집행이 수행되는 경우에 적용됩니다. 현재 Scanner 비활성화 상태에서 미판정 대상이 있으면 검사·집행을 생략하고 중계할 수 있으므로, 다운로드 성공만으로 전체 분석 완료를 판단하면 안 됩니다.

HOLD·REVIEW의 별도 응답 코드는 아직 구현되지 않았습니다. 차단 응답 JSON은 4절의 공통 오류 형식을 사용합니다.

## 4. 공통 오류 계약

아래는 **Gateway 예외 필터가 처리한 오류**의 형식입니다.

```json
{
  "requestId": "00000000-0000-4000-8000-000000000001",
  "error": {
    "code": "PACKAGE_NOT_ALLOWED",
    "message": "Package is not allowed",
    "retryable": false
  }
}
```

| 필드 | 타입 | 설명 |
|---|---|---|
| `requestId` | string | Gateway가 생성한 요청 UUID |
| `error.code` | string | 아래 코드 중 하나 |
| `error.message` | string | 외부 공개용 고정 메시지 |
| `error.retryable` | boolean | 현재 항상 `false` |

| HTTP | code | message |
|---|---|---|
| 400 | `INVALID_REQUEST` | `Invalid request` |
| 403 | `PACKAGE_NOT_ALLOWED` | `Package is not allowed` |
| 404 | `RESOURCE_NOT_FOUND` | `Requested resource was not found` |
| 500 | `GATEWAY_INTERNAL_ERROR` | `Internal server error` |

나머지 내부 4xx 예외는 원래 상태를 유지하면서 `INVALID_REQUEST`로 표현합니다. 내부 5xx 예외와 일반 예외는 `500`으로 통합합니다. 세부 원인이나 차단 패키지 목록은 공통 오류 본문에 노출하지 않습니다. 차단 사유는 Gateway 서버 로그에만 `requestId`와 `name@version=판정` 형태로 남습니다.

- 패키지를 찾지 못한 경우에도 처리 단계에 따라 `404` 또는 `500`이 반환될 수 있습니다. 모든 패키지 부재가 `404`로 구분되는 것은 아닙니다.
- Verdaccio의 `401`, `403`, `404`, `409`, `5xx` 등 **중계된 HTTP 응답은 이 JSON 계약으로 변환하지 않습니다.**
- `retryable: false`는 npm의 자동 재시도를 직접 제어하는 설정이 아닙니다.
- 전송 시작 후 발생한 스트림 오류까지 새 공통 JSON으로 교체된다고 보장하지 않습니다.

등록되지 않은 `GET /npm/-/whoami`, `POST /npm/-/whs/approvals` 등은 `404 / RESOURCE_NOT_FOUND`이며 내부 API로 중계하지 않습니다. `/npm/-/*` 전체를 열어둔 프록시가 아닙니다.

구현: [오류 변환](../src/http/to-http-exception.ts), [예외 필터](../src/http/gateway-exception.filter.ts).
