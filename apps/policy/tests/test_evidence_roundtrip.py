from unittest.mock import patch

from fastapi.testclient import TestClient

from app.evidence_api import app
from app.evidence_api import create_evidence, get_evidence, parse_stored_evidence
from app.evidence_models import EvidenceV01


def evidence(**overrides):
    value = {
        "schemaVersion": "0.1", "evidenceId": "tier1-1", "kind": "ATOMIC",
        "signal": {"id": "child-process", "type": "CHILD_PROCESS", "category": "EXECUTION"},
        "subject": {"ecosystem": "npm", "packageName": "fixture", "packageVersion": "1.0.0", "artifactHash": "hash"},
        "assertion": {"summary": "direct invocation", "basis": "PATTERN_MATCH"},
        "sources": [{"analyzer": "fixture", "analyzerVersion": "1"}],
        "locations": [{"type": "SOURCE_FILE", "path": "package/index.js"}],
        "provenance": {"scanId": "scan-1"},
    }
    value.update(overrides)
    return value


class Cursor:
    def __init__(self):
        self.raw = None
        self.query = ""

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def execute(self, query, parameters):
        self.query = query
        if isinstance(parameters, dict) and "raw_json" in parameters:
            self.raw = parameters["raw_json"].obj

    def fetchone(self):
        return (self.raw,) if "SELECT raw_json" in self.query else (1,)


class Connection:
    def __init__(self, cursor):
        self.value = cursor

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def cursor(self):
        return self.value


def test_tier1_and_tier2_jsonb_round_trip():
    cursor = Cursor()
    with patch("app.evidence_api.connect", return_value=Connection(cursor)):
        for payload in (
            evidence(),
            evidence(
                evidenceId="tier2-1", analysisPass="TIER2",
                taxonomy="EVASION_AND_OBFUSCATION", action="DEOBFUSCATION",
                capabilityPreservation={
                    "before": [], "after": None, "status": "NOT_APPLICABLE",
                    "preserved": [], "lost": [], "discovered": [], "comparisons": [], "limitations": [],
                },
                locations=[{
                    "type": "SOURCE_FILE", "path": "package/decoded.js",
                    "representation": "DEOBFUSCATED", "lineageStatus": "UNMAPPED",
                    "derivedFrom": {"path": "package/index.js", "startLine": 8, "endLine": 9},
                }],
            ),
        ):
            model = EvidenceV01.model_validate(payload)
            create_evidence(model)
            loaded = get_evidence(payload["evidenceId"])
            assert loaded.model_dump(mode="json") == model.model_dump(mode="json")
            if payload.get("analysisPass") == "TIER2":
                assert cursor.raw["analysisPass"] == "TIER2"
                assert cursor.raw["locations"][0]["derivedFrom"]["path"] == "package/index.js"
                assert cursor.raw["locations"][0]["derivedFrom"]["startLine"] == 8
                assert cursor.raw["taxonomy"] == "EVASION_AND_OBFUSCATION"
                assert cursor.raw["action"] == "DEOBFUSCATION"
                assert cursor.raw["capabilityPreservation"]["status"] == "NOT_APPLICABLE"
                assert "after" in cursor.raw["capabilityPreservation"]
                assert cursor.raw["capabilityPreservation"]["after"] is None


def test_legacy_tier1_jsonb_null_defaults_remain_readable():
    old_raw = EvidenceV01.model_validate(evidence()).model_dump(mode="json")
    assert old_raw["analysisPass"] is None
    assert old_raw["taxonomy"] is None
    assert old_raw["action"] is None
    assert old_raw["capabilityPreservation"] is None
    assert old_raw["locations"][0]["representation"] is None
    restored = parse_stored_evidence(old_raw)
    assert restored.evidenceId == "tier1-1"
    assert restored.locations[0].path == "package/index.js"


def test_new_input_null_is_422_but_legacy_jsonb_null_is_readable():
    cursor = Cursor()
    client = TestClient(app)
    for field in ("analysisPass", "taxonomy", "action", "capabilityPreservation"):
        assert client.post("/internal/v1/evidences", json=evidence(**{field: None})).status_code == 422
    legacy = EvidenceV01.model_validate(evidence()).model_dump(mode="json")
    legacy["taxonomy"] = None
    legacy["action"] = None
    legacy["capabilityPreservation"] = None
    cursor.raw = legacy
    with patch("app.evidence_api.connect", return_value=Connection(cursor)):
        response = client.get("/internal/v1/evidences/tier1-1")
    assert response.status_code == 200
    assert all(field not in response.json() for field in ("analysisPass", "taxonomy", "action"))


def test_legacy_capability_jsonb_missing_nullable_after_is_readable():
    raw = EvidenceV01.model_validate(evidence(capabilityPreservation={
        "before": [], "after": None, "status": "NOT_APPLICABLE",
        "preserved": [], "lost": [], "discovered": [], "comparisons": [], "limitations": [],
    })).model_dump(mode="json", exclude_none=True)
    raw["capabilityPreservation"].pop("after")
    restored = parse_stored_evidence(raw)
    assert restored.capabilityPreservation.after is None


def test_new_fields_survive_http_storage_and_read_round_trip():
    cursor = Cursor()
    client = TestClient(app)
    payload = evidence(
        taxonomy="EVASION_AND_OBFUSCATION", action="DEOBFUSCATION",
        capabilityPreservation={
            "before": [], "after": None, "status": "NOT_APPLICABLE",
            "preserved": [], "lost": [], "discovered": [], "comparisons": [], "limitations": [],
        },
        locations=[{"type": "SOURCE_FILE", "path": "package/decoded.js",
                    "derivedFrom": {"path": "package/index.js", "startLine": 8, "endLine": 9}}],
    )
    with patch("app.evidence_api.connect", return_value=Connection(cursor)):
        created = client.post("/internal/v1/evidences", json=payload)
        loaded = client.get("/internal/v1/evidences/tier1-1")
    assert created.status_code == 201
    assert loaded.status_code == 200
    for response in (created, loaded):
        assert response.json()["taxonomy"] == payload["taxonomy"]
        assert response.json()["action"] == payload["action"]
        assert response.json()["locations"][0]["derivedFrom"] == payload["locations"][0]["derivedFrom"]
        assert response.json()["capabilityPreservation"]["after"] is None
        assert "analysisPass" not in response.json()
