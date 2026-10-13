import pytest
from pydantic import ValidationError

from app.evidence_models import EvidenceV01


def evidence(**overrides: object) -> dict:
    payload: dict = {
        "schemaVersion": "0.1",
        "evidenceId": "evidence-1",
        "kind": "ATOMIC",
        "signal": {"id": "signal-1", "type": "CHILD_PROCESS", "category": "EXECUTION"},
        "subject": {
            "ecosystem": "npm",
            "packageName": "example",
            "packageVersion": "1.0.0",
            "artifactHash": "a" * 64,
        },
        "assertion": {"summary": "child process", "basis": "PATTERN_MATCH"},
        "sources": [{"analyzer": "custom-rule", "analyzerVersion": "1.0.0"}],
        "locations": [{"type": "SOURCE_FILE", "path": "package/index.js"}],
        "provenance": {"scanId": "scan-1", "generatedBy": "EVIDENCE_NORMALIZER"},
    }
    payload.update(overrides)
    return payload


def test_accepts_legacy_atomic_evidence_without_provenance_extensions():
    parsed = EvidenceV01.model_validate(evidence())

    assert parsed.analysisPass is None
    assert parsed.locations[0].representation is None


def test_accepts_existing_taxonomy_and_action_contract_fields():
    parsed = EvidenceV01.model_validate(evidence(
        taxonomy="CREDENTIAL_AND_SENSITIVE_DATA_ACCESS",
        action="CREDENTIAL_ACCESS",
    ))
    assert parsed.model_dump(mode="json", exclude_none=True)["taxonomy"] == "CREDENTIAL_AND_SENSITIVE_DATA_ACCESS"
    assert parsed.action == "CREDENTIAL_ACCESS"


@pytest.mark.parametrize("change", [
    {"taxonomy": "UNKNOWN"}, {"taxonomy": None},
    {"taxonomy": 1}, {"action": ""}, {"action": None}, {"action": 1},
    {"capabilityPreservation": None},
])
def test_rejects_invalid_taxonomy_or_action(change: dict):
    with pytest.raises(ValidationError):
        EvidenceV01.model_validate(evidence(**change))


@pytest.mark.parametrize("analysis_pass", ["TIER1", "TIER2"])
def test_accepts_analysis_pass_and_tier2_provenance_extensions(analysis_pass: str):
    parsed = EvidenceV01.model_validate(evidence(
        analysisPass=analysis_pass,
        locations=[{
            "type": "SOURCE_FILE",
            "path": "package/derived/index.js",
            "representation": "DEOBFUSCATED",
            "lineageStatus": "UNMAPPED",
            "derivedFrom": {"path": "package/index.js"},
        }],
    ))

    assert parsed.analysisPass == analysis_pass
    assert parsed.locations[0].derivedFrom.path == "package/index.js"


def test_accepts_existing_derived_from_line_range():
    parsed = EvidenceV01.model_validate(evidence(locations=[{
        "type": "SOURCE_FILE", "path": "package/decoded.js",
        "derivedFrom": {"path": "package/index.js", "startLine": 8, "endLine": 9},
    }]))
    assert parsed.locations[0].derivedFrom.startLine == 8
    assert parsed.locations[0].derivedFrom.endLine == 9


def test_accepts_capability_preservation_extension():
    parsed = EvidenceV01.model_validate(evidence(
        analysisPass="TIER2",
        capabilityPreservation={
            "before": ["capability.network.outbound"],
            "after": ["capability.network.outbound", "capability.process.spawn"],
            "status": "PRESERVED",
            "preserved": ["capability.network.outbound"],
            "lost": [],
            "discovered": ["capability.process.spawn"],
            "comparisons": [{
                "capability": "network", "status": "PRESERVED", "original": [],
                "deobfuscated": [{
                    "analyzer": "fixture", "analyzerVersion": "1", "ruleId": "r",
                    "findingId": "f", "path": "package/decoded.js",
                    "representation": "DEOBFUSCATED", "lineageStatus": "MAPPED",
                    "derivedFrom": {"path": "package/index.js", "startLine": 8, "endLine": 9},
                }],
            }],
            "limitations": [],
            "originalPath": "package/index.js",
            "deobfuscatedPaths": ["package/index.js"],
            "restoreStatus": "RESTORED",
        },
    ))

    assert parsed.capabilityPreservation is not None
    assert parsed.capabilityPreservation.discovered == ["capability.process.spawn"]
    assert parsed.capabilityPreservation.comparisons[0].deobfuscated[0].derivedFrom.startLine == 8


@pytest.mark.parametrize("change", [
    {"before": "network"}, {"status": "UNKNOWN"}, {"unknown": True},
    {"comparisons": [{"capability": "network", "status": "PRESERVED", "original": [], "deobfuscated": [], "unknown": True}]},
    {"comparisons": [{"capability": "network", "status": "PRESERVED", "original": [], "deobfuscated": [{
        "analyzer": "fixture", "analyzerVersion": "1", "ruleId": "r", "findingId": "f",
        "path": "package/decoded.js", "representation": "DEOBFUSCATED", "lineageStatus": "MAPPED",
        "startLine": "8",
    }]}]},
    {"comparisons": [{"capability": "network", "status": "PRESERVED", "original": [], "deobfuscated": [{
        "analyzer": "fixture", "analyzerVersion": "1", "ruleId": "r", "findingId": "f",
        "path": "package/decoded.js", "representation": "DEOBFUSCATED", "lineageStatus": "MAPPED",
        "unknown": True,
    }]}]},
    {"originalPath": None}, {"restoreStatus": None},
])
def test_rejects_invalid_capability_preservation(change: dict):
    valid = {
        "before": [], "after": None, "status": "NOT_APPLICABLE",
        "preserved": [], "lost": [], "discovered": [], "comparisons": [], "limitations": [],
    }
    with pytest.raises(ValidationError):
        EvidenceV01.model_validate(evidence(capabilityPreservation={**valid, **change}))


def test_capability_preservation_requires_shared_schema_fields():
    with pytest.raises(ValidationError):
        EvidenceV01.model_validate(evidence(capabilityPreservation={"status": "PRESERVED"}))


@pytest.mark.parametrize("field,value", [
    ("analysisPass", "INVALID"),
    ("locations", [{"type": "SOURCE_FILE", "representation": "INVALID"}]),
    ("locations", [{"type": "SOURCE_FILE", "lineageStatus": "INVALID"}]),
])
def test_rejects_invalid_provenance_enums(field: str, value: object):
    with pytest.raises(ValidationError):
        EvidenceV01.model_validate(evidence(**{field: value}))


def test_requires_location_derived_from_path():
    with pytest.raises(ValidationError):
        EvidenceV01.model_validate(evidence(
            locations=[{"type": "SOURCE_FILE", "derivedFrom": {}}],
        ))


def test_serializes_tier2_provenance_with_wire_camel_case():
    parsed = EvidenceV01.model_validate(evidence(
        analysisPass="TIER2",
        derivedFrom={"evidenceIds": ["tier1-evidence-1"]},
        locations=[{
            "type": "SOURCE_FILE",
            "path": "package/derived/index.js",
            "representation": "DEOBFUSCATED",
            "lineageStatus": "UNMAPPED",
            "derivedFrom": {"path": "package/index.js"},
        }],
    ))
    serialized = parsed.model_dump(mode="json", by_alias=True)

    assert serialized["analysisPass"] == "TIER2"
    assert serialized["derivedFrom"] == {
        "findingIds": [],
        "evidenceIds": ["tier1-evidence-1"],
    }
    assert serialized["locations"][0]["representation"] == "DEOBFUSCATED"
    assert serialized["locations"][0]["lineageStatus"] == "UNMAPPED"
    assert serialized["locations"][0]["derivedFrom"] == {"path": "package/index.js"}
    assert "analysis_pass" not in serialized
    assert "lineage_status" not in serialized["locations"][0]


@pytest.mark.parametrize("change", [
    {"analysisPass": None},
    {"locations": [{"type": "SOURCE_FILE", "representation": None}]},
    {"locations": [{"type": "SOURCE_FILE", "lineageStatus": None}]},
    {"locations": [{"type": "SOURCE_FILE", "derivedFrom": None}]},
    {"locations": [{"type": "SOURCE_FILE", "representation": 1}]},
    {"locations": [{"type": "SOURCE_FILE", "lineageStatus": 1}]},
    {"locations": [{"type": "SOURCE_FILE", "derivedFrom": {"path": 1}}]},
    {"locations": [{"type": "SOURCE_FILE", "derivedFrom": {"path": "x", "unknown": True}}]},
    {"locations": [{"type": "SOURCE_FILE", "derivedFrom": {"path": "x", "startLine": 0}}]},
    {"locations": [{"type": "SOURCE_FILE", "derivedFrom": {"path": "x", "startLine": -1}}]},
    {"locations": [{"type": "SOURCE_FILE", "derivedFrom": {"path": "x", "startLine": 1.5}}]},
    {"locations": [{"type": "SOURCE_FILE", "derivedFrom": {"path": "x", "startLine": "1"}}]},
    {"locations": [{"type": "SOURCE_FILE", "derivedFrom": {"path": "x", "startLine": None}}]},
    {"locations": [{"type": "SOURCE_FILE", "derivedFrom": {"path": "x", "endLine": 0}}]},
    {"locations": [{"type": "SOURCE_FILE", "derivedFrom": {"path": "x", "endLine": -1}}]},
    {"locations": [{"type": "SOURCE_FILE", "derivedFrom": {"path": "x", "endLine": 1.5}}]},
    {"locations": [{"type": "SOURCE_FILE", "derivedFrom": {"path": "x", "endLine": "1"}}]},
    {"locations": [{"type": "SOURCE_FILE", "derivedFrom": {"path": "x", "endLine": None}}]},
    {"locations": [{"type": "SOURCE_FILE", "unknown": True}]},
])
def test_rejects_invalid_provenance_types_and_unknown_nested_fields(change: dict):
    with pytest.raises(ValidationError):
        EvidenceV01.model_validate(evidence(**change))
