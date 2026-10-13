# Final DevOps / Release QA — 2026-10-12

관련 Issue: [#503](https://github.com/WHSProject/WHSproject/issues/503). 내부 QA 보고서이며 독립 Reviewer 판정 및 PM/PL 승인을 대신하지 않는다. **Public Release: HOLD / PRE-FREEZE.**

## 현재 요약 — 라이선스·고지 반영 및 #515 재검증 결과

### 2026-10-13 PM/PL 공개 문서 결정 반영

- ARGUS 자체 작성 코드의 라이선스를 Apache-2.0으로 확정한 PM/PL 전달을 반영해 루트 `LICENSE` 전문을 추가했다.
- README의 프로젝트 출처를 “한국인터넷진흥원(KISA)이 주관하는 화이트햇스쿨 4기 팀 프로젝트 「공공의 적」의 결과물”로 확정하고, Apache-2.0 및 `THIRD_PARTY_NOTICES.md` 링크를 추가했다.
- SemVer·폰트·아이콘·Better Auth·Babel·webcrack·GuardDog·Semgrep·Verdaccio·OSV·CI/base image·평가 자료를 루트 `THIRD_PARTY_NOTICES.md`에 정리했다. 기존 파일의 버전·출처 주석·라이선스 원문과 대조했다.
- 외부 샘플 및 비공개 QA fixture의 재배포 허가로 해석하지 않는다. Docker image/binary를 공개 배포할 경우 배포물별 원문·NOTICE·소스 제공 의무 확인이 별도로 필요하다.
- 위 문서 반영은 라이선스 게이트의 저장소 문서 준비 완료이며 Public GO가 아니다. Final SHA·독립 Reviewer·잔여 보안 위험 수용·공개 산출물 범위·PM/PL 최종 승인은 계속 대기한다.

### 사용자 요청으로 보완 source·로컬 실행 반영

응답 스트림 중단 후 Git 상태를 확인해 동일 작업을 이어갔다. 적용된 policy-llm.prompt.ts가 검증된 proposal source와 정확히 일치함을 확인했고, 실제 source compile·기존111/111 PASS. 오류별 교정 문구3줄만 Commit `23c1fe5`로 PR516에 반영, Rule/Validator/timeout/재시도 상한 불변. 이 코드 반영으로 PR 제목·설명도 최종 범위에 맞춰 수정했다. 해당 Commit CI 전부 통과 확인.

정확한 Commit archive의 Policy image build·로컬 배포 완료: image `sha256:d7e813c843d242b9391995a847c58737aa2173a27436e1e18718872a350f8194`, revision label `23c1fe5`. 배포 후 preflight9서비스/기존 sasl-plain FOUND-ACCEPT 재사용 실제 설치 PASS. 이 재사용 실행은 새 Fresh/Tier3 증거가 아니며, 직접 교정 증거는 앞선 동일 module의 격리1회 비교로 유지한다. 기존 Decision·volume 보존. PR은 Draft, dev/main 병합·공개 GO 없음.

라이선스/공개 범위 근거·잔여 결정은 `docs/release-scope-decisions.md`에 기록했다. PM/PL 전달에 따라 Apache-2.0과 공식 출처·제3자 고지를 반영했으며 별도 ARGUS NOTICE와 내부 handoff 문서는 공개 파일에 추가하지 않았다. Discord 제안 공지는 사용자가 미발송했다고 확인했으므로 미발송 상태 유지. VS Code Codex Browser 연결은 없었으나 사용자가 로컬 Chrome에서 실제 `/requests` 화면을 확인해 최신 Root 행을 캡처했다. UI 인수 결과는 아래 최신 증적 범위에서 PASS로 갱신한다.

OSV REVIEW 기대 조건 추가 검증: nextjs 공식 advisory MAL-2025-5938가 Validator VALID/APPLICABLE(Severity missing 보존)임을 확인하고 실제 SUCCESS Feed+기존13 Evidence로 새 QA DB 1회 평가했다. Policy20s timeout으로 HOLD/POLICY_LLM_UNAVAILABLE, Evidence13/Decision1 저장. Feed 수용·fail-closed 확인과 최종 REVIEW 인수 INCONCLUSIVE를 구분한다. 기존 OSV SKIPPED 실행을 REVIEW 조건 검증으로 재해석하지 않는다. QA 정지/데이터 보존.

최신 재전달 인수 기준 정정: nextjs 기대는 OSV 적용 근거의 REVIEW이며 advisory만으로 REJECT 아님. 이전 replay의 OSV SKIPPED 결과와 조건이 달라, 해당 replay를 OSV REVIEW 케이스 PASS/FAIL로 직접 재해석하지 않는다. ts-form은 REJECT-CHILD-PROCESS의 세 Predicate 직접 근거, mexc는 버전/ground truth·직접 근거, uipath는 process/path 직접 근거가 충족될 때 REJECT 기대. 필요한 UNKNOWN/최종 Citation 실패의 HOLD 차단은 허용하되 직접 Evidence가 REJECT를 충족하는데 HOLD면 목표 불일치. 최신 기준은 QA 직접 대조 문서에 반영했다.

추가 직접 재현/보완 결과: uipath 실제 오류 응답2개를 offline Validator에서 2/2 재현, 최종 Decision의 무효 참조 제외 확인. 오류별 교정 안내만 추가한 운영 미적용 patch `docs/policy-semantic-retry-proposal.patch` 준비. source variant111 PASS·실제 payload/Citation Schema 보존 확인. 같은 입력 1회 QA 비교에서 1차 동일 오류→2차 NOT_SUPPORTED 유지/빈 Citation으로 Validator 통과, 최종은 다른 UNKNOWN의 HOLD. 교정 사례 확인과 악성 탐지 인수는 구분하며 운영 Policy/Rule/Validator 변경 없음. 상세는 QA 직접 원인 대조 문서 참조.

QA 직접 원인 대조는 `docs/qa-policy-local-adjudication.md` 참조. 신규 Provider 실행 없이 uipath의 NOT_SUPPORTED+positive Citation semantic 불일치와 ts-form/nextjs의 정적 관계 근거 대비 UNKNOWN rationale를 직접 확인했다. 원인 검증을 담당자에게 반복 요청하지 않고, 구체적 근거 및 변경/인수 판단만 전달한다. 이 대조는 정책 완화·Decision 변경·공개 GO 승인이 아니다.

### Policy 21:28 회신 및 #515 실제 검증

- 전달 회신은 Draft였으나 GitHub 직접 조회 시 **#515 MERGED/isDraft=false**, 조회한 PR checks 전부 SUCCESS. head `23171a32473fa8809c8e41949a68f522b45c14a6`, dev merge `2c1d4d98351f8c2ceb0c6d6a3a7e46e99267201b`. QA 브랜치에 최신 dev를 비파괴 merge, Policy src/Dockerfile은 head SHA와 diff 없음. 최종 공개 Freeze는 별도.
- 정확한 head 소스를 별도 context에서 compile 및 기존 test **111/111 PASS**. commit revision label 포함 Policy image build PASS: `sha256:5eca57a8485500d5b7cbc2fc2dc71644a115ce6a3f9dfe8766c275e405e3511a`, revision `23171a...`.
- PR 코드의 validation 실패 최대 1회 교정 재요청·Provider timeout/transport 무재시도 확인. 현재 .env가 60s였으므로 2회=120s가 Scanner Policy HTTP 90s를 넘을 수 있었다. 담당자 PR 기준대로 로컬 POLICY_LLM_TIMEOUT_MS를 **20000**으로 맞추고 통합 Policy만 새 이미지 재배포. 최대 Provider 호출 2회/40s가 Scanner 90s 안에 들어감. 실제 image/revision/healthy/20s 확인. 키·기존 Decision·Volume 보존.
- 정상 새 `sasl-x-oauth2@0.1.0` NOT_FOUND→Fresh npm install exit0→FOUND/ACCEPT PASS. Decision `dec_5c5f11b9-1994-42d9-894a-355048670b5f`, request `31599cda-205a-474c-bee3-e27f975e0230`, scan `5c5f11b9-1994-42d9-894a-355048670b5f`. PRIMARY COMPLETED/v3/attempt1, RULE-ACCEPT-BENIGN SATISFIED/BENIGN_ALTERNATIVE_SUPPORTED SUPPORTED, ACCEPT/POLICY_PASSED, Assessment `llm:82c345b2-06b8-486c-b706-320a5d48968e:assessment-http-metadata-urls` 인용. 이전 sasl-plain 정상 사례 및 HOLD make-node 보존.
- 네 fixture는 Scanner를 무작정 재실행하지 않고 **동일한 저장 Scanner 결과**를 새 `whs-tier3-qa515` 프로젝트/신규 volume에 replay. 이전 QA DB Decision 충돌/교체 없음. 정상 통합 Policy와 같은 image/model/20s 설정. 이는 Policy 변경의 동일 입력 회귀이며 네 fixture의 새 full Scanner/Gateway HTTP E2E로 주장하지 않는다. Evidence80/Decision4 저장 PASS.

| fixture | #515 실제 결과 | 인수 구분 / requestId |
|---|---|---|
| ts-form-helpers | HOLD/POLICY_DECISIVE_EVIDENCE_UNKNOWN, PRIMARY COMPLETED/1회 | 이전 Assessment namespace 오류는 이번 실행에서 미관측, 악성 관계 UNKNOWN; request f871176a-b99a-4c42-a1f0-4742ffcb6946 |
| uipathisfun | HOLD/POLICY_LLM_INVALID_JUDGMENT, PRIMARY FAILED/2회 | NOT_SUPPORTED_CANNOT_CITE_POSITIVE_EVIDENCE:REMOTE_CODE_FETCH가 두 번 반복, 1회 교정·최종 fail-closed 실제 확인; request e37e8e12-4798-4adf-b579-7f226e84039f |
| mexc-utils-helper | HOLD/POLICY_LLM_UNAVAILABLE, PRIMARY FAILED/1회 | POLICY_LLM_TIMEOUT, 20s timeout 무재시도 실제 확인; request f9e61ef7-1aa9-4fc3-98db-3bae46ad7236 |
| nextjs-https-supertest | HOLD/POLICY_DECISIVE_EVIDENCE_UNKNOWN, PRIMARY COMPLETED/1회 | 이전 unknown reference 오류는 이번 실행에서 미관측, 악성 관계 UNKNOWN; request 57322eeb-be55-41bc-81e0-d3a21cd895a6 |

- 이번 실행에서 UNKNOWN_EVIDENCE_REF 및 Assessment namespace 혼용은 미관측, 그러나 semantic Validator 오류1/timeout1/decisive UNKNOWN2가 남음. **REJECT0**. 잘못된 ID를 무조건 교정할 수 있다거나 악성 탐지 인수 완료라고 선언하지 않는다.
- OSV version query: ts-form-helpers1.0.12=MAL-2026-2872, uipathisfun1.0.39=MAL-2026-1983, nextjs-https-supertest1.0.14=MAL-2025-5938, mexc-utils-helper1.0.0은 반환 advisory0. 공개 metadata 조회만 했으며 이 정보를 평가 Evidence에 임의 주입하거나 ground truth로 사용하지 않았다. OSV0은 정상 보증 아님.
- 담당자 fixture 기준: 직접 악성 근거와 올바른 Citation이 REJECT Rule을 만족하면 REJECT 기대. 근거 불완전/모순 또는 교정 실패 후 설치 차단 HOLD는 허용하되 **알려진 악성 동작의 직접 근거가 확인되는데 HOLD에 머무르면 탐지 인수 미통과**. uipath 결정적 UNKNOWN의 HOLD는 차단만 인정하고 탐지 QA 미통과. mexc 버전/내부 ground truth를 검증자가 별도 확인(LLM 입력 제외)해야 함.
- QA DB Decision을 Gateway production 집행 함수에 적용: 4/4 allowed=false/approvalRequested=false. 악성 full HTTP/tarball 경로는 여전히 미검증. 새 QA 서비스 정지·두 QA volume/증적 보존, 운영9/9healthy. 반복 모델 실행으로 PASS 유도 없음.
- **현재:** 정상 Fresh 및 교정 횟수·timeout 상한·fail-closed 확인, 악성 semantic 오류/timeout/UNKNOWN의 근거·인수는 Policy 검토 필요. UI/라이선스/Final/독립/PM 승인도 남으며 Public HOLD.

### Policy 20:20 회신 — 제안 인수 기준 및 수정 계획

Policy 담당자 OWNER_REPLIED, 별도 수정 PR/SHA/배포는 아직 미수신. 제안이지 PM/PL 최종 승인·수정 완료가 아니다.

1. 정상 Fresh는 VERIFIED Assessment 인용·RULE-ACCEPT-BENIGN SATISFIED·ACCEPT/POLICY_PASSED·실제 설치까지 요구. 현재 sasl-plain 실측 사례가 해당 경로를 충족한다.
2. Assessment는 assessmentIds, 일반 Evidence는 요청의 유효 evidenceIds에 인용하며 무효 참조가 최종 Decision에 반영되지 않아야 한다. 기존 3건은 Validator 실패/HOLD, replay 응답의 cited Evidence/Assessment count 0 및 저장 Decision 확인 이력으로 구분한다. 유효 참조를 사용한 악성 판단 성공으로 확장하지 않는다.
3. 동일 trace의 Scanner 저장·Policy 입력 수용·Predicate/Citation·최종 Decision 연결을 단계별 확인. 동일 요청 ID만 일치한다고 모든 단계 성공으로 간주하지 않는다.

담당자 계획: 네 fixture의 trace·기대판정 대조 → 요청별 유효 ID 목록 제한의 Provider 지원 검토 → 미지원이면 Validator 실패 후 재요청 및 오류 처리 보완·재현 회귀 추가 → 별도 PR → 통합 이미지 SHA 확인 → 정상/4 fixture를 같은 환경에서 재검증. 재요청은 아직 구현되지 않았으며 임의로 timeout/비용/무한재시도 Contract를 추가하지 않는다. QA는 수정 PR/이미지 수신 후 영향 범위 검증을 재개한다. 기존 동일 fixture 분석을 지금 반복하지 않는다.

추가 미결: fixture별 기대 Decision 및 근거(필수 REJECT vs 근거 부족 HOLD 허용 범위), 최종 거절·fallback의 공개 인수 여부는 명확히 확정해야 한다. Validator 오류가 HOLD로 차단된 사실만으로 악성 판별 인수 PASS 처리하지 않는다. 새로운 PR에 재시도 횟수·timeout 상한·최종 failureDecision·부작용/중복 저장 처리도 Review 항목으로 확인한다.

사용자 전달용 답장 초안:

> 인수 기준과 수정 계획 감사합니다. 정상 sasl-plain은 안내하신 VERIFIED 인용→Rule SATISFIED→ACCEPT/POLICY_PASSED→Fresh 설치 경로를 확인했습니다. 기존 네 fixture의 trace는 QA 보고서에 정리했습니다. 수정 PR/Commit SHA와 배포 준비가 되면 알려주시면 동일 환경에서 정상 샘플과 네 fixture를 재검증하겠습니다. fixture별 기대 Decision 및 근거와, 근거 부족 HOLD 허용 범위도 함께 정리 부탁드립니다. 재요청 경로를 추가하시면 횟수·timeout 상한과 최종 실패 판정도 확인하겠습니다.

현재 source candidate는 `26b507e346f350ba4f0cf519f7309d9d39350ed2`와 로컬 QA/Compose 수정안이다. 아직 Final Freeze 및 공개 승인은 없다.

| Gate | 최신 결과 |
|---|---|
| 기본 Runtime·Fresh default ACCEPT | PASS |
| 정상 real Tier3→VERIFIED→Policy SATISFIED→ACCEPT/POLICY_PASSED→Fresh install | sasl-plain 사례 PASS |
| 격리 4개 fixture Scanner/Jev/Evidence 경계 | 4/4 실행, 9 VERIFIED LLM Evidence, supplied invariants PASS |
| 격리 실제 Evidence·Policy·Decision DB | 80 Evidence·4 Decision 저장 PASS; 모두 HOLD |
| 악성 근거 판별 | REJECT 0; Policy invalid judgment 3 및 decisive UNKNOWN 1, 인수 미완료 |
| Gateway 집행 | 정상/기존 HOLD·REVIEW HTTP 사례 PASS; 악성 fixture는 실제 DB+production 함수 probe까지만, full HTTP 미검증 |
| Failure/Recovery·최신 Root/History/UI | PASS; 사용자 제공 실제 `/requests` 화면에서 최신 Root 행까지 교차 확인 |
| 공개/독립 인수 | License·Final SHA/CI·Reviewer·PM 승인 PENDING, Public HOLD |

## 초기 실측 기준 및 환경 (이후 업데이트는 아래 최신 기록 우선)

- QA 작업 브랜치: `docs/503-final-release-qa` (최신 `origin/dev`에서 분기).
- 소스 기준: `ed9f7fd300c219644aaaae1aa9b4bb702b62ac8a`.
- 원격 `dev`: 위 SHA. README PR [#511](https://github.com/WHSProject/WHSproject/pull/511)은 2026-10-12 12:35:45 KST 병합 완료.
- 원격 `main`: `4ada3fdaf1bc90e9497982756156249320d8330c`. Repository private, default branch `dev`. 공개 대상 브랜치 및 Final SHA Freeze는 미확정.
- `aa3360a` → 소스 기준 SHA의 변경은 README 1개뿐. 기존 이미지를 최신 SHA 전체 빌드로 주장하지 않는다. 이번 작업의 `.gitignore` 변경은 Runtime Contract 변경 없음.
- Windows / PowerShell / Python 3.11, Gateway·Scanner·Policy 실행 Node v24.21.0. 검증 시각: 2026-10-12 12:43–12:53 KST.
- 로컬 `.env` 및 `.npmrc`는 Git 추적 대상이 아님. `.env.example`은 추적됨. 인증 값은 출력하거나 보고서에 보관하지 않았다.

## 이번 신규 실측

| Test case / Expected | Actual / Evidence | QA 판정 |
|---|---|---|
| README merge / 최신 dev 반영 | GitHub PR #511 MERGED, merge SHA `ed9f7fd`; 로컬 fetch 및 분기 완료 | PASS |
| Compose 구성 / 필수 9서비스 healthy | `docker compose config --quiet` exit 0; `docker compose ps --format json`에서 9/9 running·healthy | PASS (관측 시점) |
| 실행 Timeout 및 Scanner ON | Gateway `SCANNER_ENABLED=true`, 300000ms; Scanner Agent true/RISK_BASED/180000ms, package 240000ms | PASS (설정) |
| 활성 Policy / 변경 반영 확인 | 실행 컨테이너 `HttpActivePolicyClient.fetchActive()` 결과 `qa-npm-policy/0.1.0`, 12 rules, default REVIEW, failure HOLD | PASS (조회), 변경 미반영 |
| Gateway 전체 회귀 / 기존 테스트 통과 | `npm.cmd test -- --runInBand`: 24 suites / 356 tests PASS, exit 0 | PASS (로컬 소스) |
| Scanner Runtime·Tier3 경계 / 기존 테스트 통과 | `npm.cmd test -- --runInBand test/compose-runtime.spec.ts test/tier3-runtime-integration.spec.ts test/tier3-llm-evidence-binding.spec.ts`: 3 suites / 24 tests PASS | PASS (fixture 경계), live Tier3 증거 아님 |
| Policy 기존 회귀 / 실패·불확실·Citation 처리 | `docker compose exec -T policy npm test`: 95 tests PASS, exit 0. Provider timeout, invalid citation/judgment, evidence conflict 및 unknown 관련 테스트 포함 | PASS (실행 이미지의 offline tests), live E2E 증거 아님 |
| 저장소 `.npmrc`로 인증 / metadata 200 | Preflight에서 health·guard 통과 후 npm metadata E401. 해당 파일은 credential 설정 없이 로컬 npm 옵션만 포함 | FAIL (인증 설정 선택), 아래 기존 사용자 설정으로 해결 |
| 기존 사용자 QA 설정 / reusable 설치 성공 | `python tests/e2e/critical_path.py --npmrc <existing-user-config> --package is-number --version 7.0.0`: preflight PASS → FOUND/ACCEPT → npm install exit 0 → 설치 확인 → FOUND/ACCEPT → full PASS, exit 0 | PASS (reusable path) |
| 인증 파일 Git 제외 / accidental staging 방지 | `.gitignore`에 `.npmrc`, `.npmrc.*` 추가 및 `.npmrc.example` 예외. `git check-ignore .npmrc .env` 확인 | PASS (로컬 수정안) |

활성 Policy hash: `0ef693c28ca1814398fd7338c5f7fff1bb1a13ec8276708eae683498cec4262a`. 활성 API는 기본판정 필드를 반환하지 않으며, 실행 이미지의 parser를 적용해 REVIEW/HOLD를 확인했다. Policy 기본값을 변경하지 않았다.

이번 npm 설치는 임시 workdir/cache에서 `--ignore-scripts --no-audit --no-fund`로 수행했다. 기존 ACCEPT 재사용이므로 Fresh Scanner/Policy 분석, Root intent 등록, 최신 Root DB 또는 Dashboard UI 정합성을 증명하지 않는다. 10/10 Root/Dashboard PASS는 과거 실측으로만 유지한다.

README PR CI는 head `8d7d17d`에서 success를 확인했다. Workflow는 `pull_request` → `dev`에 실행되며 Dashboard/Gateway/Scanner, Python Policy API, Compose 구성, Policy/Decision DB integration smoke 및 Docker build를 포함한다. 전체 9서비스 npm/Tier3 live E2E를 보장하지 않으며 Merge SHA의 Final Release CI 완료로 확장 해석하지 않는다.

## 담당자 회신 반영 — 재검사 종료

아래는 사용자가 12:47 KST에 전달한 담당자 검토 결과이며, Codex의 독립 재분류 결과가 아니다.

| 항목 | 분류 및 책임 | 상태 |
|---|---|---|
| `40b746fb` 80건 | SHA-256 reuseKey 76, API Schema SHA-256 2, tokenizer 설정 2; Scanner 소관 | OWNER_TRIAGED_FALSE_POSITIVE |
| `478e5bc5` 1건 | tokenizer 설정; Scanner 소관 | OWNER_TRIAGED_FALSE_POSITIVE |
| `028e709d` 1건 | Dashboard 테스트 내부 URL; 해당 변경 작성자 및 Dashboard/Policy 소관 확인 | OWNER_TRIAGED_FALSE_POSITIVE |
| `picocolors@1.1.1` Tier3 | Finding 없음 → NO_ESCALATION_SIGNAL → NO_THREAT_FINDING/SKIPPED, Assessment 0은 의도된 동작 | CLOSED / EXPECTED |

동일 526 commits Gitleaks 반복 검사·원문 조회·재분류를 하지 않았다. 담당자 판단상 실제 Credential 없음, 폐기·교체·이력 재작성 불필요. 최종 공개 대상 SHA 및 이후 변경 범위 확인은 유지한다. `picocolors`의 SKIP을 강제로 변경하거나 재검사하지 않았다. 해당 정상 패키지의 REVIEW/403 Compatibility 문제와 실제 Tier3 E2E는 별개다.

## Policy 담당자 후속 회신 — 2026-10-12

사용자가 전달한 Policy 담당자 회신 기준이다. 새 Runtime 테스트는 실행하지 않았다.

- 기본 ACCEPT 변경은 작업에 포함되지 않았다. 내부 LLM 출력 Schema·Prompt 보완만 로컬 브랜치에 있으며 commit/PR/통합 배포 없음. 기본 ACCEPT PR/SHA·배포 완료를 기다리는 항목을 **변경 계획 및 정상 패키지 Compatibility 인수 기준 결정 대기**로 정정한다. 기본 ACCEPT를 필수 해결책으로 가정하지 않는다.
- 담당자 마지막 QA 이미지 기준은 `aa3360a2df167a5a8cecc26fa426ff3c60a14a2c`. 앞선 Codex 실측 소스는 `ed9f7fd`, 실행 Policy는 REVIEW/HOLD였다. 담당자 로컬 수정 결과를 통합 PASS로 처리하지 않는다.
- 악성은 활성 REJECT Rule 조건과 요구 근거 충족 시 REJECT 기대. 위험 API/Finding 하나만으로 악성 확정 또는 REJECT를 기대하지 않는다.
- 불확실성은 Rule onUnknown·Resolver에 따라 HOLD 또는 REVIEW. Provider/판단 검증 실패의 fallback HOLD는 악성 확정과 구분한다.
- Scanner 분석 실패는 Scan 상태·API 응답·Policy 평가 진행 여부·Decision 유무를 함께 확인한다. 모든 실패가 HOLD로 저장된다고 가정하지 않는다. 별도로 Gateway가 판정 부재/오류에서 tarball을 허용하지 않는지도 검증한다.

Tier3 인수 증거는 동일 requestId/scanId/Assessment·Evidence ID로 다음을 분리한다.

| 단계 | 확인 증거 | 현재 상태 |
|---|---|---|
| 생성·저장 | 실제 Agent 실행, LLM_ASSESSMENT verificationStatus=VERIFIED, Scanner 원본 ID와 Evidence DB ID 일치 | PENDING |
| Policy 입력·수용 | Scanner Policy 요청 evidences 포함 및 EvidenceCase 참조·무결성 검증 통과 | PENDING |
| Predicate 인용 | policy_llm_judgments에서 Validator 통과 판단의 Predicate 상태와 Assessment Citation 확인 | PENDING |
| 최종 Decision 반영 | 판단의 Rule 상태를 함께 확인하고 decisions의 assessment_ids/evidence_ids/matched_rule_ids/reason_code와 대응 | PENDING |

Evidence DB 저장만으로 Policy 수용을, matched_rule_ids 존재만으로 Rule SATISFIED를 판단하지 않는다. VERIFIED Assessment가 최종 결정 Rule과 무관하면 최종 Decision에 인용되지 않을 수 있다. 실제 Schema/API 경로를 읽은 뒤 조회하며 기존 Decision 보존·새 requestId 검증 방향은 담당자가 동의했다. 샘플 확보 후 requestId/scanId를 담당자에게 공유할 문안을 준비한다.

Policy 요청은 회신 수신 완료. Scanner·PM/PL 요청은 사용자의 전달 설명 기준 발송 후 **WAITING_ON_OWNER**, 추가 회신 없음.

## 남은 Gate 및 인계

### Jev 설정 반영 후 실제 QA 완료 — 10/12 19:45–19:58 KST

사용자가 로컬 .env 설정 완료 및 남은 QA 진행을 요청했다. Secret 값은 출력/문서화하지 않았다.

**Runtime 및 source**

- Scanner만 `docker compose up -d --no-deps --no-build scanner`로 재생성해 기존 Jev 환경변수 전달 반영. 실제 설정: 키 존재=true, context check=true, recheck=false, RISK_BASED, gpt-6-luna. 운영 Policy는 기존 openai/gpt-4.1-mini/60s 유지.
- latest dev `26b507e346f350ba4f0cf519f7309d9d39350ed2` fetch 및 작업 브랜치 fast-forward. `162a8c9` 이후 변경은 Gateway SemVer 출처 주석 2줄뿐이며 기능 변경 없음. 운영 image/이전 테스트를 전체 clean build 또는 Final Freeze로 과장하지 않는다. compose env 전달 수정은 로컬 미커밋 상태.
- Jev/Planning/Policy boundary 기존 회귀: 4 suites / **352 tests PASS**. 별도 compose-runtime 5 PASS 이력 유지. 새 테스트를 만들어 결과를 대체하지 않았다.

**정상 실제 Tier3→Policy ACCEPT→Fresh install**

- `sasl-plain@0.1.0`: 사전 NOT_FOUND → Scanner STATIC_INCOMPLETE / Tier3 COMPLETED / generated Evidence 1 → VERIFIED Assessment 저장 → PRIMARY Policy COMPLETED → RULE-ACCEPT-BENIGN SATISFIED 및 BENIGN_ALTERNATIVE_SUPPORTED SUPPORTED → ACCEPT/**POLICY_PASSED** → 실제 npm install exit 0 → 설치 확인 및 사후 FOUND/ACCEPT → full Fresh E2E PASS.
- requestId `eb7ee69e-4c5e-4114-a2bd-7676199f6898`, scanId `389433ed-ebca-411c-8f58-d7823cc0076d`, Decision `dec_389433ed-ebca-411c-8f58-d7823cc0076d`.
- 저장 Evidence 4건(Atomic 3 + LLM 1). Assessment `llm:b1582604-b57e-4bad-87df-f3aa17d98c20:assessment-http-metadata-urls`: VERIFIED/BENIGN_LIKELY. Predicate와 Decision이 해당 ID 인용. policyHash `cbbee46a3125674aadff6fb5c72e17433c3018214f19b64a934de943fbb0f82b`. POLICY_DEFAULT 정상 yoctocolors와 구분.
- OSV 공식 API version query(https://api.osv.dev/v1/query)에서 sasl-plain 0.1.0 및 yoctocolors 2.1.2 HTTP 200, advisory 0건(2026-10-12T10:55:09–10Z). 해당 조회 시점 데이터이며 취약점 없음의 보증은 아니다. 신고 제출 없음. make-node HOLD Decision은 보존하며 반복해 ACCEPT를 유도하지 않았다.

**승인된 악성 fixture 격리 분석**

- QA image `sha256:b556ff8f401eecc211608d31afb048bea2b966d4989ef7e72bd67b95eacbc927`, base Scanner runtime `8f04ba...`, 검토된 supplied runner 사용. fixture read-only, cap-drop ALL/no-new-privileges, tmpfs noexec/resource limits, key는 메모리 전달. fixture 설치/entry point/lifecycle 실행 없음, no host network/Docker socket, 모델 gpt-6-luna. 격리 runner는 baseline 제약 ALWAYS/recheck true/package deadline 180s이며 운영 설정과 구분.
- 4/4 Scan COMPLETED, 4/4 Tier3 실행; Agent COMPLETED 2, PARTIAL 2. Atomic 71, VERIFIED LLM Evidence 9. REJECTED Assessment 2건은 Evidence 변환에서 제외. Jev 모든 호출 HTTP 200/인증 헤더 설정 확인.
- supplied check-results 전 항목 PASS 및 추가 nonempty VERIFIED 확인 PASS: archive/identity, Planning eligible, real Jev/Tier3, verified conversion/rejected exclusion, scanResult/persistence capture/Policy capture의 ID·content fingerprints 동일, lifecycle=false, ground truth 입력 없음.

| fixture | Tier3 | VERIFIED / REJECTED | Atomic / LLM |
|---|---|---|---|
| NPM-MAL-027106 ts-form-helpers | COMPLETED | 2 / 0 | 6 / 2 |
| NPM-MAL-027412 uipathisfun | COMPLETED | 3 / 0 | 18 / 3 |
| NPM-MAL-019532 mexc-utils-helper | PARTIAL | 1 / 1 | 37 / 1 |
| NPM-MAL-020750 nextjs-https-supertest | PARTIAL | 3 / 1 | 10 / 3 |

**실제 서비스 replay 및 차단 경계**

- 운영 DB를 사용하지 않고 별도 `whs-tier3-qa` Compose project/network/신규 DB volume에 5서비스를 기존 image ID로 기동. host ports는 127.0.0.1의 15433/18101/19001/19101/18001, 새로운 QA DB user 및 메모리 생성 credential 사용. 실제 키 값·기존 .env를 번들에 복사하지 않았다. active qa-npm-policy 0.1.0/12 rules 확인.
- supplied replay runner는 source package tree를 실행하지 않고 Scanner result를 실제 QA Evidence/Policy/Decision 서비스에 제출. 현재 Policy timeout 60s를 기다릴 수 있도록 **QA client timeout만 30→90s** 변경(운영 Contract 불변). Evidence 80건 및 Decision 4건 저장, source 9 LLM Evidence 모두 입력 보존.

| fixture | Decision / reasonCode | PRIMARY / 추적 ID |
|---|---|---|
| NPM-MAL-027106 | HOLD / POLICY_LLM_INVALID_JUDGMENT | FAILED, Assessment를 evidenceIds namespace에 인용; request 608f1afc-f15c-40ac-9aca-d0dd5c71c2bb / scan b639651f-32b7-4d5f-a05f-9f4008c06fa9 |
| NPM-MAL-027412 | HOLD / POLICY_DECISIVE_EVIDENCE_UNKNOWN | COMPLETED, RULE-REJECT-REMOTE-CODE UNKNOWN에 Assessment Citation; request 1a4a15fb-af9d-4d8d-8285-bcc76c49d1ea / scan 8134f7f4-1add-4710-a2c7-9cd76153cbd2 |
| NPM-MAL-019532 | HOLD / POLICY_LLM_INVALID_JUDGMENT | FAILED, UNKNOWN_EVIDENCE_REF; request 6d2a33b2-8f86-4fe0-aae6-4518894b400f / scan 9d53937b-6d03-474d-a843-e323b1173c83 |
| NPM-MAL-020750 | HOLD / POLICY_LLM_INVALID_JUDGMENT | FAILED, UNKNOWN_EVIDENCE_REF; request fe62f940-5b76-4795-8198-44c71c517299 / scan c33a6a08-b224-4359-8523-5307e792d08b |

- Gateway production image를 read-only/cap-drop/no-new-privileges로 별도 실행해 실제 QA DB Decision을 읽고 **운영 DecisionHandlerService.evaluateEnforcement**에 적용: 4/4 allowed=false, approvalRequest=null, blockedReasons=HOLD, exit 0. production 집행 함수+실제 DB 경계 검증이며 **악성 fixture의 전체 Gateway HTTP/tarball 다운로드 E2E가 아니다**.
- 악성 REJECT 사례 0. 오류 3건·UNKNOWN 1건의 fail-closed/HOLD를 악성 근거 인수 또는 REJECT PASS로 주장하지 않는다. Policy Schema/Prompt 참조 오류 개선과 Rule 판별에 담당자 조치/위험 인수 필요.
- 비공개 증적: `reports/validation/tier3-fixtures/qa-tier3-fixtures/output/{scanner,integration}`. Git 제외 확인. raw specimen/code/Provider 본문/keys를 Notion·채팅·Git에 업로드하지 않았다. QA services는 검증 후 정지하고 QA volume/증적 보존, 운영 9서비스 Health 별도 확인.

**잔여 Gate:** Policy 악성 근거의 UNKNOWN/timeout 위험 인수, 승인된 실제 Gateway 악성 HTTP 경로(현재 component probe까지만), 라이선스/공개 범위, PR #516 review·통합, Final Freeze/최종 CI·독립 Reviewer·PM GO/NO-GO. 정상 Tier3 ACCEPT Fresh 및 최신 Dashboard UI 사례는 확보했지만 Public HOLD 유지.

### 2026-10-13 독립 Reviewer 후속 — `99205db`

- 별도 clean checkout과 신규 Runtime에서 9/9 healthy, 인증, `sasl-plain@0.1.0`의 Fresh MISS → Scan/Tier3 COMPLETED → VERIFIED Assessment Citation → ACCEPT/POLICY_PASSED → 실제 설치 → FOUND/ACCEPT를 독립 확인했다.
- `sasl-x-oauth2@0.1.0`은 Scanner analyzer가 모두 성공했으나 Policy `POLICY_LLM_TIMEOUT`으로 HOLD/POLICY_LLM_UNAVAILABLE, Gateway 403이 발생했다. 정상 설치 인수는 FAIL이고 fail-closed 차단은 PASS다.
- 통제된 Scanner timeout 뒤 저장 HOLD를 Gateway가 재조회하여 403/BLOCKED·Root=true·동일 Decision ID로 연결하는 경로와 실제 Dashboard Assessment·Request·History·Decision 연결은 PASS다.
- 악성 fixture와 Scanner 오류 뒤 실제 REVIEW/REJECT 집행은 승인 실행 자료 미확보로 BLOCKED다. 비공개 증적 ZIP SHA-256은 `3DA2526D84C914AAE1ED56F67D0D1EE2B11A08913C10DD444DFFC953FA9F00E4`이며 내부 29개 파일의 manifest hash를 모두 대조했다. 원본은 공개 저장소에 포함하지 않는다.
- README·Demo Runbook·Gateway API의 legacy `npm login` 안내는 실제 410 동작과 불일치하여 Dashboard 발급 npm 토큰 방식으로 교정했다.
- 상세 결과는 `docs/independent-qa-2026-10-13.md`에 기록한다. 문서 교정 SHA의 CI, 악성/REVIEW/REJECT Gate, PM/PL GO 전까지 Public HOLD를 유지한다.

가현 Reviewer의 같은 SHA 별도 실행에서는 정상 Fresh·Root 연결은 PASS였으나
Decision의 짧은 `assessmentId`를 Evidence API 전체 ID로 연결하지 못해 Dashboard가
인용 근거를 누락했다. 짧은 ID 404와 전체 ID VERIFIED/200 증적을 대조해 원인을
확정했고, 동일 artifact·scan에서 실제 인용한 VERIFIED Assessment만 해석하는 회귀
수정을 추가했다. 새 수정 SHA의 실제 화면 재검증 전까지 Dashboard PASS를 확정하지 않는다.

### Policy 19:36 회신 및 저장 판단 근거 대조

- Policy 담당자가 정상 인수 기준과 UNKNOWN 동작을 설명했다. 해당 요청 회신은 **OWNER_REPLIED**로 전환한다. Rule ACCEPT는 BENIGN_ALTERNATIVE_SUPPORTED=SUPPORTED일 때만 허용, onUnknown=HOLD. VERIFIED/인용은 benign 보증이 아니며 결정적 UNKNOWN은 기본 ACCEPT fallback보다 우선한다.
- 동일 make-node scan의 저장된 PRIMARY 판단·Assessment 요약만 read-only 조회(Prompt·provider 원문·코드 미조회). audit caseStatus=COMPLETE/unresolved=[]지만 Rule UNKNOWN: 메타데이터 URL에 관한 직접 benign 설명이 입증되지 않고 intent 및 BIN entry point 코드가 부족하다는 rationale 확인. Predicate 객체 자체 rationale는 null/missing=[]였으며 구체적 설명은 Rule rationale·global limitations에 있음. 빈 unresolved/missing을 근거 충분으로 오인하지 않는다.
- 인용된 VERIFIED Assessment는 intentAssessment=UNKNOWN. author/issue tracker/license URL은 메타데이터이며 dependency 선언/네트워크 실행을 입증하지 않는다고 기록. 이는 악성 근거를 약화하지만 정상 의도를 직접 입증하지는 않는다. Assessment limitations에 publisher intent 불명 및 advertised BIN entry point 코드 미제공이 명시돼 있어 Policy 설명과 대응한다.
- **판정:** make-node Tier3 저장·수용·인용·Decision 연결 확인 및 HOLD 집행 PASS는 유지. 정상 인수는 FAIL. 악성 확정·Policy 버그·자동 ACCEPT 대상으로 단정하지 않고 Decision 보존. 동일 샘플 무작정 재실행하지 않는다.
- 정상 샘플 인수 체크: package@version·tarball integrity 고정, 적용 보안 권고 점검, 정확한 artifact Scan COMPLETED/필수 coverage 누락 없음, 위험 신호의 문서화된 정상 기능 Evidence, 결정적 UNKNOWN/CONFLICT 없음, ACCEPT Rule SATISFIED 또는 no-match POLICY_DEFAULT, Decision 저장·Fresh Gateway 설치 성공·FOUND/ACCEPT 및 integrity 일치. 기존 Fresh yoctocolors 설치 PASS와 보안 권고/coverage 검토 전체 인수를 구분한다.
- 남은 문제는 'Policy 회신 없음'이 아니라 부족한 BIN/정상 기능 근거 확보·안전성 인수 및 별도 악성 QA의 Jev 키 설정이다. TypeSafe 키가 없을 때의 context UNAVAILABLE와 빈 입력을 충분한 분석으로 대신하지 않는다. 라이선스/Final SHA/독립 검증·UI·PM 승인도 별도.

### Scanner QA 사용 동의 수신·격리 실행 준비 — 10/12 19:26 회신

- 사용자 전달 Scanner 히스 회신: "넵 확인했고 QA 진행하셔도 괜찮을 것 같습니다". 앞서 요청한 격리 분석·비공개 증적 저장 범위의 동의로 기록. 악성 설치/lifecycle 실행·재배포/공개 승인은 포함하지 않는다.
- bundle은 path/link 점검 후 Git 제외 `reports/validation/tier3-fixtures`에 해제. 악성 fixture를 이미지 build context에 포함하지 않고, 운영 Scanner image ID `8f04ba...`를 base로 QA runner만 추가한 로컬 image 생성 성공: `sha256:b556ff8f401eecc211608d31afb048bea2b966d4989ef7e72bd67b95eacbc927`. 현재 HEAD와 기존 aa3360a 사이 Scanner src/rules/Dockerfile diff 없음 확인. 전체 clean build 증거와 구분한다.
- runner source 검토: 준비된 package tree를 복사하고 static analyzers/Agent를 사용; fixture entry point import/require·패키지 설치·lifecycle 없음. Evidence/Policy 경계는 capture이며 실제 persistence는 이후 별도 replay. read-only fixture mount·cap-drop ALL·no-new-privileges·tmpfs noexec 및 resource 제한 계획. 모델은 현재 QA gpt-6-luna, runner의 180s package timeout/ALWAYS/recheck true 조건은 운영과 구분한다.
- **실행 전 BLOCKED_CONFIGURATION:** 기존 Scanner env의 OPENAI_API_KEY는 존재, TYPESAFE_API_KEY는 없음. 로컬 .env에도 TYPESAFE_API_KEY 없음. 필수 검사에서 종료되어 fixture 분석/모델 호출/QA DB replay는 시작하지 않았다. 스크립트의 Jev 조건을 삭제하거나 mock으로 대체하지 않았다.
- 추가 wiring 발견: .env.example에는 이미 TYPESAFE와 context check 6개 변수가 있으나 compose Scanner에는 전달이 빠져 있음. compose.yaml에 기존 names/defaults 연결 추가(새 정책/포트/DB Contract 아님; env 전달 Contract 수정). 실제 키 값 추가/출력 없음, Scanner 운영 재배포는 아직 안 함. Compose config 검증 PASS 및 기존 compose-runtime test 수행.
- 사용자 다음 입력: 로컬 .env에 본인 TypeSafe/Jev 키를 설정(또는 담당자와 키 사용권한 확인)한 후 설정 완료만 알려준다. 키를 채팅/Notion/Issue에 전송하지 않는다. 설정 후 운영 Scanner env 전달 반영 및 QA 격리 분석→별도 DB replay 검증을 재개한다. 운영 DB에 악성 fixture replay를 하지 않는다.

### 10/12 19시대 회신 대기 중 선행 QA 완료

- Failure/Recovery는 운영 Policy(openai)를 바꾸지 않고 같은 image로 별도 `whs-qa-failure-policy` 컨테이너를 127.0.0.1:18080에 띄워 fixture 모드로 실행했다. 처음 whs 네트워크만 연결했을 때 Policy DB 접근 TIMEOUT으로 baseline FAIL; 원래 Policy와 같은 default+whs 두 네트워크 연결 후 기존 `tests/integration/failure_recovery.py`를 재실행했다.
- **Failure/Recovery PASS, exit 0:** Policy DB API stop → fixture Policy health 유지 → HTTP 503/POLICY_DB_UNAVAILABLE → start/health 복구 → ACCEPT/saved. Decision DB API stop → Policy health 유지 → HTTP 503/FEED_PERSISTENCE_TIMEOUT → start/health 복구 → ACCEPT/saved. 테스트는 고유한 synthetic QA identity의 새 Decision을 저장하며 기존 Decision은 변경하지 않는다. Provider 실패 live 검증과 구분한다.
- 검증 전용 컨테이너 종료·제거 완료(Volume 제거 없음). 원래 Compose 9서비스 모두 running/healthy. 운영 Policy 설정은 재생성·fixture 전환하지 않았다.
- 정상 `yoctocolors@2.1.2` Root wrapper 설치: 별도 Windows 임시 workdir/cache 및 기존 인증 설정, ignore-scripts/no-audit/no-fund 사용, root intent 등록 및 npm exit 0.
- Dashboard 런타임 DB 연결에서 **최신 Root↔History 대조 PASS**: occurred_at `2026-10-12T10:27:16.059Z`(19:27 KST), requestId `c6fcbcfa-2b42-487e-9569-a264e7452346`, is_root=true, DELIVERED/ACCEPT/200, Decision `dec_b256660e-d088-477b-a2b5-8bdbb6c305b1`. 같은 root_request_id의 install_dependency_history에 root yoctocolors@2.1.2 1행 확인(의존성 없는 샘플).
- 실제 최신 Dashboard UI는 **PASS (사용자 화면 확인)**: 2026-10-13 사용자가 로그인된 로컬 Chrome의 `http://127.0.0.1:5173/requests` 화면을 제공했다. `yoctocolors@2.1.2`, 2026-10-12 19:27 KST, `ACCEPT`, `전달`, 사용자 `admin` 표시를 확인했고, 기존 DB 증적의 occurred_at·package/version·outcome과 일치한다. 같은 화면에서 `is-number@7.0.0 ACCEPT`와 과거 HOLD/오류 행도 렌더링됐다. 이는 화면 표시와 최신 Root/History 연결 검증이며 다른 패키지의 판정 정확성 또는 독립 Reviewer 결과를 대신하지 않는다.
- Root wrapper Windows shell:true DEP0190 경고 관측, 이번 설치 exit 0. 임의 사용자 입력의 shell quoting 검토는 잔여 위험이며 이번 고정 benign QA 입력과 구분한다.
- 문서 정리: `tests/e2e/failure_matrix.md`의 오래된 Decision DB 장애 기대 코드를 실제 feed-persistence 계약으로 정정. `docs/release-qa-handoff.md`에 DB migration 사전 조건·최신 증거·Reviewer 완료 후 요청 방식·화면 미검증을 반영했다.
- 최신 서비스 image IDs를 제한 출력으로 수집했다. Policy는 이번 source SHA와 대응 증거 있음. 다른 서비스 ID 확보만으로 최종 SHA 빌드 인증을 주장하지 않는다. Final Freeze는 이후 승인·수정·최종 회귀 및 Reviewer 결과 전까지 PENDING.

| 현재 Gate | 실제 상태 |
|---|---|
| Runtime/정상 reusable/Fresh default ACCEPT | PASS (범위·시점 한정) |
| Tier3 생성·DB 저장·Policy Citation·최종 Decision | 정상 make-node 사례 연결 확인, 최종 UNKNOWN/HOLD; benign 설치 FAIL |
| REVIEW/HOLD tarball 집행·인증 없음 | 실측 403/401 PASS; 악성 REJECT live는 미검증 |
| DB API Failure/Recovery | fixture 별도 Policy에서 PASS, 9서비스 복구 확인 |
| 최신 Root/History/UI | 설치·DB 대응 및 사용자 제공 실제 `/requests` 화면 교차 확인 PASS |
| 악성 fixture | 해시·격리 문서 검토 완료, 데이터 QA 사용 범위 확인 및 실제 실행 대기 |
| Policy UNKNOWN 인수 | 요청 전달 완료, 회신 대기 |
| Reviewer | 참여 가능 회신 완료; 내부 QA 완료 후 자료 전달, 독립 결과 PENDING |
| LICENSE/제3자 고지/공식 출처 | PM/PL 확정 문안 반영 완료; Final SHA 포함 여부 재확인 필요 |
| Final SHA/독립 Reviewer/PM 공개 승인 | 최종 검증·승인 대기, Public HOLD |

### migration 적용 후 make-node 실제 Tier3→Policy→Gateway 결과

- 동일 정상 package의 첫 실패는 Decision MISS로 남아 있었으므로 기존 Decision 삭제 없이 재검증. 새 requestId `a923ebf9-d49b-4096-990d-81771eb8b3f3`, scanId `39e32568-3f8d-4e5d-b7fe-233b0b3b4764`.
- Evidence DB 총 4건(Atomic 3 + LLM_ASSESSMENT 1). Assessment Evidence ID `llm:ab5d8ea7-a06c-4e8c-b944-f6690bfc0143:assessment-http-metadata-urls`, verificationStatus VERIFIED, provenance assessmentId `assessment-http-metadata-urls`, model gpt-6-luna, relatedFindingIds 3 / relatedAtomicEvidenceIds 3.
- PRIMARY Policy audit COMPLETED/failureCode null. Rule `RULE-ACCEPT-BENIGN` 상태 UNKNOWN, Predicate `BENIGN_ALTERNATIVE_SUPPORTED` 상태 UNKNOWN이며 위 Assessment Evidence ID를 assessmentIds에 인용. Validator 완료 판단의 Citation과 최종 Decision 연결은 확인했지만 SATISFIED/benign ACCEPT로 확장하지 않는다.
- 최종 `dec_39e32568-3f8d-4e5d-b7fe-233b0b3b4764`: HOLD / POLICY_DECISIVE_EVIDENCE_UNKNOWN, matchedRuleIds=[RULE-ACCEPT-BENIGN], evidenceIds=[], assessmentIds=[위 Assessment Evidence ID], 새 배포 policyHash와 일치.
- npm 실제 tarball 403, install exit 1. **정상 설치 FAIL**, **HOLD 차단 PASS**. Tier3 생성·저장 및 Policy 수용(Validator 통과 Citation으로 입증)·Predicate 인용·최종 UNKNOWN 근거 반영 확인. Scanner의 전송 본문 원문은 capture하지 않았으므로 Policy 수용 증거와 구분한다.
- 무조건 ACCEPT로 우회되지 않는 실제 불확실 경로를 확인했다. 반복해 ACCEPT가 나올 때까지 검사하지 않는다. 동일 샘플은 이제 HOLD가 저장됐으므로 재사용 경로이며 기존 Decision 삭제 금지. Policy 담당자에게 위 requestId/scanId 및 UNKNOWN 이유 검토 요청 가능.
- 악성 fixture는 아직 실행하지 않음. 공급 안내의 데이터 소유자 QA 사용 범위 확인과 현재 SHA 호환성·별도 QA 포트/DB/네트워크 조건 정리 후 수행. 번들 baseline을 실제 Gateway 악성 차단 PASS로 기록하지 않는다.

### Scanner 자료 수신 및 정상 Tier3 첫 통합 실행

- 사용자로부터 정상 npm escalation 샘플 6종·bcrypt 참고 결과와 악성 fixture bundle 전달받음. 담당자 반복 실측은 내부 QA PASS로 대체하지 않는다. 정상 샘플은 메타데이터 http URL 신호로 STATIC_INCOMPLETE, COMPLETED 및 VERIFIED Assessment 1건 기대. ACCEPT/POLICY_PASSED는 확률적이며 보장하지 않는다.
- 악성 bundle SHA-256: `7c3e256accb4c40c2321a57a1529ea23d827d63fcde67a6a3d2b63f98db42895`. archive 내 4개 sample ZIP SHA-256 모두 안내문과 일치. 외부 archive 경로 traversal/link 항목 0 확인. 코드 설치·실행·전체 압축 해제·공개 저장소 업로드 없음.
- bundle 기준 `80798e5`, runner 모델 gpt-5.6-luna/ALWAYS/context recheck ON/package 180s. 현재 정상 QA는 Scanner gpt-6-luna/RISK_BASED/package 240s, Policy gpt-4.1-mini/60s. 동일 환경으로 취급하지 않는다. bundle은 별도 Compose project/DB/비운영 포트가 필요하며 공급 문서상 데이터 소유자의 QA 사용 승인 미확인. 악성 실행은 승인 범위 확인과 호환성·격리 검토 이후 진행한다.
- bundle의 Policy replay는 Gateway 집행을 포함하지 않는다. 담당자 baseline 4건 HOLD는 timeout/invalid judgment/UNKNOWN이고 악성 근거 REJECT를 입증하지 않는다. 숫자 9/13 Assessment 등의 서로 다른 실행 이력을 고정 기대 개수로 합치지 않는다.
- 첫 `make-node@0.4.6` Fresh E2E: preflight PASS/MISS → Agent STATIC_INCOMPLETE/COMPLETED, generatedEvidenceCount=1 → npm 500 FAIL. requestId `a365df10-3ef4-44a3-bf34-c9757d2296e6`, scanId `54d58853-681b-497a-9549-027300b72bc7`.
- read-only 추적: Atomic Evidence 3건 저장, Assessment 저장 없음, Evidence POST 201×3 후 500, Policy 호출·Decision 저장 없음. DB `evidences_generated_by_check` 위반; 현재 kind/generated_by 제약은 ATOMIC/CORRELATED 및 normalizer/correlator만 허용.
- 원인: 저장소 기존 `infra/postgres/migrations/evidence/002_llm_assessment.sql`가 현재 DB에 미적용. 기존 init script에는 이미 정의돼 있으나 오래된 volume은 자동 갱신되지 않음. 기존 migration 002를 transaction으로 적용 성공. 기존 데이터·Decision·볼륨 보존, 임의 Contract 생성/정책 완화 없음. 원인 수정 후 동일 정상 패키지(여전히 MISS)를 1회 재검증 시작.
- Reviewer 가현님·혜진님 참여 가능 회신 수신. 가현 10/13 시간 무관·목요일 가능, 혜진 10/13 18시 이후 가능. 공통 시간 10/13 18시 이후 후보; PM 지정·Final SHA·일정 확정 및 실제 독립 결과는 별도.

### Scanner 자료 대기 중 신규 완료

- 새 Policy 배포 후 기존 picocolors@1.1.1 REVIEW Decision 집행을 `npm pack --ignore-scripts`로 확인: tarball GET **403 Package is not allowed**, npm exit 1. 테스트 기대 차단 PASS이며 정상 설치 PASS가 아니다. 임시 Git 제외 cache/destination 사용, 기존 Decision 변경 및 lifecycle 실행 없음.
- 인증 없는 Gateway `GET /npm/yoctocolors`: **401**, 기대 인증 거절 PASS.
- `docs/release-qa-handoff.md`에 배포 SHA/image ID 검증, 제한 출력, Reviewer 준비·재현·증거표 및 dev→main 인계 절차 준비. 기존 Reviewer 체크박스 미수정.
- 아직 남은 live 검증: REJECT/HOLD 전체 경로, 실패/복구, Tier3 4단계, 최종 Root/UI, Final Freeze/CI, 독립 결과, 라이선스/공개 승인. REVIEW 한 사례의 403을 전체 차단 회귀 PASS로 확장하지 않는다.

### 사용자 전달 협업 이력 — Scanner / PM

- Scanner 담당 히스: 15:44 회신에서 기존 fixture 실행기와 현재 환경의 불일치 수정 후 **오늘 18시경까지 샘플·실행 자료 전달 예정**. 사용자 수락. 정상 escalation 샘플(bcrypt 후보 사용 가능 여부), 격리 악성 fixture, 안전 실행 명령 및 기대 VERIFIED Assessment는 아직 수신하지 않음. WAITING_ON_OWNER 유지하며 추가 중복 요청하지 않는다. 18시를 수신 완료/승인으로 간주하지 않는다.
- PM 서빈: 13:41 회신에서 공개 대상은 기존대로 **main 예정**, 독립 Reviewer는 **혜진님·가현님 지정 예정**. 확정 지정/검증 완료/GO 승인으로 간주하지 않는다. 최종 검증 dev SHA 확정 후 dev→main PR 절차를 따르며 명시적 승인 없이 main 병합하지 않는다.
- 사용자 14:11: PM 지정 후 DevOps/QA가 문서화 및 Reviewer에게 재현 방법 안내하기로 회신. 기존 Notion 독립 QA 가이드를 사용하고 Final SHA/Runtime/Expected·Actual 및 증거 기준을 확정해 전달한다. 내부 QA 결과를 Reviewer 체크박스에 대입하지 않는다.
- 라이선스·제3자 고지·공식 출처는 PM이 파트별 공지로 취합 중. DevOps/QA 공개 산출물·외부 스크립트 출처 회신과 PM 최종 결정은 구분한다.

Reviewer 전달 문안 초안(아직 발송하지 않음):

> 혜진님·가현님 안녕하세요! 최종 공개 전 독립 QA 안내드립니다. PM의 지정 확정 및 Final SHA 준비 후 아래 가이드 기준으로 별도 PC/환경에서 검증 부탁드립니다. https://app.notion.com/p/3f2800434d5381e789c1ea06a14e25f0
> 대상 SHA와 환경 준비 조건은 최종 확정 후 전달드리겠습니다. 현재 내부 Fresh 정상 설치는 PASS지만 Tier3·차단 회귀 및 공개 Gate는 진행 중이므로 이 문안은 사전 안내입니다. 실제 수행 항목의 Expected/Actual·실행 시각·로그/캡처와 PASS/FAIL/미실행을 직접 기록 부탁드립니다. 기존 Volume과 Decision은 보존하고 인증정보는 기록하지 않습니다. 아직 승인되지 않은 악성 샘플은 실행하지 않습니다.

다음 실행 순서: 안전한 차단 회귀 준비 → Scanner 자료 수신 후 적합성 검토·실제 Tier3/격리 차단 → 최종 소스·이미지 고정 및 회귀 → PM Reviewer 지정 확정 후 독립 QA 안내 → 라이선스/고지와 잔여 Gate 포함 PM/PL GO/NO-GO. 담당자 요청은 이미 전달됐으므로 새 요청을 반복하지 않는다.

### 로컬 Policy #512 배포 및 Fresh E2E — 2026-10-12 17시대 KST

사용자가 실행환경 담당자임을 확인하고 로컬 Policy 재빌드·재배포 및 Fresh E2E 시작을 명시적으로 승인했다. DB 기본판정 무시·ACCEPT 고정은 Policy 담당자가 의도된 동작이라고 회신했으며, 이것을 PM/PL 공개 GO 또는 보안 최종 승인으로 간주하지 않는다.

- 작업 브랜치를 `origin/dev=162a8c91299f6228705a214e166df14a235ff7e5`로 fast-forward. 로컬 `.gitignore`·QA 보고서 변경 보존. Policy 빌드 입력 tracked source는 해당 SHA와 일치.
- `docker compose config --quiet` PASS → `docker compose build policy` exit 0 → `docker compose up -d --no-deps --no-build policy` exit 0. Policy만 재생성; 다른 서비스 재배포/볼륨 삭제/DB 초기화 없음.
- 이전 Policy 실행 image ID: `sha256:15d9022c88143fc8315385dd6a98c37f0669989d4cd09b2c8fd11f423fbea8aa`.
- 새 로컬 이미지 및 실행 컨테이너 image ID: `sha256:a62d4100af64ab0757da820ce54537958fb20d472574033d3276cb12c60e4ea2`. Build 출력의 manifest-list digest와 일치. 레지스트리에 Push한 RepoDigest로 해석하지 않는다. Dockerfile에 Commit label이 없으므로 빌드 직전 HEAD·소스 diff·이번 빌드 출력과 컨테이너 ID 대응을 증거로 기록한다.
- Policy healthy, 실제 HttpActivePolicyClient 결과 default ACCEPT / judgmentFailure HOLD / 12 rules, policyHash `cbbee46a3125674aadff6fb5c72e17433c3018214f19b64a934de943fbb0f82b`.
- 새 runtime image의 `npm test`: **105 PASS / 1 FAIL**, exit 1. `/app/infra/postgres/migrations/policy/003_predicate_registry.sql` 부재 ENOENT. Production Dockerfile은 dist만 포함해 source/SQL 기반 harness를 완비하지 않음. 이미지에 fixture를 임의 삽입하지 않았다. 동일 SHA 별도 source+SQL 환경의 106 PASS와 구분한다.
- 정상 후보 `yoctocolors@2.1.2` 및 `ansi-regex@6.1.0` metadata·DDB 조회 각각 NOT_FOUND 확인. 실제 설치는 yoctocolors 1개만 수행.
- `python tests/e2e/critical_path.py --npmrc <existing-user-config> --package yoctocolors --version 2.1.2`: 9서비스 preflight PASS → **NOT_FOUND** → 실제 install exit 0 → 설치 확인 → **FOUND/ACCEPT** → full fresh path PASS, exit 0. 임시 workdir/cache, ignore-scripts/no-audit/no-fund. 기존 picocolors Decision 보존.

Fresh 저장 Decision의 read-only 증거:

| 필드 | 실제 값 |
|---|---|
| decisionId | dec_b256660e-d088-477b-a2b5-8bdbb6c305b1 |
| requestId | 88a5cb7b-8ca8-4662-957e-c7c34ae20390 |
| scanId | b256660e-d088-477b-a2b5-8bdbb6c305b1 |
| decision / reasonCode | ACCEPT / POLICY_DEFAULT |
| matchedRuleIds / evidenceIds / assessmentIds | 모두 빈 목록 |
| policyVersion / policyHash | 0.1.0 / cbbee46a3125674aadff6fb5c72e17433c3018214f19b64a934de943fbb0f82b |

**판정:** 로컬 Policy 배포·Fresh 정상 미매칭 허용 경로 PASS. ACCEPT/POLICY_PASSED 또는 Tier3 인용 PASS가 아니다. Root intent/UI의 신규 검증도 아니다. 실제 악성·불확실·실패 차단 회귀, Tier3 4단계, 독립 Reviewer·License·Final Freeze·PM/PL 공개 승인 및 runtime test fixture 이슈 인수는 남아 있다. Public HOLD 유지.

### #512 코드 검토 및 오프라인 회귀 — 신규 수행

검증 소스는 `origin/dev=162a8c9`의 Policy src/tsconfig/package.json 및 관련 SQL fixture를 git archive로 추출했다. 기존 작업 브랜치·운영 컨테이너를 변경하지 않았다. 로컬 경로는 Git 제외된 `reports/validation/policy-512/source`. 기존 Scanner node_modules의 TypeScript/semver/type definitions를 재사용했으므로 clean install CI 결과와 구분한다.

- TypeScript compile exit 0: `node apps/scanner/node_modules/typescript/bin/tsc -p reports/validation/policy-512/source/apps/policy/tsconfig.json --baseUrl <existing-scanner-node_modules> --typeRoots <existing-scanner-types>`.
- 추출 Policy 디렉터리에서 기존 `npm.cmd test` 실행, NODE_PATH는 기존 Scanner node_modules. 최종 **106/106 PASS, exit 0**.
- 첫 시도는 sandbox child-process spawn EPERM으로 실행되지 않았다. 승인된 재실행은 SQL fixture 누락으로 105 PASS/1 FAIL(ENOENT). 같은 SHA의 기존 SQL fixture를 추출해 보완한 후 106 PASS. 구현 실패로 은폐하거나 첫 실행 PASS로 기록하지 않는다.
- 추가된 미매칭 ACCEPT 테스트와 DB REVIEW 무시 테스트 통과. Provider timeout/판단 검증 실패, UNKNOWN, Citation 경계 등의 기존 테스트도 포함한다. 실제 Provider/운영 DB/배포/E2E 검증은 아님.

| 배포 후 회귀 Case | Expected / 판정 기준 | 현재 증거 |
|---|---|---|
| 정상 평가 COMPLETE, Rule 미매칭 | ACCEPT/POLICY_DEFAULT, matchedRuleIds=[]; Fresh 여부와 DB 저장·Gateway 설치를 별도 확인 | offline 테스트 PASS, live PENDING |
| REJECT Rule 요구 근거 충족 | REJECT 및 해당 Rule/Citation, Gateway tarball 차단 | Resolver 우선순위 코드 및 기존 경계 테스트, live PENDING |
| REVIEW/HOLD Rule 매칭 | 선택된 Rule effect 유지, Gateway 차단 | 코드 검토, live PENDING |
| Predicate UNKNOWN / unresolved | onUnknown·Resolver에 따른 HOLD 또는 REVIEW, ACCEPT fallback 진입하지 않음 | UNKNOWN 관련 offline 테스트 PASS, live PENDING |
| Evidence conflict | REVIEW/POLICY_EVIDENCE_CONFLICT, Gateway 차단 | Resolver 코드 확인, live PENDING |
| Coverage 부족 | 기본 HOLD; 매칭 Rule minimumSupport=PARTIAL 예외를 별도 구분 | Resolver 코드 확인, live PENDING |
| Provider timeout/오류·Validator 실패 | policy.judgmentFailureDecision 적용(현재 HOLD); 악성 확정과 구분 | offline 테스트 PASS, live PENDING |
| Scanner 실패·Decision 없음·API 오류 | Scan/API/Policy 진행·Decision 유무 추적, Gateway 전달 우회 없음 | 기존 Gateway 회귀 PASS 이력, 최신 live PENDING |
| DB defaultDecision REVIEW/HOLD/REJECT 명시 | #512는 값과 무관하게 ACCEPT로 고정; DB 정책 관리와 런타임 적용 범위 인수 확인 필요 | REVIEW override 테스트 PASS; 구현상 모든 입력값 무시 |

보안 인수 확인점: #512는 '기본값이 생략됐을 때만 ACCEPT'가 아니라 명시된 DB defaultDecision도 무시한다. 정상 미매칭 허용의 정책 완화 범위와 일치하는지 Policy/보안 담당자 확인이 필요하다. 이를 구현 버그 또는 최종 안전성 PASS로 단정하지 않는다.

배포 후 새 policyHash 기록 → 기존 Decision을 보존하고 승인된 Fresh 대상의 사전 MISS 확인 → 정상/차단 경로 → Tier3 단계별 추적 → Final SHA 회귀 순서로 진행한다. picocolors의 기존 REVIEW Decision을 삭제해 Fresh로 만들지 않는다. 담당자 배포·Scanner 샘플 회신 없이 운영 Policy를 재빌드하거나 Provider를 호출하지 않았다.

### 후속 Policy 변경 및 PM 공개 공지 — 앞선 미진행 기록 이후

- 사용자 전달: 정상 평가에서 Rule 미매칭 시 ACCEPT/POLICY_DEFAULT, 매칭 Rule 및 Provider·평가 오류 처리는 유지했다는 담당자 보고.
- 최신 fetch에서 PR #512 merge `162a8c9` 및 작업 commit `b0d0ed6` 확인. 기존 작업 브랜치/검증 소스는 `ed9f7fd`를 유지한다. 실행 이미지 배포·새 Policy hash·새 SHA 회귀는 미확인이며 앞선 REVIEW/HOLD 실측은 과거 결과다.
- 구현은 parseActivePolicy의 defaultDecision을 입력값과 무관하게 ACCEPT로 고정한다. 미매칭 경로의 정책 완화이며 담당자 설명만으로 보안 승인 또는 PASS 처리하지 않는다. Provider·판단 오류 외에 불확실·coverage 부족·Scan 실패/판정 부재의 Gateway 차단도 검증 필요.
- PM 초기 공지에서는 자체 라이선스·공식 표기가 미정이었으나, 2026-10-13 후속 전달로 Apache-2.0·KISA 주관 공식 출처·제3자 고지 문안이 확정돼 반영됐다. 데이터/샘플 재배포와 Docker image/binary 공개 범위는 별도다.
- DevOps/QA 공개 범위: Compose/Dockerfile/CI/테스트 소스가 현재 검토 대상. 저장소 Workflow에서 이미지 build는 확인했으나 push 설정은 발견하지 못했다. Docker 이미지·배포 산출물 공개는 아직 확정되지 않았다. CI는 actions/checkout, setup-node, setup-python, github-script, labeler 사용. 직접 복사·수정한 외부 스크립트의 출처는 저장소 표기만으로 없음 확정 불가.
- 후속 필요: PM에게 공개 산출물 범위 및 QA 참여 일정 회신, Policy 배포 확인 후 최신 SHA의 정상 Fresh·차단·Tier3 회귀. 이 후속 확인에서 새 Runtime/Provider 테스트나 이미지 배포는 수행하지 않았다.

| 작업 | 상태 / QA 결과 | Owner / 필요한 입력 |
|---|---|---|
| Policy 변경·보안 영향 | OWNER_REPLIED / 변경 미진행, 인수 결정 PENDING | Policy·보안: Compatibility 해결 방향 및 보안 인수 기준 결정. 로컬 Schema·Prompt 수정의 반영 여부도 확정 필요 |
| 정상 Fresh 설치 | WAITING_ON_OWNER / PENDING | 승인된 정상 샘플·기대 판정 및 Runtime 대상 확정 후 QA. 기본 ACCEPT 변경을 전제로 삼지 않으며 기존 Decision 보존 |
| Tier3 실제 Provider→Assessment→Policy→Decision | WAITING_ON_OWNER / PENDING | Scanner·Policy: 승인된 benign escalation 샘플(기존 bcrypt 후보의 적합성 확인), 실행 명령, trace 및 Citation 인수 기준 |
| 격리 악성 E2E | WAITING_ON_OWNER / PENDING | Scanner·보안: 승인된 fixture, 격리 조건, lifecycle 비실행 경로, 기대 Decision |
| LICENSE / 제3자 고지 / 공식 출처 | PASS (문서 준비) | PM/PL 확정 문안에 따라 루트 Apache-2.0 LICENSE, THIRD_PARTY_NOTICES, README 공식 출처 반영. Final SHA에서 재확인 |
| Final SHA·이미지·Failure/Recovery | TODO / PENDING | QA: 변경 준비 후 Final 후보 고정, 이미지와 소스 대응, 대표 E2E·서비스 중단/복구 검증. 이번에는 실행 서비스를 중단하지 않음 |
| 독립 Reviewer | WAITING_ON_OWNER / PENDING | PL: 별도 PC Reviewer 지정 및 직접 작성한 결과. Reviewer 체크박스 미수정 |
| 최종 공개 승인 | WAITING_ON_OWNER / PENDING | PM/PL: Final SHA, 미해결 Gate, 공개 대상 브랜치 확인 후 GO/NO-GO |

Release risk: 정상 Fresh 경로와 실제 Tier3 정책 기여가 미검증이며 라이선스·독립 검증·최종 승인도 남아 있다. 부분 PASS 및 오탐 분류 완료만으로 Public GO를 선언할 수 없다.

## 기존 Discord 요청문 — 전달 이력

사용자가 각 파트에 요청 후 Policy 회신을 전달했다. 아래는 기존 요청문 보존이며 새로 재전송할 요청이 아니다. Policy 회신 내용은 위 정정 사항을 우선한다. Scanner·PM/PL 회신 대기.

Policy/보안 담당자님, 현재 실행 환경은 `qa-npm-policy/0.1.0`, default REVIEW·failure HOLD이며 정책 hash는 기존 값과 동일합니다. 변경 PR/Commit SHA와 배포 여부, 기본 ACCEPT의 허용 범위 및 악성·불확실·분석 실패 시 차단 인수 기준을 부탁드립니다. 회신 후 기존 Decision을 수정하지 않고 정상 Fresh 설치 및 차단 회귀를 진행하겠습니다.

Scanner/Policy 담당자님, Gitleaks 82건 오탐 분류와 picocolors의 정상 SKIP 회신을 반영해 해당 검사를 종료했습니다. 실제 Tier3 종단 검증용 승인된 정상 escalation 샘플과 실행 명령, 격리 악성 fixture 및 실행 조건을 부탁드립니다. VERIFIED Assessment 저장 → Policy 입력 → Predicate/Citation → Decision → Gateway 집행을 확인할 수 있는 기대 결과와 trace 기준도 부탁드립니다. 악성 샘플은 호스트에 설치하거나 lifecycle을 실행하지 않겠습니다.

PM/PL님, README #511 병합과 기본 Runtime·reusable 설치·범위별 회귀를 확인했고, 전달받은 Apache-2.0 LICENSE·제3자 고지·공식 출처 문안을 QA 브랜치에 반영했습니다. 공개 대상 Final SHA 확정, 독립 Reviewer 결과, 악성 fixture 잔여 위험 수용, 공개 산출물 범위 및 최종 GO/NO-GO 판단이 필요합니다. 완료 전까지 Public HOLD를 유지하겠습니다.

# 2026-10-13 20:47 KST — Policy Known Risk 및 잔여 공개 Gate

Scanner 담당자는 여러 정상·악성 샘플을 반복 확인했으나 다수 악성 fixture가 Policy
timeout·응답 검증 실패·결정적 UNKNOWN으로 `HOLD`에 머문다고 회신했다. 안정적인
`REVIEW`/`REJECT` 재현을 위해 새로운 샘플을 계속 탐색하는 작업은 결함의 해결이나
재현 가능한 인수 기준이 아니므로 종료한다.

Policy 담당자는 공개 전 추가 수정보다 현재 한계를 Known Risk로 수용하고 Scanner·Policy
최적화를 공개 후 후속 과제로 진행하는 방안을 제안했다. 현재 증거상 악성 fixture가
`ACCEPT`되어 설치된 사례는 없고, `HOLD`는 Gateway에서 403으로 차단된다. 따라서
fail-closed 집행은 PASS이나 악성 탐지 정확도는 FAIL/BLOCKED로 유지한다.

Dashboard 코드 검증 SHA는 `273151b47b899212f80e61a3be42f5ccf9e1d900`이다. 이후
문서 전용 커밋은 별도로 구분한다. PR #516은 Draft/Open, MERGEABLE이며 해당 코드 SHA의
PR CI는 모두 SUCCESS다. 남은 Gate는 다음과 같다.

1. Dashboard 짧은 Assessment citation ID 보완의 독립 Reviewer 최소 재검증
2. Policy 탐지 정확도 한계에 대한 PM/PL Known Risk 수용 결정
3. 수용 시 제한사항·후속 개선 과제를 보존한 Final QA 판정 확정
4. PR #516 병합 후 Merge SHA Smoke, `main` Final SHA 확정 및 PM/PL 최종 GO

Known Risk 수용은 악성 탐지 QA의 PASS 전환을 의미하지 않는다. 최종 공개 기록은
“Gateway 보안 차단 PASS / Policy 탐지 정확도 Known Risk 수용”으로 분리한다.

### 2026-10-13 23:14 KST — Dashboard 독립 재검증 후속

- Reviewer는 `7a11935`와 Dashboard 코드 검증 SHA `273151b` 사이의 차이가 문서 3개뿐이며 실행 코드·빌드 입력·Contract가 동일함을 확인했다.
- 짧은 Assessment ID 인용 표시는 이전 실제 화면 PASS와 코드 동일성을 연결해 PASS로 판정했다.
- 미인용 Assessment 제외는 같은 scan에 복수 VERIFIED Assessment가 있는 보존 데이터가 없어 독립 실화면 검증 BLOCKED다.
- 동일 scan의 인용·미인용 Assessment를 함께 구성하고 인용 1건만 반환되는지 확인하는 targeted Dashboard test는 현재 HEAD에서 1 file / 7 tests PASS다.
- 자동화 회귀 PASS와 독립 실화면 표본 부재를 구분하며, 이를 위해 운영 DB를 변조하지 않는다.
