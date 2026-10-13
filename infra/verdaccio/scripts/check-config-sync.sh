#!/usr/bin/env sh
# config.local.yaml 과 config.s3.yaml 이 저장소 부분만 다른지 확인한다.
#
# Verdaccio 설정은 저장소 구성에 따라 키 구조가 달라져(storage: ↔ store:) 파일을
# 둘로 나눴다. 나머지 설정(Guard, 인증, Plugin 등)은 같아야 하는데, 한쪽만 고치면
# 저장소 구성에 따라 보안 동작이 달라진다. 이 스크립트로 어긋남을 잡는다.
#
# 사용법:
#   sh infra/verdaccio/scripts/check-config-sync.sh
#
# 비교에서 빼는 부분:
#   - 파일 맨 앞 주석 블록(파일 설명)
#   - 저장소 블록: local 의 'storage:' 한 줄, s3 의 'store:' 블록과 그 바로 위 주석
#
# 같으면 exit 0, 다르면 차이를 보여주고 exit 1.

set -eu

case "$0" in
  */*) SCRIPT_DIR="${0%/*}" ;;
  *) SCRIPT_DIR="." ;;
esac
VERDACCIO_DIR=$(cd "$SCRIPT_DIR/.." && pwd)

# PowerShell 에서 Git 의 sh.exe 만 직접 불러도 돌도록 셸 내장 기능만 쓴다.
normalize() {
  in_header=1
  pending_comments=""
  in_store=0
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%"$(printf '\r')"}"
    # 맨 앞 주석 블록은 파일 설명이라 뺀다.
    if [ "$in_header" -eq 1 ]; then
      case "$line" in
        "#"*) continue ;;
        *) in_header=0 ;;
      esac
    fi
    # store 블록은 들여쓴 줄이 이어지는 동안 계속된다.
    if [ "$in_store" -eq 1 ]; then
      case "$line" in
        " "*) continue ;;
        *) in_store=0 ;;
      esac
    fi
    case "$line" in
      "#"*)
        # 주석은 바로 뒤 줄이 저장소 블록인지 보고 나서 내보낸다.
        pending_comments="${pending_comments}${line}
"
        continue
        ;;
      "storage:"*)
        pending_comments=""
        continue
        ;;
      "store:"*)
        pending_comments=""
        in_store=1
        continue
        ;;
    esac
    printf '%s' "$pending_comments"
    pending_comments=""
    printf '%s\n' "$line"
  done
  printf '%s' "$pending_comments"
}

LOCAL_TEXT=$(normalize < "$VERDACCIO_DIR/config.local.yaml")
S3_TEXT=$(normalize < "$VERDACCIO_DIR/config.s3.yaml")

if [ "$LOCAL_TEXT" = "$S3_TEXT" ]; then
  echo "config.local.yaml 과 config.s3.yaml 이 저장소 설정 외에는 같습니다."
  exit 0
fi

echo "config.local.yaml 과 config.s3.yaml 이 저장소 설정 외에도 다릅니다."
echo "한쪽만 고쳤다면 다른 쪽에도 같게 반영하세요."
echo ""
# 차이 위치를 알려준다. diff 가 없는 셸도 있어 줄 단위로 처음 다른 곳만 찾는다.
line_no=0
printf '%s\n' "$LOCAL_TEXT" > "${TMPDIR:-/tmp}/whs-config-local.$$"
printf '%s\n' "$S3_TEXT" > "${TMPDIR:-/tmp}/whs-config-s3.$$"
trap 'rm -f "${TMPDIR:-/tmp}/whs-config-local.$$" "${TMPDIR:-/tmp}/whs-config-s3.$$"' EXIT
exec 3< "${TMPDIR:-/tmp}/whs-config-s3.$$"
while IFS= read -r local_line || [ -n "$local_line" ]; do
  line_no=$((line_no + 1))
  if ! IFS= read -r s3_line <&3; then
    s3_line="(끝)"
  fi
  if [ "$local_line" != "$s3_line" ]; then
    echo "  비교 ${line_no}번째 줄"
    echo "    local: ${local_line}"
    echo "    s3   : ${s3_line}"
    exit 1
  fi
done < "${TMPDIR:-/tmp}/whs-config-local.$$"
if IFS= read -r s3_line <&3; then
  echo "  config.s3.yaml 에만 있는 줄: ${s3_line}"
fi
exit 1
