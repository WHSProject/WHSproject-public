#!/usr/bin/env sh
# Verdaccio Storage 무결성 점검 스크립트
#
# 저장된 Tarball 을 실제로 해싱해 Metadata 의 dist.integrity 와 대조한다.
# Verdaccio 는 자기 Cache 를 검증하지 않으므로(실측), 변조되거나 손상된
# Tarball 을 그대로 반환한다. 이 스크립트는 그 상태를 사후에 찾아낸다.
#
# 사용법:
#   sh infra/verdaccio/scripts/verify-cache.sh
#   sh infra/verdaccio/scripts/verify-cache.sh --verbose
#
# 종료 코드:
#   0  검사 완료. 전부 일치
#   1  불일치 또는 검증 불가 항목 존재
#   2  점검 대상이 없음. Volume 이름과 Storage 경로를 확인한다
#
# 0건과 "문제 없음" 을 구분하기 위해 2 를 따로 둔다. cron 으로 돌릴 때
# Volume 이름을 잘못 지정하면 아무것도 찾지 못한 채 성공으로 끝나기 때문이다.
#
# 한계:
#   - 요청 시점에 차단하지 못한다. 정기 점검 또는 사고 대응용이다.
#   - Metadata 자체가 함께 변조된 경우는 잡지 못한다.
#     그 경우는 Gateway 가 Decision 의 값과 비교해야 한다.

set -eu

VOLUME="${VERDACCIO_VOLUME:-whsproject_verdaccio_storage}"
IMAGE="${VERDACCIO_IMAGE:-verdaccio/verdaccio:6.10.0}"
MODE="normal"

case "${1:-}" in
  "") ;;
  --verbose) MODE="verbose" ;;
  *)
    echo "Usage: sh infra/verdaccio/scripts/verify-cache.sh [--verbose]" >&2
    exit 2
    ;;
esac

if [ "$#" -gt 1 ]; then
  echo "Usage: sh infra/verdaccio/scripts/verify-cache.sh [--verbose]" >&2
  exit 2
fi

print_no_target() {
  reason="$1"
  hint="$2"
  echo "Verdaccio cache verification"
  echo "Volume: ${VOLUME}"
  echo "Storage: /verdaccio/storage/data"
  if [ "${MODE}" = "verbose" ]; then
    echo "Mode: verbose"
  fi
  echo
  echo "[WARN] ${reason}"
  echo "  hint: ${hint}"
  echo
  echo "Summary"
  echo "Package checks: 0"
  echo "Tarball checks: 0"
  echo "OK: 0"
  echo "FAIL: 0"
  echo "WARN: 1"
  echo "Result: NO_TARGET"
}

# docker run 은 없는 Volume 이름을 받으면 빈 Volume 을 새로 만든다.
# 그대로 두면 오타가 "점검 대상 없음" 으로 조용히 넘어가고 쓰레기 Volume 도 남는다.
if ! docker volume inspect "${VOLUME}" >/dev/null 2>&1; then
  print_no_target \
    "Volume not found: ${VOLUME}" \
    "Set VERDACCIO_VOLUME to an existing Verdaccio storage volume."
  exit 2
fi

docker run --rm -v "${VOLUME}:/verdaccio/storage:ro" --entrypoint node "${IMAGE}" -e '
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = "/verdaccio/storage/data";
const verbose = process.argv[1] === "verbose";
const volume = process.argv[2];

function printHeader() {
  console.log("Verdaccio cache verification");
  console.log("Volume: " + volume);
  console.log("Storage: " + ROOT);
  if (verbose) console.log("Mode: verbose");
  console.log("");
}

function printSummary(packageChecks, tarballChecks, ok, fail, warn, result) {
  console.log("");
  console.log("Summary");
  console.log("Package checks: " + packageChecks);
  console.log("Tarball checks: " + tarballChecks);
  console.log("OK: " + ok);
  console.log("FAIL: " + fail);
  console.log("WARN: " + warn);
  console.log("Result: " + result);
}

function printDetails(details) {
  if (!verbose) return;
  for (const [label, value] of details) {
    if (value !== undefined && value !== null && value !== "") {
      console.log("  " + label + ": " + value);
    }
  }
}

// dist.integrity 는 SRI 형식이다: "<alg>-<base64>". 공백으로 여러 개가 올 수 있다.
function parseSri(value) {
  if (typeof value !== "string") return [];
  return value.trim().split(/\s+/).map((token) => {
    const dash = token.indexOf("-");
    if (dash < 1) return null;
    return { algorithm: token.slice(0, dash), digest: token.slice(dash + 1) };
  }).filter(Boolean);
}

// 앞쪽이 더 강한 알고리즘이다. SRI 는 여러 알고리즘이 있으면 가장 강한 것으로
// 검증한다. 약한 알고리즘이 맞았다고 통과시키면 강한 쪽 불일치를 놓친다.
const ALGORITHM_STRENGTH = ["sha512", "sha384", "sha256"];
const SUPPORTED = new Set(ALGORITHM_STRENGTH);

function digestOf(algorithm, buffer, encoding) {
  return crypto.createHash(algorithm).update(buffer).digest(encoding);
}

function collectPackages(dir, found) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const child = path.join(dir, entry.name);
    if (fs.existsSync(path.join(child, "package.json"))) {
      found.push(child);
    } else {
      collectPackages(child, found);   // @scope/ 하위 탐색
    }
  }
  return found;
}

printHeader();

if (!fs.existsSync(ROOT)) {
  console.log("[WARN] Storage path not found: " + ROOT);
  console.log("  hint: Verify VERDACCIO_VOLUME points to the expected Verdaccio storage volume.");
  printSummary(0, 0, 0, 0, 1, "NO_TARGET");
  process.exit(2);
}

// Tarball 단위 집계와 Package 단위 오류를 분리한다.
// Metadata 를 못 읽으면 그 Package 의 Tarball 은 세지도 못하므로 같이 셀 수 없다.
let tarballOk = 0, mismatch = 0, skipped = 0; // Tarball 단위
let metadataOk = 0, metadataErrors = 0;       // Package 단위
const results = [];

const packageDirs = collectPackages(ROOT, []);

for (const pkgDir of packageDirs) {
  const metadataPath = path.join(pkgDir, "package.json");
  let packument;
  try {
    packument = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
  } catch (error) {
    results.push({ status: "WARN", subject: "Package " + path.relative(ROOT, pkgDir) + " metadata",
                   details: [["stage", "metadata-read"], ["metadata", metadataPath],
                             ["diagnostic", "METADATA_UNREADABLE"],
                             ["reason", "metadata unreadable: " + error.message]] });
    metadataErrors++;
    continue;
  }

  const name = packument.name || path.relative(ROOT, pkgDir);
  const versions = Object.keys(packument.versions || {});
  results.push({ status: "OK", subject: "Package " + name + " metadata",
                 details: [["stage", "metadata-read"], ["metadata", metadataPath],
                           ["versions", versions.join(", ") || "none"]] });
  metadataOk++;

  const tarballs = fs.readdirSync(pkgDir).filter((file) => file.endsWith(".tgz"));

  for (const file of tarballs) {
    const tarballPath = path.join(pkgDir, file);
    const version = versions.find(
      (candidate) => (packument.versions[candidate].dist || {}).tarball?.endsWith("/" + file)
    );

    if (!version) {
      results.push({ status: "WARN", subject: "Tarball " + name + "@unknown",
                     details: [["stage", "metadata-match"], ["file", verbose ? tarballPath : file],
                               ["diagnostic", "ORPHAN_TARBALL"],
                               ["reason", "version not found in metadata"]] });
      skipped++;
      continue;
    }

    const dist = packument.versions[version].dist || {};
    const buffer = fs.readFileSync(tarballPath);
    const candidates = parseSri(dist.integrity).filter((sri) => SUPPORTED.has(sri.algorithm));

    if (candidates.length > 0) {
      // 가장 강한 알고리즘 하나만 검증한다. 해시는 한 번만 계산하고, 같은
      // 알고리즘 후보가 여러 개면 그중 하나만 맞아도 유효하다(W3C SRI).
      const algorithm = ALGORITHM_STRENGTH.find(
        (candidate) => candidates.some((sri) => sri.algorithm === candidate)
      );
      const expected = candidates.filter((sri) => sri.algorithm === algorithm).map((sri) => sri.digest);
      const expectedSri = expected.map((digest) => algorithm + "-" + digest).join(" ");
      const actualDigest = digestOf(algorithm, buffer, "base64");
      const actualSri = algorithm + "-" + actualDigest;

      if (expected.includes(actualDigest)) {
        tarballOk++;
        results.push({ status: "OK", subject: "Tarball " + name + "@" + version + " integrity",
                       details: [["stage", "tarball-integrity"], ["file", tarballPath], ["algorithm", algorithm],
                                 ["expected", expectedSri], ["actual", actualSri]] });
      } else {
        mismatch++;
        results.push({ status: "FAIL", subject: "Tarball " + name + "@" + version,
                       details: [["stage", "tarball-integrity"], ["file", verbose ? tarballPath : file],
                                 ["diagnostic", "INTEGRITY_MISMATCH"], ["reason", "integrity mismatch"],
                                 ["algorithm", algorithm], ["expected", expectedSri], ["actual", actualSri]] });
      }
      continue;
    }

    // integrity 가 없는 구버전 Package 는 shasum(sha1) 으로 대조한다.
    if (typeof dist.shasum === "string") {
      const actual = digestOf("sha1", buffer, "hex");
      if (actual === dist.shasum) {
        tarballOk++;
        results.push({ status: "OK", subject: "Tarball " + name + "@" + version + " shasum",
                       details: [["stage", "tarball-shasum"], ["file", tarballPath], ["algorithm", "sha1"],
                                 ["expected", dist.shasum], ["actual", actual]] });
      } else {
        mismatch++;
        results.push({ status: "FAIL", subject: "Tarball " + name + "@" + version,
                       details: [["stage", "tarball-shasum"], ["file", verbose ? tarballPath : file],
                                 ["diagnostic", "SHASUM_MISMATCH"], ["reason", "shasum mismatch"],
                                 ["algorithm", "sha1"], ["expected", dist.shasum], ["actual", actual]] });
      }
      continue;
    }

    results.push({ status: "WARN", subject: "Tarball " + name + "@" + version,
                   details: [["stage", "hash-reference"], ["file", verbose ? tarballPath : file],
                             ["diagnostic", "NO_REFERENCE_HASH"],
                             ["reason", "integrity reference is missing"]] });
    skipped++;
  }
}

const checked = tarballOk + mismatch + skipped;

for (const result of results) {
  console.log("[" + result.status + "] " + result.subject);
  if (result.status === "OK") {
    printDetails(result.details);
  } else {
    // 실패와 검증 불가 항목은 기본 출력에서도 대상 파일과 원인을 보여준다.
    for (const [label, value] of result.details) {
      if (label === "file" || label === "reason" || verbose) {
        console.log("  " + label + ": " + value);
      }
    }
  }
}

let resultName;
let exitCode;

if (checked === 0 && metadataErrors === 0) {
  console.log(
    packageDirs.length === 0
      ? "[WARN] No cached packages found"
      : "[WARN] No cached tarballs found"
  );
  resultName = "NO_TARGET";
  exitCode = 2;
} else if (mismatch > 0) {
  resultName = "FAIL";
  exitCode = 1;
} else if (skipped > 0 || metadataErrors > 0) {
  resultName = "UNVERIFIABLE";
  exitCode = 1;
} else {
  resultName = "PASS";
  exitCode = 0;
}

const noTargetWarnings = exitCode === 2 ? 1 : 0;
printSummary(
  packageDirs.length,
  checked,
  metadataOk + tarballOk,
  mismatch,
  metadataErrors + skipped + noTargetWarnings,
  resultName
);

process.exit(exitCode);
' -- "${MODE}" "${VOLUME}"
