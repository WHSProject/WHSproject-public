# Dataset Batch Adapter

The adapter is an explicit offline CLI over `LocalStaticAnalysisService`. It accepts
external manifests and existing extracted artifacts by absolute path; it never
downloads, extracts, installs, or executes a package. Registry, OSV, Agent, Policy,
Gateway, and Decision paths are not instantiated.

The Primary cohort is sealed at exactly 179 eligible non-quarantine sample IDs. An
atomic ledger limits GuardDog, Metadata, and Custom Rule to one attempt per sample,
179 attempts per analyzer, and 537 total attempts. Failed attempts consume budget;
retry is zero. Each package is mounted read-only into the digest-pinned external
container with network none. The package tree is hashed before and after analysis.

`--resume` reuses only a complete `COMPLETED` sample whose archive, Scanner commit,
image/tool/ruleset versions, Finding/Evidence/mapping contracts, sandbox policy, and
batch policy form the same cache identity. Failure, partial, corrupt, `.tmp`, and
`.partial` outputs are not successful cache entries.

The export uses sample-scoped Finding/Evidence IDs and joins every record with
`sampleId` plus `archiveSha256`. Runtime durations live under `runs/`; canonical
sample files contain stable analysis content and provenance. Correlated Evidence is
explicitly unsupported and exported as an empty JSONL file.

Canonical Scanner Findings and the Scanner-owned Agent Finding v0.3 projection are
both exported. Lab consumers must read `agent-findings.v0.3.jsonl`; they must not
derive Agent fields from `findings.jsonl`. Per-sample equivalents are
`scanner-findings.json` and `agent-findings.v0.3.json`.

The approved container reference is explicit rather than inferred from Docker's
default tag. Pass both `--image whs-scanner-external-guarddog:local` and its pinned
`--image-digest`; the runner rejects a mismatch before analyzer entry.
