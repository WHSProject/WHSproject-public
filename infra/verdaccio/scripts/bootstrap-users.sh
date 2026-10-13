#!/usr/bin/env sh
# Verdaccio 초기 계정 생성 스크립트
#
# config.yaml 의 auth.htpasswd.max_users 가 -1 이면 가입이 막혀 있어
# 계정을 만들 수 없다. 이 스크립트는 max_users 제한을 우회하지 않고,
# htpasswd 파일을 직접 생성해 볼륨에 넣는 방식으로 동작한다.
# 기존 계정이 있으면 덮어쓰지 않고 실패한다. 이후 계정 관리는
# manage-users.sh 를 사용한다.
#
# 사용법:
#   VERDACCIO_ADMIN_PASSWORD=... VERDACCIO_CI_PASSWORD=... \
#     VERDACCIO_READER_PASSWORD=... \
#     sh infra/verdaccio/scripts/bootstrap-users.sh
#
# 비밀번호는 인자로 받지 않는다(셸 히스토리에 남으므로).
# 생성된 htpasswd 는 Docker 볼륨 안에만 존재하며 repo에 커밋하지 않는다.

set -eu

VOLUME="${VERDACCIO_VOLUME:-whsproject_verdaccio_storage}"
IMAGE="${VERDACCIO_IMAGE:-verdaccio/verdaccio:6.10.0}"
ROUNDS="${VERDACCIO_BCRYPT_ROUNDS:-10}"

: "${VERDACCIO_ADMIN_PASSWORD:?VERDACCIO_ADMIN_PASSWORD 를 환경변수로 지정하세요}"
: "${VERDACCIO_CI_PASSWORD:?VERDACCIO_CI_PASSWORD 를 환경변수로 지정하세요}"
: "${VERDACCIO_READER_PASSWORD:?VERDACCIO_READER_PASSWORD 를 환경변수로 지정하세요}"

echo "htpasswd 생성 중 (volume: ${VOLUME}, bcrypt rounds: ${ROUNDS})"

# 비밀번호를 -e NAME=VALUE 로 넘기면 평문이 docker 클라이언트의 인자 목록에
# 들어가 같은 호스트의 다른 사용자에게 ps 로 노출된다. 이름만 넘기고 값은
# 환경에서 상속시킨다.
ADMIN_PW="${VERDACCIO_ADMIN_PASSWORD}" \
CI_PW="${VERDACCIO_CI_PASSWORD}" \
READER_PW="${VERDACCIO_READER_PASSWORD}" \
ROUNDS="${ROUNDS}" \
docker run --rm \
  -v "${VOLUME}:/verdaccio/storage" \
  -e ADMIN_PW -e CI_PW -e READER_PW -e ROUNDS \
  --entrypoint node \
  "${IMAGE}" -e '
const fs = require("fs");
const bcrypt = require("/usr/local/lib/node_modules/verdaccio/node_modules/bcryptjs");
const rounds = parseInt(process.env.ROUNDS, 10);
const file = "/verdaccio/storage/htpasswd";

if (fs.existsSync(file) && fs.readFileSync(file, "utf8").trim() !== "") {
  console.error("기존 htpasswd가 있어 초기화를 중단합니다.");
  console.error("계정 추가·변경은 manage-users.sh를 사용하세요.");
  process.exit(1);
}

const users = {
  admin: process.env.ADMIN_PW,
  "whs-ci": process.env.CI_PW,
  "gateway-reader": process.env.READER_PW,
};
const lines = Object.entries(users).map(
  ([u, p]) => u + ":" + bcrypt.hashSync(p, rounds)
);
fs.writeFileSync(file, lines.join("\n") + "\n", { mode: 0o644 });
console.log("생성된 계정: " + Object.keys(users).join(", "));
'

echo "완료. Verdaccio 를 재시작하면 적용됩니다."
echo "주의: 이 htpasswd 는 /verdaccio/storage 볼륨 안에 있으므로"
echo "      저장소 전체 백업에 비밀번호 해시가 포함됩니다."
