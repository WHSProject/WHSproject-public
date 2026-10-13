from datetime import datetime, timezone
from uuid import uuid4

from app import decision_db_api
from app.decision_models import DecisionSaveRequest


class _Cursor:
    def __init__(self, row):
        self.row = row
        self.calls = []

    def execute(self, sql, params=None):
        self.calls.append((sql, params))

    def fetchone(self):
        if len(self.calls) == 1:
            return (self.row[0],)
        return self.row

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return None


class _Connection:
    def __init__(self, row):
        self.cursor_instance = _Cursor(row)

    def cursor(self):
        return self.cursor_instance

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return None


def test_decision_save_preserves_assessment_and_feed_provenance(monkeypatch):
    row = (
        uuid4(), "dec-virtual", uuid4(), None, "REVIEW", "REVIEW_SIGNAL", "review",
        ["RULE-1"], ["atomic-cited"], uuid4(), "policy", "1", "judgment-1", "hash",
        ["assessment-1"], uuid4(), ["osv:GHSA-virtual"], "npm", "virtual-demo", "1.2.3",
        "sha256:virtual", "sha512-virtual", datetime.now(timezone.utc), datetime.now(timezone.utc),
    )
    connection = _Connection(row)
    monkeypatch.setattr(decision_db_api, "connect", lambda: connection)

    payload = DecisionSaveRequest.model_validate({
        "policyKey": "policy",
        "decision": {
            "decisionId": "dec-virtual",
            "requestId": str(row[2]),
            "score": None,
            "decision": "REVIEW",
            "reasonCode": "REVIEW_SIGNAL",
            "reason": "review",
            "matchedRuleIds": ["RULE-1"],
            "evidenceIds": ["atomic-cited"],
            "scanId": str(row[9]),
            "policyVersion": "1",
            "judgmentId": "judgment-1",
            "policyHash": "hash",
            "assessmentIds": ["assessment-1"],
            "feedSnapshotId": str(row[15]),
            "feedEvidenceIds": ["osv:GHSA-virtual"],
            "subject": {
                "ecosystem": "npm",
                "packageName": "virtual-demo",
                "packageVersion": "1.2.3",
                "artifactHash256": "sha256:virtual",
            },
            "evaluatedAt": datetime.now(timezone.utc).isoformat(),
        },
    })

    result = decision_db_api.save_decision(payload)
    params = connection.cursor_instance.calls[0][1]

    assert params[11:16] == (
        "judgment-1",
        "hash",
        ["assessment-1"],
        row[15],
        ["osv:GHSA-virtual"],
    )
    assert result.assessmentIds == ["assessment-1"]
    assert result.feedEvidenceIds == ["osv:GHSA-virtual"]
