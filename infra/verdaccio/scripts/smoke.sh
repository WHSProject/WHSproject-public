#!/usr/bin/env sh
# Verdaccio Registry Smoke Test
#
# 수동으로 반복해 온 Registry 동작 확인을 한 번에 재실행한다.
# Gateway 연동 이후에도 같은 항목을 그대로 재사용하는 것이 목적이다.
#
# 주의: 이 스크립트를 만든 것만으로 W-019 / W-022 / W-027 이 끝나지 않는다.
#       현재는 Verdaccio 직결 경로만 검사한다. Gateway 경유 경로는
#       Gateway 라우팅이 붙은 뒤 별도 항목으로 추가해야 한다.
#
# 검사 항목:
#    1  GET /-/ping                  200
#    2  Web UI                       404  (web.enable=false)
#    3  사용자 직접 가입              409  (auth.htpasswd.max_users=-1)
#    4  admin 로그인과 JWT 발급
#   5a  Approval API 미인증 요청      401  (service_auth_enabled 가 false 면 400)
#   5b  인증된 빈 ACCEPT 목록 차단    400
#    6  ACCEPT 전 Metadata 조회       200  (Guard 는 metadata 를 막지 않는다)
#    7  Registry Guard 설정 동작      config.yaml 의 guard_enabled 에 따라
#                                     미승인 Version/Tarball 403 또는 200
#                                     (검사 8 이 등록하지 않는 다른 Version 사용.
#                                      승인 목록이 메모리에 남아 반복 실행이
#                                      틀어지는 것을 막는다)
#    8  정상 ACCEPT 목록 등록         200 REGISTERED, Cache 저장 확인
#    9  ACCEPT Package 미인증 조회    401
#   10  ACCEPT Tarball                직접 요청 200, 무결성 값 실측 대조
#   11  ACCEPT Metadata               Version / integrity / Tarball URL 보존
#   12  같은 Tarball 재요청 시 동일 바이트
#   13  내부 Package 미인증 publish   401
#   14  admin 내부 Package publish    201  (@whs/* , 실행마다 다른 이름)
#   15  외부 이름 publish 차단        403  (publish: no-publish)
#   16  없는 내부 Package             404  (@whs/* 에 proxy 가 없어 npmjs 로 나가지 않는다)
#   17  ACCEPT 후 내부 Tarball        200, 올린 바이트와 동일
#  18a  whs-ci 내부 Package publish   201  (VERDACCIO_CI_PASSWORD 를 준 경우에만)
#  18b  whs-ci unpublish 차단         403  (unpublish: admin)
#   19  admin unpublish               201, 이후 조회 404
#
# 검사 13~19 가 만든 Package 는 검사 끝에 지운다.
#
# 사용법:
#   sh infra/verdaccio/scripts/smoke.sh
#
# 터미널에서 실행하면 admin 비밀번호를 물어본다(화면에 표시하지 않는다).
# CI 처럼 터미널이 없는 곳에서는 환경변수로 준다.
#
#   VERDACCIO_ADMIN_PASSWORD='...' \
#     sh infra/verdaccio/scripts/smoke.sh
#
# admin 하나만 있으면 된다. setup-local.sh / setup-local.ps1 로 만든 계정을
# 그대로 쓸 수 있다. whs-ci 와 일반 사용자는 MVP 검사 범위가 아니다. 계정별
# whs-ci 비밀번호를 함께 주면 내부 Package 권한 검사(18a·18b)까지 돈다.
# 주지 않으면 그 두 항목만 건너뛰고 나머지는 그대로 검사한다.
#
# 비밀번호는 인자로 받지 않는다(셸 히스토리에 남으므로).
# bootstrap-users.sh / manage-users.sh 와 같은 규약이다.
#
# 환경변수:
#   VERDACCIO_ADMIN_USER          기본 admin
#   VERDACCIO_ADMIN_PASSWORD      터미널 실행 시 생략 가능. 비대화형에서는 필수
#   VERDACCIO_CI_PASSWORD         whs-ci 비밀번호. 주면 검사 18a·18b 를 함께 실행한다
#   VERDACCIO_CONTAINER           기본 whs-verdaccio
#   VERDACCIO_NETWORK             기본값은 위 컨테이너에서 자동으로 찾는다
#   VERDACCIO_INTERNAL_URL        기본 http://verdaccio:4873
#   VERDACCIO_IMAGE               검사 컨테이너 Image. 기본은 대상 컨테이너와 같은 Image
#                                 (S3 저장소 구성에서 검사 8 이 쓰는 AWS SDK 가 들어 있다)
#   VERDACCIO_PUBLIC_URL          검사 11 의 기대값. 생략하면 컨테이너 환경변수에서 읽는다
#   VERDACCIO_URL_PREFIX          검사 11 의 기대값. 생략하면 config.yaml 에서 읽는다
#   WHS_APPROVAL_SERVICE_TOKEN    Approval API 서비스 인증 Token.
#                                 생략하면 실행 중인 컨테이너에서 읽는다
#                                 config.yaml 의 service_auth_enabled 가 false 면 필요 없다
#   SMOKE_PROXY_PACKAGE           기본 is-odd. dist.integrity 가 있는 외부 Package
#
# 검사 7 과 검사 11 의 기대값은 실행 중인 컨테이너의 실제 설정에서 읽는다.
# Script 기본값과 실제 설정이 어긋나면 Verdaccio 는 정상인데 검사만 실패한다.
#   guard_enabled        - config.yaml (검사 컨테이너가 Mount 를 공유한다)
#   url_prefix           - config.yaml
#   VERDACCIO_PUBLIC_URL - Verdaccio 프로세스의 환경변수
#
# 종료 코드:
#   0  전 항목 통과
#   1  실패 항목 있음
#   2  전제조건 미충족 (컨테이너/네트워크 없음, 계정 미생성 등)
#
# 0 과 2 를 구분하는 이유는 verify-cache.sh 와 같다. 전제조건이 무너진
# 상태를 "통과" 로 읽으면 아무것도 검사하지 않고 성공으로 끝난다.
#
# 한계:
#   - Verdaccio 직결이다. Gateway 경유는 검사하지 않는다.
#   - npm CLI 가 아니라 Registry HTTP API 를 직접 호출한다. npm Client
#     버전별 호환은 별도 항목(W-026)에서 확인한다.
#   - ACCEPT 등록 직후 Metadata/Tarball 이 저장됐는지 확인한다. 로컬 저장소는 Volume 의
#     파일을, S3 저장소는 버킷의 객체를 본다. 저장 위치는 실행 중인 설정의 store 블록으로
#     정한다. 이후 요청이
#     npmjs 를 다시 호출하지 않는지는 Uplink 로그 대조가 필요해 다루지 않는다.
#     저장된 Tarball 전체의 무결성은 verify-cache.sh 가 담당한다.
#   - ACCEPT 기대값을 만들기 위해 검사 컨테이너가 npmjs Metadata를 직접 조회한다.
#     Docker Network 자체가 없으면 전제조건 미충족(exit 2), Network는 있지만
#     npmjs 조회가 실패하면 Registry 동작 검증 실패(exit 1)로 처리한다.
#   - 내부 Package 는 Verdaccio 가 받는 요청(publish, 조회, Tarball, unpublish)까지
#     검사한다. npm CLI 로 하는 실제 install 은 Gateway 경유라 다루지 않는다.

set -eu

CONTAINER="${VERDACCIO_CONTAINER:-whs-verdaccio}"
IMAGE="${VERDACCIO_IMAGE:-}"
INTERNAL_URL="${VERDACCIO_INTERNAL_URL:-http://verdaccio:4873}"
PROXY_PACKAGE="${SMOKE_PROXY_PACKAGE:-is-odd}"

ADMIN_USER="${VERDACCIO_ADMIN_USER:-admin}"

# 비밀번호는 setup-local.sh / manage-users.sh 와 같은 방식으로 받는다.
# 터미널에서 실행하면 물어보고, 환경변수가 이미 있으면 그대로 쓴다.
# CI 처럼 터미널이 없는 곳에서는 환경변수가 필수다.
ECHO_DISABLED=0

restore_terminal() {
  if [ "$ECHO_DISABLED" -eq 1 ]; then
    stty echo 2>/dev/null || true
    ECHO_DISABLED=0
  fi
}

clear_password() {
  unset VERDACCIO_ADMIN_PASSWORD 2>/dev/null || true
}

trap 'restore_terminal' EXIT
trap 'restore_terminal; clear_password; exit 130' HUP INT TERM

if [ -z "${VERDACCIO_ADMIN_PASSWORD:-}" ]; then
  if [ ! -t 0 ]; then
    echo "VERDACCIO_ADMIN_PASSWORD 를 환경변수로 지정하세요." >&2
    echo "터미널에서 실행하면 직접 입력받습니다." >&2
    exit 2
  fi

  printf "%s 비밀번호: " "$ADMIN_USER"
  ECHO_DISABLED=1
  stty -echo
  if ! IFS= read -r VERDACCIO_ADMIN_PASSWORD; then
    restore_terminal
    printf "
"
    echo "[취소] 비밀번호 입력이 완료되기 전에 입력이 종료되었습니다." >&2
    exit 2
  fi
  restore_terminal
  printf "
"

  if [ -z "$VERDACCIO_ADMIN_PASSWORD" ]; then
    echo "[실패] 비밀번호는 비워둘 수 없습니다." >&2
    exit 2
  fi
fi

# 실행 중인 컨테이너가 없으면 Network 도 찾을 수 없다. 먼저 끊는다.
if ! docker inspect "$CONTAINER" >/dev/null 2>&1; then
  echo "Verdaccio 컨테이너를 찾을 수 없습니다: ${CONTAINER}" >&2
  echo "docker compose up -d verdaccio 로 먼저 기동하세요." >&2
  exit 2
fi

# 검사 11 의 기대값은 실행 중인 컨테이너의 실제 설정에서 읽는다.
# Script 기본값과 실제 설정이 어긋나면 Verdaccio 는 정상인데 검사만 실패한다.
# 검사 7 의 guard_enabled 를 config.yaml 에서 직접 읽는 것과 같은 기준이다.
#   VERDACCIO_PUBLIC_URL - Verdaccio 프로세스의 환경변수
#   url_prefix           - config.yaml
# 환경변수로 직접 지정하면 그 값이 우선한다.
CONTAINER_PUBLIC_URL=$(docker inspect -f "{{range .Config.Env}}{{println .}}{{end}}" "$CONTAINER" | while IFS= read -r line; do
  case "$line" in VERDACCIO_PUBLIC_URL=*) printf "%s" "${line#VERDACCIO_PUBLIC_URL=}" ;; esac
done)
CONTAINER_URL_PREFIX=$(MSYS_NO_PATHCONV=1 docker exec "$CONTAINER" cat /verdaccio/conf/config.yaml | while IFS= read -r line; do
  case "$line" in url_prefix:*) printf "%s" "${line#url_prefix:}" ;; esac
done)
# 앞뒤 공백과 CR 제거. 셸 내장 기능만 사용한다(위 sed 주석 참고).
CONTAINER_URL_PREFIX="${CONTAINER_URL_PREFIX%%$(printf "\r")}"
while [ "${CONTAINER_URL_PREFIX# }" != "$CONTAINER_URL_PREFIX" ]; do
  CONTAINER_URL_PREFIX="${CONTAINER_URL_PREFIX# }"
done
while [ "${CONTAINER_URL_PREFIX% }" != "$CONTAINER_URL_PREFIX" ]; do
  CONTAINER_URL_PREFIX="${CONTAINER_URL_PREFIX% }"
done

# Approval API 서비스 인증 Token 도 같은 기준으로 실행 중인 컨테이너에서 읽는다.
# Script 를 실행하는 셸에 오래된 값이 남아 있으면 Verdaccio 는 정상인데 Approval
# 검사만 401 로 실패한다. 값 자체는 출력하지 않는다.
CONTAINER_SERVICE_TOKEN=$(docker inspect -f "{{range .Config.Env}}{{println .}}{{end}}" "$CONTAINER" | while IFS= read -r line; do
  case "$line" in WHS_APPROVAL_SERVICE_TOKEN=*) printf "%s" "${line#WHS_APPROVAL_SERVICE_TOKEN=}" ;; esac
done)
SERVICE_TOKEN="${WHS_APPROVAL_SERVICE_TOKEN:-${CONTAINER_SERVICE_TOKEN:-}}"

# 검사 컨테이너는 기본으로 대상과 같은 Image 를 쓴다. S3 저장소 구성에서 검사 8 이
# 버킷을 확인할 AWS SDK 는 그 Image 에만 들어 있다(infra/verdaccio/Dockerfile).
if [ -z "$IMAGE" ]; then
  IMAGE=$(docker inspect -f "{{.Config.Image}}" "$CONTAINER")
fi
IMAGE="${IMAGE:-verdaccio/verdaccio:6.10.0}"

# S3 저장소 구성의 접속값도 실행 중인 컨테이너에서 읽는다. 로컬 저장소 구성에서는
# 비어 있고 쓰지 않는다. 값은 출력하지 않고 이름으로만 넘긴다.
container_env() {
  docker inspect -f "{{range .Config.Env}}{{println .}}{{end}}" "$CONTAINER" | while IFS= read -r line; do
    case "$line" in "$1="*) printf "%s" "${line#"$1="}" ;; esac
  done
}
S3_BUCKET=$(container_env AWS_S3_BUCKET)
S3_REGION=$(container_env AWS_REGION)
S3_ENDPOINT=$(container_env AWS_ENDPOINT_URL_S3)
S3_ACCESS_KEY_ID=$(container_env AWS_ACCESS_KEY_ID)
S3_SECRET_ACCESS_KEY=$(container_env AWS_SECRET_ACCESS_KEY)

# 비어 있어도 여기서 멈추지 않는다. config.yaml 의 service_auth_enabled 가
# false 면 Token 이 필요 없고, 켜져 있는데 없으면 검사 5a 에서 실패로 보고한다.

PUBLIC_URL="${VERDACCIO_PUBLIC_URL:-${CONTAINER_PUBLIC_URL:-http://localhost:3000}}"
URL_PREFIX="${VERDACCIO_URL_PREFIX:-${CONTAINER_URL_PREFIX:-/npm/}}"

# Git Bash(MSYS)는 docker 인자 중 "/" 로 시작하는 값을 Windows 경로로 바꾼다.
# /npm/ 을 그대로 넘기면 컨테이너 안에서 "C:/Program Files/Git/npm/" 이 되고,
# 그 값으로 만들어진 dist.tarball 이 저장되면 이후 Metadata 조회에서
# Verdaccio 가 URL 파싱에 실패해 프로세스째 죽는다(실측).
# 앞 "/" 를 떼서 넘기고 컨테이너 안에서 다시 붙인다.
#
# sed 를 쓰지 않는다. PowerShell 에서 Git 의 sh.exe 만 직접 호출하면
# PATH 에 sed 가 없어 실패한다. 셸 내장 기능만 사용한다.
URL_PREFIX_NOSLASH="$URL_PREFIX"
while [ "${URL_PREFIX_NOSLASH#/}" != "$URL_PREFIX_NOSLASH" ]; do
  URL_PREFIX_NOSLASH="${URL_PREFIX_NOSLASH#/}"
done
while [ "${URL_PREFIX_NOSLASH%/}" != "$URL_PREFIX_NOSLASH" ]; do
  URL_PREFIX_NOSLASH="${URL_PREFIX_NOSLASH%/}"
done

# Host Port 를 공개하지 않으므로 Host 에서 직접 붙을 수 없다.
# Verdaccio 가 붙어 있는 Network 안에서 검사 컨테이너를 띄운다.
# awk 도 쓰지 않는다(위 sed 주석과 같은 이유).
# 여러 Network 에 붙어 있으면 첫 번째를 쓴다. 원하는 것이 아니면
# VERDACCIO_NETWORK 로 직접 지정한다.
NETWORK="${VERDACCIO_NETWORK:-}"
if [ -z "$NETWORK" ]; then
  NETWORK_LIST=$(docker inspect -f "{{range \$k, \$v := .NetworkSettings.Networks}}{{\$k}} {{end}}" "$CONTAINER")
  NETWORK="${NETWORK_LIST%% *}"
fi
if [ -z "$NETWORK" ]; then
  echo "Verdaccio 가 연결된 Docker Network 를 찾을 수 없습니다." >&2
  echo "VERDACCIO_NETWORK 환경변수로 직접 지정하세요." >&2
  exit 2
fi

echo "Verdaccio Smoke Test"
echo "  container : ${CONTAINER}"
echo "  network   : ${NETWORK}"
echo "  registry  : ${INTERNAL_URL}"
echo "  public url: ${PUBLIC_URL}${URL_PREFIX}"
echo ""

# 검사 컨테이너는 Verdaccio Image 의 node 를 그대로 쓴다. Image 를 새로 받지
# 않고, 대상 컨테이너의 Mount를 읽기 전용으로 공유해 Storage 파일을 확인한다.
# Host 경로를 직접 인자로 넘기지 않아 Windows 경로 변환 문제를 피한다.
# 비밀번호를 -e NAME=VALUE 로 넘기면 평문이 docker 클라이언트의 인자 목록에
# 들어가 같은 호스트의 다른 사용자에게 ps 로 노출된다. 이름만 넘기고 값은
# 환경에서 상속시킨다. manage-users.sh / bootstrap-users.sh 와 같은 기준이다.
MSYS_NO_PATHCONV=1 ADMIN_PW="$VERDACCIO_ADMIN_PASSWORD" \
CI_PW="${VERDACCIO_CI_PASSWORD:-}" \
SERVICE_TOKEN="$SERVICE_TOKEN" \
S3_BUCKET="$S3_BUCKET" S3_REGION="$S3_REGION" S3_ENDPOINT="$S3_ENDPOINT" \
S3_ACCESS_KEY_ID="$S3_ACCESS_KEY_ID" S3_SECRET_ACCESS_KEY="$S3_SECRET_ACCESS_KEY" \
docker run --rm \
  --network "$NETWORK" \
  --volumes-from "${CONTAINER}:ro" \
  -e BASE="$INTERNAL_URL" \
  -e PUBLIC_URL="$PUBLIC_URL" \
  -e URL_PREFIX_NOSLASH="$URL_PREFIX_NOSLASH" \
  -e PROXY_PACKAGE="$PROXY_PACKAGE" \
  -e ADMIN_USER="$ADMIN_USER" \
  -e ADMIN_PW \
  -e CI_PW \
  -e SERVICE_TOKEN \
  -e S3_BUCKET -e S3_REGION -e S3_ENDPOINT \
  -e S3_ACCESS_KEY_ID -e S3_SECRET_ACCESS_KEY \
  --entrypoint node \
  "$IMAGE" -e '
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const BASE = process.env.BASE;
const PUBLIC_URL = process.env.PUBLIC_URL;
// 앞뒤 "/" 를 뗀 상태로 전달된다(위 MSYS 주석 참고). 여기서 복원한다.
// 접두사를 쓰지 않는 구성이면 "//" 가 아니라 "/" 하나여야 한다.
const PREFIX_BODY = process.env.URL_PREFIX_NOSLASH || "";
const URL_PREFIX = PREFIX_BODY ? "/" + PREFIX_BODY + "/" : "/";
const PROXY_PACKAGE = process.env.PROXY_PACKAGE;
const RUN_STAMP = Date.now();
const APPROVAL_ENDPOINT = BASE + "/-/whs/approvals";
const SERVICE_TOKEN = process.env.SERVICE_TOKEN || "";
const STORAGE_ROOT = "/verdaccio/storage/data";
const CONFIG_PATH = "/verdaccio/conf/config.yaml";

// dist.integrity 는 SRI 형식이다: "<알고리즘>-<base64>". 공백으로 여러 개가
// 올 수 있다. sha512 로 고정해 계산하면 sha256 으로 배포된 Package 에서
// 거짓 불일치가 난다. verify-cache.sh 와 같은 강도 순서를 쓴다.
const SRI_STRENGTH = ["sha512", "sha384", "sha256"];

// Guard 활성 여부는 실행 중인 config.yaml 에서 직접 읽는다. 같은 사실을
// 환경변수로 따로 받으면 실제 설정과 어긋난 채로 검사 7 만 실패하는 상태가
// 생긴다. 검사 컨테이너는 --volumes-from 으로 대상의 Mount 를 그대로 공유하므로
// Verdaccio 가 읽는 것과 같은 파일을 본다.
//
// js-yaml 이 있다는 보장이 없어 whs-approval 블록에서 지정한 키 한 줄만 읽는다.
// 값이 없으면 Plugin 기본값(config.<key> !== false)과 같게 활성으로 본다.
// guard_enabled 와 service_auth_enabled 가 같은 기준을 쓴다.
function readApprovalFlag(key) {
  let text;
  try {
    text = fs.readFileSync(CONFIG_PATH, "utf8");
  } catch (error) {
    return { error: CONFIG_PATH + " 를 읽을 수 없습니다: " + error.message };
  }

  const lines = text.split(/\r?\n/);
  let blockIndent = null;

  for (const line of lines) {
    if (blockIndent === null) {
      const header = line.match(/^(\s*)whs-approval:\s*$/);
      if (header) { blockIndent = header[1].length; }
      continue;
    }

    if (/^\s*$/.test(line) || /^\s*#/.test(line)) { continue; }

    const indent = line.match(/^\s*/)[0].length;
    if (indent <= blockIndent) { break; }

    const entry = line.match(new RegExp("^\\s*" + key + ":\\s*(.+?)\\s*$"));
    if (entry) {
      // 인용부호 없는 false 만 비활성이다. "false" 는 YAML 에서 문자열이고
      // Plugin 도 !== false 로 보므로 활성으로 남는다.
      const value = entry[1].replace(/\s+#.*$/, "").trim();
      return { value: !/^(false|False|FALSE)$/.test(value) };
    }
  }

  if (blockIndent === null) {
    return { error: CONFIG_PATH + " 에 whs-approval Middleware 설정이 없습니다" };
  }
  return { value: true };
}

function readGuardEnabled() {
  return readApprovalFlag("guard_enabled");
}

function pickSri(integrity) {
  const tokens = String(integrity).trim().split(/\s+/);
  for (const algorithm of SRI_STRENGTH) {
    for (const token of tokens) {
      if (token.indexOf(algorithm + "-") === 0) {
        return { algorithm: algorithm, digest: token.slice(algorithm.length + 1) };
      }
    }
  }
  return null;
}

let pass = 0;
let fail = 0;
let prereq = null;

function ok(name, detail) {
  pass++;
  console.log("  PASS  " + name + (detail ? "  (" + detail + ")" : ""));
}

function bad(name, detail) {
  fail++;
  console.log("  FAIL  " + name + (detail ? "  -> " + detail : ""));
}

function check(name, condition, detail) {
  if (condition) { ok(name, detail); } else { bad(name, detail); }
}

function pkgPath(pkg) {
  return BASE + "/" + encodeURIComponent(pkg);
}

async function req(url, options) {
  const res = await fetch(url, options || {});
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* 본문이 JSON 이 아닐 수 있다 */ }
  return { status: res.status, text: text, json: json };
}

function auth(token) {
  return { authorization: "Bearer " + token };
}

// npm 의 로그인 API (npm login --auth-type=legacy 와 같은 경로).
//
// max_users 가 -1 이면 이 엔드포인트는 가입 요청으로 먼저 판정된다.
// JSON 본문만 보내면 계정과 비밀번호가 맞아도 409 user registration disabled
// 로 끊긴다(실측). Authorization: Basic 을 함께 보내야 기존 계정 인증으로
// 처리되어 201 과 JWT 를 돌려준다. npm CLI 가 이 헤더를 같이 보내기 때문에
// 수동 검증에서는 드러나지 않는 차이다.
async function login(user, password) {
  const basic = Buffer.from(user + ":" + password).toString("base64");
  return req(BASE + "/-/user/org.couchdb.user:" + encodeURIComponent(user), {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      authorization: "Basic " + basic
    },
    body: JSON.stringify({ name: user, password: password })
  });
}

// Approval API 는 서비스 인증을 요구한다. 전용 Header 가 아니라 Authorization 을
// 쓰는 이유는 Verdaccio 요청 로거가 authorization 만 <Classified> 로 가리기
// 때문이다. 전용 Header 면 Token 이 평문으로 로그에 남는다.
function registerAcceptList(requestId, packages) {
  return req(APPROVAL_ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer " + SERVICE_TOKEN
    },
    body: JSON.stringify({ requestId: requestId, packages: packages })
  });
}

async function resolveProxyArtifact() {
  const upstream = await req(
    "https://registry.npmjs.org/" + encodeURIComponent(PROXY_PACKAGE)
  );
  if (upstream.status !== 200 || !upstream.json) {
    return { error: "npmjs Metadata status " + upstream.status };
  }

  const tags = upstream.json["dist-tags"];
  const version = tags && tags.latest;
  const versionMetadata = version && upstream.json.versions
    ? upstream.json.versions[version]
    : null;
  const integrity = versionMetadata && versionMetadata.dist
    ? versionMetadata.dist.integrity
    : null;
  const tarball = versionMetadata && versionMetadata.dist
    ? versionMetadata.dist.tarball
    : null;

  if (!version || typeof integrity !== "string" || typeof tarball !== "string") {
    return { error: "latest Version의 dist.integrity 또는 dist.tarball이 없습니다" };
  }

  let filename;
  try {
    const pathname = new URL(tarball).pathname;
    filename = decodeURIComponent(pathname.slice(pathname.lastIndexOf("/") + 1));
  } catch (error) {
    return { error: "npmjs dist.tarball URL을 해석할 수 없습니다" };
  }

  // 검사 7(Guard) 은 승인 목록에 없는 좌표로 확인해야 한다. 검사 8 이 등록하는
  // latest 를 그대로 쓰면, 승인 목록이 프로세스 메모리에 남는 탓에 같은
  // Verdaccio 에서 두 번째 실행할 때 이미 승인된 상태가 되어 403 이 나오지
  // 않는다(실측). 그래서 이 Script 가 끝까지 등록하지 않는 다른 Version 을
  // 쓴다. 존재하지 않는 Version 은 Guard 가 꺼진 경우 404 가 되므로 안 된다.
  const probeVersion = Object.keys(upstream.json.versions || {})
    .filter((candidate) => candidate !== version)
    .pop();
  const probeTarball = probeVersion
    ? (upstream.json.versions[probeVersion].dist || {}).tarball
    : null;

  if (!probeVersion || typeof probeTarball !== "string") {
    return {
      error: PROXY_PACKAGE + " 에 latest 외의 Version 이 없어 Guard 검사를 " +
        "수행할 수 없습니다. SMOKE_PROXY_PACKAGE 에 Version 이 둘 이상인 " +
        "Package 를 지정하세요"
    };
  }

  let probeFilename;
  try {
    const pathname = new URL(probeTarball).pathname;
    probeFilename = decodeURIComponent(pathname.slice(pathname.lastIndexOf("/") + 1));
  } catch (error) {
    return { error: "npmjs dist.tarball URL을 해석할 수 없습니다 (Guard 검사용)" };
  }

  return {
    artifact: {
      packageName: PROXY_PACKAGE,
      version: version,
      integrity: integrity
    },
    filename: filename,
    probe: { version: probeVersion, filename: probeFilename }
  };
}

function packageStorageDirectory(packageName) {
  return path.join(STORAGE_ROOT, ...packageName.split("/"));
}

// 저장 위치는 실행 중인 설정에서 읽는다. 최상위 store 블록에 aws-s3-storage 가 있으면
// S3, 없으면 로컬 Volume 이다. js-yaml 이 없어 readApprovalFlag 처럼 줄 단위로 읽는다.
// keyPrefix 는 S3 Plugin 과 같이 끝에 "/" 를 붙인다. 없으면 버킷 맨 위에 저장된다.
function readStorageLocation() {
  let text;
  try {
    text = fs.readFileSync(CONFIG_PATH, "utf8");
  } catch (error) {
    return { error: CONFIG_PATH + " 를 읽을 수 없습니다: " + error.message };
  }

  let inStore = false;
  let s3 = false;
  let keyPrefix;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, "").replace(/^#.*$/, "");
    if (/^\S/.test(line)) {
      inStore = /^store:\s*$/.test(line);
      continue;
    }
    if (!inStore) continue;
    if (/^\s+aws-s3-storage:\s*$/.test(line)) s3 = true;
    const prefix = /^\s+keyPrefix:\s*"?([^"\s]*)"?\s*$/.exec(line);
    if (s3 && prefix) keyPrefix = prefix[1];
  }

  if (!s3) return { type: "local" };
  if (keyPrefix === undefined) return { type: "s3", keyPrefix: "" };
  return { type: "s3", keyPrefix: keyPrefix.endsWith("/") ? keyPrefix : keyPrefix + "/" };
}

// S3 저장 확인에 쓰는 AWS SDK 는 S3 Plugin 이 함께 설치한 것을 쓴다. Verdaccio 가
// Plugin 을 찾는 기준(Verdaccio 설치 위치)과 같게 찾는다.
function createS3Access() {
  const { createRequire } = require("module");
  const entry = createRequire("/usr/local/lib/node_modules/verdaccio/bin/verdaccio")
    .resolve("verdaccio-aws-s3-storage");
  const sdk = createRequire(entry)("@aws-sdk/client-s3");
  const client = new sdk.S3Client({
    region: process.env.S3_REGION || undefined,
    endpoint: process.env.S3_ENDPOINT || undefined,
    credentials: process.env.S3_ACCESS_KEY_ID
      ? {
        accessKeyId: process.env.S3_ACCESS_KEY_ID,
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || ""
      }
      : undefined
  });
  return { client, HeadObjectCommand: sdk.HeadObjectCommand };
}

async function s3ObjectExists(access, key) {
  try {
    await access.client.send(new access.HeadObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key }));
    return true;
  } catch (error) {
    const status = error && error.$metadata ? error.$metadata.httpStatusCode : undefined;
    if (status === 404 || (error && error.name === "NotFound")) return false;
    throw error;
  }
}

async function cacheFilesExist(packageName, filename) {
  const location = readStorageLocation();
  if (location.error) return { error: location.error };

  if (location.type === "local") {
    const directory = packageStorageDirectory(packageName);
    return {
      where: "local",
      metadata: fs.existsSync(path.join(directory, "package.json")),
      tarball: fs.existsSync(path.join(directory, filename))
    };
  }

  if (!process.env.S3_BUCKET) {
    return { error: "S3 저장소 구성인데 컨테이너에 AWS_S3_BUCKET 이 없습니다" };
  }
  let access;
  try {
    access = createS3Access();
  } catch (error) {
    return {
      error: "S3 확인에 필요한 AWS SDK 를 검사 Image 에서 찾을 수 없습니다" +
        " (VERDACCIO_IMAGE 확인): " + error.message
    };
  }

  const base = location.keyPrefix + packageName + "/";
  try {
    return {
      where: "s3",
      metadata: await s3ObjectExists(access, base + "package.json"),
      tarball: await s3ObjectExists(access, base + filename)
    };
  } catch (error) {
    return { error: "S3 버킷 확인 실패: " + (error.name || error.message) };
  }
}

async function run() {
  console.log("[기본 동작]");

  const ping = await req(BASE + "/-/ping");
  check("1  GET /-/ping 200", ping.status === 200, "status " + ping.status);

  const web = await req(BASE + "/");
  check("2  Web UI 비활성화 404", web.status === 404, "status " + web.status);

  // 실제로 계정이 만들어지면 안 되므로 매번 다른 이름을 쓴다.
  //
  // 상태 코드만으로는 약하다. 기존 계정이 Basic 헤더 없이 로그인해도 같은 409
  // 가 나오기 때문이다(login 함수 주석 참고). 그래서 본문 메시지까지 본다.
  // 다만 Verdaccio 가 두 경우에 같은 메시지를 쓰므로, 이 검사는 "가입 경로가
  // 열려 있지 않다" 까지만 보장한다.
  const probe = "smoke-signup-probe-" + Date.now();
  const signup = await req(BASE + "/-/user/org.couchdb.user:" + probe, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: probe, password: crypto.randomBytes(18).toString("hex") })
  });
  const registrationDisabled = signup.json && /registration disabled/i.test(signup.json.error || "");
  check("3  사용자 직접 가입 차단 409",
    signup.status === 409 && registrationDisabled,
    "status " + signup.status + (registrationDisabled ? "" : ", 예상과 다른 응답"));

  console.log("");
  console.log("[인증]");

  const loginResult = await login(process.env.ADMIN_USER, process.env.ADMIN_PW);
  const adminToken = loginResult.json && loginResult.json.token;
  const isJwt = typeof adminToken === "string" && adminToken.split(".").length === 3;
  check("4  admin 로그인과 JWT 발급",
    loginResult.status === 201 && isJwt,
    "status " + loginResult.status + (adminToken ? "" : ", token 없음"));

  // 로그인이 안 되면 이후 항목은 의미가 없다.
  if (!isJwt) {
    prereq = "admin 로그인에 실패했습니다. htpasswd 에 계정이 있는지 확인하세요.\n" +
      "  sh infra/verdaccio/scripts/manage-users.sh list";
    return;
  }

  console.log("");
  console.log("[ACCEPT Middleware]");

  const unauthorizedApproval = await req(APPROVAL_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      requestId: "smoke-unauthorized-" + RUN_STAMP,
      packages: []
    })
  });
  // 서비스 인증은 저장소 설정에서 켜져 있지만, 연동 문제를 가릴 때 config.yaml 로
  // 끌 수 있다. 검사 7 이 guard_enabled 를 읽는 것처럼 실제 설정을 읽어 기대값을 정한다.
  const serviceAuth = readApprovalFlag("service_auth_enabled");
  if (serviceAuth.error) {
    check("5a Approval API 서비스 인증 설정 확인", false, serviceAuth.error);
  } else if (!serviceAuth.value) {
    check("5a Approval API 서비스 인증 비활성 (config service_auth_enabled false) 400",
      unauthorizedApproval.status === 400,
      "status " + unauthorizedApproval.status);
  } else if (!SERVICE_TOKEN) {
    check("5a Approval API 서비스 인증 Token 확인", false,
      "Token 을 찾을 수 없습니다. compose 의 WHS_APPROVAL_SERVICE_TOKEN 을 설정한 뒤 Verdaccio 를 다시 기동하세요");
  } else {
    check("5a Approval API 미인증 요청 차단 401",
      unauthorizedApproval.status === 401 && unauthorizedApproval.json &&
        unauthorizedApproval.json.error === "unauthorized service request",
      "status " + unauthorizedApproval.status);
  }

  const invalidApproval = await registerAcceptList("smoke-invalid-" + RUN_STAMP, []);
  check("5b 인증된 빈 ACCEPT 목록 등록 차단 400",
    invalidApproval.status === 400,
    "status " + invalidApproval.status);

  const resolved = await resolveProxyArtifact();
  if (resolved.error) {
    bad("6  ACCEPT 전 Metadata 조회 200", resolved.error);
    bad("7  Registry Guard 설정 동작", resolved.error);
    bad("8  ACCEPT 목록 등록 200 REGISTERED", resolved.error);
    bad("8  Metadata/Tarball Cache 저장", resolved.error);
    bad("9  ACCEPT Package 미인증 조회 401", resolved.error);
    bad("10 ACCEPT Tarball 직접 요청과 무결성 일치", resolved.error);
    bad("11 ACCEPT Metadata Version/integrity 보존", resolved.error);
    bad("12 같은 Tarball 재요청 시 동일 바이트", resolved.error);
  } else {
    const approved = resolved.artifact;
    const internalTarball = pkgPath(approved.packageName) + "/-/" +
      encodeURIComponent(resolved.filename);

    const metadataBeforeApproval = await req(pkgPath(approved.packageName), {
      headers: auth(adminToken)
    });
    check("6  ACCEPT 전 Metadata 조회 200",
      metadataBeforeApproval.status === 200,
      "status " + metadataBeforeApproval.status);

    // 이 Script 가 승인 등록하지 않는 Version 이라 반복 실행해도 결과가 같다.
    const probe = resolved.probe;
    const probeTarballPath = pkgPath(approved.packageName) + "/-/" +
      encodeURIComponent(probe.filename);

    const versionBeforeApproval = await req(
      pkgPath(approved.packageName) + "/" + encodeURIComponent(probe.version),
      { headers: auth(adminToken) }
    );
    const tarballBeforeApproval = await req(probeTarballPath, {
      headers: auth(adminToken)
    });
    const guard = readGuardEnabled();
    if (guard.error) {
      // 기대값을 정할 수 없으면 이 검사는 통과도 실패도 아니다.
      prereq = "Registry Guard 설정을 확인할 수 없습니다.\n  " + guard.error;
      return;
    }
    const expectedGuardStatus = guard.value ? 403 : 200;
    check("7  Registry Guard 설정 동작",
      versionBeforeApproval.status === expectedGuardStatus &&
        tarballBeforeApproval.status === expectedGuardStatus,
      "config guard_enabled " + guard.value + ", 미승인 " + probe.version +
        " status " + versionBeforeApproval.status + "/" +
        tarballBeforeApproval.status);

    const approval = await registerAcceptList(
      "smoke-approval-" + RUN_STAMP,
      [approved]
    );
    const registered = approval.status === 200 && approval.json &&
      approval.json.status === "REGISTERED" && approval.json.packageCount === 1;
    check("8  ACCEPT 목록 등록 200 REGISTERED",
      registered,
      "status " + approval.status +
        (approval.json ? ", status " + approval.json.status +
          ", packageCount " + approval.json.packageCount : ""));

    const cached = await cacheFilesExist(approved.packageName, resolved.filename);
    check("8  Metadata/Tarball Cache 저장",
      registered && !cached.error && cached.metadata && cached.tarball,
      cached.error ||
        ("metadata " + cached.metadata + ", tarball " + cached.tarball +
          (cached.where === "s3" ? " (S3)" : "")));

    const unauth = await req(pkgPath(approved.packageName));
    check("9  ACCEPT Package 미인증 조회 401",
      unauth.status === 401,
      "status " + unauth.status);

    // package-lock.json 경로처럼 Metadata 요청 없이 Tarball이 먼저 와도
    // ACCEPT 목록만으로 독립적으로 검사하고 제공해야 한다.
    const first = await fetch(internalTarball, { headers: auth(adminToken) });
    const firstBody = Buffer.from(await first.arrayBuffer());
    const sri = pickSri(approved.integrity);
    const firstHashOk = sri !== null &&
      crypto.createHash(sri.algorithm).update(firstBody).digest("base64") === sri.digest;
    check("10 ACCEPT Tarball 직접 요청과 무결성 일치",
      first.status === 200 && firstHashOk,
      "status " + first.status +
        (sri ? ", " + sri.algorithm + (firstHashOk ? " 일치" : " 불일치")
          : ", 지원하지 않는 integrity 형식"));

    const meta = await req(pkgPath(approved.packageName), { headers: auth(adminToken) });
    const versions = meta.json && meta.json.versions ? Object.keys(meta.json.versions) : [];
    const versionMetadata = meta.json && meta.json.versions
      ? meta.json.versions[approved.version]
      : null;
    const dist = versionMetadata ? versionMetadata.dist || {} : {};
    const expectedStart = PUBLIC_URL + URL_PREFIX + approved.packageName + "/-/";
    const metadataOk = meta.status === 200 &&
      versions.includes(approved.version) &&
      dist.integrity === approved.integrity &&
      typeof dist.tarball === "string" && dist.tarball.indexOf(expectedStart) === 0;
    check("11 ACCEPT Metadata Version/integrity 보존",
      metadataOk,
      "status " + meta.status + ", versions " + (versions.join(", ") || "없음"));

    const second = await fetch(internalTarball, { headers: auth(adminToken) });
    const secondBody = Buffer.from(await second.arrayBuffer());
    check("12 같은 Tarball 재요청 시 동일 바이트",
      first.status === 200 && second.status === 200 && firstBody.equals(secondBody),
      "status " + first.status + " -> " + second.status);
  }

  console.log("");
  console.log("[내부 Package]");

  // 검사용 Package 는 실행마다 다른 이름을 쓰고, 끝에 unpublish 로 지운다.
  // 이름이 같으면 두 번째 실행에서 이미 있는 Package 를 다시 올리게 된다.
  const internalName = "@whs/smoke-" + RUN_STAMP;
  const internalVersion = "1.0.0";
  const internalBytes = crypto.randomBytes(256);
  const internalIntegrity = "sha512-" +
    crypto.createHash("sha512").update(internalBytes).digest("base64");
  const internalShasum = crypto.createHash("sha1").update(internalBytes).digest("hex");

  // npm publish 가 보내는 형태와 같다. Tarball 은 _attachments 에 base64 로 담는다.
  function publishBody(name, version) {
    const short = name.indexOf("/") === -1 ? name : name.slice(name.indexOf("/") + 1);
    const filename = short + "-" + version + ".tgz";
    const versionMetadata = {
      name: name,
      version: version,
      description: "verdaccio smoke test",
      dist: {
        shasum: internalShasum,
        integrity: internalIntegrity,
        tarball: BASE + "/" + name + "/-/" + filename
      }
    };
    const attachments = {};
    attachments[filename] = {
      content_type: "application/octet-stream",
      data: internalBytes.toString("base64"),
      length: internalBytes.length
    };
    const versions = {};
    versions[version] = versionMetadata;
    return {
      filename: filename,
      body: {
        _id: name,
        name: name,
        description: "verdaccio smoke test",
        "dist-tags": { latest: version },
        versions: versions,
        readme: "",
        _attachments: attachments
      }
    };
  }

  async function publish(name, version, token) {
    const prepared = publishBody(name, version);
    const headers = { "content-type": "application/json" };
    if (token) { headers.authorization = "Bearer " + token; }
    const result = await req(pkgPath(name), {
      method: "PUT",
      headers: headers,
      body: JSON.stringify(prepared.body)
    });
    result.filename = prepared.filename;
    return result;
  }

  // Unpublish 는 DELETE /{package}/-rev/{rev} 이다. DELETE /{package} 는 Verdaccio 에
  // 없는 경로라 404 가 난다(실측).
  async function unpublish(name, token) {
    const meta = await req(pkgPath(name), { headers: auth(token) });
    const rev = meta.json && meta.json._rev ? meta.json._rev : "1-0000000000000000";
    return req(pkgPath(name) + "/-rev/" + encodeURIComponent(rev), {
      method: "DELETE",
      headers: auth(token)
    });
  }

  const unauthenticatedPublish = await publish(internalName, internalVersion, null);
  check("13 내부 Package 미인증 publish 401",
    unauthenticatedPublish.status === 401,
    "status " + unauthenticatedPublish.status);

  const adminPublish = await publish(internalName, internalVersion, adminToken);
  check("14 admin 내부 Package publish 201",
    adminPublish.status === 201,
    "status " + adminPublish.status);

  // 외부 Package 이름으로는 admin 도 올릴 수 없어야 한다. 같은 이름으로 로컬에 올려
  // npmjs Package 를 가리는 것을 막기 위함이다(config 의 publish: no-publish).
  // 실제 npmjs Package 이름을 쓰면 규칙이 깨졌을 때 그 Package 를 덮어쓰게 되므로,
  // 외부 규칙에 걸리는 새 이름을 쓴다.
  const externalName = "smoke-external-" + RUN_STAMP;
  const externalPublish = await publish(externalName, internalVersion, adminToken);
  check("15 외부 이름 publish 차단 403",
    externalPublish.status === 403,
    "status " + externalPublish.status);

  // @whs/* 에는 proxy 가 없다. 없는 내부 Package 는 npmjs 에 묻지 않고 404 여야 한다.
  // 내부 Package 이름이 외부로 새면 공격자가 그 이름을 npmjs 에 선점할 수 있다.
  const missingInternal = await req(pkgPath("@whs/smoke-missing-" + RUN_STAMP), {
    headers: auth(adminToken)
  });
  check("16 없는 내부 Package 404 (npmjs 로 조회하지 않음)",
    missingInternal.status === 404,
    "status " + missingInternal.status);

  // Guard 는 내부 Package 의 Tarball 도 승인 목록 기준으로 막는다. 내부 Package 도
  // 의존성으로 외부 Package 를 끌어오므로 예외 없이 Gateway 판정을 거치게 하는
  // 정책이다. Gateway 가 ACCEPT 를 등록한 뒤에야 받을 수 있다.
  // 여기서는 등록하고 받아 바이트를 대조한다.
  const internalApproval = await registerAcceptList("smoke-internal-" + RUN_STAMP, [{
    packageName: internalName,
    version: internalVersion,
    integrity: internalIntegrity
  }]);
  const internalTarballPath = pkgPath(internalName) + "/-/" +
    encodeURIComponent(adminPublish.filename);
  const internalFetch = await fetch(internalTarballPath, { headers: auth(adminToken) });
  const internalFetched = internalFetch.status === 200
    ? Buffer.from(await internalFetch.arrayBuffer())
    : Buffer.alloc(0);
  check("17 ACCEPT 후 내부 Tarball 조회와 바이트 일치",
    internalApproval.status === 200 && internalFetch.status === 200 &&
      internalFetched.equals(internalBytes),
    "approval status " + internalApproval.status +
      ", tarball status " + internalFetch.status);

  // whs-ci 검사는 비밀번호를 준 경우에만 한다. smoke.sh 는 admin 하나로 돌아간다.
  const ciUser = "whs-ci";
  const ciPassword = process.env.CI_PW || "";
  let ciToken = null;
  if (ciPassword) {
    const ciLogin = await login(ciUser, ciPassword);
    ciToken = ciLogin.json && ciLogin.json.token;
    if (!ciToken) {
      bad("18a whs-ci 내부 Package publish 201", "whs-ci 로그인 실패 status " + ciLogin.status);
      bad("18b whs-ci unpublish 차단 403", "whs-ci 로그인 실패");
    }
  }

  const ciPackageName = "@whs/smoke-ci-" + RUN_STAMP;
  if (ciToken) {
    const ciPublish = await publish(ciPackageName, internalVersion, ciToken);
    check("18a whs-ci 내부 Package publish 201",
      ciPublish.status === 201,
      "status " + ciPublish.status);

    const ciUnpublish = await unpublish(internalName, ciToken);
    check("18b whs-ci unpublish 차단 403",
      ciUnpublish.status === 403,
      "status " + ciUnpublish.status);
  }

  const adminUnpublish = await unpublish(internalName, adminToken);
  const afterUnpublish = await req(pkgPath(internalName), { headers: auth(adminToken) });
  check("19 admin unpublish 201 과 이후 조회 404",
    adminUnpublish.status === 201 && afterUnpublish.status === 404,
    "unpublish status " + adminUnpublish.status +
      ", 이후 조회 status " + afterUnpublish.status);

  // 검사용 Package 를 남기지 않는다. 위에서 지워졌으면 아무 일도 하지 않는다.
  for (const name of [internalName, ciPackageName, externalName]) {
    const remaining = await req(pkgPath(name), { headers: auth(adminToken) });
    if (remaining.status === 200) {
      const removed = await unpublish(name, adminToken);
      if (removed.status !== 201) {
        bad("정리: " + name + " 를 지우지 못했습니다", "status " + removed.status);
      }
    }
  }
}

run().then(function () {
  console.log("");
  if (prereq) {
    console.error(prereq);
    process.exit(2);
  }
  console.log("통과 " + pass + " / 실패 " + fail);
  process.exit(fail > 0 ? 1 : 0);
}).catch(function (err) {
  console.error("");
  console.error("검사 도중 오류가 발생했습니다: " + err.message);
  process.exit(1);
});
'
