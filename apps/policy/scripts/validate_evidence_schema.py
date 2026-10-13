"""Run with python3 (jsonschema installed) from the repository root."""

import json
from copy import deepcopy
from pathlib import Path

from jsonschema import Draft202012Validator, FormatChecker


root = Path(__file__).resolve().parents[3]
schema = json.loads((root / "packages/contracts/evidence-v0.1.schema.json").read_text())
validator = Draft202012Validator(schema, format_checker=FormatChecker())
base = {
    "schemaVersion": "0.1", "evidenceId": "atomic-1", "kind": "ATOMIC",
    "signal": {"id": "signal-1", "type": "CHILD_PROCESS", "category": "EXECUTION"},
    "subject": {"ecosystem": "npm", "packageName": "fixture", "packageVersion": "1.0.0", "artifactHash": "hash"},
    "assertion": {"summary": "direct invocation", "basis": "PATTERN_MATCH"},
    "sources": [{"analyzer": "fixture", "analyzerVersion": "1"}],
    "locations": [{"type": "SOURCE_FILE", "path": "package/index.js"}],
    "provenance": {"scanId": "scan-1"},
}


def checked(change, valid):
    value = deepcopy(base)
    change(value)
    assert validator.is_valid(value) is valid, value


checked(lambda value: None, True)
checked(lambda value: value.update(analysisPass="TIER1"), True)
checked(lambda value: value.update(kind="CORRELATED", evidenceId="correlated-1", derivedFrom={"evidenceIds": ["atomic-1"]}), True)
checked(lambda value: value.update(analysisPass="TIER2", locations=[{
    "type": "SOURCE_FILE", "path": "package/decoded.js", "representation": "DEOBFUSCATED",
    "lineageStatus": "UNMAPPED", "derivedFrom": {"path": "package/index.js"},
}]), True)
for field, bad in (("analysisPass", "TIER3"), ("analysisPass", None)):
    checked(lambda value, field=field, bad=bad: value.update({field: bad}), False)
for field, bad in (
    ("representation", "DERIVED"), ("representation", 1), ("representation", None),
    ("lineageStatus", "LOST"), ("lineageStatus", 1), ("lineageStatus", None),
    ("derivedFrom", {"path": 1}), ("derivedFrom", {"path": "x", "unknown": True}),
    ("derivedFrom", None), ("unknown", True),
):
    checked(lambda value, field=field, bad=bad: value["locations"][0].update({field: bad}), False)
checked(lambda value: value.update(unknown=True), False)
print("Shared Evidence Schema: 17 valid/invalid assertions passed")
