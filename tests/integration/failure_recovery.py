#!/usr/bin/env python3

import base64
import hashlib
import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone
from http.client import RemoteDisconnected
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
from uuid import uuid4


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

TIMEOUT_SECONDS = float(
    os.getenv("FAILURE_RECOVERY_TIMEOUT_SECONDS", "10")
)

RECOVERY_TIMEOUT_SECONDS = float(
    os.getenv("FAILURE_RECOVERY_WAIT_SECONDS", "60")
)


class FailureRecoveryError(RuntimeError):
    pass


def log(message: str) -> None:
    print(
        f"[failure-recovery] {message}",
        flush=True,
    )


def fail(message: str) -> None:
    raise FailureRecoveryError(message)


def request_json(
    method: str,
    url: str,
    payload: dict | None = None,
) -> tuple[int, dict]:
    body = None
    headers = {
        "Accept": "application/json",
    }

    if payload is not None:
        body = json.dumps(
            payload
        ).encode("utf-8")

        headers["Content-Type"] = (
            "application/json"
        )

    request = Request(
        url=url,
        data=body,
        headers=headers,
        method=method,
    )

    try:
        with urlopen(
            request,
            timeout=TIMEOUT_SECONDS,
        ) as response:
            status = response.status
            raw_body = (
                response.read()
                .decode("utf-8")
            )

    except HTTPError as exc:
        status = exc.code
        raw_body = (
            exc.read()
            .decode(
                "utf-8",
                errors="replace",
            )
        )

    except URLError as exc:
        fail(
            f"{method} {url} "
            f"connection failed: {exc.reason}"
        )

    except (
        RemoteDisconnected,
        ConnectionResetError,
        TimeoutError,
    ) as exc:
        fail(
            f"{method} {url} "
            f"connection not ready: {exc}"
        )

    if not raw_body:
        return status, {}

    try:
        return (
            status,
            json.loads(raw_body),
        )

    except json.JSONDecodeError:
        fail(
            f"{method} {url} "
            f"returned invalid JSON: "
            f"{raw_body}"
        )


def compose(*args: str) -> None:
    command = [
        "docker",
        "compose",
        *args,
    ]

    log(
        "RUN "
        + " ".join(command)
    )

    subprocess.run(
        command,
        check=True,
    )


def make_integrity(
    seed: str,
) -> str:
    digest = hashlib.sha512(
        seed.encode("utf-8")
    ).digest()

    encoded = base64.b64encode(
        digest
    ).decode("ascii")

    return (
        f"sha512-{encoded}"
    )


def evaluation_payload(
    label: str,
) -> dict:
    run_id = uuid4().hex

    package_name = (
        f"qa-failure-"
        f"{label}-"
        f"{run_id[:10]}"
    )

    package_version = "1.0.0"

    artifact_seed = f"{package_name}@{package_version}"
    artifact_hash = hashlib.sha256(
        artifact_seed.encode("utf-8")
    ).hexdigest()
    integrity = make_integrity(artifact_seed)

    observed_at = (
        datetime.now(
            timezone.utc
        )
        .isoformat()
        .replace(
            "+00:00",
            "Z",
        )
    )

    scan_id = str(uuid4())

    evidence_subject = {
        "ecosystem": "npm",
        "packageName": package_name,
        "packageVersion": package_version,
        "artifactHash": artifact_hash,
    }
    evaluation_subject = {
        **evidence_subject,
        "integrity": integrity,
    }

    return {
        "requestId": str(uuid4()),
        "scanStatus": "COMPLETED",
        "scanId": scan_id,
        "subject": evaluation_subject,
        "score": 95,
        "expectedArtifactHash": artifact_hash,
        "osvFeed": {
            "source": "OSV",
            "feedStatus": "SKIPPED",
            "query": {
                "ecosystem": "npm",
                "packageName": package_name,
                "packageVersion": package_version,
            },
            "advisories": [],
            "complete": False,
            "pagesFetched": 0,
            "collectedAt": None,
            "completedAt": None,
            "errorCode": None,
            "skippedReason": "DISABLED",
        },
        "evidences": [
            {
                "schemaVersion": "0.1",
                "evidenceId": (
                    f"ev_{uuid4().hex}"
                ),
                "kind": "ATOMIC",
                "signal": {
                    "id": (
                        "QA-FAILURE-"
                        "RECOVERY-SAFE"
                    ),
                    "type": (
                        "PACKAGE_METADATA"
                    ),
                    "category": (
                        "METADATA"
                    ),
                },
                "subject": evidence_subject,
                "assertion": {
                    "summary": (
                        "Failure/recovery "
                        "integration test "
                        "package metadata"
                    ),
                    "basis": (
                        "METADATA_VALUE"
                    ),
                },
                "sources": [
                    {
                        "analyzer": (
                            "qa-failure-"
                            "recovery"
                        ),
                        "analyzerVersion": (
                            "1.0.0"
                        ),
                        "ruleId": (
                            "QA-FAILURE-"
                            "RECOVERY-001"
                        ),
                    }
                ],
                "locations": [],
                "provenance": {
                    "scanId": scan_id,
                    "generatedBy": (
                        "EVIDENCE_"
                        "NORMALIZER"
                    ),
                    "observedAt": (
                        observed_at
                    ),
                },
                "limitations": [],
            }
        ],
    }


def assert_health(
    name: str,
    base_url: str,
) -> None:
    status, payload = (
        request_json(
            "GET",
            f"{base_url}/health",
        )
    )

    if (
        status != 200
        or payload.get("status")
        != "ok"
    ):
        fail(
            f"{name} health "
            f"expected 200/ok, "
            f"got {status}: "
            f"{payload}"
        )

    log(
        f"PASS health: {name}"
    )


def wait_for_health(
    name: str,
    base_url: str,
) -> None:
    deadline = (
        time.monotonic()
        + RECOVERY_TIMEOUT_SECONDS
    )

    last_error = "no response"

    while (
        time.monotonic()
        < deadline
    ):
        try:
            status, payload = (
                request_json(
                    "GET",
                    f"{base_url}/health",
                )
            )

            if (
                status == 200
                and payload.get("status")
                == "ok"
            ):
                log(
                    "PASS recovered "
                    f"health: {name}"
                )
                return

            last_error = (
                f"HTTP {status}: "
                f"{payload}"
            )

        except FailureRecoveryError as exc:
            last_error = str(exc)

        time.sleep(1)

    fail(
        f"{name} did not recover "
        f"within "
        f"{RECOVERY_TIMEOUT_SECONDS}s: "
        f"{last_error}"
    )


def assert_evaluation_success(
    label: str,
) -> None:
    status, payload = (
        request_json(
            "POST",
            (
                f"{POLICY_BASE_URL}"
                "/internal/v1/"
                "evaluations"
            ),
            evaluation_payload(
                label
            ),
        )
    )

    if status != 200:
        fail(
            "evaluation expected "
            f"HTTP 200, got "
            f"{status}: {payload}"
        )

    if (
        payload.get("decision")
        != "ACCEPT"
    ):
        fail(
            "evaluation expected "
            "ACCEPT, got: "
            f"{payload.get('decision')!r}"
        )

    persistence = (
        payload.get(
            "persistence"
        )
        or {}
    )

    if (
        persistence.get("saved")
        is not True
    ):
        fail(
            "evaluation was not "
            f"persisted: "
            f"{persistence}"
        )

    log(
        "PASS evaluation after "
        f"{label}: ACCEPT / saved"
    )


def assert_dependency_failure(
    *expected_codes: str,
) -> None:
    if not expected_codes:
        fail("dependency failure expected code is required")

    status, payload = (
        request_json(
            "POST",
            (
                f"{POLICY_BASE_URL}"
                "/internal/v1/"
                "evaluations"
            ),
            evaluation_payload(
                expected_codes[0].lower()
            ),
        )
    )

    detail = (
        payload.get("detail")
        or {}
    )

    actual_code = (
        payload.get("code")
        or detail.get("code")
    )

    if (
        status != 503
        or actual_code
        not in expected_codes
    ):
        expected = " or ".join(expected_codes)
        fail(
            "dependency failure "
            "contract mismatch: "
            f"expected HTTP 503/"
            f"{expected}, "
            f"got HTTP {status}/"
            f"{actual_code}: "
            f"{payload}"
        )

    log(
        "PASS dependency failure: "
        f"HTTP 503 / "
        f"{actual_code}"
    )


def main() -> int:
    policy_db_stopped = False
    decision_db_stopped = False

    try:
        log(
            "starting Failure / "
            "Recovery integration QA"
        )

        assert_health(
            "policy",
            POLICY_BASE_URL,
        )

        assert_health(
            "policy-db-api",
            POLICY_DB_BASE_URL,
        )

        assert_health(
            "decision-db-api",
            DECISION_DB_BASE_URL,
        )

        assert_evaluation_success(
            "baseline"
        )

        log(
            "SCENARIO 1: "
            "Policy DB API outage"
        )

        compose(
            "stop",
            "policy-db-api",
        )

        policy_db_stopped = True

        assert_health(
            "policy",
            POLICY_BASE_URL,
        )

        assert_dependency_failure(
            "POLICY_DB_UNAVAILABLE"
        )

        compose(
            "start",
            "policy-db-api",
        )

        policy_db_stopped = False

        wait_for_health(
            "policy-db-api",
            POLICY_DB_BASE_URL,
        )

        assert_evaluation_success(
            "policy-db-recovery"
        )

        log(
            "SCENARIO 2: "
            "Decision DB API outage"
        )

        compose(
            "stop",
            "decision-db-api",
        )

        decision_db_stopped = True

        assert_health(
            "policy",
            POLICY_BASE_URL,
        )

        assert_dependency_failure(
            "FEED_PERSISTENCE_UNAVAILABLE",
            "FEED_PERSISTENCE_TIMEOUT",
        )

        compose(
            "start",
            "decision-db-api",
        )

        decision_db_stopped = False

        wait_for_health(
            "decision-db-api",
            DECISION_DB_BASE_URL,
        )

        assert_evaluation_success(
            "decision-db-recovery"
        )

        log(
            "PASS Failure / "
            "Recovery scenarios"
        )

        return 0

    except (
        FailureRecoveryError,
        subprocess.CalledProcessError,
    ) as exc:
        log(
            f"FAIL {exc}"
        )
        return 1

    finally:
        services = []

        if policy_db_stopped:
            services.append(
                "policy-db-api"
            )

        if decision_db_stopped:
            services.append(
                "decision-db-api"
            )

        if services:
            try:
                compose(
                    "start",
                    *services,
                )

                log(
                    "cleanup: stopped "
                    "dependency services "
                    "restarted"
                )

            except (
                subprocess
                .CalledProcessError
            ) as exc:
                log(
                    "WARN cleanup failed: "
                    f"{exc}"
                )


if __name__ == "__main__":
    sys.exit(main())
