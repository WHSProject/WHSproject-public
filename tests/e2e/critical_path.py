#!/usr/bin/env python3

import argparse
import json
import os
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


def find_repo_root() -> Path:
    start = Path(__file__).resolve().parent
    for candidate in (start, *start.parents):
        if (candidate / "compose.yaml").is_file():
            return candidate
    raise RuntimeError("compose.yaml not found above tests/e2e")


ROOT = find_repo_root()

GATEWAY_BASE_URL = os.getenv(
    "GATEWAY_BASE_URL",
    "http://localhost:3000",
).rstrip("/")

POLICY_BASE_URL = os.getenv(
    "POLICY_BASE_URL",
    "http://localhost:8000",
).rstrip("/")

POLICY_DB_BASE_URL = os.getenv(
    "POLICY_DB_BASE_URL",
    "http://localhost:9000",
).rstrip("/")

DECISION_DB_BASE_URL = os.getenv(
    "DECISION_DB_BASE_URL",
    "http://localhost:9100",
).rstrip("/")

EVIDENCE_BASE_URL = os.getenv(
    "EVIDENCE_BASE_URL",
    "http://localhost:8100",
).rstrip("/")

REGISTRY_URL = os.getenv(
    "QA_REGISTRY_URL",
    f"{GATEWAY_BASE_URL}/npm/",
)

TIMEOUT_SECONDS = float(
    os.getenv("E2E_TIMEOUT_SECONDS", "15")
)

NPM_COMMAND = "npm.cmd" if os.name == "nt" else "npm"

REQUIRED_SERVICES = {
    "postgres",
    "evidence-api",
    "policy-db-api",
    "policy",
    "decision-db-api",
    "scanner",
    "gateway",
    "dashboard",
    "verdaccio",
}


class CriticalPathError(RuntimeError):
    pass


def log(message: str) -> None:
    print(f"[critical-path] {message}", flush=True)


def fail(message: str) -> None:
    raise CriticalPathError(message)


def run(
    command: list[str],
    *,
    env: dict[str, str] | None = None,
    timeout: float | None = None,
) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(
            command,
            cwd=ROOT,
            env=env,
            text=True,
            encoding="utf-8",
            errors="replace",
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout or TIMEOUT_SECONDS,
            check=False,
        )
    except FileNotFoundError:
        fail(f"command not found: {command[0]}")
    except subprocess.TimeoutExpired:
        fail(f"command timed out: {' '.join(command)}")


def run_ok(
    command: list[str],
    *,
    env: dict[str, str] | None = None,
    timeout: float | None = None,
) -> subprocess.CompletedProcess[str]:
    result = run(
        command,
        env=env,
        timeout=timeout,
    )

    if result.returncode != 0:
        fail(
            "command failed\n"
            f"  command: {' '.join(command)}\n"
            f"  exit: {result.returncode}\n"
            f"  stdout: {result.stdout.strip()}\n"
            f"  stderr: {result.stderr.strip()}"
        )

    return result


def compose(
    *args: str,
    timeout: float | None = None,
) -> subprocess.CompletedProcess[str]:
    return run_ok(
        ["docker", "compose", *args],
        timeout=timeout,
    )


def http_json(
    url: str,
) -> tuple[int, dict, dict[str, str]]:
    request = Request(
        url=url,
        method="GET",
        headers={"Accept": "application/json"},
    )

    try:
        with urlopen(
            request,
            timeout=TIMEOUT_SECONDS,
        ) as response:
            status = response.status
            raw_body = response.read().decode("utf-8")
            headers = {
                key.lower(): value
                for key, value in response.headers.items()
            }
    except HTTPError as exc:
        raw_body = exc.read().decode(
            "utf-8",
            errors="replace",
        )
        fail(f"GET {url} returned HTTP {exc.code}: {raw_body}")
    except URLError as exc:
        fail(f"GET {url} connection failed: {exc.reason}")

    if not raw_body:
        return status, {}, headers

    try:
        payload = json.loads(raw_body)
    except json.JSONDecodeError:
        fail(f"GET {url} returned invalid JSON: {raw_body}")

    return status, payload, headers


def assert_health(
    service: str,
    url: str,
) -> tuple[dict, dict[str, str]]:
    status, payload, headers = http_json(url)

    if status != 200 or payload.get("status") != "ok":
        fail(
            f"{service} health expected HTTP 200/status=ok, "
            f"got HTTP {status}: {payload}"
        )

    log(f"PASS health: {service}")
    return payload, headers


def check_compose_runtime() -> None:
    run_ok(["docker", "--version"])
    run_ok(["docker", "compose", "version"])
    compose("config", "--quiet")

    running = compose(
        "ps",
        "--services",
        "--status",
        "running",
    )

    running_services = {
        line.strip()
        for line in running.stdout.splitlines()
        if line.strip()
    }

    missing = sorted(
        REQUIRED_SERVICES - running_services
    )

    if missing:
        fail(
            "required Compose services are not running: "
            + ", ".join(missing)
        )

    log("PASS Compose runtime: required 9 services running")


def check_postgres() -> None:
    result = compose(
        "exec",
        "-T",
        "postgres",
        "sh",
        "-lc",
        'pg_isready -U "$POSTGRES_USER" -d postgres',
    )

    if "accepting connections" not in result.stdout:
        fail(
            "PostgreSQL pg_isready did not report accepting connections: "
            + result.stdout.strip()
        )

    log("PASS health: postgres")


def check_http_services() -> None:
    assert_health(
        "policy-db-api",
        f"{POLICY_DB_BASE_URL}/health",
    )
    assert_health(
        "policy",
        f"{POLICY_BASE_URL}/health",
    )
    assert_health(
        "decision-db-api",
        f"{DECISION_DB_BASE_URL}/health",
    )
    assert_health(
        "evidence-api",
        f"{EVIDENCE_BASE_URL}/health",
    )

    payload, headers = assert_health(
        "gateway",
        f"{GATEWAY_BASE_URL}/health",
    )

    if payload.get("service") != "gateway":
        fail(f"gateway health service mismatch: {payload}")

    if not headers.get("x-request-id"):
        fail("gateway health response is missing x-request-id")

    log("PASS gateway x-request-id")


def check_scanner() -> None:
    script = """
fetch('http://127.0.0.1:3001/health/ready')
  .then(async (response) => {
    const body = await response.text();
    console.log(`HTTP ${response.status}`);
    console.log(body);
    process.exit(response.ok ? 0 : 1);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
""".strip()

    result = compose(
        "exec",
        "-T",
        "scanner",
        "node",
        "-e",
        script,
    )

    if "HTTP 200" not in result.stdout or '"status":"ok"' not in result.stdout:
        fail(
            "scanner /health/ready unexpected response: "
            + result.stdout.strip()
        )

    log("PASS health: scanner")


def check_verdaccio() -> None:
    result = compose(
        "exec",
        "-T",
        "verdaccio",
        "wget",
        "-qO-",
        "http://127.0.0.1:4873/-/ping",
    )

    if result.stdout.strip() != "{}":
        fail(
            "Verdaccio /-/ping unexpected response: "
            + result.stdout.strip()
        )

    compose(
        "exec",
        "-T",
        "verdaccio",
        "sh",
        "-lc",
        "grep -Eq '^[[:space:]]*guard_enabled:[[:space:]]*true' /verdaccio/conf/config.yaml",
    )

    log("PASS health: verdaccio")
    log("PASS Verdaccio guard_enabled=true")


def check_dashboard() -> None:
    compose(
        "exec",
        "-T",
        "dashboard",
        "sh",
        "-lc",
        "wget -q -O /dev/null http://127.0.0.1/api/health",
    )
    log("PASS health: dashboard")


def check_gateway_scanner_enabled() -> None:
    result = compose(
        "exec",
        "-T",
        "gateway",
        "sh",
        "-lc",
        'printf "%s" "$SCANNER_ENABLED"',
    )

    if result.stdout.strip().lower() != "true":
        fail(
            "Gateway SCANNER_ENABLED must be true, got: "
            + repr(result.stdout.strip())
        )

    log("PASS Gateway SCANNER_ENABLED=true")


def windows_path_if_needed(path: str) -> str:
    if os.name != "nt" or not path.startswith("/"):
        return path

    converted = run(
        ["cygpath", "-w", path],
    )

    if converted.returncode == 0 and converted.stdout.strip():
        return converted.stdout.strip()

    return path


def check_npm_metadata(
    npmrc: str | None,
    package: str,
    version: str,
) -> None:
    if not npmrc:
        fail(
            "npm auth config is required for metadata preflight. "
            "Pass --npmrc <path> or set QA_NPMRC."
        )

    npmrc_for_child = windows_path_if_needed(npmrc)

    child_env = os.environ.copy()
    child_env["NPM_CONFIG_USERCONFIG"] = npmrc_for_child

    target = f"{package}@{version}"

    result = run_ok(
        [
            NPM_COMMAND,
            "view",
            target,
            "version",
            "--json",
            f"--registry={REGISTRY_URL}",
        ],
        env=child_env,
        timeout=60,
    )

    try:
        observed_version = json.loads(
            result.stdout.strip()
        )
    except json.JSONDecodeError:
        fail(
            "npm view returned invalid JSON: "
            + result.stdout.strip()
        )

    if observed_version != version:
        fail(
            f"npm metadata version mismatch for {target}: "
            f"expected {version}, got {observed_version!r}"
        )

    log(
        f"PASS Gateway npm metadata: {target} -> {observed_version}"
    )


def decision_lookup(
    package: str,
    version: str,
    integrity: str,
) -> dict:
    url = f"{DECISION_DB_BASE_URL}/internal/v1/decisions/lookup"
    body = {
        "requestId": str(uuid.uuid4()),
        "packages": [
            {
                "packageName": package,
                "version": version,
                "integrity": integrity,
            }
        ],
    }
    request = Request(
        url=url,
        data=json.dumps(body).encode("utf-8"),
        method="POST",
        headers={"Content-Type": "application/json"},
    )

    try:
        with urlopen(request, timeout=TIMEOUT_SECONDS) as response:
            raw_body = response.read().decode("utf-8")
            status = response.status
    except HTTPError as exc:
        raw_body = exc.read().decode("utf-8", errors="replace")
        fail(f"POST {url} returned HTTP {exc.code}: {raw_body}")
    except URLError as exc:
        fail(f"POST {url} connection failed: {exc.reason}")

    if status != 200:
        fail(f"POST {url} expected HTTP 200, got {status}: {raw_body}")

    try:
        payload = json.loads(raw_body)
        results = payload["results"]
        result = results[0]
    except (json.JSONDecodeError, KeyError, IndexError, TypeError):
        fail(f"Decision lookup returned unexpected JSON: {raw_body}")

    if len(results) != 1:
        fail(f"Decision lookup expected one result: {payload}")

    return result


def run_full(args: argparse.Namespace) -> None:
    if not args.npmrc:
        fail(
            "npm auth config is required for full Critical Path. "
            "Pass --npmrc <path> or set QA_NPMRC."
        )

    target = f"{args.package}@{args.version}"
    child_env = os.environ.copy()
    child_env["NPM_CONFIG_USERCONFIG"] = windows_path_if_needed(args.npmrc)

    integrity_result = run_ok(
        [
            NPM_COMMAND,
            "view",
            target,
            "dist.integrity",
            "--json",
            f"--registry={REGISTRY_URL}",
        ],
        env=child_env,
        timeout=60,
    )

    try:
        integrity = json.loads(integrity_result.stdout.strip())
    except json.JSONDecodeError:
        fail(
            "npm view dist.integrity returned invalid JSON: "
            + integrity_result.stdout.strip()
        )

    if not isinstance(integrity, str) or not integrity.strip():
        fail(f"npm package is missing dist.integrity: {target}")

    integrity = integrity.strip()
    before = decision_lookup(args.package, args.version, integrity)
    before_status = before.get("lookupStatus")

    if before_status == "FOUND" and before.get("decision") != "ACCEPT":
        fail(
            "existing Decision must be ACCEPT for reusable Critical Path: "
            + json.dumps(before, ensure_ascii=False)
        )
    if before_status not in {"FOUND", "NOT_FOUND"}:
        fail(
            "unexpected Decision pre-lookup: "
            + json.dumps(before, ensure_ascii=False)
        )

    log(
        "PASS Decision pre-lookup: "
        + (
            "NOT_FOUND fresh analysis path"
            if before_status == "NOT_FOUND"
            else "FOUND/ACCEPT reusable path"
        )
    )

    with tempfile.TemporaryDirectory(
        prefix="whs-critical-path-"
    ) as temp_dir:
        workdir = Path(temp_dir)
        cache_dir = workdir / "npm-cache"
        cache_dir.mkdir()
        (workdir / "package.json").write_text(
            json.dumps(
                {
                    "name": "whs-critical-path-qa",
                    "version": "1.0.0",
                    "private": True,
                }
            ),
            encoding="utf-8",
        )

        install = run_ok(
            [
                NPM_COMMAND,
                "install",
                target,
                f"--prefix={workdir}",
                f"--registry={REGISTRY_URL}",
                f"--cache={cache_dir}",
                "--prefer-online",
                "--fetch-retries=0",
                "--ignore-scripts",
                "--no-audit",
                "--no-fund",
            ],
            env=child_env,
            timeout=300,
        )
        log(f"PASS npm install through Gateway: {target} exit={install.returncode}")

        run_ok(
            [
                NPM_COMMAND,
                "ls",
                target,
                f"--prefix={workdir}",
                "--depth=0",
            ],
            env=child_env,
            timeout=60,
        )
        log(f"PASS installed package verification: {target}")

    after = decision_lookup(args.package, args.version, integrity)
    if (
        after.get("lookupStatus") != "FOUND"
        or after.get("decision") != "ACCEPT"
    ):
        fail(
            "Decision post-lookup expected FOUND/ACCEPT: "
            + json.dumps(after, ensure_ascii=False)
        )

    log("PASS Decision post-lookup: FOUND/ACCEPT")
    if before_status == "NOT_FOUND":
        log(
            "PASS fresh path: DDB MISS -> Scanner/Policy -> "
            "Decision persistence -> Gateway install"
        )
    else:
        log(
            "PASS reusable path: existing ACCEPT -> "
            "Decision revalidation -> Gateway install"
        )
    log("PASS full Critical Path E2E")

def run_preflight(args: argparse.Namespace) -> None:
    log("starting Critical Path E2E preflight")

    check_compose_runtime()
    check_postgres()
    check_http_services()
    check_scanner()
    check_gateway_scanner_enabled()
    check_verdaccio()
    check_dashboard()
    check_npm_metadata(
        args.npmrc,
        args.package,
        args.version,
    )

    log("PASS Critical Path E2E preflight")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "WHS npm Critical Path E2E QA. "
            "Runs preflight first, then an authenticated npm install Critical Path unless --preflight-only is set."
        )
    )

    parser.add_argument(
        "--preflight-only",
        action="store_true",
        help="run non-destructive runtime and metadata checks only",
    )
    parser.add_argument(
        "--npmrc",
        default=os.getenv("QA_NPMRC") or os.getenv("NPM_CONFIG_USERCONFIG"),
        help="temporary authenticated npmrc path (or QA_NPMRC env)",
    )
    parser.add_argument(
        "--package",
        default=os.getenv("E2E_PACKAGE", "is-number"),
        help="npm package used for Critical Path E2E",
    )
    parser.add_argument(
        "--version",
        default=os.getenv("E2E_PACKAGE_VERSION", "7.0.0"),
        help="expected package version",
    )

    return parser.parse_args()


def main() -> int:
    args = parse_args()

    try:
        run_preflight(args)

        if args.preflight_only:
            return 0

        run_full(args)
        return 0

    except CriticalPathError as exc:
        log(f"FAIL {exc}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
