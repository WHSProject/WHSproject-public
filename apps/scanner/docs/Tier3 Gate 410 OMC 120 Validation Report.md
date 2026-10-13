# Issue #410: OMC-120 Tier3 Gate validation

This report separates the initial 40-sample sanity run, the earlier static/
restore-state proxy run, the pre-fix full-funnel run, and the final current
full-funnel rerun. The final rerun used the same fixed OMC-120 corpus as the
existing #391-before baseline: 60 benign and 60 malicious archives.

Package installation, lifecycle execution, entry-point execution, network
access from analyzer containers, and OpenAI/Tier3 provider calls were not
performed. The pilot exercised static analysis through Tier1, Tier2,
Handoff, the production API-free Gate, and Tier3 Input construction.

## Dataset and reproducibility

- OMC revision: `f0722971eddb654c308106c9086ff69da5b0484b`
- Archive cache: `apps/scanner/reports/validation/omc-120-archives-2026-09-30`
- Source report: `apps/scanner/reports/validation/omc-120-pilot-source.json`
- Manifest: `apps/scanner/reports/validation/omc-120-reproducibility-manifest-2026-09-30.json`
- Archive count: 120; archive SHA-256 values were checked by the pilot
- Labels: 60 benign, 60 malicious
- Analyzer versions: GuardDog `3.1.0`, Semgrep `1.172.0`
- Docker network mode: `NONE`

The archive cache is local and ignored by Git. The manifest and source report
are retained in the repository. The pilot's temporary extraction roots were
cleaned after completion; per-sample production summaries were used during
validation but are generated outputs and are not retained in the repository.

## Earlier validation retained for history

The earlier 40-sample result remains a sanity/regression result only. The
earlier OMC-120 Tier2/static report and restore-state Gate proxy also remain
separate measurements; neither is relabeled as a full production result.

The earlier static lifecycle observation was:

| Label | Lifecycle | P0 lifecycle-entry | Lifecycle-to-process | Lifecycle + download |
|---|---:|---:|---:|---:|
| benign | 9 | 0 | 0 | 0 |
| malicious | 48 | 42 | 9 | 26 |

Those values came from the static lifecycle adapter and are not used as the
full-funnel values below.

## Full production runs

The final current run was fresh and sequential: GuardDog-on completed 120
cases before GuardDog-off started. Both variants produced 120 rows, with 118
non-failed sample rows and two scan failures:
`discorddependency@1.0.0.zip` and `bem-mvc@1.0.0.zip`.
The GuardDog-on run has 114 `COMPLETED` and 4 `PARTIAL` rows; the partial rows
include `graphql@16.9.0` and `vibranced@1.4.45` because an analyzer timed out.
GuardDog-off labels analyzer-disabled rows `PARTIAL` by design.

The current run used the targeted #407 fixes from commit
`13f1c77bf5d4c67462cdd9dc0c7af520cd70df6e`. No baseline rerun was performed.

Current final run:

- Analyzer image: `sha256:6bb4e08db51b2c8c39795b0ba77922d4b50b3cd85174c0737075743868101710`
- Per-sample JSON/Markdown output: generated locally during validation and not retained in the repository.

#391-before baseline, reused without rerunning:

- Scanner commit: `886f383f28a1c1444d8be331d5814a62ab6c0268`
- Worktree: `C:\Users\김혜진\AppData\Local\Temp\whs-391-before`
- Analyzer image: `sha256:28c13d674524fabe12d1fdee4c3ce1eae35049e45287c09ea9ed88a753178e21`
- Per-sample JSON/Markdown output: generated locally during validation and not retained in the repository.

The command was:

```powershell
pnpm --filter scanner exec node scripts/omc-tier1-tier2-pilot.mjs
```

The environment was held constant for corpus, source report, manifest,
Dockerfile, analyzer versions, and command. The analyzer image and scanner
worktree were the intended differences.

The earlier incomplete current run was generated during validation but is not
retained: it contained 17 custom-rule preflight failures and 17 corresponding
GuardDog failures, and was not used for the final comparison.

## #391 comparison and #407 attribution

The pilot stores Finding counts, normalized signal IDs, rule IDs, Agent
trigger state, Gate state, and Tier3 Input state. It does not serialize a
separate `Tier1RiskAssessment` object. The Tier1 matrix below was reconstructed
from the persisted rule/signal IDs using the same four predicates as
`assessTier1Risk`; Finding presence is reported separately.

### Finding presence versus Tier1 risk

| Run | Finding-positive benign | Finding-positive malicious | TP | FP | TN | FN | Recall | Precision | FPR | FNR |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| BEFORE (#391 baseline) | 45 | 57 | 48 | 3 | 57 | 12 | 0.8000 | 0.9412 | 0.0500 | 0.2000 |
| AFTER (fresh current, #391 + #407 + targeted fixes) | 44 | 57 | 47 | 3 | 57 | 13 | 0.7833 | 0.9400 | 0.0500 | 0.2167 |

`graphql@16.9.0` is false in the fresh current run and no longer produces
`custom.credential-source`; its remaining findings are generic
collection-source plus information-read signals. `ardatan-sync-fetch@0.0.1`
is also false after the provenance-scoped lifecycle fix.

The observed one-sample malicious delta is `vibranced@1.4.45`: its fresh
current GuardDog run timed out, so the threat evidence present in the reused
baseline and earlier current artifact was absent from this sample. This is a
sample-level analyzer failure, not a code-attributable recall regression; the
fresh run nevertheless records the exact observed matrix above and does not
silently impute the missing finding.

The three benign Tier1 risk-positive packages remain the existing corroborated
threat cases: `streamsearch`, `ordered-binary`, and `critters`. No new benign
Tier1 risk-positive package was introduced by the two targeted fixes.
The full-funnel JSON stores normalized signal IDs but not every Evidence
location; the `ardatan` false result is additionally confirmed by the targeted
production rerun with metadata/source provenance.

### Agent trigger

Agent trigger is a separate production routing metric and must not be
interpreted as the Tier1 verdict or Policy final decision.

| Run | TP | FP | TN | FN | Recall | Precision | FPR | FNR |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| BEFORE | 50 | 10 | 50 | 10 | 0.8333 | 0.8333 | 0.1667 | 0.1667 |
| AFTER | 50 | 7 | 53 | 10 | 0.8333 | 0.8772 | 0.1167 | 0.1667 |

The final current Agent-trigger count was 7 benign and 50 malicious. This is
an improvement in benign routing count relative to the reused baseline, but
it is not a Policy final-verdict metric.

## #407 lifecycle results from the final current funnel

The values below are package-level co-occurrence counts from normalized static
signals. They do not mean lifecycle commands were executed or that the
signals were proven to originate from one command.

| Label | Lifecycle | Lifecycle-entry | Lifecycle + process | Lifecycle + download | Credential + network | Sensitive read + network |
|---|---:|---:|---:|---:|---:|---:|
| benign | 9 | 0 | 5 | 1 | 0 | 0 |
| malicious | 47 | 42 | 21 | 29 | 5 | 1 |

The earlier static adapter values in the history section remain separately
labelled. In the final current funnel, lifecycle presence alone did not make a
package Tier1 risk-positive. `ardatan-sync-fetch` is now Tier1 risk-negative;
its separate Agent/Gate routing is recorded below. Historical FN examples were
not recovered from the unavailable original corpus.

## #410 production Gate funnel

The final current `guarddog-on` funnel is:

| Label | Finding | Tier1 risk-positive | Tier2 candidate | Tier2 Evidence | Handoff | Gate executed | Gate escalation | Tier3 Input |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| benign | 44 | 3 | 8 | 7 | 8 | 8 | 7 | 1 |
| malicious | 57 | 47 | 9 | 9 | 9 | 9 | 2 | 1 |

The corresponding reused baseline funnel was benign `45 / 3 / 8 / 7 / 8 / 8 /
5 / 0` and malicious `57 / 48 / 9 / 9 / 9 / 2 / 1` for the columns after
Finding, in the same order. The fresh current Agent-trigger count is 7 benign
and 50 malicious. The fresh current Tier3 Input for `ardatan-sync-fetch` was
created after its Tier1 risk became false because the independent Agent/Gate
path observed analyzer disagreement.

Final current Gate reason counts (a sample can have more than one reason):

| Label | ANALYZER_DISAGREEMENT | HIGH_CONFIDENCE_STATIC | PARTIAL_RESTORE | SEMANTIC_RELATION_UNCLEAR | UNKNOWN_PATTERN | UNRESOLVED_OBFUSCATION | WEAK_SIGNAL_COMBINATION |
|---|---:|---:|---:|---:|---:|---:|---:|
| benign | 5 | 1 | 1 | 3 | 0 | 2 | 0 |
| malicious | 1 | 7 | 0 | 2 | 0 | 0 | 0 |

Benign Gate escalations were:

- `html-minifier@4.0.0`: analyzer disagreement.
- `react-shallow-renderer@16.15.0`: semantic relation unclear.
- `ardatan-sync-fetch@0.0.1`: analyzer disagreement; Tier1 risk remained false.
- `stream-transform@3.3.3`: analyzer disagreement and semantic relation unclear.
- `marked@15.0.3`: analyzer disagreement and unresolved obfuscation.
- `ejs@3.1.10`: analyzer disagreement, partial restore, and unresolved obfuscation.
- `critters@0.0.25`: semantic relation unclear.

One benign Tier3 Input was created for `ardatan-sync-fetch@0.0.1` through the
independent Agent/Gate routing path. Malicious packages without a Tier3 Input
were classified as:

| Cause | Count | Notes |
|---|---:|---|
| Handoff absent / no Tier2 route | 49 | No production Handoff was created |
| Gate executed, not escalated | 7 | All `HIGH_CONFIDENCE_STATIC`: `ks-log`, `nocuzune`, `commons-skin`, `eslint-plugin-seller-ui-eslint-plugin`, `native-svg`, `oj-cropper`, `systemrobotassistant` |
| Gate escalated, Input not delivered | 1 | `vibranced`; shadow build failed after GuardDog timeout and unresolved evidence |
| Scan failure | 2 | `discorddependency`, `bem-mvc` |

There were no malicious cases in the `Gate not executed after Handoff`
category.

## HIGH_CONFIDENCE_STATIC with LOW confidence

The same pattern was reproduced in the final current and reused baseline
runs:

- `commons-skin@6.0.4`
- `eslint-plugin-seller-ui-eslint-plugin@0.0.3`
- `oj-cropper@1.9.99.zip`
- `systemrobotassistant@3.0.8.zip`

This task did not change Gate logic. `HIGH_CONFIDENCE_STATIC` is the fallback
reason when no other escalation reason remains, while confidence is lowered
separately when unresolved restoration is observed. The pair is therefore a
reason/quality-semantics observation, not a confirmed Gate bug.

## Targeted #407 fixes

The regression was caused by applying shell-style `$VAR` and `${VAR}`
credential-source matching to all JavaScript source. Normal GraphQL template
interpolation such as `${getTokenKindDesc(kind)}` was therefore misread as a
credential source because the interpolated identifier contained `TOKEN`.

The fix scopes shell-environment matching to lifecycle command analysis while
preserving direct `process.env` detection in ordinary source analysis. A
GraphQL-shaped negative fixture was added. On the final current run,
`graphql@16.9.0` has no `custom.credential-source`, no credential/network
corroboration, no Tier2 route, and no Gate escalation.

The second fix scopes `prepare` lifecycle corroboration to shared metadata
script provenance. `ardatan-sync-fetch@0.0.1` has `prepare: npm run build`,
while its network/process evidence comes from unrelated runtime source files.
The fresh targeted result therefore keeps Tier1 risk false. Its Agent/Gate
routing is recorded separately and was not changed by this fix.

## Validation and limitations

Validation completed after the targeted fix:

- Scanner typecheck: PASS.
- Scanner build: PASS.
- Related custom-rule, Tier1 weighting, metadata, and Tier3 Gate tests: PASS,
  4 suites and 65 tests.
- `git diff --check`: PASS.
- No OpenAI provider call was made.

The full-funnel pilot measures static analyzer output, normalized Evidence,
Tier1 summary, Tier2/Handoff, API-free Gate, and Tier3 Input construction. It
does not make a Policy final decision and does not execute package lifecycle
scripts or package code. The raw JSON is a per-sample funnel summary, not a
complete copy of every Finding/Evidence object.

The old pre-fix current artifact was excluded from performance comparison
because of its 17 preflight failures and is not retained in the repository.
The final comparison uses the fresh current result and the already completed
#391-before result on the same 120 archives.

## Reproducibility artifacts

- `apps/scanner/reports/validation/omc-120-pilot-source.json`
- `apps/scanner/reports/validation/omc-120-reproducibility-manifest-2026-09-30.json`
- `apps/scanner/scripts/omc-120-reproducibility.mjs`
- `apps/scanner/scripts/omc-120-lifecycle-report.mjs`
- `apps/scanner/reports/validation/omc-120-archives-2026-09-30` (local ignored cache)

The full-funnel per-sample JSON/Markdown outputs, lifecycle aggregate JSON,
Tier2 benchmark outputs, and Tier3 gate profile output were generated during
validation but are intentionally excluded from Git. They can be regenerated
from the manifest, local archive cache, scripts, and recorded commands above.
