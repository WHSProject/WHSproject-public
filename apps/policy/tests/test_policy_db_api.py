import pytest
from pydantic import ValidationError

from app.policy_db_api import (
    PolicyCreateRequest,
    PolicyPublishRequest,
    PolicyRuleCreate,
)


def valid_rule() -> dict:
    return {
        "ruleCode": "RULE-ALLOW-001",
        "ruleKind": "HARD",
        "name": "Allow safe package",
        "description": "Accept packages without detected risks.",
        "enabled": True,
        "decision": "ACCEPT",
        "priority": 100,
        "conditions": {},
        "reasonCode": "POLICY_PASSED",
        "reasonMessage": "Package passed the policy.",
    }


def test_policy_create_request_defaults_to_npm():
    request = PolicyCreateRequest(
        policyKey="default-npm-policy",
        name="Default npm Policy",
        version="1.0.0",
        createdBy="test-user",
        updatedBy="test-user",
        rules=[valid_rule()],
    )

    assert request.ecosystem == "npm"
    assert request.policyKey == "default-npm-policy"
    assert request.version == "1.0.0"
    assert len(request.rules) == 1
    assert request.rules[0].decision == "ACCEPT"


def test_policy_rule_rejects_invalid_decision():
    with pytest.raises(ValidationError):
        PolicyRuleCreate(
            **{
                **valid_rule(),
                "decision": "BLOCK",
            }
        )


def test_policy_create_request_rejects_unknown_fields():
    with pytest.raises(ValidationError):
        PolicyCreateRequest(
            policyKey="default-npm-policy",
            name="Default npm Policy",
            version="1.0.0",
            createdBy="test-user",
            updatedBy="test-user",
            unknownField="not-allowed",
        )


def test_publish_request_requires_updated_by():
    request = PolicyPublishRequest(updatedBy="policy-admin")

    assert request.updatedBy == "policy-admin"


def test_policy_rule_defaults():
    rule = PolicyRuleCreate(
        **{
            **valid_rule(),
            "description": None,
            "enabled": True,
            "conditions": {},
        }
    )

    assert rule.enabled is True
    assert rule.priority == 100
    assert rule.conditions.when is None
    assert rule.conditions.minimumSupport is None
