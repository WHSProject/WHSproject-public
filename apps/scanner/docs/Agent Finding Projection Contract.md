# Agent Finding Projection Contract

## Ownership and versions

Scanner owns the projection from canonical `Finding` plus its `AnalyzerResult`
context to Agent Finding 0.3.0. Canonical Findings are not changed. Projection
contract version is `0.3.0`; implementation version is `1.0.0`. Lab consumes the
projected JSON and must never infer analyzer identity from rule IDs or remap canonical
`findings.jsonl`.

## Field rules

- `findingId`, `ruleId`, `type`, `message`, `location`, and `data` are preserved.
- `analyzer` and `analyzerVersion` come only from the enclosing `AnalyzerResult`.
- Supported analyzer identities are `guarddog`, `metadata`, and `custom-rule`.
- Missing/unknown analyzer context or version is a structured projection failure.
- Findings sort by analyzer, finding ID, rule ID, location path, and start line.
- Object keys, including `data`, use recursively sorted canonical JSON order.
- Timestamps, duration, run IDs, decisions, split, and source labels are absent.

`data` must be JSON-serializable, finite, non-circular, non-binary, and free of host
or container absolute paths. Its projected canonical JSON limit is 65,536 bytes.
Oversized data is not silently truncated: the Finding fails projection with original
and projected byte sizes plus a source hash, while the canonical Scanner result
continues to retain the original data.

## Atomic Evidence

Scanner `AtomicEvidenceV0_1` is already structurally accepted by the Agent request
Evidence wrapper, which deliberately permits the full canonical fields. It is passed
through without semantic projection. Scanner validates evidence ID uniqueness,
artifact subject identity, and exact analyzer/version/rule/Finding source lineage
against the projected Finding set.

## Export boundary

Dataset exports keep both representations:

- `findings.jsonl` / `scanner-findings.json`: canonical Scanner Findings.
- `agent-findings.v0.3.jsonl` / `agent-findings.v0.3.json`: Agent projection.

Projection provenance and failures belong to the export or Fixture envelope, never
the model payload. Schema and implementation hashes participate in resume identity.

## Consumer status

The existing operational `LlmAgentInputBuilderService`, `AgentFinding`, legacy code
slice selector, and current Tier 3 artifact contract still use the older
`kind/description/rawMatch` and `location.file` representation. They are intentionally
unchanged by this scoped contract task. Those paths must become version-aware before
the production Agent runner can execute request 0.3.0; Dataset profile generation can
consume the new projection independently.
