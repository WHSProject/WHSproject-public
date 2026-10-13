from datetime import datetime, timezone
from pathlib import Path
from uuid import UUID

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from app import decision_db_api
from app.decision_models import FeedPersistenceRequest


REQUEST_ID = UUID("10000000-0000-4000-8000-000000000001")
SCAN_ID = UUID("20000000-0000-4000-8000-000000000001")
SNAPSHOT_ID = UUID("30000000-0000-4000-8000-000000000001")
ATTEMPT_ID = UUID("40000000-0000-4000-8000-000000000001")


def payload(status: str = "SUCCESS") -> dict:
    now = datetime(2026, 9, 23, tzinfo=timezone.utc).isoformat()
    result = {
        "attempt": {
            "requestId": str(REQUEST_ID),
            "scanId": str(SCAN_ID),
            "ecosystem": "npm",
            "packageName": "demo",
            "packageVersion": "1.0.0",
            "source": "OSV",
            "feedStatus": status,
            "complete": status == "SUCCESS",
            "errorCode": "HTTP_ERROR" if status == "FAILED" else (
                "DEADLINE_EXCEEDED" if status == "TIMEOUT" else None
            ),
            "skippedReason": "DISABLED" if status == "SKIPPED" else None,
            "pagesFetched": 0 if status == "SKIPPED" else 1,
            "startedAt": now,
            "completedAt": now,
            "failureDetail": None if status == "SUCCESS" else "detail",
        },
        "snapshot": None,
    }
    if status == "SUCCESS":
        result["snapshot"] = {
            "ecosystem": "npm",
            "packageName": "demo",
            "packageVersion": "1.0.0",
            "source": "OSV",
            "rawAdvisories": [],
            "validationResult": {
                "validationStatus": "EMPTY",
                "advisories": [],
                "exclusions": [],
            },
            "contentDigest": "a" * 64,
            "collectedAt": now,
            "validatedAt": now,
        }
    return result


class FakeCursor:
    def __init__(self, rows, fail_on=None):
        self.rows = list(rows)
        self.fail_on = fail_on
        self.statements = []

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def execute(self, statement, parameters=None):
        normalized = " ".join(statement.split())
        self.statements.append((normalized, parameters))
        if self.fail_on and self.fail_on in normalized:
            raise RuntimeError("database write failed")

    def fetchone(self):
        return self.rows.pop(0)


class FakeConnection:
    def __init__(self, cursor):
        self._cursor = cursor

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def cursor(self):
        return self._cursor


def install_connection(monkeypatch, cursor):
    monkeypatch.setattr(decision_db_api, "connect", lambda: FakeConnection(cursor))


@pytest.mark.parametrize("status", ["SUCCESS", "FAILED", "TIMEOUT", "SKIPPED"])
def test_attempt_models_accept_all_feed_statuses(status):
    model = FeedPersistenceRequest(**payload(status))
    assert model.attempt.feedStatus == status
    assert (model.snapshot is not None) == (status == "SUCCESS")


def test_incomplete_or_failed_attempt_cannot_create_snapshot():
    value = payload("FAILED")
    value["snapshot"] = payload("SUCCESS")["snapshot"]
    with pytest.raises(ValidationError, match="Only complete SUCCESS attempts"):
        FeedPersistenceRequest(**value)


def test_incomplete_success_is_attempt_only():
    value = payload("SUCCESS")
    value["attempt"]["complete"] = False
    value["snapshot"] = None
    model = FeedPersistenceRequest(**value)
    assert model.attempt.feedStatus == "SUCCESS"
    assert model.attempt.complete is False
    assert model.snapshot is None


def test_success_snapshot_is_inserted_and_linked_to_attempt(monkeypatch):
    cursor = FakeCursor([None, None, (SNAPSHOT_ID,), (ATTEMPT_ID,)])
    install_connection(monkeypatch, cursor)
    result = decision_db_api.save_feed_lookup(FeedPersistenceRequest(**payload()))
    assert result.attemptId == ATTEMPT_ID
    assert result.snapshotId == SNAPSHOT_ID
    assert result.snapshotReused is False
    snapshot_insert = next(sql for sql, _ in cursor.statements if "INSERT INTO feed_snapshots" in sql)
    assert "validated_at, expires_at" in snapshot_insert
    assert "%s + INTERVAL '1 hour'" in snapshot_insert


def test_active_same_digest_snapshot_is_reused_without_timestamp_update(monkeypatch):
    cursor = FakeCursor([None, (SNAPSHOT_ID,), (ATTEMPT_ID,)])
    install_connection(monkeypatch, cursor)
    result = decision_db_api.save_feed_lookup(FeedPersistenceRequest(**payload()))
    assert result.snapshotId == SNAPSHOT_ID
    assert result.snapshotReused is True
    assert not any("INSERT INTO feed_snapshots" in sql for sql, _ in cursor.statements)
    assert not any("UPDATE feed_snapshots" in sql for sql, _ in cursor.statements)
    reuse_select = next(sql for sql, _ in cursor.statements if "FROM feed_snapshots" in sql)
    assert "expires_at > GREATEST(%s, CURRENT_TIMESTAMP)" in reuse_select
    assert "expires_at <= %s" not in reuse_select


def test_expired_same_digest_snapshot_creates_a_new_success_snapshot(monkeypatch):
    # The DB query returns no reusable snapshot, but still reports the latest expired digest.
    cursor = FakeCursor([None, (None, None, SNAPSHOT_ID, "a" * 64), (SNAPSHOT_ID,), (ATTEMPT_ID,)])
    install_connection(monkeypatch, cursor)
    result = decision_db_api.save_feed_lookup(FeedPersistenceRequest(**payload()))
    assert result.snapshotReused is False
    assert any("INSERT INTO feed_snapshots" in sql for sql, _ in cursor.statements)
    assert not any("UPDATE feed_snapshots" in sql for sql, _ in cursor.statements)
    reuse_select = next(sql for sql, _ in cursor.statements if "FROM feed_snapshots" in sql)
    assert "expires_at > GREATEST(%s, CURRENT_TIMESTAMP)" in reuse_select


def test_failed_lookup_does_not_update_existing_snapshot_ttl(monkeypatch):
    cursor = FakeCursor([None, (ATTEMPT_ID,)])
    install_connection(monkeypatch, cursor)
    result = decision_db_api.save_feed_lookup(FeedPersistenceRequest(**payload("FAILED")))
    assert result.snapshotId is None
    assert not any("feed_snapshots" in sql for sql, _ in cursor.statements)


def test_request_id_retry_returns_existing_attempt(monkeypatch):
    cursor = FakeCursor([(ATTEMPT_ID, SNAPSHOT_ID)])
    install_connection(monkeypatch, cursor)
    result = decision_db_api.save_feed_lookup(FeedPersistenceRequest(**payload()))
    assert result.attemptId == ATTEMPT_ID
    assert result.snapshotId == SNAPSHOT_ID
    assert not any("INSERT INTO" in sql for sql, _ in cursor.statements)


@pytest.mark.parametrize(
    ("fail_on", "code"),
    [
        ("INSERT INTO feed_snapshots", "FEED_SNAPSHOT_PERSISTENCE_FAILED"),
        ("INSERT INTO feed_lookup_attempts", "FEED_ATTEMPT_PERSISTENCE_FAILED"),
    ],
)
def test_snapshot_and_attempt_storage_errors_are_distinct(monkeypatch, fail_on, code):
    rows = [None, None]
    if fail_on == "INSERT INTO feed_lookup_attempts":
        rows.append((SNAPSHOT_ID,))
    cursor = FakeCursor(rows, fail_on=fail_on)
    install_connection(monkeypatch, cursor)
    with pytest.raises(HTTPException) as raised:
        decision_db_api.save_feed_lookup(FeedPersistenceRequest(**payload()))
    assert raised.value.status_code == 503
    assert raised.value.detail["code"] == code


def test_migration_enforces_utc_timestamps_ttl_and_nullable_decision_links():
    migration = (
        Path(__file__).parents[3]
        / "infra/postgres/migrations/decision/005_add_feed_persistence.sql"
    ).read_text(encoding="utf-8")
    assert "TIMESTAMPTZ NOT NULL" in migration
    assert "expires_at = validated_at + INTERVAL '1 hour'" in migration
    assert "feed_snapshot_id UUID REFERENCES feed_snapshots(id)" in migration
    assert "feed_evidence_ids TEXT[]" in migration

    provenance_migration = (
        Path(__file__).parents[3]
        / "infra/postgres/migrations/decision/006_add_decision_provenance.sql"
    ).read_text(encoding="utf-8")
    assert "assessment_ids TEXT[]" in provenance_migration
