#!/usr/bin/env python3

import base64
import hashlib
import json
import os
import sys
from datetime import datetime, timezone
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
from uuid import UUID, uuid4


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
    os.getenv("SMOKE_TIMEOUT_SECONDS", "10")
)

EXPECTED_POLICY_KEY = os.getenv(
    "EXPECTED_POLICY_KEY",
    "qa-npm-policy",
)

EXPECTED_POLICY_VERSION = os.getenv(
    "EXPECTED_POLICY_VERSION",
    "0.1.0",
)


class SmokeTestError(RuntimeError):
    pass


def log(message: str) -> None:
    print(f"[policy-ddb-smoke] {message}", flush=True)


def fail(message: str) -> None:
    raise SmokeTestError(message)


def http_json(
    method: str,
    url: str,
    payload: dict | None = None,
    expected_status: int = 200,
) -> dict:
    body = None
    headers = {
        "Accept": "application/json",
    }

    if payload is not None:
        body = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"

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
            raw_body = response.read().decode("utf-8")

    except HTTPError as exc:
        error_body = exc.read().decode(
            "utf-8",
            errors="replace",
        )
        fail(
            f"{method} {url} returned HTTP {exc.code}: "
            f"{error_body}"
        )

    except URLError as exc:
        fail(
            f"{method} {url} connection failed: "
            f"{exc.reason}"
        )

    if status != expected_status:
        fail(
            f"{method} {url}: expected HTTP "
            f"{expected_status}, got {status}"
        )

    if not raw_body:
        return {}

    try:
        return json.loads(raw_body)
    except json.JSONDecodeError as exc:
        fail(
            f"{method} {url} returned invalid JSON: "
            f"{raw_body}"
        )
        raise exc


def assert_equal(
    actual,
    expected,
    message: str,
) -> None:
    if actual != expected:
        fail(
            f"{message}: expected {expected!r}, "
            f"got {actual!r}"
        )


def assert_true(
    condition: bool,
    message: str,
) -> None:
    if not condition:
        fail(message)


def make_integrity(seed: str) -> str:
    digest = hashlib.sha512(
        seed.encode("utf-8")
    ).digest()

    encoded = base64.b64encode(
        digest
    ).decode("ascii")

    return f"sha512-{encoded}"


def validate_uuid(value: str, field_name: str) -> None:
    try:
        UUID(value)
    except (ValueError, TypeError) as exc:
        fail(
            f"{field_name} is not a valid UUID: "
            f"{value!r}"
        )
        raise exc


def check_health(
    service_name: str,
    base_url: str,
) -> None:
    response = http_json(
        "GET",
        f"{base_url}/health",
    )

    assert_equal(
        response.get("status"),
        "ok",
        f"{service_name} health status",
    )

    log(
        f"PASS health: {service_name}"
    )


def main() -> int:
    run_id = uuid4().hex

    request_id = str(uuid4())
    scan_id = str(uuid4())

    package_name = (
        f"qa-smoke-{run_id[:12]}"
    )
    package_version = "1.0.0"

    artifact_seed = f"{package_name}@{package_version}"
    artifact_hash = hashlib.sha256(
        artifact_seed.encode("utf-8")
    ).hexdigest()
    integrity = make_integrity(artifact_seed)

    evidence_id = (
        f"ev_{uuid4().hex}"
    )

    log("starting Policy / Decision DB integration smoke")
    log(f"package={package_name}@{package_version}")
    log(f"requestId={request_id}")

    # 1. Runtime prerequisites
    check_health(
        "policy",
        POLICY_BASE_URL,
    )
    check_health(
        "policy-db-api",
        POLICY_DB_BASE_URL,
    )
    check_health(
        "decision-db-api",
        DECISION_DB_BASE_URL,
    )

    # 2. Active Published Policy 확인
    active_policy = http_json(
        "GET",
        (
            f"{POLICY_DB_BASE_URL}"
            "/internal/v1/policies/active"
        ),
    )

    assert_equal(
        active_policy.get("policyKey"),
        EXPECTED_POLICY_KEY,
        "active policy key",
    )

    assert_equal(
        active_policy.get("policyVersion"),
        EXPECTED_POLICY_VERSION,
        "active policy version",
    )

    assert_equal(
        active_policy.get("ecosystem"),
        "npm",
        "active policy ecosystem",
    )

    log(
        "PASS active policy: "
        f"{EXPECTED_POLICY_KEY}/"
        f"{EXPECTED_POLICY_VERSION}"
    )

    # 3. Policy Evaluation 실행
    observed_at = (
        datetime.now(timezone.utc)
        .isoformat()
        .replace("+00:00", "Z")
    )

    evaluation_payload = {
        "requestId": request_id,
        "scanStatus": "COMPLETED",
        "scanId": scan_id,
        "subject": {
            "ecosystem": "npm",
            "packageName": package_name,
            "packageVersion": package_version,
            "artifactHash": artifact_hash,
            "integrity": integrity,
        },
        "score": 95,
        "expectedArtifactHash": artifact_hash,
        "evidences": [
            {
                "schemaVersion": "0.1",
                "evidenceId": evidence_id,
                "kind": "ATOMIC",
                "signal": {
                    "id": "QA-SMOKE-SAFE",
                    "type": "PACKAGE_METADATA",
                    "category": "METADATA",
                },
                "subject": {
                    "ecosystem": "npm",
                    "packageName": package_name,
                    "packageVersion": package_version,
                    "artifactHash": artifact_hash,
                },
                "assertion": {
                    "summary": (
                        "Integration smoke test "
                        "package metadata"
                    ),
                    "basis": "METADATA_VALUE",
                },
                "sources": [
                    {
                        "analyzer": "qa-smoke",
                        "analyzerVersion": "1.0.0",
                        "ruleId": "QA-SMOKE-001",
                    }
                ],
                "locations": [],
                "provenance": {
                    "scanId": scan_id,
                    "generatedBy": (
                        "EVIDENCE_NORMALIZER"
                    ),
                    "observedAt": observed_at,
                },
                "limitations": [],
            }
        ],
        "osvFeed": {
            "source": "OSV",
            "feedStatus": "SUCCESS",
            "query": {
                "ecosystem": "npm",
                "packageName": package_name,
                "packageVersion": package_version,
            },
            "advisories": [],
            "complete": True,
            "pagesFetched": 1,
            "collectedAt": observed_at,
            "completedAt": observed_at,
            "errorCode": None,
            "skippedReason": None,
        },
    }

    decision = http_json(
        "POST",
        (
            f"{POLICY_BASE_URL}"
            "/internal/v1/evaluations"
        ),
        evaluation_payload,
    )

    assert_equal(
        decision.get("requestId"),
        request_id,
        "evaluation requestId",
    )

    assert_equal(
        decision.get("scanId"),
        scan_id,
        "evaluation scanId",
    )

    assert_equal(
        decision.get("decision"),
        "ACCEPT",
        "evaluation decision",
    )

    assert_equal(
        decision.get("policyVersion"),
        EXPECTED_POLICY_VERSION,
        "evaluation policyVersion",
    )

    subject = decision.get("subject") or {}

    assert_equal(
        subject.get("packageName"),
        package_name,
        "evaluation packageName",
    )

    assert_equal(
        subject.get("packageVersion"),
        package_version,
        "evaluation packageVersion",
    )

    assert_equal(
        subject.get("artifactHash"),
        artifact_hash,
        "evaluation artifactHash",
    )

    assert_equal(
        subject.get("integrity"),
        integrity,
        "evaluation integrity",
    )

    persistence = (
        decision.get("persistence") or {}
    )

    assert_true(
        persistence.get("saved") is True,
        "Decision persistence.saved must be true",
    )

    decision_db_id = persistence.get(
        "decisionDbId"
    )

    assert_true(
        bool(decision_db_id),
        "Decision persistence.decisionDbId "
        "must be present",
    )

    validate_uuid(
        decision_db_id,
        "decisionDbId",
    )

    decision_id = decision.get(
        "decisionId"
    )

    assert_true(
        isinstance(decision_id, str)
        and decision_id.startswith("dec_"),
        "decisionId must use dec_ prefix",
    )

    log(
        "PASS evaluation → Decision DB save: "
        f"decision={decision.get('decision')}, "
        f"decisionId={decision_id}"
    )

    # 4. Decision DB internal UUID GET
    stored = http_json(
        "GET",
        (
            f"{DECISION_DB_BASE_URL}"
            "/internal/v1/decisions/"
            f"{decision_db_id}"
        ),
    )

    assert_equal(
        stored.get("id"),
        decision_db_id,
        "stored internal id",
    )

    assert_equal(
        stored.get("decisionId"),
        decision_id,
        "stored decisionId",
    )

    assert_equal(
        stored.get("requestId"),
        request_id,
        "stored requestId",
    )

    assert_equal(
        stored.get("scanId"),
        scan_id,
        "stored scanId",
    )

    assert_equal(
        stored.get("decision"),
        "ACCEPT",
        "stored decision",
    )

    assert_equal(
        stored.get("policyKey"),
        EXPECTED_POLICY_KEY,
        "stored policyKey",
    )

    assert_equal(
        stored.get("policyVersion"),
        EXPECTED_POLICY_VERSION,
        "stored policyVersion",
    )

    feed_snapshot_id = stored.get(
        "feedSnapshotId"
    )

    assert_true(
        bool(feed_snapshot_id),
        "stored feedSnapshotId must be present",
    )

    validate_uuid(
        feed_snapshot_id,
        "feedSnapshotId",
    )

    assert_equal(
        stored.get("feedEvidenceIds"),
        None,
        "empty Feed has no cited feedEvidenceIds",
    )

    stored_subject = (
        stored.get("subject") or {}
    )

    assert_equal(
        stored_subject.get("packageName"),
        package_name,
        "stored packageName",
    )

    assert_equal(
        stored_subject.get("packageVersion"),
        package_version,
        "stored packageVersion",
    )

    assert_equal(
        stored_subject.get("artifactHash512"),
        integrity,
        "stored artifactHash512",
    )

    assert_equal(
        stored_subject.get("artifactHash256"),
        artifact_hash,
        "stored artifactHash256",
    )

    log(
        "PASS Decision DB GET by internal UUID"
    )

    # 5. Gateway 방식 Decision Lookup
    lookup_payload = {
        "requestId": request_id,
        "packages": [
            {
                "packageName": package_name,
                "version": package_version,
                "integrity": integrity,
            }
        ],
    }

    lookup = http_json(
        "POST",
        (
            f"{DECISION_DB_BASE_URL}"
            "/internal/v1/decisions/lookup"
        ),
        lookup_payload,
    )

    assert_equal(
        lookup.get("requestId"),
        request_id,
        "lookup requestId",
    )

    results = lookup.get("results")

    assert_true(
        isinstance(results, list)
        and len(results) == 1,
        "lookup must return exactly one result",
    )

    result = results[0]

    assert_equal(
        result.get("lookupStatus"),
        "FOUND",
        "lookup status",
    )

    assert_equal(
        result.get("decisionId"),
        decision_id,
        "lookup decisionId",
    )

    assert_equal(
        result.get("decision"),
        "ACCEPT",
        "lookup decision",
    )

    assert_equal(
        result.get("policyKey"),
        EXPECTED_POLICY_KEY,
        "lookup policyKey",
    )

    assert_equal(
        result.get("policyVersion"),
        EXPECTED_POLICY_VERSION,
        "lookup policyVersion",
    )

    log(
        "PASS Decision DB lookup: FOUND / ACCEPT"
    )

    log(
        "PASS Policy / Decision DB integration smoke"
    )

    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SmokeTestError as exc:
        print(
            f"[policy-ddb-smoke] FAIL: {exc}",
            file=sys.stderr,
            flush=True,
        )
        sys.exit(1)
    except KeyboardInterrupt:
        print(
            "[policy-ddb-smoke] interrupted",
            file=sys.stderr,
            flush=True,
        )
        sys.exit(130)
