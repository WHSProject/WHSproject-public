# Scanner Capability Preservation

Scanner restoration verification compares canonical capability signal IDs from
`EvidenceMappingRegistry`, not analyzer-specific Rule IDs. Comparisons are
performed per original package file and include restored payload files.

## Statuses

- `PRESERVED`: the capability is observed in both original and derived analysis.
- `LOST`: the capability is observed in the original and absent after a
  complete, successful derived analysis.
- `DISCOVERED`: the capability is only observed after restoration.
- `NOT_VERIFIED`: restoration, derived analysis, or lineage is incomplete.
- `NOT_APPLICABLE`: no capability is in scope for the file.

`PARTIAL_RESTORED`, `UNRESOLVED`, `SKIPPED`, `FAILED`, and any failed,
partial, or timed-out derived analyzer never turn a missing capability into
`LOST`. They retain observed findings and add explicit limitations.

## Downstream contract

The capability report is attached to the obfuscation shadow result and is
propagated to Tier2 Evidence, the internal Tier2 Handoff, and optional
`capabilityPreservation` in Tier3 Agent input v0.3. Each comparison includes
the original and deobfuscated observations, analyzer and Rule provenance, file
paths, representation, and `DIRECT`/`MAPPED`/`UNMAPPED` lineage. Verified line
mapping adds `derivedFrom` coordinates; missing mapping remains `UNMAPPED`.

Relevant limitations are `CAPABILITY_COMPARISON_INCOMPLETE`,
`DERIVED_ANALYSIS_UNAVAILABLE`, and
`PARTIAL_RESTORE_PREVENTS_COMPLETE_VERIFICATION`.
