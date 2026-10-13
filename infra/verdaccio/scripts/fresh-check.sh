#!/usr/bin/env sh
# Verdaccio 새 환경 검증
#
# 아무것도 없는 상태에서 Verdaccio 가 처음부터 정상 동작하는지 한 번에 확인한다.
# 새 PC 나 새 조직에 설치했을 때를 재현하기 위해, 빈 볼륨으로 Verdaccio 를 따로
# 띄워 계정 생성 → 기동 → smoke.sh → 무결성 검사 권한 확인까지 돌린 뒤 정리한다.
#
# 기존 whs-verdaccio 컨테이너와 whsproject_verdaccio_storage 볼륨은 읽지도
# 바꾸지도 않는다. 이미 쓰던 환경에서는 계정·캐시·설정이 남아 있어, 새로 설치할
# 때만 드러나는 문제가 가려진다.
#
# 사용법:
#   sh infra/verdaccio/scripts/fresh-check.sh
#
# 필요한 것: Docker, npmjs 에 닿는 인터넷(smoke.sh 검사 8·10 이 실제로 받아온다).
# 비밀번호와 서비스 Token 은 실행할 때마다 새로 만들고 화면·명령 인자에 남기지
# 않는다. 성공·실패·중단 어느 경우에도 만든 컨테이너·볼륨·Network 를 지운다.
#
# 환경변수:
#   VERDACCIO_IMAGE        기본 verdaccio/verdaccio:6.10.0
#   VERDACCIO_PUBLIC_URL   기본 http://localhost:3000
#
# 결과는 마지막 줄의 합계와 exit code 로 알린다. 하나라도 실패하면 1 이다.

set -eu

IMAGE="${VERDACCIO_IMAGE:-verdaccio/verdaccio:6.10.0}"
PUBLIC_URL="${VERDACCIO_PUBLIC_URL:-http://localhost:3000}"

# PowerShell 에서 Git 의 sh.exe 만 직접 부르면 PATH 에 dirname, date, sleep, sed 가
# 없다. 셸 내장 기능과 컨테이너 안의 node 만 쓴다(smoke.sh 와 같은 기준).
case "$0" in
  */*) SCRIPT_DIR="${0%/*}" ;;
  *) SCRIPT_DIR="." ;;
esac
SCRIPT_DIR=$(cd "$SCRIPT_DIR" && pwd)
VERDACCIO_DIR=$(cd "$SCRIPT_DIR/.." && pwd)

# Docker Desktop 에 Host 경로를 넘길 때 Git Bash 의 /c/... 표기가 아니라
# C:/... 표기가 필요하다. pwd -W 가 없는 셸(Linux)에서는 그대로 쓴다.
HOST_VERDACCIO_DIR=$(cd "$VERDACCIO_DIR" && { pwd -W 2>/dev/null || pwd; })

# 기존 환경과 겹치지 않도록 실행마다 다른 이름을 쓴다.
RUN_ID="whs-fresh-$$"
CONTAINER="${RUN_ID}-verdaccio"
VOLUME="${RUN_ID}-storage"
NETWORK="${RUN_ID}-net"

PASSED=0
FAILED=0
CREATED_CONTAINER=0
CREATED_VOLUME=0
CREATED_NETWORK=0

pass() {
  PASSED=$((PASSED + 1))
  echo "  [통과] $1"
}

fail() {
  FAILED=$((FAILED + 1))
  echo "  [실패] $1"
}

# 실패를 알아보려면 Verdaccio 로그가 필요하다. 요청 Header 의 authorization 은
# Verdaccio 가 <Classified> 로 가려서 남긴다.
show_logs() {
  if [ "$CREATED_CONTAINER" -eq 1 ]; then
    echo ""
    echo "--- Verdaccio 로그 (마지막 30줄) ---"
    docker logs --tail 30 "$CONTAINER" 2>&1 || true
  fi
}

cleanup() {
  if [ "$CREATED_CONTAINER" -eq 1 ]; then
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  fi
  if [ "$CREATED_VOLUME" -eq 1 ]; then
    docker volume rm "$VOLUME" >/dev/null 2>&1 || true
  fi
  if [ "$CREATED_NETWORK" -eq 1 ]; then
    docker network rm "$NETWORK" >/dev/null 2>&1 || true
  fi
}

trap cleanup EXIT
trap 'cleanup; exit 130' HUP INT TERM

# 비밀번호와 Token 은 컨테이너 안의 node 로 만든다. Host 에 openssl 이나
# /dev/urandom 이 있다고 가정하지 않는다.
random_secret() {
  docker run --rm --entrypoint node "$IMAGE" \
    -e 'process.stdout.write(require("crypto").randomBytes(18).toString("hex"))'
}

echo "Verdaccio 새 환경 검증"
echo "  image     : ${IMAGE}"
echo "  container : ${CONTAINER}"
echo ""

echo "[1] 새 환경 만들기"
docker network create "$NETWORK" >/dev/null
CREATED_NETWORK=1
docker volume create "$VOLUME" >/dev/null
CREATED_VOLUME=1
ADMIN_PW=$(random_secret)
CI_PW=$(random_secret)
READER_PW=$(random_secret)
SERVICE_TOKEN=$(random_secret)
pass "빈 볼륨과 Network 생성"

echo ""
echo "[2] 계정 생성 (bootstrap-users.sh)"
if VERDACCIO_VOLUME="$VOLUME" \
  VERDACCIO_IMAGE="$IMAGE" \
  VERDACCIO_ADMIN_PASSWORD="$ADMIN_PW" \
  VERDACCIO_CI_PASSWORD="$CI_PW" \
  VERDACCIO_READER_PASSWORD="$READER_PW" \
  sh "$SCRIPT_DIR/bootstrap-users.sh" >/dev/null; then
  pass "admin, whs-ci, gateway-reader 계정 생성"
else
  fail "계정 생성"
  exit 1
fi

echo ""
echo "[3] Verdaccio 기동"
# compose.yaml 의 verdaccio 서비스와 같은 Mount 와 환경변수를 쓴다. Network 별칭을
# verdaccio 로 두어 smoke.sh 의 기본 주소(http://verdaccio:4873)가 그대로 맞게 한다.
# 서비스 Token 은 값이 아니라 이름만 넘긴다(ps 노출 방지).
MSYS_NO_PATHCONV=1 WHS_APPROVAL_SERVICE_TOKEN="$SERVICE_TOKEN" \
docker run -d \
  --name "$CONTAINER" \
  --network "$NETWORK" \
  --network-alias verdaccio \
  -e VERDACCIO_HANDLE_KILL_SIGNALS=true \
  -e VERDACCIO_PUBLIC_URL="$PUBLIC_URL" \
  -e WHS_APPROVAL_SERVICE_TOKEN \
  -v "$VOLUME:/verdaccio/storage" \
  -v "$HOST_VERDACCIO_DIR/config.local.yaml:/verdaccio/conf/config.yaml:ro" \
  -v "$HOST_VERDACCIO_DIR/plugins:/verdaccio/plugins:ro" \
  "$IMAGE" >/dev/null
CREATED_CONTAINER=1

# Host 에 sleep 이 없을 수 있어 컨테이너 안에서 기다린다.
if docker exec "$CONTAINER" node -e '
const deadline = Date.now() + 60000;
(async () => {
  while (Date.now() < deadline) {
    try {
      const response = await fetch("http://127.0.0.1:4873/-/ping");
      if (response.ok) process.exit(0);
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  process.exit(1);
})();' >/dev/null 2>&1; then
  pass "/-/ping 응답"
else
  fail "60초 안에 /-/ping 이 응답하지 않음"
  show_logs
  exit 1
fi

LOGS=$(docker logs "$CONTAINER" 2>&1 || true)
for plugin in verdaccio-whs-audit verdaccio-whs-approval verdaccio-whs-integrity; do
  case "$LOGS" in
    *"plugin ${plugin} successfully loaded"*) pass "${plugin} 로드" ;;
    *) fail "${plugin} 로드 로그 없음" ;;
  esac
done

echo ""
echo "[4] Smoke Test (smoke.sh)"
if VERDACCIO_CONTAINER="$CONTAINER" \
  VERDACCIO_NETWORK="$NETWORK" \
  VERDACCIO_IMAGE="$IMAGE" \
  VERDACCIO_ADMIN_PASSWORD="$ADMIN_PW" \
  VERDACCIO_CI_PASSWORD="$CI_PW" \
  sh "$SCRIPT_DIR/smoke.sh"; then
  pass "smoke.sh"
else
  fail "smoke.sh"
fi

echo ""
echo "[5] 무결성 검사 API 권한"
# 로그인 안 함 401, whs-ci 403, admin 200 을 확인한다. 검사 결과 자체는 보지 않는다.
# 비밀번호는 이름만 넘긴다.
CHECK_STATUS=0
CHECK_OUTPUT=$(MSYS_NO_PATHCONV=1 ADMIN_PW="$ADMIN_PW" CI_PW="$CI_PW" \
docker run --rm \
  --network "$NETWORK" \
  -e ADMIN_PW -e CI_PW \
  --entrypoint node \
  "$IMAGE" -e '
const BASE = "http://verdaccio:4873";
const CHECK = BASE + "/-/whs/integrity/checks";

async function login(user, password) {
  const basic = Buffer.from(user + ":" + password).toString("base64");
  const response = await fetch(BASE + "/-/user/org.couchdb.user:" + user, {
    method: "PUT",
    headers: { "content-type": "application/json", authorization: "Basic " + basic },
    body: JSON.stringify({ name: user, password }),
  });
  const body = await response.json().catch(() => ({}));
  return body.token;
}

async function check(token) {
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = "Bearer " + token;
  const response = await fetch(CHECK, {
    method: "POST",
    headers,
    body: JSON.stringify({ packages: [{ packageName: "is-odd", version: "0.0.0-fresh-check" }] }),
  });
  return response.status;
}

(async () => {
  const adminToken = await login("admin", process.env.ADMIN_PW);
  const ciToken = await login("whs-ci", process.env.CI_PW);
  const lines = [
    ["로그인 안 함 401", await check(undefined), 401],
    ["whs-ci 403", ciToken ? await check(ciToken) : "login failed", 403],
    ["admin 200", adminToken ? await check(adminToken) : "login failed", 200],
  ];
  for (const [label, actual, expected] of lines) {
    console.log((actual === expected ? "PASS " : "FAIL ") + label + " (status " + actual + ")");
  }
})().catch((error) => {
  console.log("FAIL 무결성 검사 권한 확인 중 오류: " + error.message);
  process.exit(1);
});' 2>&1) || CHECK_STATUS=$?

# 출력 한 줄이 한 결과다. 셸 내장 기능만으로 나눈다.
CHECK_RESULTS=0
while IFS= read -r line; do
  case "$line" in
    "PASS "*) pass "${line#PASS }"; CHECK_RESULTS=$((CHECK_RESULTS + 1)) ;;
    "FAIL "*) fail "${line#FAIL }"; CHECK_RESULTS=$((CHECK_RESULTS + 1)) ;;
  esac
done <<EOF
$CHECK_OUTPUT
EOF

# 결과를 세기만 하면, 확인용 컨테이너가 뜨지 못하거나 결과를 내기 전에 끝났을 때
# 아무것도 세지 않고 전체가 통과로 끝난다. 실행 결과와 결과 개수를 따로 본다.
# 출력에는 비밀번호가 없다(이름으로만 넘겼다).
if [ "$CHECK_STATUS" -ne 0 ] || [ "$CHECK_RESULTS" -ne 3 ]; then
  fail "권한 확인이 끝까지 실행되지 않음 (exit ${CHECK_STATUS}, 결과 ${CHECK_RESULTS}/3)"
  while IFS= read -r line; do
    echo "         ${line}"
  done <<EOF
$CHECK_OUTPUT
EOF
fi

echo ""
echo "[6] 내부 Package 이름 Uplink 유출 확인"
# @whs/* 에는 proxy 가 없다. 없는 내부 Package 를 조회해도 npmjs 로 이름이 나가면
# 안 된다. 나가면 공격자가 그 이름을 npmjs 에 선점해 악성 Package 를 올릴 수 있다.
#
# "로그에 안 보인다" 만으로는 약하다. 로그가 아예 안 남는 상황도 같은 결과가 되기
# 때문이다. 그래서 없는 외부 이름도 함께 조회해, 그쪽은 나가는 것까지 확인한다.
LEAK_STAMP="leak-probe-$$"
LEAK_STATUS=$(MSYS_NO_PATHCONV=1 ADMIN_PW="$ADMIN_PW" LEAK_STAMP="$LEAK_STAMP" \
docker exec -e ADMIN_PW -e LEAK_STAMP "$CONTAINER" node -e '
const BASE = "http://127.0.0.1:4873";
(async () => {
  const basic = Buffer.from("admin:" + process.env.ADMIN_PW).toString("base64");
  const login = await fetch(BASE + "/-/user/org.couchdb.user:admin", {
    method: "PUT",
    headers: { "content-type": "application/json", authorization: "Basic " + basic },
    body: JSON.stringify({ name: "admin", password: process.env.ADMIN_PW }),
  });
  const token = (await login.json()).token;
  const names = ["@whs/" + process.env.LEAK_STAMP, process.env.LEAK_STAMP];
  const codes = [];
  for (const name of names) {
    const response = await fetch(BASE + "/" + encodeURIComponent(name), {
      headers: { authorization: "Bearer " + token },
    });
    codes.push(response.status);
  }
  console.log(codes.join(" "));
})().catch((error) => {
  console.log("error " + error.message);
  process.exit(1);
});' 2>&1) || LEAK_STATUS="error"

case "$LEAK_STATUS" in
  "404 404") pass "없는 내부·외부 Package 조회 404" ;;
  *) fail "조회 상태가 예상과 다름 (${LEAK_STATUS})" ;;
esac

LEAK_LOGS=$(docker logs "$CONTAINER" 2>&1 || true)
case "$LEAK_LOGS" in
  *"registry.npmjs.org/@whs"*|*"registry.npmjs.org/%40whs"*)
    fail "내부 Package 이름이 npmjs 로 나갔습니다" ;;
  *) pass "내부 Package 이름이 npmjs 로 나가지 않음" ;;
esac

# 외부 이름은 나가야 한다. 안 나갔다면 위 결과를 믿을 수 없다.
case "$LEAK_LOGS" in
  *"registry.npmjs.org/${LEAK_STAMP}"*)
    pass "외부 Package 이름은 npmjs 로 조회됨 (비교 기준)" ;;
  *)
    fail "외부 이름도 npmjs 로 나가지 않아, 유출 확인을 신뢰할 수 없습니다" ;;
esac

echo ""
if [ "$FAILED" -gt 0 ]; then
  show_logs
fi

echo ""
echo "새 환경 검증 통과 ${PASSED} / 실패 ${FAILED}"

if [ "$FAILED" -gt 0 ]; then
  exit 1
fi
