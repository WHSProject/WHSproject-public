#!/usr/bin/env bash

set -u

ROOT="$(git rev-parse --show-toplevel)"
SCANNER_ROOT="$ROOT/apps/scanner"
REPORT_DIR="$ROOT/reports/validation"
REPORT="$REPORT_DIR/obfuscation-llm-pr-validation.md"
NODE="${NODE_BINARY:-$(command -v node)}"
FAILED=0
DIFF_OUTPUT="$(mktemp)"

mkdir -p "$REPORT_DIR"

{
  printf '# 난독화 LLM PR 검증 보고서\n\n'
  printf -- '- 실행 시각: %s\n' "$(date '+%Y-%m-%d %H:%M:%S')"
  printf -- '- Node: %s\n' "$($NODE -v)"
  printf -- '- 브랜치: %s\n' "$(git branch --show-current)"
  printf -- '- 기준 커밋: %s\n\n' "$(git rev-parse --short HEAD)"
} > "$REPORT"

run_check() {
  local title="$1"
  shift
  local output
  local result_code
  output="$(mktemp)"

  (
    cd "$SCANNER_ROOT"
    "$@"
  ) > "$output" 2>&1
  result_code=$?

  {
    printf '## %s\n\n' "$title"
    if [ "$result_code" -eq 0 ]; then
      printf -- '- 결과: 통과\n\n'
    else
      printf -- '- 결과: 실패\n\n'
    fi
    printf '%s\n' '```text'
    sed -n '1,240p' "$output"
    printf '%s\n\n' '```'
  } >> "$REPORT"

  rm -f "$output"
  if [ "$result_code" -ne 0 ]; then FAILED=1; fi
}

run_check '타입 검사' "$NODE" ./node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
run_check 'Scanner 빌드' "$NODE" --no-node-snapshot ./node_modules/@nestjs/cli/bin/nest.js build
run_check 'Scanner 전체 테스트' "$NODE" --no-node-snapshot --experimental-vm-modules ./node_modules/jest/bin/jest.js --config jest.config.cjs --runInBand

{
  printf '## 변경 형식 검사\n\n'
  if git diff --check > "$DIFF_OUTPUT" 2>&1; then
    printf -- '- 결과: 통과\n\n'
  else
    printf -- '- 결과: 실패\n\n'
    FAILED=1
  fi
  printf '%s\n' '```text'
  sed -n '1,240p' "$DIFF_OUTPUT"
  printf '%s\n\n' '```'
} >> "$REPORT"
rm -f "$DIFF_OUTPUT"

printf '검증 보고서: %s\n' "$REPORT"
exit "$FAILED"
