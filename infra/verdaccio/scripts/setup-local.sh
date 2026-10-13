#!/usr/bin/env sh
# macOS / Linux / Git Bash용 Verdaccio 최초 계정 설정
#
# 실행 중인 whs-verdaccio 컨테이너의 실제 Storage Volume을 찾아 admin 계정을
# 생성한다. 기존 계정이 있으면 아무것도 덮어쓰지 않는다.

set -eu

CONTAINER="${VERDACCIO_CONTAINER:-whs-verdaccio}"
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ECHO_DISABLED=0

restore_terminal() {
  if [ "$ECHO_DISABLED" -eq 1 ]; then
    stty echo 2>/dev/null || true
    ECHO_DISABLED=0
  fi
}

clear_passwords() {
  unset SECRET_VALUE FIRST_PASSWORD PASSWORD_VALUE \
    ADMIN_PASSWORD 2>/dev/null || true
}

cleanup() {
  restore_terminal
  clear_passwords
}

trap 'cleanup' EXIT
trap 'cleanup; exit 130' HUP INT TERM

read_secret() {
  printf "%s" "$1"

  if [ -t 0 ]; then
    ECHO_DISABLED=1
    stty -echo
    if ! IFS= read -r SECRET_VALUE; then
      restore_terminal
      printf "\n"
      echo "[취소] 비밀번호 입력이 완료되기 전에 입력이 종료되었습니다." >&2
      return 1
    fi
    restore_terminal
    printf "\n"
  else
    if ! IFS= read -r SECRET_VALUE; then
      echo "[취소] 비밀번호 입력이 완료되기 전에 입력이 종료되었습니다." >&2
      return 1
    fi
  fi
}

read_password_pair() {
  ACCOUNT_NAME="$1"

  while true; do
    if ! read_secret "${ACCOUNT_NAME} 비밀번호: "; then
      return 1
    fi
    FIRST_PASSWORD="$SECRET_VALUE"

    if [ -z "$FIRST_PASSWORD" ]; then
      echo "[실패] 비밀번호는 비워둘 수 없습니다. 다시 입력하세요." >&2
      continue
    fi

    if ! read_secret "${ACCOUNT_NAME} 비밀번호 확인: "; then
      return 1
    fi

    if [ "$FIRST_PASSWORD" != "$SECRET_VALUE" ]; then
      echo "[실패] 입력한 비밀번호가 일치하지 않습니다. 다시 입력하세요." >&2
      continue
    fi

    PASSWORD_VALUE="$FIRST_PASSWORD"
    return 0
  done
}

echo
echo "WHSProject Verdaccio 최초 계정 설정"
echo "===================================="
echo "이 작업은 Docker 저장 볼륨마다 한 번만 실행합니다."
echo "입력한 평문 비밀번호는 화면이나 파일에 저장하지 않습니다."
echo

if ! command -v docker >/dev/null 2>&1; then
  echo "[실패] Docker 명령을 찾을 수 없습니다. Docker Desktop을 설치하세요." >&2
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "[실패] Docker에 연결할 수 없습니다. Docker Desktop을 실행하세요." >&2
  exit 1
fi

if ! docker inspect "$CONTAINER" >/dev/null 2>&1; then
  echo "[실패] '${CONTAINER}' 컨테이너가 없습니다." >&2
  echo "먼저 docker compose up -d를 실행하세요." >&2
  exit 1
fi

RUNNING=$(docker inspect --format '{{.State.Running}}' "$CONTAINER")
if [ "$RUNNING" != "true" ]; then
  echo "[실패] '${CONTAINER}' 컨테이너가 실행 중이 아닙니다." >&2
  echo "먼저 docker compose up -d를 실행하세요." >&2
  exit 1
fi

VOLUME=$(docker inspect --format \
  '{{range .Mounts}}{{if eq .Destination "/verdaccio/storage"}}{{if eq .Type "volume"}}{{.Name}}{{end}}{{end}}{{end}}' \
  "$CONTAINER")

if [ -z "$VOLUME" ]; then
  echo "[실패] '${CONTAINER}'의 /verdaccio/storage Docker 볼륨을 찾을 수 없습니다." >&2
  exit 1
fi

USERS=$(docker exec "$CONTAINER" node -e '
const fs = require("fs");
const file = "/verdaccio/storage/htpasswd";
if (!fs.existsSync(file)) process.exit(0);
const users = fs.readFileSync(file, "utf8")
  .split(/\r?\n/)
  .filter(line => line.trim() !== "")
  .map(line => line.split(":")[0]);
process.stdout.write(users.join(","));
')

if [ -n "$USERS" ]; then
  case ",${USERS}," in
    *,admin,*) MISSING_USERS="" ;;
    *) MISSING_USERS="admin" ;;
  esac

  if [ -n "$MISSING_USERS" ]; then
    echo "[확인 필요] 계정 파일은 있지만 필수 계정이 일부 누락되었습니다." >&2
    echo "현재 계정: ${USERS}" >&2
    echo "누락 계정: ${MISSING_USERS}" >&2
    echo "기존 계정을 보호하기 위해 자동으로 덮어쓰지 않았습니다." >&2
    echo "다음 명령으로 누락 계정을 추가하세요:" >&2
    echo "VERDACCIO_VOLUME=${VOLUME} sh ${SCRIPT_DIR}/manage-users.sh" >&2
    exit 1
  fi

  echo "[완료] 이 Docker 볼륨은 이미 초기화되어 있습니다."
  echo "현재 계정: ${USERS}"
  echo "기존 계정을 덮어쓰지 않았습니다."
  echo
  echo "로그인:"
  echo "npm login --auth-type=legacy --registry=http://localhost:3000/npm/"
  echo
  echo "로그인 및 Metadata 조회 확인:"
  echo "npm view is-odd version --registry=http://localhost:3000/npm/"
  exit 0
fi

echo "생성할 계정:"
echo "  admin  - 내부 패키지 배포 및 삭제"
echo
echo "비밀번호를 두 번 입력하세요. 입력 내용은 화면에 표시되지 않습니다."

read_password_pair "admin"
ADMIN_PASSWORD="$PASSWORD_VALUE"
unset PASSWORD_VALUE FIRST_PASSWORD SECRET_VALUE 2>/dev/null || true

echo
echo "계정을 생성하는 중입니다..."
VERDACCIO_VOLUME="$VOLUME" \
VERDACCIO_USER_PASSWORD="$ADMIN_PASSWORD" \
  sh "${SCRIPT_DIR}/manage-users.sh" add admin

clear_passwords

echo "Verdaccio를 재시작하는 중입니다..."
docker restart "$CONTAINER" >/dev/null

echo
echo "[완료] admin 계정을 생성했습니다."
echo "이 PC에서는 Docker 볼륨을 삭제하지 않는 한 다시 초기화할 필요가 없습니다."
echo
echo "다음 명령으로 로그인하세요:"
echo "npm login --auth-type=legacy --registry=http://localhost:3000/npm/"
echo
echo "로그인 및 Metadata 조회 확인:"
echo "npm view is-odd version --registry=http://localhost:3000/npm/"
