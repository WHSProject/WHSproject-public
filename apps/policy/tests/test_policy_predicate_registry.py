from pathlib import Path

from app.policy_db_api import PolicyDocument, PolicyPredicateDefinition


def test_policy_document_exposes_predicate_catalog():
    document = PolicyDocument.model_validate({
        "policyKey": "qa-npm-policy",
        "policyVersion": "0.1.0",
        "ecosystem": "npm",
        "rules": [],
        "predicates": [{
            "code": "TENANT_BEHAVIOR_MATCH",
            "description": "A tenant-defined behavior.",
            "category": "custom",
            "requiresFeedEvidence": False,
            "rejectAllowed": True,
        }],
    })
    assert isinstance(document.predicates[0], PolicyPredicateDefinition)
    assert document.predicates[0].code == "TENANT_BEHAVIOR_MATCH"


def test_registry_and_qa_policy_migrations_include_extended_policy_surface():
    root = Path(__file__).resolve().parents[3]
    registry = (root / "infra/postgres/migrations/policy/003_predicate_registry.sql").read_text(encoding="utf-8")
    expanded = (root / "infra/postgres/migrations/policy/004_expand_qa_policy.sql").read_text(encoding="utf-8")

    for code in ("CHILD_PROCESS_SPAWNED", "CREDENTIAL_SOURCE_ACCESSED", "REMOTE_CODE_FETCH", "OBFUSCATION_PRESENT"):
        assert f"'{code}'" in registry
    for rule in ("RULE-REJECT-CONFIRMED-EXFIL", "RULE-REJECT-CHILD-PROCESS", "RULE-REVIEW-OBFUSCATION", "RULE-HOLD-NATIVE-BINARY"):
        assert f"'{rule}'" in expanded
