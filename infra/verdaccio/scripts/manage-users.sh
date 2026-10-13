#!/usr/bin/env sh
# Verdaccio 계정 관리 스크립트
#
# bootstrap-users.sh 는 최초 1회 htpasswd 를 생성한다.
# 기존 계정이 있으면 덮어쓰지 않고 실패한다.
# 이후 계정 추가/삭제/비밀번호 변경은 이 스크립트로 한다. 기존 항목을 보존한다.
#
# 사용법:
#   sh manage-users.sh
#   sh manage-users.sh list
#   VERDACCIO_USER_PASSWORD=... sh manage-users.sh add <username>
#   VERDACCIO_USER_PASSWORD=... sh manage-users.sh passwd <username>
#   sh manage-users.sh del <username>
#
# 비밀번호는 인자로 받지 않는다(셸 히스토리에 남으므로).
#
# 반영 시점 (실측 확인):
#   add    - 즉시 반영. 재시작 불필요
#   passwd - 즉시 반영. 재시작 불필요
#   del    - 재시작해야 반영된다. 재시작 전까지 삭제된 계정으로 로그인이 계속 된다
#
# 주의: 계정을 삭제하고 재시작해도, 그 계정이 이미 발급받은 JWT 는
#       만료(7일)까지 계속 유효하다. 즉시 차단이 필요하면 README 의
#       "긴급 토큰 무효화" 절차를 따른다.

set -eu

VOLUME="${VERDACCIO_VOLUME:-whsproject_verdaccio_storage}"
IMAGE="${VERDACCIO_IMAGE:-verdaccio/verdaccio:6.10.0}"
ROUNDS="${VERDACCIO_BCRYPT_ROUNDS:-10}"

CMD="${1:-}"
USER_NAME="${2:-}"
ECHO_DISABLED=0

restore_terminal() {
  if [ "$ECHO_DISABLED" -eq 1 ]; then
    stty echo 2>/dev/null || true
    ECHO_DISABLED=0
  fi
}

trap 'restore_terminal' EXIT
trap 'restore_terminal; exit 130' HUP INT TERM

usage() {
  echo "usage: sh manage-users.sh [list|add|passwd|del] [username]" >&2
  exit 2
}

validate_username() {
  if [ -z "$1" ]; then
    echo "[실패] 사용자명을 입력하세요." >&2
    return 1
  fi

  case "$1" in
    *:*|*[[:space:]]*)
      echo "[실패] 사용자명에는 공백이나 ':'을 사용할 수 없습니다." >&2
      return 1
      ;;
  esac
}

run_command() {
  # 비밀번호를 -e NAME=VALUE 로 넘기면 평문이 docker 클라이언트의 인자 목록에
  # 들어가 같은 호스트의 다른 사용자에게 ps 로 노출된다. 이름만 넘기고 값은
  # 환경에서 상속시킨다.
  CMD="$1" UNAME="${2:-}" UPW="${3:-}" ROUNDS="$ROUNDS" \
  docker run --rm \
    -v "${VOLUME}:/verdaccio/storage" \
    -e CMD -e UNAME \
    -e UPW -e ROUNDS \
    --entrypoint node \
    "${IMAGE}" -e '
const fs = require("fs");
const bcrypt = require("/usr/local/lib/node_modules/verdaccio/node_modules/bcryptjs");
const FILE = "/verdaccio/storage/htpasswd";
const cmd = process.env.CMD, name = process.env.UNAME;

let lines = [];
if (fs.existsSync(FILE)) {
  lines = fs.readFileSync(FILE, "utf8").split("\n").filter(l => l.trim() !== "");
}
const idx = lines.findIndex(l => l.split(":")[0] === name);

if (cmd === "list") {
  if (!lines.length) { console.log("(계정 없음)"); }
  else lines.forEach(l => console.log("  " + l.split(":")[0]));
  process.exit(0);
}

if (cmd === "add" && idx !== -1) {
  console.error("이미 존재하는 계정입니다: " + name + "  (비밀번호 변경은 passwd 사용)");
  process.exit(1);
}
if ((cmd === "passwd" || cmd === "del") && idx === -1) {
  console.error("존재하지 않는 계정입니다: " + name);
  process.exit(1);
}

if (cmd === "del") {
  lines.splice(idx, 1);
} else {
  const entry = name + ":" + bcrypt.hashSync(process.env.UPW, parseInt(process.env.ROUNDS, 10));
  if (idx === -1) lines.push(entry); else lines[idx] = entry;
}

fs.writeFileSync(FILE, lines.join("\n") + "\n", { mode: 0o644 });
console.log(cmd + " 완료: " + name + "  (현재 계정 " + lines.length + "개)");
if (cmd === "del") {
  console.log("주의: Verdaccio 를 재시작해야 삭제가 반영됩니다.");
  console.log("      이미 발급된 JWT 는 재시작 후에도 만료까지 유효합니다.");
}
'
}

read_secret() {
  printf "%s" "$1"

  if [ -t 0 ]; then
    ECHO_DISABLED=1
    stty -echo
    if ! IFS= read -r SECRET_VALUE; then
      restore_terminal
      printf "\n"
      return 1
    fi
    restore_terminal
    printf "\n"
  else
    IFS= read -r SECRET_VALUE || return 1
  fi
}

clear_password_values() {
  unset SECRET_VALUE FIRST_PASSWORD PASSWORD_VALUE 2>/dev/null || true
}

read_password_pair() {
  clear_password_values
  if ! read_secret "비밀번호: "; then
    clear_password_values
    return 1
  fi
  FIRST_PASSWORD="$SECRET_VALUE"

  if [ -z "$FIRST_PASSWORD" ]; then
    echo "[실패] 비밀번호는 비워둘 수 없습니다." >&2
    clear_password_values
    return 1
  fi

  if ! read_secret "비밀번호 확인: "; then
    clear_password_values
    return 1
  fi
  if [ "$FIRST_PASSWORD" != "$SECRET_VALUE" ]; then
    echo "[실패] 입력한 비밀번호가 일치하지 않습니다." >&2
    clear_password_values
    return 1
  fi

  PASSWORD_VALUE="$FIRST_PASSWORD"
}

read_username() {
  printf "사용자명: "
  IFS= read -r INPUT_USERNAME || return 1
  validate_username "$INPUT_USERNAME"
}

interactive_menu() {
  while true; do
    echo
    echo "Verdaccio 사용자 관리"
    echo "1. 사용자 목록 조회"
    echo "2. 사용자 추가"
    echo "3. 비밀번호 변경"
    echo "4. 사용자 삭제"
    echo "0. 종료"
    printf "선택: "

    if ! IFS= read -r MENU_CHOICE; then
      echo
      return 0
    fi

    case "$MENU_CHOICE" in
      1)
        run_command list || echo "[실패] 사용자 목록 조회에 실패했습니다." >&2
        ;;
      2)
        if read_username && read_password_pair; then
          run_command add "$INPUT_USERNAME" "$PASSWORD_VALUE" || \
            echo "[실패] 사용자 추가에 실패했습니다." >&2
          clear_password_values
        fi
        ;;
      3)
        if read_username && read_password_pair; then
          run_command passwd "$INPUT_USERNAME" "$PASSWORD_VALUE" || \
            echo "[실패] 비밀번호 변경에 실패했습니다." >&2
          clear_password_values
        fi
        ;;
      4)
        if read_username; then
          printf "'%s' 사용자를 삭제하시겠습니까? [y/N]: " "$INPUT_USERNAME"
          if ! IFS= read -r DELETE_CONFIRM; then
            echo
            return 0
          fi
          case "$DELETE_CONFIRM" in
            y|Y|yes|YES|Yes)
              run_command del "$INPUT_USERNAME" || \
                echo "[실패] 사용자 삭제에 실패했습니다." >&2
              ;;
            *) echo "사용자 삭제를 취소했습니다." ;;
          esac
        fi
        ;;
      0)
        echo "사용자 관리를 종료합니다."
        return 0
        ;;
      *)
        echo "[실패] 0~4 중에서 선택하세요." >&2
        ;;
    esac
  done
}

if [ -z "$CMD" ]; then
  if [ -t 0 ]; then
    interactive_menu
    exit 0
  fi
  usage
fi

case "$CMD" in
  list) ;;
  add|passwd|del)
    [ -n "$USER_NAME" ] || usage
    validate_username "$USER_NAME" || exit 2
    ;;
  *) usage ;;
esac

case "$CMD" in
  add|passwd)
    : "${VERDACCIO_USER_PASSWORD:?VERDACCIO_USER_PASSWORD 를 환경변수로 지정하세요}"
    ;;
esac

run_command "$CMD" "$USER_NAME" "${VERDACCIO_USER_PASSWORD:-}"
