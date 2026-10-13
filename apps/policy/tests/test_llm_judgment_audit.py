import json
from datetime import datetime, timezone
from uuid import uuid4

from app import decision_db_api
from app.decision_models import PolicyLlmJudgmentSaveRequest


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


def test_llm_judgment_save_preserves_jsonb_rule_evaluations_path_raw_payload_and_shadow_metadata(monkeypatch):
    original_judgment = {"judgmentId": "j-shadow", "ruleEvaluations": [{"ruleId": "R", "status": "NOT_SATISFIED"}]}
    evaluated_judgment = {"judgmentId": "j-shadow", "ruleEvaluations": [{"ruleId": "R", "status": "UNKNOWN"}]}
    raw_response = {"id": "provider-response", "output": [{"content": [{"type": "output_text", "text": json.dumps(original_judgment)}]}]}
    row = (
        uuid4(), "SHADOW", uuid4(), uuid4(), "policy", "1", "hash", "openai", "policy-judgment-v1", "a" * 64,
        "j-shadow", "COMPLETED", "policy prompt", "gpt-shadow", "provider-response", 12.5,
        evaluated_judgment, raw_response, None,
        "REVIEW", "REVIEW_SIGNAL", "j-primary",
        {"decisionChanged": True}, datetime.now(timezone.utc), datetime.now(timezone.utc),
    )
    connection = _Connection(row)
    monkeypatch.setattr(decision_db_api, "connect", lambda: connection)

    payload = PolicyLlmJudgmentSaveRequest.model_validate({
        "audit": {
            "runMode": "SHADOW",
            "requestId": str(row[2]),
            "scanId": str(row[3]),
            "policyKey": "policy",
            "policyVersion": "1",
            "policyHash": "hash",
            "provider": "openai",
            "promptVersion": "policy-judgment-v1",
            "inputHash": "a" * 64,
            "judgmentId": "j-shadow",
            "status": "COMPLETED",
            "prompt": "policy prompt",
            "model": "gpt-shadow",
            "providerRequestId": "provider-response",
            "durationMs": 12.5,
            "judgmentJson": evaluated_judgment,
            "responseJson": raw_response,
            "resolvedDecision": "REVIEW",
            "resolvedReasonCode": "REVIEW_SIGNAL",
            "shadowOfJudgmentId": "j-primary",
            "comparison": {"decisionChanged": True},
        }
    })

    result = decision_db_api.save_llm_judgment(payload)
    params = connection.cursor_instance.calls[0][1]

    assert params[0:12] == (
        "SHADOW", row[2], row[3], "policy", "1", "hash", "openai", "policy-judgment-v1", "a" * 64, "j-shadow", "COMPLETED", "policy prompt",
    )
    assert params[20] == "j-primary"
    assert params[15].obj["ruleEvaluations"] == evaluated_judgment["ruleEvaluations"]
    assert params[16].obj == raw_response
    assert result.id == row[0]
    assert result.judgmentJson["ruleEvaluations"] == evaluated_judgment["ruleEvaluations"]
    assert json.loads(result.responseJson["output"][0]["content"][0]["text"]) == original_judgment
    assert result.comparison == {"decisionChanged": True}
