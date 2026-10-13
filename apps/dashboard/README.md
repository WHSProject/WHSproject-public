# ARGUS Security Dashboard

WHSProject의 Package, Scan, Decision, Evidence, Policy 상태를 조회하고,
사용자·권한을 관리하는 Dashboard입니다.

## 페이지 구성

| 화면 | 경로 | 내용 | 데이터 |
|---|---|---|---|
| Overview | `/` | 최근 24시간 설치 요청·판정·미승인 추이, 적용 중 정책(버전·사용 중 Rule 수·적용한 사람), 판정 분포, 최근 판정(설치 시도 사용자·트리거된 Rule), 판정 방식 안내 | 목업(적용 중 정책은 실제 Policy DB API) |
| Requests | `/requests` | 최근 7일 루트 패키지 설치 요청(날짜별·설치 시도 사용자·루트 판정, 클릭 → Package 상세), 패키지·사용자 검색, 판정 필터. | 목업(`docs/download-events-contract.md`) |
| Packages | `/packages` | 패키지 버전별 최신 판정 목록(검색·판정 필터·페이지), 판정 상세(사유·정책 버전·매칭 Rule·Evidence·버전 이력) | 목업(정책 버전 Rule은 실제 Policy DB API) |
| Logs | `/logs` | 설치 기록(누가·언제·어떤 패키지·판정·결과), 사용자·기간·패키지 필터 | 목업 |
| Rules | `/rules` | 적용 중인 정책의 Rule 편집(판정·우선순위 1~100·활성·이름·조건·고급 설정), 조건·판정 필터, 적용 = 새 버전 생성 + 활성화 (Editor·Admin) | 실제(Policy DB API) |
| Versions | `/versions` | 정책 버전 목록(상태·만든 사람·적용 시각), 버전별 Rule 보기, 같은 Policy 내부 버전의 이전 버전 다시 적용 (Editor·Admin) | 실제(Policy DB API) |
| 개인 설정 | `/settings` | 내 정보, username·비밀번호 변경, 로그인된 기기 관리 | 실제(`user_db`) |
| Admin | `/admin/users` | 계정 생성, 비밀번호 설정·재설정 링크 발급, 권한 변경, 비활성화·활성화 (Admin 전용) | 실제(`user_db`) |
| 권한 변경 이력 | `/admin/role-changes` | 최근 100건 (Admin 전용) | 실제(`user_db`) |
| 인증 | `/login`, `/reset-password` | username 로그인(비밀번호 분실은 관리자 문의 안내), Admin이 발급한 링크로 비밀번호 설정 | 실제(`user_db`) |

> **Overview, Requests, Packages, Logs의 수치·판정은 목업입니다(Overview 적용 중 정책, Package 매칭 Rule은 실제 Policy DB API).**
> 실제 API 응답이나 Policy 계산 결과가 아니며, API 연동은 후속 작업입니다.

- 인증 외 모든 화면은 로그인해야 볼 수 있습니다.
  - 1차: `src/proxy.ts`가 쿠키를 확인합니다.
  - 2차: 각 `page.tsx`가 DB 세션을 확인합니다.
- 권한이 없으면 403 화면을 보여 줍니다. 메뉴 숨김은 UX일 뿐이고, 실제 차단은 서버에서 합니다.
- 역할은 Viewer < Developer < Editor < Admin 네 가지입니다. 권한 정의는 `src/lib/auth/common/permissions.ts`에 있습니다.
  - Developer(#384): 조회 + 패키지 설치(`package:install`, Gateway 인증 연동 때 사용). Editor·Admin도 설치할 수 있습니다.
- 로그인은 username과 비밀번호로만 합니다.
  - username: 영문·숫자·`_` 3~30자. 입력은 대소문자를 구분하지 않고, 소문자로 저장합니다.
- 메일 인증, 비밀번호 재설정 메일, 회원가입, 이메일 로그인, Google 로그인은 #380에서 삭제했습니다(2026-09-27 멘토 회의).
  - 해당 화면(`/signup`, `/verify-email`, `/forgot-password`, `/settings/login-methods`)은 없습니다(404).
  - Better Auth가 기본으로 여는 관련 API(`/sign-up/email`, `/sign-in/email`, `/send-verification-email`, `/verify-email`, `/request-password-reset`, `/sign-in/social`, `/link-social`, `/unlink-account`)는 404로 막습니다(`src/lib/auth/server/hooks.ts`).
  - 다시 필요하면 #326(Google 로그인), #323(메일 인증·가입)과 #380의 삭제 내역을 참고합니다.
- 계정은 Admin이 만듭니다(#384). 메일은 보내지 않습니다.
  1. Admin이 `/admin/users`에서 username과 역할(기본 Viewer)을 정해 계정을 만듭니다.
  2. 화면에 나온 **비밀번호 설정 링크(1시간, 한 번만 사용)** 를 사용자에게 직접 전달합니다.
  3. 사용자가 링크(`/reset-password?token=…`)에서 비밀번호를 두 번 입력하면 로그인할 수 있습니다. 그전까지 상태는 "설정 대기"입니다.
  - 비밀번호를 잊으면 Admin이 "재설정 링크"를 발급합니다. 재설정하면 그 사용자의 로그인이 모두 끊깁니다.
  - 링크를 새로 발급하면 이전 링크는 쓸 수 없습니다.
  - 링크 토큰은 Better Auth 재설정 토큰 형식(`verifications`의 `reset-password:<token>`)으로 서버가 직접 넣습니다(`src/features/admin/server/accounts.ts`).
  - Better Auth를 거친 사용자 생성은 모두 거절합니다(`user.validateUserInfo`).
- 이메일은 Better Auth 필수 칸이라 `<username>@argus.local` 자동값을 넣습니다. 로그인·화면에 쓰지 않고, username을 바꾸면 함께 바뀝니다.

## 기술 구성

| 영역 | 사용 |
|---|---|
| 프레임워크 | Next.js 16 App Router (standalone 빌드), React 19, TypeScript |
| 스타일 | CSS Variables + CSS Modules, 로컬 폰트(Wanted Sans, IBM Plex Mono, `public/fonts`) |
| 인증 | Better Auth (username·비밀번호, admin 플러그인) |
| DB | PostgreSQL `user_db` (`pg`), 스키마는 `infra/postgres/migrations/user/` |
| 검사 | ESLint, Vitest + React Testing Library |

## 디렉터리 구조

```text
src/
├── proxy.ts          로그인 쿠키가 없으면 /login으로
├── app/              주소(URL)와 화면 조립
│   ├── (auth)/       로그인 전 화면
│   ├── (dashboard)/  로그인 후 화면 (page.tsx: 권한 확인 → 데이터 조회 → 기능 화면 호출)
│   ├── api/          서버 API (auth, admin, settings, health)
│   └── _shell/       앱 공통 틀: AppShell, 404·403 화면, 전역 스타일
├── features/         기능별 코드
│   ├── overview/ requests/ packages/ logs/ rules/ versions/
│   ├── auth/         로그인·비밀번호 재설정 화면
│   ├── settings/     개인 설정
│   └── admin/        사용자 관리
├── components/       여러 기능이 쓰는 화면 부품
│   ├── ui/           Button, FormNotice, SearchField(주소 값 자동 검색 hook 포함), TextField
│   └── decision/     판정 칩, 판정 필터
└── lib/              여러 기능이 쓰는 기반 코드
    ├── db.ts  format.ts  navigation.ts
    ├── decision/     판정 타입·순서, server/(Decision DB API 읽기, Package·Overview 공용)
    ├── download-events/ 설치 기록 타입, server/(user_db.download_events 읽기, Request·Overview 공용)
    ├── auth/
    │   ├── client.ts  브라우저용 인증 클라이언트
    │   ├── common/    서버·브라우저 공용 규칙 (권한, 경로, 입력 검증, 표시 이름)
    │   └── server/    서버 전용 (Better Auth 설정, 세션, API 요청 검사)
    └── policy/       Rule·Version 공용 Policy 정책 코드
        ├── common/    서버·브라우저 공용 (정책·Rule 형식, Policy 형식 변환, 표시 이름, 오류 문구)
        └── server/    서버 전용 (Policy DB API 호출)
test/                 src와 같은 경로에 테스트를 둡니다
scripts/
└── create-admin.js   첫 Admin 생성 (이미지에는 /app/create-admin.js로 들어갑니다)
```

기능 폴더 안에는 필요한 폴더만 둡니다.

| 폴더 | 내용 |
|---|---|
| `components/` | 그 기능의 화면 |
| `api/` | 브라우저에서 서버 API 호출 |
| `server/` | DB 조회·변경 (서버 전용) |
| `types/` | 화면과 서버가 같이 쓰는 타입 |
| `model/` | 계산, 오류 문구 변환 |
| `data/` | 목업 |

기능 폴더의 입구 파일:
- `index.ts`: 브라우저에서도 안전한 공개 입구입니다.
- `index.server.ts`: 서버 전용 입구입니다. 페이지와 API만 사용합니다.

**규칙**

1. import 방향은 `app → features → components → lib`입니다. 역방향은 lint 오류입니다.
2. 기능끼리는 import하지 않습니다.
   - 꼭 필요할 때만 상대 기능의 `index.ts`로 한 방향으로 허용하고, 이 README에 예외로 적습니다.
   - 현재 예외는 없습니다.
3. 두 개 이상의 기능이 쓰고 쉽게 사라지지 않는 코드만 `components`·`lib`로 올립니다.
4. 브라우저 코드는 서버 전용 모듈(DB, `lib/auth/server`, 기능의 `server/`)을 import하지 않습니다. lint 오류로 잡힙니다.
5. 인증 서버 코드 중 `lib/auth/server/cli.ts`에서 이어지는 파일은 상대경로로 import합니다. Better Auth CLI가 `@/` 별칭을 읽는지 확인하지 않았기 때문입니다.

## 실행 방법

### 개발 서버

```bash
# 저장소 루트: 사용자 DB(PostgreSQL)
docker compose up -d postgres

# apps/dashboard
npm ci
npm run dev
```

- 접속 주소: `http://localhost:5173` (쿠키 도메인 때문에 `127.0.0.1` 대신 `localhost`)
- 개발 서버는 루트 `.env`를 읽지 않습니다.
  - `apps/dashboard/.env.local`을 만들어 쓰며, 이 파일은 커밋되지 않습니다.
  - 셸에 같은 이름의 환경변수가 있으면 셸 값이 우선합니다.

```env
DB_HOST=127.0.0.1
DB_PORT=5432
DB_USER=
DB_PASSWORD=
DB_NAME=user_db
BETTER_AUTH_URL=http://localhost:5173
BETTER_AUTH_SECRET=        # openssl rand -base64 32
POLICY_DB_URL=http://127.0.0.1:9000   # Rules·Versions 페이지
DECISION_DB_URL=http://127.0.0.1:9100 # Package·Overview 판정 조회
EVIDENCE_DB_URL=http://127.0.0.1:8100 # Package 근거 조회
```

메일(`SMTP_*`, `MAIL_FROM`)과 Google 로그인(`GOOGLE_*`) 값은 쓰지 않습니다(#380).

### 처음 로그인하기

설치 직후에는 Admin이 없으므로 스크립트로 첫 Admin을 만듭니다(#384).

1. **`user_db` 확인:** 새 Postgres 볼륨이면 자동으로 만들어집니다. 기존 볼륨이면 한 번 직접 만들고, 빠진 migration을 적용합니다.
   ```bash
   docker compose exec postgres sh -c 'createdb -U "$POSTGRES_USER" user_db'
   docker compose exec postgres sh -c 'psql -U "$POSTGRES_USER" -d user_db -v ON_ERROR_STOP=1 -f /migrations/user/001_initial.sql'
   docker compose exec postgres sh -c 'psql -U "$POSTGRES_USER" -d user_db -v ON_ERROR_STOP=1 -f /migrations/user/002_account_management.sql'
   ```
2. **Admin 계정 만들기:** 출력된 링크(1시간, 한 번만 사용)를 열어 비밀번호를 설정합니다.
   ```bash
   # Docker (저장소 루트)
   docker compose exec dashboard node create-admin.js admin

   # 개발 서버 (apps/dashboard, .env.local의 DB_*·BETTER_AUTH_URL 사용)
   npm run create-admin -- admin
   ```
   - 비밀번호를 설정한 Admin이 이미 있으면 거절합니다. 그다음 계정은 Admin 화면에서 만듭니다.
   - 링크가 만료됐으면 같은 명령을 다시 실행합니다. 비밀번호를 설정하기 전의 Admin이면 링크만 새로 발급합니다.
   - 비밀번호는 입력받지 않으므로 셸 기록·환경변수에 남지 않습니다.
3. **로그인:** `/login`에서 username(`admin`)과 설정한 비밀번호로 로그인합니다.

### 검사

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

### 운영 빌드 · Docker

- **로컬 운영 빌드:** `npm run build && npm start`로 standalone `server.js`를 `127.0.0.1:5173`에서 실행합니다.
- **Docker:** 저장소 루트에서 `docker compose up -d --build --no-deps dashboard`로 띄웁니다.
  - 이미지: Node 24 Alpine, 비루트 사용자, 컨테이너 포트 80
  - 호스트 공개: `127.0.0.1:${DASHBOARD_PORT:-5173}`
  - 로그인하려면 루트 `.env`에 `BETTER_AUTH_SECRET`이 필요합니다.
- **상태 검사:** `GET /api/health`는 로그인 없이 `{"status":"ok","service":"dashboard"}`를 돌려줍니다.
- **포트 충돌:** 개발 서버, 로컬 운영 서버, Compose의 Dashboard는 모두 5173을 쓰므로 하나만 실행합니다.
- **Better Auth를 올릴 때:** 같은 버전의 CLI로 스키마 변경이 필요한지 확인합니다(`DB_*` 필요).
  `npx auth@<버전> generate --config src/lib/auth/server/cli.ts --output <임시 파일> --yes`

## 후속 작업

- 로그인 세션 만료 정책 명시 (현재 Better Auth 기본값: 7일, 사용 시 연장)
- Requests·Overview 설치 요청: Gateway가 `download_events`에 `is_root`·`decision_id`를 기록하면(`docs/download-events-contract.md`) `lib/download-events/server/download-events.ts`를 `user_db` 조회로 교체
- Overview: 판정 요약 API(`docs/package-decision-contract.md` 3.3)가 생기면 `lib/decision/server/decision-db.ts` 교체
- Packages: Policy가 패키지 목록·버전 이력 API(`docs/package-decision-contract.md`)를 만들면 읽는 부분(`lib/decision/server/decision-db.ts`) 교체
- Rules: Policy가 Dashboard Rule 형식(`docs/policy-rule-contract.md`)을 받게 되면 변환 부분(`lib/policy/common/format.ts`) 교체, 조건 목록 API 연결
- Logs 실제 데이터 연동: Gateway가 `download_events`를 기록하면 `lib/download-events` 읽기로 옮겨 `user_db` 조회로 교체 (Dashboard 소유 DB라 API Contract 불필요)
- 상위 Package 기반 Dependency Tree
