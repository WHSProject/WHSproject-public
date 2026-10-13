# Dashboard 설치 기록(download_events) 명세

Gateway가 `user_db.download_events`에 남기는 설치 기록과 Dashboard가 읽는 방식입니다(이슈 #441).
Gateway가 기록한 설치 요청을 Request·Overview·Logs가 공용 읽기 함수로 조회합니다.
`user_db`는 Dashboard 소유 DB라 다른 파트와 API 합의 없이 직접 조회합니다.

## 1. 현재 단계

테이블은 이미 있습니다(`infra/postgres/migrations/user/002_account_management.sql`: `id`, `occurred_at`, `request_id`, `user_id`, `username`, `source_ip`, `package_name`, `version`, `outcome`, `decision`, `http_status`).
Gateway 기록 기반은 #467/#468, 사용자 연결은 #471/#476에 구현됐습니다. Logs는 #477에서, Request·Overview의 설치 요청과 사용자 조회는 #490에서 실제 DB 조회로 전환했습니다.
읽는 곳은 `src/lib/download-events/server/download-events.ts` 한 파일(Request·Overview·Logs 공용)입니다.

| 화면 | 쓰는 데이터 |
|---|---|
| Request | `listRootRequests`(실제 DB 조회). 최근 7일(한국 시간) 루트 패키지 요청, 날짜별·최신순. 검색(패키지 이름·사용자), 판정 필터. 클릭 → 판정 id로 Package 상세 |
| Overview | `listRootRequests`·`findRequesters`(실제 DB 조회). 최근 24시간 루트 패키지 요청 수(1시간씩), 최근 판정의 설치 시도 사용자(판정의 `requestId` → `username`) |
| Log(설치 기록 탭) | `listDownloadEvents`(모든 요청, 서버 조회). 기본 최근 7일(한국 시간), 사용자·기간·패키지 이름/버전 부분 일치 검색, 50건씩 페이지 나누기(`page`) |
| Log(의존성 역추적 탭) | `listRootInstallsContaining`·`listRootDependencies`(4.4·4.5절). 패키지(이름 정확 일치, 버전 선택)가 포함된 과거 Root 설치와 한 설치의 전체 의존성. 기간 필터 없음, 최대 200건. Package 상세의 "이 패키지가 포함된 설치 보기"(`view=trace`)에서 연결 |

Log 화면은 탭 2개입니다. 주소 값 `view`가 `trace`면 의존성 역추적, 그 밖에는 설치 기록입니다(`view`가 없고 `trace`가 있으면 역추적으로 읽어 이전 주소와 호환). 보이는 탭의 데이터만 조회하며, 탭을 바꿔도 다른 탭의 주소 값(`q`·`user`·`trace`·`page` 등)은 지우지 않습니다. 설치 기록 탭 주소는 보통 `view`를 생략하지만, `trace` 값이 남아 있으면 `view=events`를 씁니다. 두 탭의 검색은 성격이 다릅니다.

| | 설치 기록 | 의존성 역추적 |
|---|---|---|
| 이름 검색 | 이름·버전 부분 일치 | 이름 정확 일치(대소문자 무시) |
| 기간 | 적용 | 적용 안 함 |
| 단위 | 요청 1건 | Root 설치 |

## 2. 루트 추적 컬럼 (#461에 추가 완료, 값 연결은 #460)

| 컬럼 | 형식 | 의미 |
|---|---|---|
| `is_root` | `BOOLEAN NOT NULL DEFAULT FALSE` | 사용자가 설치 명령으로 직접 지정한 패키지의 tarball 요청이면 `true`, 하위 의존성 요청은 `false` |
| `decision_id` | `TEXT NULL` | Gateway가 그 요청에 집행한 판정의 id(Decision 조회 `FOUND` 결과의 `decisionId`). 판정이 없으면(처음 보는 패키지 `NOT_FOUND`, 인증 실패·오류) `NULL` |

```sql
-- infra/postgres/migrations/user/003_download_events_root.sql (#461)
ALTER TABLE download_events
    ADD COLUMN IF NOT EXISTS is_root BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS decision_id TEXT;

-- Request 목록·Overview 24시간 수는 모두 루트 요청을 시각 범위로 읽습니다.
CREATE INDEX IF NOT EXISTS download_events_root_idx
    ON download_events (occurred_at DESC) WHERE is_root;

-- Overview가 판정의 request_id로 설치를 시도한 사용자를 찾습니다(4.2절).
CREATE INDEX IF NOT EXISTS download_events_request_idx
    ON download_events (request_id);
```

- Root 의도(install-intents)가 등록된 설치만 `is_root = true`로 기록됩니다. Dashboard는 이 값만 읽으므로 일반 npm install이나 루트 판별 전에 실패한 요청은 Request에서 빠질 수 있습니다.
- `request_id`는 지금처럼 Gateway 요청 ID(`x-request-id`)를 씁니다. Gateway는 tarball 요청의 ID를 판정 흐름에 그대로 넘기므로(`apps/gateway/src/controllers/tarball.controller.ts`) 판정 기록의 `request_id`와 같은 값입니다. Overview가 이 값으로 판정을 만든 요청의 사용자를 찾습니다.

### 2.1 Root 설치 의존성 이력 (`install_dependency_history`, #474)

Gateway가 Root 설치 요청 시점의 Arborist 의존성 전체를 남기는 테이블입니다(`infra/postgres/migrations/user/005_install_dependency_history.sql`). Dashboard는 읽기만 합니다.

| 컬럼 | 의미 |
|---|---|
| `root_request_id` | Root tarball 요청의 Gateway 요청 ID. **`download_events.request_id`와 같은 값**이라 이 값으로 사용자·시각·결과를 잇습니다 |
| `root_package_name`, `root_package_version` | 사용자가 설치 명령으로 직접 지정한 Root 패키지와 해석된 버전 |
| `package_name`, `package_version`, `integrity` | 그 Root 설치에 포함된 의존성 하나 |
| `captured_at` | Gateway가 이력을 기록한 시각 |

- 사용자 컬럼은 없습니다. 사용자는 `download_events`에서 `request_id`로 가져옵니다. 그 행이 없으면(기록 저장 실패 등) 사용자·시각·결과를 알 수 없어 `LEFT JOIN`으로 이력만 보여 줍니다.
- 이력은 Gateway에 Root 설치 의도가 등록된 패키지의 tarball 요청이 올 때만 생깁니다. npm 로컬 캐시로 설치하면 tarball 요청이 Gateway에 오지 않아 기록되지 않습니다. 따라서 역추적은 "Root 설치로 기록된 설치"만 찾습니다.
- 기본 키는 `(root_request_id, package_name, package_version, integrity)`, 인덱스는 `(package_name, package_version, captured_at DESC)`와 `(root_request_id)`입니다.

## 3. 기록 규칙 (Gateway)

- tarball 요청 1건 = 1행(지금과 같음)
- 루트 패키지 요청이면 `is_root = true`
- 판정을 집행했으면 `decision`과 `decision_id`를 함께 기록(판정 재사용이면 재사용한 판정의 id)
- 처음 보는 패키지(Decision 조회 `NOT_FOUND` → 차단 후 검사 요청)는 `outcome = 'BLOCKED'`, `decision`·`decision_id`는 `NULL`
- 유효한 npm 토큰이면 검증된 `user_id`, `username`(요청 당시 이름)을 기록합니다. 사용자 제공 이름은 신뢰하지 않습니다.
- 토큰 없음·무효·만료는 두 값 모두 `NULL`, `outcome = 'UNAUTHENTICATED'`, HTTP 401입니다.
- 유효한 토큰의 사용자에게 설치 권한이 없거나 비활성 상태면 `FORBIDDEN`, HTTP 403이며 검증된 사용자 정보를 보존합니다. `decision`은 NULL입니다.
- 인증 DB 장애는 HTTP 500으로 설치를 막습니다. `ERROR` 기록을 시도하지만 같은 DB 장애로 기록도 실패할 수 있습니다.
- 인증 거부는 분석/root 판별 전에 발생하므로 Request 목록에 반드시 나타나지는 않습니다.
- metadata 단계에서 거부된 요청은 tarball 기록이 없습니다.

## 4. Dashboard 조회 (Request·Overview·Logs 적용 완료)

시각은 `TIMESTAMPTZ`로 비교하고, 한국 시간 0시 같은 기간 계산은 Dashboard가 해서 넘깁니다.
검색어는 `%`·`_`가 와일드카드로 해석되지 않도록 `LIKE` 대신 `position`으로 비교합니다.

### 4.1 루트 패키지 요청 목록 (`listRootRequests`)

```sql
SELECT request_id, occurred_at, username, package_name, version, outcome, decision, decision_id
FROM download_events
WHERE is_root
  AND occurred_at >= $1 AND occurred_at <= $2
  AND ($3 = '' OR position(lower($3) in lower(package_name)) > 0
               OR position(lower($3) in lower(coalesce(username, ''))) > 0)
  AND ($4::text IS NULL OR decision = $4)
ORDER BY occurred_at DESC, id
```

- `$4`는 전체 판정(`ALL`)이면 NULL입니다. 같은 시각의 요청은 `id` 오름차순으로 순서를 고정합니다.

### 4.2 요청 id별 사용자 (`findRequesters`, 루트 여부와 관계없이)

```sql
SELECT request_id, username FROM download_events WHERE request_id = ANY($1)
```

### 4.3 설치 기록 목록 (`listDownloadEvents`)

`from`·`to`는 한국 날짜(YYYY-MM-DD)입니다. 누락·잘못된 값·배열은 각 날짜의 기본값(오늘-6일, 오늘)으로 복원하고 역순이면 교환합니다.
`q`는 공통 `normalizeSearch`로 정리하며 `user`는 username 정확 일치입니다. 배열 검색어·사용자는 전체로 처리합니다.
URL에서 기본값은 생략합니다. 서버는 시작일 0시 이상, 종료일 다음 날 0시 미만을 조회합니다.

```sql
SELECT id, occurred_at, request_id, user_id, username, host(source_ip) AS source_ip,
       package_name, version, outcome, decision, http_status
FROM download_events
WHERE occurred_at >= $1 AND occurred_at < $2
  AND ($3 = '' OR position(lower($3) in lower(package_name || '@' || version)) > 0)
  AND ($4 = '' OR ($4 = '__anonymous__' AND username IS NULL) OR username = $4)
ORDER BY occurred_at DESC, id
LIMIT 51 OFFSET $5
```

- `$1`, `$2`: 위 기간의 시작·끝 시각, `$3`: 패키지 `name@version` 부분 검색어(대소문자 무시), `$4`: 사용자(빈 값 전체, `__anonymous__` 로그인 안 함), `$5`: `(page - 1) * 50`.
- 한 페이지는 50건(`LOG_PAGE_SIZE`)입니다. 51행을 읽어 51행이 오면 앞 50행만 반환하고 `hasNext: true`로 "다음"을 켭니다. 전체 건수(COUNT)는 조회하지 않아 페이지 번호 목록 없이 "이전"·"다음"과 현재 범위(예: 1–50건)만 보여 줍니다.
- `page`는 주소 값이며 `^[1-9][0-9]{0,4}$`가 아니면 1입니다(0·음수·소수·문자·배열·99999 초과). `page`가 1이면 주소에서 생략합니다. 사용자·기간·검색어를 바꾸면 1페이지로 돌아갑니다.
- `ORDER BY occurred_at DESC, id`는 `id`가 유일해서 같은 시각의 행이 있어도 순서가 고정되므로 페이지 사이에 중복·누락이 없습니다. 페이지를 넘기는 사이 새 기록이 쌓이면 최신 행이 앞에 끼어들어 한 행이 다음 페이지에 한 번 더 보일 수 있습니다(OFFSET 방식의 한계).
- 범위를 넘은 페이지(0행)는 "이 페이지에 기록이 없습니다."와 1페이지 링크를 보여 줍니다.
- 시각은 ISO 문자열, 요청 IP는 `host(source_ip)` 문자열(NULL 허용)로 반환합니다.
- 사용자 선택 목록은 검색어·선택 사용자와 관계없이 같은 기간에서 조회합니다.

```sql
SELECT DISTINCT username FROM download_events
WHERE occurred_at >= $1 AND occurred_at < $2 AND username IS NOT NULL
ORDER BY username
```

DB 조회 실패 시 로더가 `DOWNLOAD_EVENTS_UNAVAILABLE`을 반환하며, 화면은 오류 안내를 표시합니다. 원인은 서버 로그에만 남깁니다.

### 4.4 문제 패키지가 포함된 Root 설치 (`listRootInstallsContaining`)

주소 값 `trace`(패키지 이름)와 `traceVersion`(선택)으로 조회합니다. 둘 다 공통 `normalizeSearch`로 정리하고, `trace`가 비어 있으면 `traceVersion`은 무시합니다. 배열 값은 기본값(빈 값)으로 처리합니다.
**기간(`from`·`to`)은 적용하지 않습니다.** 과거 전체 이력을 찾는 기능입니다.

```sql
-- download_events는 LEFT JOIN: 설치 기록 저장이 실패한 설치도 이력에는 보이게 합니다.
SELECT h.root_request_id, h.root_package_name, h.root_package_version,
       h.package_version AS matched_version, h.captured_at,
       e.username, e.user_id, e.occurred_at, e.outcome, e.decision
FROM install_dependency_history h
LEFT JOIN download_events e ON e.request_id = h.root_request_id
WHERE lower(h.package_name) = lower($1)
  AND ($2 = '' OR h.package_version = $2)
ORDER BY h.captured_at DESC, h.root_request_id, h.package_version
LIMIT 201
```

- `$1`: 패키지 이름(대소문자 무시, 정확 일치), `$2`: 버전(빈 값이면 모든 버전, 정확 일치).
- 한 Root 설치에 같은 패키지의 여러 버전이 들어 있으면 버전마다 한 행입니다(`matched_version`). `h.package_version`은 같은 시각의 행끼리 순서를 고정하려고 정렬에 넣었습니다.
- 201행이면 앞 200행만 반환하고 `truncated: true`로 "최근 200건만 표시합니다."를 안내합니다.
- `download_events` 행이 없으면 `username`·`user_id`·`occurred_at`·`outcome`·`decision`이 모두 NULL입니다. 화면은 시각에 `captured_at`을 쓰고, 결과는 "기록 없음"으로 표시합니다.
- `download_events.request_id`에는 유일 제약이 없습니다(요청 1건 = 1행이라 정상 흐름에서는 한 행). 같은 `request_id` 행이 둘 이상이면 그 설치가 중복 행으로 나옵니다.
- `lower(h.package_name)` 비교는 `(package_name, …)` 인덱스를 쓰지 못할 수 있습니다. 데이터가 적은 MVP라 그대로 두고, 느려지면 그때 검토합니다.
- 조회 실패 시 로더가 `trace`에 `ROOT_TRACE_UNAVAILABLE`을 담습니다. 같은 탭의 Root 상세(4.5절)는 그대로 표시하고 원인은 서버 로그에만 남깁니다. 설치 기록은 다른 탭이라 이 탭에서는 조회하지 않습니다.

### 4.5 Root 설치의 전체 의존성 (`listRootDependencies`)

주소 값 `root`(Root 설치의 `root_request_id`)로 조회합니다. Gateway 요청 ID 형식(UUID)이 아니면 빈 값으로 처리합니다.

```sql
SELECT root_package_name, root_package_version, package_name, package_version, integrity
FROM install_dependency_history
WHERE root_request_id = $1
ORDER BY package_name, package_version
```

- 결과가 0행이면 `null`이며, 로더가 `rootDetail`에 `ROOT_NOT_FOUND`를 담습니다. 조회가 실패하면 `ROOT_TRACE_UNAVAILABLE`입니다. 둘 다 4.4절 결과에는 영향을 주지 않습니다.
- 의존성 경로(부모-자식)는 이력에 없어 표시하지 않습니다. 화면은 `integrity`를 줄여 보여 주고 전체 값은 `title`로 봅니다.

## 5. Dashboard 연결 상태 (완료)

- Request·Overview의 `listRootRequests`·`findRequesters`를 `getPool()` 조회(4절 SQL)로 전환하고 설치 요청 목업을 삭제했습니다(#490). 조회 함수는 테스트용 `Queryable` 주입을 지원합니다.
- Request 조회 실패는 검색·필터를 유지한 채 `DOWNLOAD_EVENTS_UNAVAILABLE`로 안내합니다. Overview 설치 요청 조회 실패는 해당 카드만 안내하며, 사용자 조회 실패는 최근 판정을 유지하고 사용자 칸만 비웁니다. 원인은 서버 로그에 기록합니다.
- 환경변수 추가는 없습니다(`user_db`는 이미 연결되어 있음).
- Logs는 같은 읽기 파일의 `listDownloadEvents`·`listDownloadUsernames`로 전환했고 별도 Logs 목업을 삭제했습니다.
- Request·Logs는 공통 `outcomeLabel`로 `BLOCKED` + `decision` NULL을 "판정 대기"(neutral), `FORBIDDEN`을 "권한 없음"으로 표시합니다.
- 설치 기록은 50건씩 페이지를 나눕니다(4.3절). 역추적 결과의 페이지 나누기는 하지 않고 200건 제한을 유지합니다.


## 6. npm 전용 토큰 및 배포 순서 (#471)

Dashboard 개인 설정에서 토큰을 발급합니다. 로그인 세션과 분리된 `whs_npm_` 접두사 + 32바이트 난수이며,
`npm_tokens`에는 SHA-256 해시만 저장합니다. 사용자당 1개, 90일 만료입니다.
만료가 길어도 Gateway가 요청마다 현재 역할·정지 여부를 확인하므로, 권한을 잃은 계정은 토큰이 남아 있어도 바로 거부됩니다.
재발급은 원자적 교체, 폐기는 본인 행 삭제이며 새 요청부터 반영됩니다. 진행 중인 요청을 취소하지는 않습니다.
발급/재발급은 현재 활성 상태와 `package:install` 권한을 확인합니다. 폐기는 설치 권한 없이도 유효한 세션으로 가능합니다.

- `POST /api/settings/npm-token`: 발급·재발급. `{ token, expiresAt }`, `Cache-Control: no-store`.
- `DELETE /api/settings/npm-token`: 본인 토큰 폐기, 204.
- 둘 다 기존 Dashboard 세션·Origin 검사를 적용하며 요청 본문의 사용자 ID를 사용하지 않습니다.
- Gateway는 매 요청 토큰 해시·만료를 조회한 뒤 현재 role/ban 상태를 확인합니다. 인증 캐시는 없습니다.
- HTTP 401: `AUTHENTICATION_REQUIRED`, 계정 권한 403: `INSTALL_NOT_PERMITTED`, 정책 차단 403: `PACKAGE_NOT_ALLOWED`.
- 인증 DB 설정 누락·장애는 500으로 거부합니다. 기록만 fail-open이며 Pool 연결/종료는 공유합니다.

배포 순서:

1. 기존 DB에 아래 migration을 적용합니다. 신규 DB는 bootstrap에 포함됩니다. 사용자 DB 소유자가 적용하며 반복 실행할 수 있습니다.

   ```sh
   docker compose exec -T postgres sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d user_db -f /migrations/user/004_npm_tokens.sql'
   ```

2. DevOps가 기존 `infra/verdaccio/scripts/manage-users.sh`로 `gateway-reader` 계정을 추가합니다.
   기존 admin을 재사용하지 않습니다. `VERDACCIO_SERVICE_USER`, `VERDACCIO_SERVICE_PASSWORD`를 Gateway에 Secret으로 주입합니다.
3. Dashboard를 배포하고 개발자/CI 전용 계정의 토큰을 발급합니다. 토큰 원문은 이때만 표시됩니다.
4. Gateway 배포 및 개발자·QA·CI의 npm 설정 전환을 같은 점검 시간에 수행합니다.
   기존 Verdaccio 토큰과 Gateway npm login Route는 더 이상 지원하지 않습니다(410 안내).
5. 서비스 계정 Basic 인증으로 실제 metadata/tarball 읽기를 확인합니다. 자격증명 누락·잘못된 비밀번호는 서버 오류로 거부하며 사용자 토큰으로 재시도하지 않습니다.
   upstream 403은 Verdaccio의 정책·무결성 차단일 수도 있어 그대로 보존합니다.

개발자 설정(컴퓨터마다 1회, 운영자가 안내한 Gateway 주소로 교체). 사용자 `~/.npmrc`에 저장되어 이후 설치에서 자동으로 식별됩니다.
Dashboard 설정 화면은 발급 직후 토큰이 채워진 아래 명령을 보여 줍니다.

```sh
npm config set registry https://<Gateway주소>/npm/
npm config set //<Gateway주소>/npm/:_authToken <발급된 토큰>
```

CI는 토큰을 파일에 저장하지 않고 Secret 환경변수로 주입합니다.

```ini
registry=https://<Gateway주소>/npm/
//<Gateway주소>/npm/:_authToken=${NPM_TOKEN}
```

실제 토큰을 저장소·로그에 남기지 않습니다.
외부 접속에는 HTTPS를 사용하고 서비스 계정 Basic 자격증명은 신뢰하는 내부 Verdaccio 경로에만 전달합니다.
비밀번호 변경/유출 시 Gateway Secret을 교체해야 합니다. Basic 인증 비용은 실제 설치로 검증합니다.

QA는 `tests/e2e/critical_path.py --npmrc <임시 npmrc>` 또는 `QA_NPMRC`에 새 토큰을 설정한 파일을 전달합니다.
스크립트는 그 파일을 npm에 넘기므로 인증 방식별 변경은 없습니다. 토큰은 CI도 90일이므로 만료 전 재발급/Secret 교체 담당을 정합니다.
전체 critical_path 검증에는 Scanner·Policy·Evidence·Decision·Dashboard 등 기존 서비스가 모두 정상이어야 합니다.

실제 사용자 IP/trustProxy, #460 root 판별, 화면의 실데이터 조회 전환은 #471 범위에 포함되지 않습니다.
#477에서 Logs 실데이터 조회와 결과 라벨을 연결했습니다. 실제 DB 행 확인과 화면 표시 테스트는 구분합니다.
