# Tier 1/Tier 2 Benchmark and Tier 3 Gate

The runtime gate is implemented in `src/llm-agent/tier3-escalation-gate.ts`.
The benchmark uses the same pure decision function, so a benchmark result cannot
silently diverge from production routing.

## Input

`benchmark:tier1-tier2` accepts a JSON array or `{ "samples": [...] }`. Each
sample contains `sampleId`, `truth` (`BENIGN` or `MALICIOUS`), Tier 1 results and
normalized evidence. Optional Tier 2 handoff, restore result, and duration
fields are accepted. This is intentionally an adapter contract: the external
179-sample batch output must be joined with a behavior-level ground-truth file
before it is used for Precision/Recall claims.

```powershell
pnpm --filter scanner build
pnpm --filter scanner benchmark:tier1-tier2 -- --input <benchmark.json> --output <report.json>
```

The report includes TP/FP/TN/FN, Precision/Recall/F1/FPR/FNR, Tier 1
completion, Tier 2 entry, explainable-without-Tier3 rate, escalation rate, and
p50/p95 latency for each supplied stage.

`predictedMalicious` is a weighted Tier 1 signal assessment, not the old
`any finding => malicious` benchmark shortcut and not a replacement for the
Production Policy decision. A generic capability alone is not malicious; the
assessment requires threat-plus-capability corroboration, lifecycle/download/
process execution, sensitive-file-read plus outbound network, or credential
source plus outbound network. Production malicious verdicts apply the same
corroboration boundary at the Agent/Tier3 and Policy decision points; weaker
signals may still be routed to semantic review without being classified as
malicious.

Lifecycle content analysis is bounded lexical analysis of `preinstall`,
`install`, `postinstall`, and `prepare` command text. Script presence, normal
build/setup wrappers such as `npm run build` or `tsc`, and a generic process
signal alone remain non-malicious. Lifecycle content contributes to a
high-confidence assessment only when it forms a supported corroboration such
as lifecycle + remote download + process execution, credential source +
outbound network, or sensitive file read + outbound network. This analysis does
not execute package scripts or claim runtime data flow.

## Gate rules

`HIGH_CONFIDENCE_STATIC` prevents escalation when strong evidence is
corroborated, analyzers agree, and restore is complete without limitations.
`ANALYZER_DISAGREEMENT`, `PARTIAL_RESTORE`, `UNRESOLVED_OBFUSCATION`,
`WEAK_SIGNAL_COMBINATION`, `SEMANTIC_RELATION_UNCLEAR`, and `UNKNOWN_PATTERN`
are explicit escalation reasons. `RISK_BASED` uses the gate in the
Orchestrator. `ALWAYS` remains an explicit force-run mode, and disabled Agent
behavior remains `AGENT_DISABLED`.

The repository does not contain the external 179 extracted artifacts, Docker
image, or a behavior-level label manifest. Therefore no 179-sample quality
number is claimed by the unit tests; the command above is the reproducible
execution point once those inputs are mounted.

## 2026-09-28 executable run

The historical OMC runner was executed at revision
`f0722971eddb654c308106c9086ff69da5b0484b` with 20 benign and 20 malicious
archives. All 40 completed. Tier 2 candidate routing produced TP=1, FP=1,
TN=19, FN=19 against the package-level labels: Precision 50.00%, Recall
5.00%, F1 9.09%, FPR 5.00%, FNR 95.00%. Tier 2 candidate/restore latency was
p50 17.89ms and p95 1271.55ms; package-level latency was p50 501ms and p95
2653ms. Restore status was RESTORED 1 and PARTIAL_RESTORED 3.

This is not an obfuscation ground-truth score: the OMC labels describe whether
the package is malicious, not whether a particular file is obfuscated. The
same run did not contain Tier 1 analyzer results or normalized Tier 2 findings,
so the profile output is only a restore-state gate proxy. Conservative routed
2/40 to Tier 3 (5.00%), while Balanced and LLM_MINIMAL routed 1/40 (2.50%).
Actual Tier3 provider p50/p95 and gate-induced end-to-end latency were not
measured because no provider was executed.

## 2026-09-28 real Tier 1/Tier 2 pipeline pilot

The same 40 OMC archives were then executed through the real
`LocalStaticAnalysisService` and `ObfuscationAnalyzer`, using the Docker
`external-guarddog` target from `apps/scanner/Dockerfile`. This run executed
Metadata, Custom Rule/Semgrep, GuardDog, webcrack/Babel restore, derived
Custom Rule/GuardDog re-analysis, Tier 2 candidate validation, normalized
Tier 2 Evidence, and the production gate function. The Tier 3 provider itself
was not called.

The GuardDog-on run completed 40/40. GuardDog-off also completed 40/40, with
GuardDog intentionally returning `SKIPPED`. After evidence-based calibration,
the gate routes 1/40 (2.50%) to Tier 3 with GuardDog and 5/40 (12.50%) without
GuardDog. With GuardDog, the gate reduces the pre-gate Tier 2 route by 12.50
percentage points (6/40 to 1/40), and the LLM-free rate is 97.50%. This
supersedes the previous restore-state proxy result; the proxy 2.5% must not be
used as a production rate.

The calibration treats `RISK_CAPABILITY_NOT_REANALYZED` as a soft limitation
when normalized Tier 1/Tier 2 evidence corroborates the behavior. It does not
escalate merely because Custom Rule and GuardDog use different rule IDs. A
hard unresolved dynamic decode without threat corroboration remains an
escalation reason; in this corpus that leaves `ejs` as the single Tier 3
candidate.

The full machine-readable output is generated at
`reports/validation/omc-tier1-tier2-pilot-2026-09-28.json` by
`pilot:omc-tier1-tier2`. Its labels remain package-level OMC benign/malicious
labels, so the confusion matrices are pipeline/package-label measurements,
not file-level obfuscation ground truth.
