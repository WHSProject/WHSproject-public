"""Offline fixture Policy/DB smoke for W7-DF-03/04/08.

Run only against an isolated Compose project. DB credentials come from env.
"""

import hashlib
import json
import os
import sys
from datetime import datetime, timezone
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from uuid import uuid4

import psycopg


POLICY_URL = os.environ.get("POLICY_BASE_URL", "http://127.0.0.1:28000")


def evaluate(payload):
    request = Request(
        f"{POLICY_URL}/internal/v1/evaluations",
        data=json.dumps(payload).encode(),
        headers={"content-type": "application/json"},
        method="POST",
    )
    try:
        with urlopen(request, timeout=40) as response:
            assert response.status == 200
            return json.load(response)
    except HTTPError as error:
        result = json.load(error)
        raise AssertionError(f"Policy HTTP {error.code}: {result.get('code')}: {result.get('message')}") from error


def payload(kind, status, advisory=False):
    request_id, scan_id = str(uuid4()), str(uuid4())
    package_name = f"w7-fixture-{uuid4().hex[:12]}"
    artifact_hash = hashlib.sha256(package_name.encode()).hexdigest()
    now = datetime.now(timezone.utc).isoformat()
    subject = {
        "ecosystem": "npm", "packageName": package_name,
        "packageVersion": "1.0.0", "artifactHash": artifact_hash,
    }
    evidence = {
        "schemaVersion": "0.1", "evidenceId": f"ev_{uuid4().hex}",
        "kind": kind, "analysisPass": "TIER2" if kind == "CORRELATED" else "TIER1",
        "signal": {"type": "PACKAGE_METADATA"}, "subject": {**subject},
        "assertion": {"summary": "Fixture package metadata"},
        "provenance": {"scanId": scan_id},
    }
    complete = status == "SUCCESS"
    advisories = []
    if advisory:
        advisories.append({
            "id": "GHSA-w7-fixture-1234",
            "affected": [{"package": {"ecosystem": "npm", "name": package_name},
                          "ranges": [{"type": "SEMVER", "events": [{"introduced": "0"}]}]}],
            "database_specific": {"severity": "HIGH"},
        })
    return {
        "requestId": request_id, "scanId": scan_id, "scanStatus": "COMPLETED",
        "subject": {**subject, "integrity": "sha512-fixture"},
        "evidences": [evidence],
        "osvFeed": {
            "source": "OSV", "feedStatus": status,
            "query": {key: subject[key] for key in ("ecosystem", "packageName", "packageVersion")},
            "advisories": advisories, "complete": complete,
            "pagesFetched": 1 if complete else 0,
            "collectedAt": now if complete else None,
            "completedAt": now if complete else None,
            "errorCode": "NETWORK_ERROR" if status == "FAILED" else "DEADLINE_EXCEEDED" if status == "TIMEOUT" else None,
            "skippedReason": "DISABLED" if status == "SKIPPED" else None,
        },
    }


def run():
    connection = psycopg.connect(
        host=os.environ.get("DB_HOST", "127.0.0.1"), port=int(os.environ.get("DB_PORT", os.environ.get("POSTGRES_PORT", "25432"))),
        user=os.environ.get("DB_USER", os.environ.get("POSTGRES_USER", "w7test")),
        password=os.environ.get("DB_PASSWORD", os.environ.get("POSTGRES_PASSWORD", "")),
        dbname="decision_db",
    )
    try:
        with connection:
            for kind, status, advisory in [
                ("ATOMIC", "SUCCESS", True),
                ("CORRELATED", "SUCCESS", False),
                ("ATOMIC", "FAILED", False),
                ("ATOMIC", "TIMEOUT", False),
                ("ATOMIC", "SKIPPED", False),
            ]:
                case = payload(kind, status, advisory)
                first = evaluate(case)
                again = evaluate(case)
                assert first["decisionId"] == again["decisionId"]
                assert first["requestId"] == case["requestId"]
                assert first["scanId"] == case["scanId"]
                assert first["score"] is None
                with connection.cursor() as cursor:
                    cursor.execute("SELECT decision_id, score, feed_snapshot_id, feed_evidence_ids, judgment_id FROM decisions WHERE request_id = %s", (case["requestId"],))
                    decisions = cursor.fetchall()
                    assert len(decisions) == 1 and decisions[0][0] == first["decisionId"]
                    assert decisions[0][1] is None
                    cursor.execute("SELECT feed_status, snapshot_id, scan_id, package_name, pages_fetched FROM feed_lookup_attempts WHERE request_id = %s", (case["requestId"],))
                    attempts = cursor.fetchall()
                    assert len(attempts) == 1 and attempts[0][0] == status
                    assert str(attempts[0][2]) == case["scanId"]
                    assert attempts[0][3] == case["subject"]["packageName"]
                    assert bool(attempts[0][1]) == (status == "SUCCESS")
                    assert decisions[0][2] == attempts[0][1]
                    cursor.execute("SELECT run_mode, status, provider, model, prompt_version, input_hash, response_json, judgment_json, resolved_decision, resolved_reason_code, duration_ms, evaluated_at FROM policy_llm_judgments WHERE request_id = %s ORDER BY run_mode", (case["requestId"],))
                    audits = cursor.fetchall()
                    assert [row[0] for row in audits] == ["PRIMARY", "SHADOW"]
                    assert all(row[1] == "COMPLETED" and row[2] == "fixture" and row[3] == "fixture" for row in audits)
                    assert all(row[4] == "policy-judgment-v2" and len(row[5]) == 64 for row in audits)
                    assert all(row[6] is not None and row[7] is not None and row[8] is not None and row[9] is not None and row[10] >= 0 and row[11] is not None for row in audits)
                    assert audits[0][7]["judgmentId"] == decisions[0][4]
                print(f"PASS {kind} {status} advisory={advisory}: decision/attempt/audit/idempotence")
            malformed = payload("ATOMIC", "SUCCESS")
            malformed["osvFeed"]["advisories"] = [{"id": "GHSA-invalid-without-affected"}]
            evaluate(malformed)
            with connection.cursor() as cursor:
                cursor.execute("SELECT s.raw_advisories, s.validation_result FROM feed_lookup_attempts a JOIN feed_snapshots s ON s.id = a.snapshot_id WHERE a.request_id = %s", (malformed["requestId"],))
                raw, validation = cursor.fetchone()
                assert len(raw) == 1 and validation["validationStatus"] == "ALL_EXCLUDED"
                assert validation["exclusions"][0]["code"] == "INVALID_AFFECTED"
            print("PASS invalid advisory: raw preserved, validation excluded, successful empty-citation Snapshot")

            recovered = payload("ATOMIC", "FAILED")
            failed_decision = evaluate(recovered)
            recovered["requestId"] = str(uuid4())
            recovered["osvFeed"].update({
                "feedStatus": "SUCCESS", "complete": True, "pagesFetched": 1,
                "collectedAt": datetime.now(timezone.utc).isoformat(),
                "completedAt": datetime.now(timezone.utc).isoformat(), "errorCode": None,
            })
            success_decision = evaluate(recovered)
            assert failed_decision["decisionId"] != success_decision["decisionId"]
            with connection.cursor() as cursor:
                cursor.execute("SELECT count(*), count(feed_snapshot_id) FROM decisions WHERE package_name = %s", (recovered["subject"]["packageName"],))
                assert cursor.fetchone() == (2, 1)
            print("PASS feed failure then recovery: old Decision preserved, new Snapshot/Decision stored")

            incomplete = payload("ATOMIC", "SUCCESS")
            incomplete["osvFeed"]["complete"] = False
            try:
                evaluate(incomplete)
            except AssertionError as error:
                assert "HTTP 422" in str(error) and "INVALID_OSV_SUCCESS_STATE" in str(error)
            else:
                raise AssertionError("SUCCESS complete=false must be rejected")
            with connection.cursor() as cursor:
                cursor.execute("SELECT count(*) FROM feed_lookup_attempts WHERE request_id = %s", (incomplete["requestId"],))
                assert cursor.fetchone()[0] == 0
            print("PASS SUCCESS complete=false: rejected before Attempt/Snapshot")
    finally:
        connection.close()


def run_osv_target():
    """The target-only fixture selects the active OSV Rule without benign support."""
    case = payload("ATOMIC", "SUCCESS", True)
    connection = psycopg.connect(
        host=os.environ.get("DB_HOST", "127.0.0.1"),
        port=int(os.environ.get("DB_PORT", "5432")),
        user=os.environ.get("DB_USER", os.environ.get("POSTGRES_USER", "w7test")),
        password=os.environ.get("DB_PASSWORD", os.environ.get("POSTGRES_PASSWORD", "")),
        dbname="decision_db",
    )
    try:
        first = evaluate(case)
        again = evaluate(case)
        assert first["decisionId"] == again["decisionId"]
        with connection.cursor() as cursor:
            cursor.execute("SELECT decision, reason_code, feed_snapshot_id, feed_evidence_ids, score FROM decisions WHERE request_id = %s", (case["requestId"],))
            decision = cursor.fetchone()
            assert decision is not None and decision[0] == "REVIEW" and decision[1] == "OSV_ADVISORY_REVIEW"
            assert decision[2] is not None and decision[3] == ["osv:GHSA-w7-fixture-1234"] and decision[4] is None
            cursor.execute("SELECT id, snapshot_id FROM feed_lookup_attempts WHERE request_id = %s", (case["requestId"],))
            attempts = cursor.fetchall()
            assert len(attempts) == 1 and attempts[0][1] == decision[2]
            cursor.execute("SELECT raw_advisories, validation_result, content_digest, validated_at, expires_at FROM feed_snapshots WHERE id = %s", (decision[2],))
            snapshot = cursor.fetchone()
            assert snapshot is not None and len(snapshot[0]) == 1
            assert snapshot[1]["validationStatus"] == "VALID" and snapshot[1]["exclusions"] == []
            assert snapshot[1]["advisories"][0]["feedEvidenceId"] == decision[3][0]
            assert len(snapshot[2]) == 64 and (snapshot[4] - snapshot[3]).total_seconds() == 3600
            cursor.execute("SELECT run_mode, status, judgment_json, response_json, resolved_decision, resolved_reason_code, failure_code FROM policy_llm_judgments WHERE request_id = %s ORDER BY run_mode", (case["requestId"],))
            audits = cursor.fetchall()
            assert [audit[0] for audit in audits] == ["PRIMARY", "SHADOW"]
            assert all(audit[1] == "COMPLETED" and audit[4:6] == ("REVIEW", "OSV_ADVISORY_REVIEW") and audit[6] is None for audit in audits)
            for audit in audits:
                osv_rule = next(rule for rule in audit[2]["ruleEvaluations"] if rule["ruleId"] == "RULE-REVIEW-OSV-HIGH")
                assert osv_rule["status"] == "SATISFIED"
                assert osv_rule["predicateEvaluations"][0]["feedEvidenceIds"] == decision[3]
                assert json.loads(audit[3]["output_text"])["judgmentId"] == audit[2]["judgmentId"]
        print("PASS OSV target: Rule SATISFIED, Resolver REVIEW, citation/DB/audit/TTL/idempotence")
    finally:
        connection.close()


def run_feed_outage():
    case = payload("ATOMIC", "SUCCESS")
    try:
        evaluate(case)
    except AssertionError as error:
        assert "HTTP 503" in str(error) and "FEED_PERSISTENCE" in str(error)
    else:
        raise AssertionError("Feed DB outage must fail the Policy HTTP request")
    connection = psycopg.connect(
        host=os.environ.get("DB_HOST", "127.0.0.1"),
        port=int(os.environ.get("DB_PORT", "5432")),
        user=os.environ.get("DB_USER", os.environ.get("POSTGRES_USER", "w7test")),
        password=os.environ.get("DB_PASSWORD", os.environ.get("POSTGRES_PASSWORD", "")),
        dbname="decision_db",
    )
    try:
        with connection.cursor() as cursor:
            for table in ("feed_lookup_attempts", "decisions", "policy_llm_judgments"):
                cursor.execute(f"SELECT count(*) FROM {table} WHERE request_id = %s", (case["requestId"],))
                assert cursor.fetchone()[0] == 0
    finally:
        connection.close()
    print("PASS Feed DB outage: HTTP 503, no Attempt/Decision/Audit written")


def run_shadow_failure(expected_code="POLICY_LLM_HTTP_503"):
    case = payload("ATOMIC", "SUCCESS")
    first = evaluate(case)
    again = evaluate(case)
    assert first["decisionId"] == again["decisionId"] and first["score"] is None
    connection = psycopg.connect(
        host=os.environ.get("DB_HOST", "127.0.0.1"),
        port=int(os.environ.get("DB_PORT", "5432")),
        user=os.environ.get("DB_USER", os.environ.get("POSTGRES_USER", "w7test")),
        password=os.environ.get("DB_PASSWORD", os.environ.get("POSTGRES_PASSWORD", "")),
        dbname="decision_db",
    )
    try:
        with connection.cursor() as cursor:
            cursor.execute("SELECT decision, decision_id FROM decisions WHERE request_id = %s", (case["requestId"],))
            decisions = cursor.fetchall()
            assert len(decisions) == 1 and decisions[0][1] == first["decisionId"]
            cursor.execute("SELECT run_mode, status, provider, failure_code, response_json, resolved_decision FROM policy_llm_judgments WHERE request_id = %s ORDER BY run_mode", (case["requestId"],))
            audits = cursor.fetchall()
            assert len(audits) == 2
            assert audits[0][0:2] == ("PRIMARY", "COMPLETED") and audits[0][5] == decisions[0][0]
            assert audits[1][0:2] == ("SHADOW", "FAILED")
            assert audits[1][3] == expected_code
            assert audits[1][4] == ({"code": "fixture_provider_error"} if expected_code == "POLICY_LLM_HTTP_503" else None)
            cursor.execute("SELECT count(*) FROM feed_lookup_attempts WHERE request_id = %s", (case["requestId"],))
            assert cursor.fetchone()[0] == 1
    finally:
        connection.close()
    print(f"PASS Shadow {expected_code}: HTTP 200, Primary Decision/Audit retained, Shadow FAILED, no duplicate writes")


def run_primary_failure():
    case = payload("ATOMIC", "SUCCESS")
    result = evaluate(case)
    assert result["decision"] == "HOLD" and result["reasonCode"] == "POLICY_LLM_UNAVAILABLE"
    connection = psycopg.connect(
        host=os.environ.get("DB_HOST", "127.0.0.1"),
        port=int(os.environ.get("DB_PORT", "5432")),
        user=os.environ.get("DB_USER", os.environ.get("POSTGRES_USER", "w7test")),
        password=os.environ.get("DB_PASSWORD", os.environ.get("POSTGRES_PASSWORD", "")),
        dbname="decision_db",
    )
    try:
        with connection.cursor() as cursor:
            cursor.execute("SELECT decision, reason_code, score FROM decisions WHERE request_id = %s", (case["requestId"],))
            assert cursor.fetchone() == ("HOLD", "POLICY_LLM_UNAVAILABLE", None)
            cursor.execute("SELECT run_mode, status, failure_code, response_json, resolved_decision FROM policy_llm_judgments WHERE request_id = %s ORDER BY run_mode", (case["requestId"],))
            primary, shadow = cursor.fetchall()
            assert primary[0:3] == ("PRIMARY", "FAILED", "POLICY_LLM_HTTP_503")
            assert primary[3] == {"code": "fixture_provider_error"} and primary[4] == "HOLD"
            assert shadow[0:2] == ("SHADOW", "COMPLETED")
    finally:
        connection.close()
    print("PASS Primary provider 503: policy failure HOLD, Primary FAILED/raw response, Shadow cannot override")


if __name__ == "__main__":
    if "--osv-target" in sys.argv:
        run_osv_target()
    elif "--feed-outage" in sys.argv:
        run_feed_outage()
    elif "--shadow-failure" in sys.argv:
        run_shadow_failure()
    elif "--shadow-timeout" in sys.argv:
        run_shadow_failure("POLICY_LLM_TIMEOUT")
    elif "--primary-failure" in sys.argv:
        run_primary_failure()
    else:
        run()
