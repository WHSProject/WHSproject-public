#!/usr/bin/env sh
# Verdaccio Cache 조회·정리
#
# 저장된 Package 목록과 용량을 보고, 필요하면 지운다. 로컬 Volume 구성과 AWS S3 구성을
# 모두 지원한다. 저장 위치는 실행 중인 컨테이너의 설정에서 읽는다.
#
# 사용법:
#   sh infra/verdaccio/scripts/cache-admin.sh list
#   sh infra/verdaccio/scripts/cache-admin.sh usage
#   sh infra/verdaccio/scripts/cache-admin.sh show <package>
#   sh infra/verdaccio/scripts/cache-admin.sh delete <package> [<package>...]
#
# delete 는 기본이 Dry-run 이다. 무엇이 지워질지 보여주기만 하고 지우지 않는다.
# 실제로 지우려면 --yes 를 붙인다.
#
#   sh infra/verdaccio/scripts/cache-admin.sh delete is-odd --yes
#
# 삭제는 파일을 직접 지우지 않고 Registry 의 Unpublish API 를 쓴다. 파일만 지우면
# Verdaccio 의 Package 목록(.verdaccio-db.json / verdaccio-s3-db.json)과 어긋나
# 이후 조회가 이상해진다. 그래서 admin 계정이 필요하다(config 의 unpublish: admin).
#
# 내부 Package(@whs/*)는 기본적으로 삭제 대상에서 제외한다. 외부 Package 는 npmjs 에서
# 다시 받아올 수 있지만 내부 Package 는 되받을 곳이 없다. 지우려면 --include-internal
# 을 함께 준다.
#
# 지운 외부 Package 는 다음 요청에서 npmjs 로부터 다시 받아 저장된다. 따로 재수집
# 명령이 필요 없다(README 참고).
#
# 환경변수:
#   VERDACCIO_CONTAINER        기본 whs-verdaccio
#   VERDACCIO_ADMIN_USER       기본 admin
#   VERDACCIO_ADMIN_PASSWORD   delete --yes 에만 필요. 없으면 터미널에서 입력받는다
#
# 종료 코드:
#   0  정상
#   1  실패 (삭제 실패 등)
#   2  전제조건 미충족 (컨테이너 없음, 대상 Package 없음, 비밀번호 없음 등)

set -eu

CONTAINER="${VERDACCIO_CONTAINER:-whs-verdaccio}"
ADMIN_USER="${VERDACCIO_ADMIN_USER:-admin}"

COMMAND="${1:-}"
if [ -z "$COMMAND" ]; then
  echo "Usage: sh infra/verdaccio/scripts/cache-admin.sh <list|usage|show|delete> [package...] [--yes] [--include-internal]" >&2
  exit 2
fi
shift

APPLY=0
INCLUDE_INTERNAL=0
TARGETS=""

for arg in "$@"; do
  case "$arg" in
    --yes) APPLY=1 ;;
    --include-internal) INCLUDE_INTERNAL=1 ;;
    -*)
      echo "알 수 없는 옵션입니다: ${arg}" >&2
      exit 2
      ;;
    *) TARGETS="${TARGETS}${arg}
" ;;
  esac
done

case "$COMMAND" in
  list|usage) ;;
  show|delete)
    if [ -z "$TARGETS" ]; then
      echo "Package 이름을 지정하세요." >&2
      exit 2
    fi
    ;;
  *)
    echo "알 수 없는 명령입니다: ${COMMAND}" >&2
    exit 2
    ;;
esac

if ! command -v docker >/dev/null 2>&1; then
  echo "[실패] Docker 명령을 찾을 수 없습니다." >&2
  exit 2
fi

if ! docker inspect "$CONTAINER" >/dev/null 2>&1; then
  echo "Verdaccio 컨테이너를 찾을 수 없습니다: ${CONTAINER}" >&2
  echo "docker compose up -d verdaccio 로 먼저 기동하세요." >&2
  exit 2
fi

RUNNING=$(docker inspect -f "{{.State.Running}}" "$CONTAINER")
if [ "$RUNNING" != "true" ]; then
  echo "'${CONTAINER}' 컨테이너가 실행 중이 아닙니다." >&2
  exit 2
fi

# 실제로 지울 때만 비밀번호를 받는다. 조회에는 필요 없다.
# smoke.sh / manage-users.sh 와 같은 방식이다. 인자로는 받지 않는다(셸 히스토리).
ECHO_DISABLED=0
restore_terminal() {
  if [ "$ECHO_DISABLED" -eq 1 ]; then
    stty echo 2>/dev/null || true
    ECHO_DISABLED=0
  fi
}
trap 'restore_terminal' EXIT
trap 'restore_terminal; exit 130' HUP INT TERM

ADMIN_PW="${VERDACCIO_ADMIN_PASSWORD:-}"
if [ "$COMMAND" = "delete" ] && [ "$APPLY" -eq 1 ] && [ -z "$ADMIN_PW" ]; then
  if [ ! -t 0 ]; then
    echo "VERDACCIO_ADMIN_PASSWORD 를 환경변수로 지정하세요." >&2
    exit 2
  fi
  printf "%s 비밀번호: " "$ADMIN_USER"
  ECHO_DISABLED=1
  stty -echo
  IFS= read -r ADMIN_PW || true
  restore_terminal
  printf "\n"
  if [ -z "$ADMIN_PW" ]; then
    echo "[실패] 비밀번호는 비워둘 수 없습니다." >&2
    exit 2
  fi
fi

# 조회와 삭제 모두 실행 중인 컨테이너 안에서 한다. 컨테이너에는 저장소 설정과
# 자격증명(S3 구성)이 이미 있어 Host 에 아무것도 준비할 필요가 없다.
# 비밀번호는 이름만 넘긴다(값이 docker 인자로 들어가면 ps 에 보인다).
MSYS_NO_PATHCONV=1 ADMIN_PW="$ADMIN_PW" \
docker exec \
  -e CACHE_COMMAND="$COMMAND" \
  -e CACHE_TARGETS="$TARGETS" \
  -e CACHE_APPLY="$APPLY" \
  -e CACHE_INCLUDE_INTERNAL="$INCLUDE_INTERNAL" \
  -e ADMIN_USER="$ADMIN_USER" \
  -e ADMIN_PW \
  "$CONTAINER" node -e '
const fs = require("fs");
const path = require("path");

const CONFIG_PATH = "/verdaccio/conf/config.yaml";
const BASE = "http://127.0.0.1:4873";
const COMMAND = process.env.CACHE_COMMAND;
const APPLY = process.env.CACHE_APPLY === "1";
const INCLUDE_INTERNAL = process.env.CACHE_INCLUDE_INTERNAL === "1";
const TARGETS = (process.env.CACHE_TARGETS || "").split(/\r?\n/).filter((name) => name !== "");

// 저장 위치는 실행 중인 설정에서 읽는다. smoke.sh 와 같은 기준이다. js-yaml 이 있다는
// 보장이 없어 필요한 줄만 읽는다.
function readStorageLocation() {
  const text = fs.readFileSync(CONFIG_PATH, "utf8");
  let inStore = false;
  let s3 = false;
  let keyPrefix;
  let storagePath;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, "").replace(/^#.*$/, "");
    if (/^\S/.test(line)) {
      inStore = /^store:\s*$/.test(line);
      const local = /^storage:\s*(\S+)\s*$/.exec(line);
      if (local) storagePath = local[1];
      continue;
    }
    if (!inStore) continue;
    if (/^\s+aws-s3-storage:\s*$/.test(line)) s3 = true;
    const prefix = /^\s+keyPrefix:\s*"?([^"\s]*)"?\s*$/.exec(line);
    if (s3 && prefix) keyPrefix = prefix[1];
  }
  if (s3) {
    const normalized = keyPrefix === undefined || keyPrefix === ""
      ? ""
      : (keyPrefix.endsWith("/") ? keyPrefix : keyPrefix + "/");
    return { type: "s3", keyPrefix: normalized };
  }
  return { type: "local", root: storagePath || "/verdaccio/storage/data" };
}

function humanSize(bytes) {
  if (bytes < 1024) return bytes + " B";
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value = value / 1024;
    unit += 1;
  }
  return value.toFixed(1) + " " + units[unit];
}

function isInternal(name) {
  return name.startsWith("@whs/");
}

// 로컬 저장소는 Package 마다 폴더 하나다. @scope 는 한 단계 더 들어간다.
function collectLocal(root) {
  const packages = new Map();
  let unreadable = 0;

  // 저장 폴더 자체를 읽지 못하면 "Cache 가 비었다" 가 아니라 "확인하지 못했다" 이다.
  // 빈 결과로 돌려주면 권한 오류나 경로 오타를 정상으로 읽고, 그 상태에서 삭제 계획을
  // 세우게 된다. 그래서 여기서 멈춘다.
  const readRoot = () => {
    try {
      return fs.readdirSync(root, { withFileTypes: true });
    } catch (error) {
      throw new Error(
        "저장 폴더를 읽지 못했습니다 (" + root + "): " + (error.code || error.message),
      );
    }
  };

  // Package 폴더 하나를 못 읽는 것은 전체를 멈출 일은 아니다. 대신 개수를 세어 알린다.
  const readPackageDir = (dir) => {
    try {
      return fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      unreadable += 1;
      return null;
    }
  };

  const addPackage = (name, dir) => {
    const entries = readPackageDir(dir);
    if (entries === null) {
      return;
    }
    const tarballs = [];
    let metadata = false;
    let metadataSize = 0;
    for (const file of entries.filter((entry) => entry.isFile())) {
      const full = path.join(dir, file.name);
      let stat;
      try {
        stat = fs.statSync(full);
      } catch {
        unreadable += 1;
        continue;
      }
      if (file.name === "package.json") {
        metadata = true;
        metadataSize = stat.size;
        continue;
      }
      if (file.name.endsWith(".tgz")) {
        tarballs.push({ file: file.name, size: stat.size, modified: stat.mtime.toISOString() });
      }
    }
    if (metadata || tarballs.length > 0) {
      packages.set(name, { name, metadata, metadataSize, tarballs });
    }
  };

  for (const entry of readRoot()) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith("@")) {
      const scopedEntries = readPackageDir(path.join(root, entry.name));
      for (const scoped of scopedEntries ?? []) {
        if (scoped.isDirectory()) {
          addPackage(entry.name + "/" + scoped.name, path.join(root, entry.name, scoped.name));
        }
      }
      continue;
    }
    addPackage(entry.name, path.join(root, entry.name));
  }

  return { entries: [...packages.values()], unreadable };
}

// S3 구성은 버킷을 직접 조회한다. 자격증명은 컨테이너 환경에 이미 있고, SDK 는 S3
// Plugin 이 함께 설치한 것을 쓴다(verdaccio-whs-integrity 와 같은 기준).
async function collectS3(keyPrefix) {
  const { createRequire } = require("module");
  const entry = createRequire("/usr/local/lib/node_modules/verdaccio/bin/verdaccio")
    .resolve("verdaccio-aws-s3-storage");
  const sdk = createRequire(entry)("@aws-sdk/client-s3");
  const client = new sdk.S3Client({});
  const bucket = process.env.AWS_S3_BUCKET;
  if (!bucket) {
    throw new Error("AWS_S3_BUCKET 이 컨테이너에 없습니다");
  }

  const packages = new Map();
  let token;
  do {
    const response = await client.send(new sdk.ListObjectsV2Command({
      Bucket: bucket,
      Prefix: keyPrefix,
      MaxKeys: 1000,
      ContinuationToken: token,
    }));
    for (const object of response.Contents || []) {
      const key = object.Key;
      if (typeof key !== "string" || !key.startsWith(keyPrefix)) continue;
      const rest = key.slice(keyPrefix.length);
      const slash = rest.lastIndexOf("/");
      if (slash <= 0) continue;
      const name = rest.slice(0, slash);
      const file = rest.slice(slash + 1);
      if (!packages.has(name)) {
        packages.set(name, { name, metadata: false, metadataSize: 0, tarballs: [] });
      }
      const found = packages.get(name);
      if (file === "package.json") {
        found.metadata = true;
        found.metadataSize = object.Size || 0;
      } else if (file.endsWith(".tgz")) {
        found.tarballs.push({
          file,
          size: object.Size || 0,
          modified: object.LastModified ? new Date(object.LastModified).toISOString() : "",
        });
      }
    }
    token = response.IsTruncated === true ? response.NextContinuationToken : undefined;
  } while (token);

  return { entries: [...packages.values()], unreadable: 0 };
}

// Metadata(package.json)도 저장 용량이다. 외부 Package 는 모든 Version 정보가 들어 있어
// Tarball 하나보다 큰 경우가 많다(is-odd: Metadata 27KB, Tarball 2.7KB). Tarball 만 세면
// 실제 사용량이 크게 축소돼 보인다.
function tarballSize(entry) {
  return entry.tarballs.reduce((sum, tarball) => sum + tarball.size, 0);
}

function totalSize(entry) {
  return tarballSize(entry) + (entry.metadataSize || 0);
}

function lastModified(entry) {
  return entry.tarballs
    .map((tarball) => tarball.modified)
    .filter((value) => value !== "")
    .sort()
    .pop() || "";
}

async function login() {
  const user = process.env.ADMIN_USER;
  const password = process.env.ADMIN_PW;
  const basic = Buffer.from(user + ":" + password).toString("base64");
  const response = await fetch(BASE + "/-/user/org.couchdb.user:" + encodeURIComponent(user), {
    method: "PUT",
    headers: { "content-type": "application/json", authorization: "Basic " + basic },
    body: JSON.stringify({ name: user, password }),
  });
  const body = await response.json().catch(() => ({}));
  if (response.status !== 201 || !body.token) {
    throw new Error("admin 로그인 실패 (status " + response.status + ")");
  }
  return body.token;
}

// 파일을 직접 지우지 않는다. Verdaccio 의 Package 목록과 어긋나지 않게 Unpublish
// API 를 쓴다. 경로는 DELETE /{package}/-rev/{rev} 이다(실측).
async function unpublish(name, token) {
  const url = BASE + "/" + encodeURIComponent(name);
  const metadata = await fetch(url, { headers: { authorization: "Bearer " + token } });
  if (metadata.status !== 200) {
    return { ok: false, detail: "Metadata 조회 status " + metadata.status };
  }
  const body = await metadata.json().catch(() => ({}));
  const rev = typeof body._rev === "string" ? body._rev : "1-0000000000000000";
  const removed = await fetch(url + "/-rev/" + encodeURIComponent(rev), {
    method: "DELETE",
    headers: { authorization: "Bearer " + token },
  });
  return { ok: removed.status === 201, detail: "status " + removed.status };
}

(async () => {
  const location = readStorageLocation();
  const collected = location.type === "s3"
    ? await collectS3(location.keyPrefix)
    : collectLocal(location.root);
  const entries = collected.entries;
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const where = location.type === "s3"
    ? "S3 (keyPrefix " + (location.keyPrefix || "(없음)") + ")"
    : "로컬 " + location.root;
  console.log("저장 위치: " + where);
  // 읽지 못한 항목이 있으면 결과가 실제보다 적다. 조용히 넘기지 않는다.
  if (collected.unreadable > 0) {
    console.log("[주의] 읽지 못한 항목 " + collected.unreadable +
      "개가 있습니다. 아래 목록과 용량은 실제보다 적을 수 있습니다.");
  }
  console.log("");

  if (COMMAND === "list") {
    if (entries.length === 0) {
      console.log("저장된 Package 가 없습니다.");
      return;
    }
    console.log("Package".padEnd(34) + "버전".padStart(4) + "용량".padStart(12) + "  마지막 저장");
    for (const entry of entries) {
      console.log(
        entry.name.padEnd(34) +
        String(entry.tarballs.length).padStart(4) +
        humanSize(totalSize(entry)).padStart(12) +
        "  " + (lastModified(entry).slice(0, 19) || "-"),
      );
    }
    console.log("");
    console.log("Package " + entries.length + "개, 합계 " +
      humanSize(entries.reduce((sum, entry) => sum + totalSize(entry), 0)));
    return;
  }

  if (COMMAND === "usage") {
    const tarballs = entries.reduce((sum, entry) => sum + tarballSize(entry), 0);
    const metadata = entries.reduce((sum, entry) => sum + (entry.metadataSize || 0), 0);
    const versions = entries.reduce((sum, entry) => sum + entry.tarballs.length, 0);
    const internal = entries.filter((entry) => isInternal(entry.name));
    console.log("Package        : " + entries.length + "개 (내부 @whs/* " + internal.length + "개)");
    console.log("저장된 버전    : " + versions + "개");
    console.log("Tarball        : " + humanSize(tarballs));
    console.log("Metadata       : " + humanSize(metadata));
    console.log("합계           : " + humanSize(tarballs + metadata));
    console.log("");
    console.log("용량 상위");
    const top = [...entries].sort((a, b) => totalSize(b) - totalSize(a)).slice(0, 10);
    for (const entry of top) {
      console.log("  " + entry.name.padEnd(34) + humanSize(totalSize(entry)).padStart(12));
    }
    return;
  }

  const found = new Map(entries.map((entry) => [entry.name, entry]));

  if (COMMAND === "show") {
    let missing = 0;
    for (const name of TARGETS) {
      const entry = found.get(name);
      console.log(name);
      if (!entry) {
        console.log("  저장된 것이 없습니다.");
        missing += 1;
        continue;
      }
      console.log("  Metadata: " + (entry.metadata
        ? "있음 (" + humanSize(entry.metadataSize || 0) + ")"
        : "없음"));
      for (const tarball of entry.tarballs.sort((a, b) => (a.file < b.file ? -1 : 1))) {
        console.log("  " + tarball.file.padEnd(40) +
          humanSize(tarball.size).padStart(10) + "  " + tarball.modified.slice(0, 19));
      }
      console.log("  합계: " + humanSize(totalSize(entry)));
    }
    if (missing === TARGETS.length) process.exitCode = 2;
    return;
  }

  // delete
  const plan = [];
  const skipped = [];
  for (const name of TARGETS) {
    const entry = found.get(name);
    if (!entry) {
      skipped.push({ name, reason: "저장된 것이 없음" });
      continue;
    }
    if (isInternal(name) && !INCLUDE_INTERNAL) {
      skipped.push({ name, reason: "내부 Package. 지우려면 --include-internal" });
      continue;
    }
    plan.push(entry);
  }

  console.log(APPLY ? "삭제합니다." : "Dry-run 입니다. 실제로 지우려면 --yes 를 붙이세요.");
  console.log("");
  for (const entry of plan) {
    console.log("  지움   " + entry.name.padEnd(34) +
      String(entry.tarballs.length).padStart(3) + "개 버전  " +
      humanSize(totalSize(entry)).padStart(10) +
      (isInternal(entry.name) ? "  (내부 Package)" : ""));
  }
  for (const item of skipped) {
    console.log("  건너뜀 " + item.name.padEnd(34) + item.reason);
  }
  console.log("");

  if (plan.length === 0) {
    console.log("지울 대상이 없습니다.");
    process.exitCode = 2;
    return;
  }

  if (!APPLY) {
    console.log("합계 " + humanSize(plan.reduce((sum, entry) => sum + totalSize(entry), 0)) +
      " 가 지워집니다. 외부 Package 는 다음 요청에서 npmjs 로부터 다시 받아옵니다.");
    console.log("Package 상세 정보는 show <package> 명령으로 확인하세요.");
    return;
  }

  const token = await login();
  let failed = 0;
  for (const entry of plan) {
    const result = await unpublish(entry.name, token);
    console.log((result.ok ? "  [완료] " : "  [실패] ") + entry.name + "  " + result.detail);
    if (!result.ok) failed += 1;
  }
  console.log("");
  console.log("지움 " + (plan.length - failed) + " / 실패 " + failed);
  if (failed > 0) process.exitCode = 1;
})().catch((error) => {
  console.error("");
  console.error("Cache 조회·정리 중 오류가 발생했습니다: " + error.message);
  process.exit(1);
});
'
