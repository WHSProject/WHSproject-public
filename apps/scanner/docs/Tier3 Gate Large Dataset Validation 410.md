# Issue #410 Tier3 Gate Large Dataset Validation

## 목적

Issue #391 Tier 1 generic signal weighting과 Issue #407 lifecycle script 분석이
적용된 HEAD에서 Tier3 Gate 전달 기준을 재검증한다. 이번 작업은 Gate threshold나
조건을 조정하지 않고, 재현 가능한 dataset과 보존된 validation artifact의 범위를
확인하는 데 목적이 있다.

## 실행 기준

- Branch: `test/410-tier3-gate-large-dataset`
- HEAD: `13f3e33` (`test(scanner): validate Tier3 gate on larger dataset (#410)`)
- Tier3 Gate production function: `src/llm-agent/tier3-escalation-gate.ts`
- Gate input path: Tier1 analyzer findings/evidence + optional Tier2 handoff/restore
- Tier3 provider: 호출하지 않음

## Dataset recovery audit

The historical report describes a 600-sample run (300 benign / 300 malicious),
with 14 Scanner failures, 6 unresolved socket comparisons, a 580-sample
comparable set, class counts of 293 malicious / 287 benign, and 22 Tier3 Inputs.
Those facts were used as search anchors only. They are not treated as a current
run result.

The audit covered all local Git refs and history, commit `9298fb9` and adjacent
commits, deleted-file history, Scanner benchmark/report/script paths, ignored
report paths, the repository-adjacent `agent-lab` workspace, Downloads, Temp,
and targeted execution/session logs. No package/version/label manifest, archive
root, or raw per-sample result for the historical 600/580/140 sets was found.
The commit `9298fb9` is a dashboard OAuth merge commit; its tree does not
contain the historical dataset artifact.

The recovery classification and hashes are recorded in
`Tier3 Gate 410 Recovery Inventory.json`.

| Dataset | Source | 전체 | 정상 | 악성 | Recovery class | Current-HEAD rerun |
|---|---|---:|---:|---:|---|---|
| Historical 600 | OMC / MPAD / Datadog aggregate record | 600 | 300 | 300 | D: aggregate only | 불가: exact manifest/archive 없음 |
| Historical 580 comparable | historical aggregate record | 580 | 287 | 293 | D: aggregate only | 불가: sample rows 없음 |
| Historical 140 | historical aggregate/reference | 140 | - | - | D: aggregate only | 불가: manifest/archive 없음 |
| OMC stored pilot | `reports/validation/omc-tier1-tier2-pilot-2026-09-28.json` | 40 | 20 | 20 | B: manifest/raw report, archive 없음 | stored result only |
| Lab4 external corpus | external `agent-lab/Lab4` | 87 | 30 | 57 | B: separate manifest/labels, archive 없음 | 실행하지 않음 |

The external 87-sample Lab4 manifest and the 25,767-row DataDog CSV are not
the historical OMC/MPAD/Datadog 600-sample selection. They are therefore not
used as a direct before/after corpus. The Lab4 payload hash is not an npm
archive hash, and its ignored local archives are absent; re-collecting by
package name/version alone would not prove exact corpus identity.

## Dataset 확인

| Dataset | Source | 전체 | 정상 | 악성 | 실행 성공 | 실행 실패 | 상태 |
|---|---|---:|---:|---:|---:|---:|---|
| OMC stored pilot | `reports/validation/omc-tier1-tier2-pilot-2026-09-28.json` | 40 | 20 | 20 | 40 | 0 | 보존 report, 실행 commit은 `9298fb9` |
| OMC Tier2 source | `reports/validation/tier2-omcbench-2026-09-23.json` | 40 | 20 | 20 | 40 | 0 | 현재 Gate proxy 입력 |
| OMC 140 | exact manifest/archive 없음 | 0 | - | - | 0 | 0 | 실행 불가 |
| OMC 600 | exact manifest/archive 없음 | 0 | - | - | 0 | 0 | 실행 불가 |

140건/600건 원본 corpus, manifest, extracted archive가 repository 또는 현재
workspace에 없어 대규모 실행 결과로 간주하지 않았다. 과거 report의 숫자를 현재
HEAD의 결과로 재사용하지 않았다. 따라서 이번 단계에서도 40건을 Issue 목표
달성으로 표시하지 않는다.

## 보존된 40건 실제 pilot funnel

아래는 저장된 `guarddogOn` pilot report의 package-level 결과다. 이 report는 현재
HEAD가 아니라 report에 기록된 `9298fb9` 실행 결과이며, 현재 HEAD와 직접적인
before/after 비교에는 사용하지 않는다.

| Label | 전체 | Tier1 Finding ≥1 | Tier2 Evidence >0 | Candidate | RESTORED 포함 | PARTIAL 포함 | UNRESOLVED 포함 | Handoff | Gate 실행 | Gate escalation |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| BENIGN | 20 | 13 | 3 | 3 | 2 | 1 | 2 | 3 | 3 | 1 |
| MALICIOUS | 20 | 19 | 3 | 3 | 2 | 1 | 1 | 3 | 3 | 0 |

Gate 미실행은 BENIGN 17건, MALICIOUS 17건이며 모두 Handoff가 생성되지 않은
경로다. 이 report에는 독립적인 Tier1 high-confidence boolean이 저장되지 않아
Finding 존재와 high-confidence static을 동일하게 해석하지 않았다.

### 보존된 Gate reason 분포

| Label | Reason | Count | Escalation |
|---|---|---:|---:|
| BENIGN | `HIGH_CONFIDENCE_STATIC` | 2 | 0 |
| BENIGN | `ANALYZER_DISAGREEMENT` + `PARTIAL_RESTORE` + `UNRESOLVED_OBFUSCATION` | 1 | 1 |
| MALICIOUS | `HIGH_CONFIDENCE_STATIC` | 3 | 0 |

정상 Tier3 전달 사례는 `OMC-benign-ejs-3-1-10-tgz` 1건이다. Tier1 signals에는
filesystem read/write, network outbound, process spawn, system information read가
있었고, Tier2 복원이 3개 파일 모두 `PARTIAL_RESTORED`이며
`DYNAMIC_DECODE_UNRESOLVED`가 존재했다. 따라서 전달 원인은 generic 단일 signal이
아니라 analyzer disagreement와 restore/semantic uncertainty의 조합이다.

악성 Tier3 미전달 사례는 다음 3건이며 모두 `HIGH_CONFIDENCE_STATIC`으로 종료됐다.

- `OMC-malicious-nocuzune-1-0-0-zip`: threat와 sensitive/network/download/process capability가 함께 존재.
- `OMC-malicious-oj-cropper-1-9-99-zip`: lifecycle/install, download/network/process 및 threat signal이 존재.
- `OMC-malicious-systemrobotassistant-3-0-8-zip`: lifecycle/preinstall, download/network와 threat signal이 존재.

`oj-cropper`와 `systemrobotassistant`는 저장된 report에서 reason은
`HIGH_CONFIDENCE_STATIC`이지만 decision confidence가 `LOW`로 기록됐다. 이는
unresolved/partial restore 상태를 confidence 필드가 별도로 반영한 관찰사항이며,
이번 Issue에서는 reason/threshold를 임의 변경하지 않는다.

보존된 pilot artifact는 `Tier3 provider was not called` 상태이고 Tier3 Input의
per-sample 결과를 저장하지 않았다. 따라서 Tier3 Input 생성 수와 실제 전달 수는
0으로 단정하지 않고 `NOT_MEASURED`로 기록한다.

## 현재 HEAD Gate proxy

현재 build 산출물로 다음 표준 script를 실행했다.

```powershell
pnpm --filter scanner build
$env:OMC_GATE_OUTPUT = '<temporary path>'
pnpm --filter scanner exec node scripts/omc-gate-profile-eval.mjs
```

이 실행은 40건 Tier2 restore-state만 사용하며 Tier1 findings와 normalized Tier2
evidence를 입력하지 않는다. 따라서 full production funnel이 아닌 Gate decision
proxy다.

| Profile | Corpus | Gate 실행 | Gate 미실행 | Escalation | Reason 분포 |
|---|---:|---:|---:|---:|---|
| CONSERVATIVE | 40 (20/20) | 2 | 38 | 2 | `PARTIAL_RESTORE` 1, `UNRESOLVED_OBFUSCATION` 1, `SEMANTIC_RELATION_UNCLEAR` 2 |
| BALANCED | 40 (20/20) | 2 | 38 | 1 | `PARTIAL_RESTORE` 1, `UNRESOLVED_OBFUSCATION` 1 |
| LLM_MINIMAL | 40 (20/20) | 2 | 38 | 1 | `PARTIAL_RESTORE` 1, `UNRESOLVED_OBFUSCATION` 1 |

Proxy의 Gate 미실행은 source report의 Tier2 candidate/handoff 조건이 없는 38건에
해당한다. 이 결과만으로 정상/악성 전달률 또는 #391/#407 효과를 산출하지 않는다.

## Current-HEAD rerun scope and limitations

The available 40-case report is a prior stored run at scanner commit `9298fb9`,
not a current-HEAD rerun. The current HEAD proxy is limited to stored Tier2
restore state and does not contain Tier1 findings, normalized Tier2 evidence,
or a production Handoff for every package. Consequently, no 600/580/140
full-funnel rerun was claimed.

The external 87-sample manifest was not promoted to a validation corpus. Its
archives are absent, the exact archive identity cannot be checked from its
payload hash, and Docker is unavailable in this environment, so the standard
GuardDog/custom-rule production path cannot be executed safely. A metadata-only
or synthetic rerun would not satisfy Issue #410's full-funnel requirement.

## #391 / #407 관찰

- 현재 workspace에는 동일 corpus의 pre-#391/pre-#407 실행 결과가 없어 before/after 직접 비교는 불가하다.
- 보존된 pilot에는 lifecycle signal과 threat/capability 조합이 포함된 악성 sample이 있으며, 현재 Gate가 이를 `HIGH_CONFIDENCE_STATIC`으로 처리한 사실만 확인할 수 있다.
- 보존된 benign escalation은 lifecycle 존재 단독이 아니라 partial restore, unresolved decode, analyzer disagreement 조합이었다. 단, 해당 report는 현재 HEAD 실행 결과가 아니다.
- #391 generic weighting 및 #407 lifecycle 분석을 대규모 corpus에서 재검증할 충분한 raw input은 현재 없다.
- #391의 generic single-signal 경계와 corroboration 조합은 관련 unit/production-path fixture에서 검증했지만, historical 600 corpus의 aggregate 수치와 직접 연결하지 않았다.
- #407의 lifecycle 내용 분석은 현재 branch에 포함되어 있으나, 600 corpus raw package와 lifecycle script rows가 없어 대규모 변화량은 산출하지 않았다.

## HIGH_CONFIDENCE_STATIC + LOW confidence

The stored 40-case report records `oj-cropper` and `systemrobotassistant` with
reason `HIGH_CONFIDENCE_STATIC` and decision confidence `LOW`. The current
Tier2-only proxy can reproduce the reason for those samples under some profiles,
but it does not carry the original Tier1 evidence or confidence field. Therefore
the combined reason/confidence observation is `NOT_REPRODUCED_ON_FULL_FUNNEL`,
not a confirmed regression. No logic change was made.

## Gate 결론

현재 Gate 기준은 기존 fixture와 보존된 40건 artifact에 대해서는 유지 가능하다.
그러나 Issue 목표인 대규모 dataset 안정성에 대해서는 `추가 dataset 필요`로
분류한다. 140/600 corpus가 확보되기 전에는 threshold나 reason 조건을 조정하지
않는다.

다음 실행에서는 각 sample에 대해 Tier1 findings/evidences, Tier2 candidate,
restore, handoff, Gate decision/reasons, Tier3 Input build result를 함께 저장해야
정상 전달 사례와 악성 미전달 사례를 완전한 funnel로 분류할 수 있다.

## 제한 및 후속

- Finding은 최종 악성 판정이 아니다.
- Tier3 미전달은 자동으로 미탐을 의미하지 않는다.
- Gate 미실행은 자동으로 정상이라는 뜻이 아니다.
- 동일 corpus가 아니면 before/after 직접 비교를 하지 않는다.
- 보존 report는 package-level OMC label이며 file-level ground truth가 아니다.
- 실제 LLM Provider 호출은 수행하지 않았다.
- benchmark dataset은 운영 npm 분포가 아니다.
- 다음 GuardDog 선택 실행 Production 작업에서 140/600 corpus와 per-sample raw funnel을 확보해야 한다.
- 새 실행은 package/version/label/source/archive hash, Scanner commit, date, Tier1/Tier2/Handoff/Gate/Tier3 Input fields, raw per-sample JSON, aggregate report를 함께 보존해야 한다.
