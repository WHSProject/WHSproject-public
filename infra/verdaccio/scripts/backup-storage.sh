#!/usr/bin/env sh
# Verdaccio Storage Volume 백업
#
# 실행 중인 Verdaccio 의 Docker Volume 을 찾아 tar 로 내려받는다. Volume 이름을 손으로
# 확인할 필요가 없다.
#
# 사용법:
#   sh infra/verdaccio/scripts/backup-storage.sh [저장할 폴더]
#
# 저장할 폴더를 생략하면 현재 폴더에 만든다.
#
# 무엇이 들어가나:
#   로컬 저장소 구성  Package Metadata·Tarball, htpasswd, .verdaccio-db.json 전부
#   S3 저장소 구성    htpasswd 만 (Package 와 목록·서명 secret 은 버킷에 있다)
#
# S3 구성에서는 버킷을 따로 챙긴다. 버킷 버전 관리를 켜 두면 이 Script 와 달리 덮어쓰기와
# 삭제가 실시간으로 보관되므로, 버킷용 백업 명령은 따로 돌리지 않아도 된다(README 백업 절).
#
# 백업 파일에는 비밀번호 해시와 토큰 서명 secret 이 들어 있다. 저장 위치와 접근 권한을
# 제한한다.
#
# 환경변수:
#   VERDACCIO_CONTAINER   기본 whs-verdaccio
#
# 종료 코드:
#   0  백업 생성
#   1  실패 (컨테이너·Volume 없음, tar 실패 등)

set -eu

CONTAINER="${VERDACCIO_CONTAINER:-whs-verdaccio}"
OUT_DIR="${1:-.}"

if [ "$#" -gt 1 ]; then
  echo "Usage: sh infra/verdaccio/scripts/backup-storage.sh [저장할 폴더]" >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "[실패] Docker 명령을 찾을 수 없습니다. Docker Desktop 을 설치하세요." >&2
  exit 1
fi

if ! docker inspect "$CONTAINER" >/dev/null 2>&1; then
  echo "[실패] '${CONTAINER}' 컨테이너가 없습니다." >&2
  echo "먼저 docker compose up -d verdaccio 를 실행하세요." >&2
  exit 1
fi

VOLUME=$(docker inspect --format \
  '{{range .Mounts}}{{if eq .Destination "/verdaccio/storage"}}{{if eq .Type "volume"}}{{.Name}}{{end}}{{end}}{{end}}' \
  "$CONTAINER")
if [ -z "$VOLUME" ]; then
  echo "[실패] '${CONTAINER}' 의 /verdaccio/storage Docker 볼륨을 찾을 수 없습니다." >&2
  exit 1
fi

IMAGE=$(docker inspect --format '{{.Config.Image}}' "$CONTAINER")

if [ ! -d "$OUT_DIR" ]; then
  echo "[실패] 폴더가 없습니다: ${OUT_DIR}" >&2
  exit 1
fi

# Docker Desktop 에 넘길 Host 경로는 Git Bash 의 /c/... 표기가 아니라 C:/... 표기가
# 필요하다. pwd -W 가 없는 셸(Linux)에서는 그대로 쓴다.
HOST_OUT_DIR=$(cd "$OUT_DIR" && { pwd -W 2>/dev/null || pwd; })

# Host 에 date 가 없을 수 있어(PowerShell 에서 Git 의 sh.exe 만 직접 호출하는 경우)
# 컨테이너 안의 node 로 만든다. smoke.sh / fresh-check.sh 와 같은 기준이다.
STAMP=$(docker run --rm --entrypoint node "$IMAGE" -e '
const d = new Date();
const p = (n) => String(n).padStart(2, "0");
process.stdout.write(
  d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "-" + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds())
);')
FILE="verdaccio-storage-${STAMP}.tgz"

echo "Verdaccio Storage 백업"
echo "  container : ${CONTAINER}"
echo "  volume    : ${VOLUME}"
echo "  파일      : ${OUT_DIR}/${FILE}"
echo ""

# Volume 은 읽기 전용으로 붙인다. --user 0 은 Volume 안 파일 소유자와 무관하게 읽기 위함.
if ! MSYS_NO_PATHCONV=1 docker run --rm --user 0 \
  -v "${VOLUME}:/from:ro" \
  -v "${HOST_OUT_DIR}:/out" \
  --entrypoint sh "$IMAGE" \
  -c "tar czf /out/${FILE} -C /from ." ; then
  echo "[실패] 백업을 만들지 못했습니다." >&2
  exit 1
fi

# 만들어진 파일에 계정이 들어갔는지 확인한다. 빈 tar 를 성공으로 넘기지 않기 위함이다.
SUMMARY=$(MSYS_NO_PATHCONV=1 docker run --rm --user 0 \
  -v "${HOST_OUT_DIR}:/out:ro" \
  --entrypoint sh "$IMAGE" \
  -c "tar tzf /out/${FILE} | grep -c . ; tar tzf /out/${FILE} | grep -c '^./htpasswd$' || true")

ENTRIES=0
HAS_HTPASSWD=0
{ IFS= read -r ENTRIES; IFS= read -r HAS_HTPASSWD; } <<EOF
$SUMMARY
EOF

if [ "${ENTRIES:-0}" -le 1 ]; then
  echo "[실패] 백업 파일이 비어 있습니다. Volume 과 컨테이너를 확인하세요." >&2
  exit 1
fi

echo "  [통과] 항목 ${ENTRIES}개"
if [ "$HAS_HTPASSWD" = "1" ]; then
  echo "  [통과] 계정 파일(htpasswd) 포함"
else
  echo "  [주의] 계정 파일(htpasswd)이 없습니다. 아직 계정을 만들지 않았을 수 있습니다."
fi
echo ""
echo "백업 파일에는 비밀번호 해시와 토큰 서명 secret 이 들어 있습니다."
echo "저장 위치와 접근 권한을 제한하세요."
