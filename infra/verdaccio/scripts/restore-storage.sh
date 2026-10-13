#!/usr/bin/env sh
# Verdaccio Storage Volume 복원
#
# backup-storage.sh 로 만든 tar 를 새 Docker Volume 에 푼다. 공식 Image 의 실행
# 사용자(UID 10001, GID 65533)에 맞춰 소유권도 바꾼다. 소유권을 맞추지 않으면
# Verdaccio 가 기동은 되지만 저장할 때 권한 오류가 난다(README 참고).
#
# 사용법:
#   sh infra/verdaccio/scripts/restore-storage.sh <백업파일> <새 Volume 이름>
#
# 예:
#   sh infra/verdaccio/scripts/restore-storage.sh ./backup/verdaccio-storage-20260912-043644.tgz whs-restored
#
# 쓰고 있는 Volume 을 덮어쓰지 않는다. 대상 Volume 이 비어 있지 않으면 멈춘다.
# 복원한 Volume 으로 기동하려면 compose 의 Volume 이름을 바꾸거나, 확인용으로
# 임시 컨테이너에 붙인다(README 「복원」 참고).
#
# S3 저장소 구성에서는 이 Volume 에 계정(htpasswd)만 있다. Package 와 목록·서명
# secret 은 버킷에 있으므로 버킷 쪽은 따로 다룬다.
#
# 종료 코드:
#   0  복원 완료
#   1  복원 실패
#   2  전제조건 미충족 (파일 없음, 대상 Volume 이 비어 있지 않음 등)

set -eu

ARCHIVE="${1:-}"
VOLUME="${2:-}"
IMAGE="${VERDACCIO_IMAGE:-verdaccio/verdaccio:6.10.0}"

if [ -z "$ARCHIVE" ] || [ -z "$VOLUME" ]; then
  echo "Usage: sh infra/verdaccio/scripts/restore-storage.sh <백업파일> <새 Volume 이름>" >&2
  exit 2
fi

if [ ! -f "$ARCHIVE" ]; then
  echo "[실패] 백업 파일이 없습니다: ${ARCHIVE}" >&2
  exit 2
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "[실패] Docker 명령을 찾을 수 없습니다." >&2
  exit 2
fi

# Host 경로를 Docker 에 넘길 때 Git Bash 의 /c/... 가 아니라 C:/... 가 필요하다.
ARCHIVE_DIR=$(cd "$(dirname "$ARCHIVE")" && { pwd -W 2>/dev/null || pwd; })
ARCHIVE_NAME=$(basename "$ARCHIVE")

echo "Verdaccio Storage 복원"
echo "  백업 파일 : ${ARCHIVE_NAME}"
echo "  대상 Volume: ${VOLUME}"
echo ""

# 이미 쓰고 있는 Volume 을 덮어쓰면 되돌릴 수 없다. 비어 있을 때만 진행한다.
if docker volume inspect "$VOLUME" >/dev/null 2>&1; then
  # 비어 있는지만 보면 부족하다. 기동 직후처럼 잠깐 비어 있는 Volume 을 다른 컨테이너가
  # 쓰고 있을 수 있다. 그 위에 풀면 실행 중인 Verdaccio 의 저장소를 바꿔 버린다.
  # sed·tr 를 쓰지 않는다. PowerShell 에서 Git 의 sh.exe 만 직접 부르면 PATH 에 없다
  # (smoke.sh 와 같은 기준). 셸 내장 기능만 쓴다.
  USERS=""
  while IFS= read -r line; do
    line="${line%"$(printf '\r')"}"
    [ -z "$line" ] && continue
    USERS="${USERS}${line}, "
  done <<EOF
$(docker ps -a --filter "volume=${VOLUME}" --format "{{.Names}} ({{.State}})")
EOF
  USERS="${USERS%, }"
  if [ -n "$USERS" ]; then
    echo "[실패] '${VOLUME}' 을 쓰는 컨테이너가 있습니다: ${USERS}" >&2
    echo "복원은 새 Volume 으로 합니다. 새 이름을 쓰세요." >&2
    exit 2
  fi

  EXISTING=$(MSYS_NO_PATHCONV=1 docker run --rm --user 0 -v "${VOLUME}:/target:ro" \
    --entrypoint sh "$IMAGE" -c 'ls -A /target 2>/dev/null | wc -l')
  # 앞뒤 공백과 CR 을 셸 내장 기능만으로 없앤다.
  EXISTING="${EXISTING%"$(printf '\r')"}"
  while [ "${EXISTING# }" != "$EXISTING" ]; do EXISTING="${EXISTING# }"; done
  while [ "${EXISTING% }" != "$EXISTING" ]; do EXISTING="${EXISTING% }"; done
  if [ "${EXISTING:-0}" != "0" ]; then
    echo "[실패] '${VOLUME}' 에 이미 데이터가 있습니다(${EXISTING}개 항목)." >&2
    echo "쓰고 있는 Volume 을 덮어쓰지 않습니다. 새 이름을 쓰세요." >&2
    exit 2
  fi
else
  docker volume create "$VOLUME" >/dev/null
fi

# 풀고 나서 공식 Image 의 실행 사용자로 소유권을 맞춘다.
#
# 파일 이름을 명령 문자열에 끼워 넣지 않는다. 이름에 공백이나 ;, $( ) 가 있으면 그대로
# 셸 명령으로 해석된다. 이름은 환경변수로 넘기고 컨테이너 안에서 따옴표로 감싼다.
if ! MSYS_NO_PATHCONV=1 ARCHIVE_NAME="$ARCHIVE_NAME" docker run --rm --user 0 \
  -v "${VOLUME}:/target" \
  -v "${ARCHIVE_DIR}:/backup:ro" \
  -e ARCHIVE_NAME \
  --entrypoint sh "$IMAGE" \
  -c 'tar xzf "/backup/$ARCHIVE_NAME" -C /target && chown -R 10001:65533 /target'; then
  echo "[실패] 복원하지 못했습니다." >&2
  exit 1
fi

# 무엇이 들어왔는지 확인한다. 빈 복원을 성공으로 넘기지 않는다.
SUMMARY=$(MSYS_NO_PATHCONV=1 docker run --rm --user 0 -v "${VOLUME}:/target:ro" \
  --entrypoint sh "$IMAGE" -c \
  'ls -A /target | wc -l; [ -f /target/htpasswd ] && echo yes || echo no; ls /target/data 2>/dev/null | wc -l')

ENTRIES=0
HAS_HTPASSWD=no
PACKAGES=0
{ IFS= read -r ENTRIES; IFS= read -r HAS_HTPASSWD; IFS= read -r PACKAGES; } <<EOF
$SUMMARY
EOF
# wc 출력의 앞뒤 공백과 CR 을 셸 내장 기능만으로 없앤다(sed·tr 없이).
trim() {
  value="$1"
  value="${value%"$(printf '\r')"}"
  while [ "${value# }" != "$value" ]; do value="${value# }"; done
  while [ "${value% }" != "$value" ]; do value="${value% }"; done
  printf '%s' "$value"
}
ENTRIES=$(trim "$ENTRIES")
PACKAGES=$(trim "$PACKAGES")
HAS_HTPASSWD=$(trim "$HAS_HTPASSWD")

if [ "${ENTRIES:-0}" = "0" ]; then
  echo "[실패] 복원했지만 Volume 이 비어 있습니다." >&2
  exit 1
fi

echo "  [통과] 항목 ${ENTRIES}개 복원"
if [ "$HAS_HTPASSWD" = "yes" ]; then
  echo "  [통과] 계정 파일(htpasswd) 있음"
else
  echo "  [주의] 계정 파일(htpasswd)이 없습니다. 복원 후 로그인할 수 없습니다."
fi
echo "  Package 폴더: ${PACKAGES:-0}개 (S3 구성 백업이면 0 이 정상입니다)"
echo ""
echo "확인하려면 이 Volume 으로 Verdaccio 를 띄운 뒤 로그인과 smoke.sh 를 돌립니다."
echo "  docker run -d --name whs-verdaccio-restored \\"
echo "    -e VERDACCIO_PUBLIC_URL=http://localhost:3000 \\"
echo "    -v ${VOLUME}:/verdaccio/storage \\"
echo "    -v \"\$(pwd)/infra/verdaccio/config.local.yaml:/verdaccio/conf/config.yaml:ro\" \\"
echo "    -v \"\$(pwd)/infra/verdaccio/plugins:/verdaccio/plugins:ro\" \\"
echo "    ${IMAGE}"
