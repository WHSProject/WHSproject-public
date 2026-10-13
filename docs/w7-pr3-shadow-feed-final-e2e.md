# W7 PR 3: Shadow·Feed 참조 및 최종 E2E 검증

Issue #420, W7-DF-03·04·08. 기준 `e8a6ab8` (`origin/dev`와 동일, 기존 브랜치에 fast-forward 반영). 검증 환경: 2026-10-02, WSL `/mnt/c`, Node 24.21.0, 격리 Compose 프로젝트 `whsw7420`. 자동·통합 검증은 Fixture/Mock Provider를 사용했다.

## 범위와 실행 경로

Scanner는 Tier1·Tier2의 ATOMIC/CORRELATED Evidence와 검증된 LLM_ASSESSMENT를 기존 Contract에 맞춰 Policy Evaluation Request로 만든다. OSV 수집 결과는 `osvFeed`에 별도로 담긴다. Policy는 Request를 parse하고 OSV를 검증해 FeedLookupAttempt 및 성공 Snapshot을 Decision DB API에 저장한다. 그 다음 활성 Policy, EvidenceCase, Prompt를 사용해 Primary Judgment를 검증한다. Shadow가 켜져 있으면 같은 Prompt를 별도로 평가·감사한다. TypeScript Rule Resolver와 Decision Resolver만 최종 Decision을 계산한다. Policy는 Primary·Shadow 감사 이력을 각각 저장한 후 Primary Decision을 DB에 저장하고 Scanner 호출자에게 응답한다.

`requestId`는 Attempt·Audit·Decision의 연결 키이고, `scanId`와 package identity는 Request와 저장 레코드에 유지된다. `policyVersion`은 활성 Published Policy에서 오며 `judgmentId`는 Primary의 Resolver 입력과 Decision에 연결된다. `snapshotId`는 성공 Feed Attempt와 Decision에 연결된다. `feedEvidenceIds`는 Snapshot 전체가 아니라 **최종 채택 Rule의 유효한 Citation**만 저장된다. 신규 Decision의 `score`는 항상 null이다.

기존 `policy-provenance.integration.test.ts`는 Static 단독, Feed 단독, VERIFIED Assessment 단독, Static+Feed, Static+Assessment, Static+Feed+Assessment의 여섯 조합과 세 Citation namespace의 분리를 검사한다. Scanner Request/Contract 테스트는 Tier1·Tier2 필드와 실패한 Assessment 제거 후 기존 Static/Feed 보존을 검사한다. 격리 DB 테스트는 ATOMIC 및 CORRELATED 입력을 각각 저장했지만 Scanner의 실제 tarball 분석 결과를 생성한 것은 아니다.

## Rule·Predicate·Citation 실측

격리 `policy_db.policy_rules`에서 `RULE-REVIEW-OSV-HIGH`의 조건이 `OSV_ADVISORY_APPLIES`이고 활성 상태임을 확인했다. `RULE-REJECT-CONFIRMED-EXFIL`은 credential source, external sink, reachable execution, benign alternative 미지원의 allOf를 요구한다. `RULE-HOLD-SCAN-TIMEOUT`은 `ANALYSIS_COVERAGE_INCOMPLETE`, `RULE-REJECT-SHELL-EXEC`은 `DATA_REACHES_PROCESS_EXECUTION`을 사용한다. 테스트에서 이 Rule/Predicate 정의를 수정하지 않았다.

Citation namespace는 `evidenceIds`의 Scanner ATOMIC/CORRELATED ID, `assessmentIds`의 VERIFIED LLM Assessment ID, `feedEvidenceIds`의 `osv:` ID로 구분한다. `OSV_ADVISORY_APPLIES`만 Feed ID를 인용할 수 있다. Scanner Predicate의 Feed ID, 없는 ID, Citation 없는 SUPPORTED, 잘못된 Predicate 및 Prompt Injection 형태의 입력은 기존 Validator가 거부한다. `recommendedOutcome`은 최종 Decision에 영향을 주지 않는다.

기본 `POLICY_LLM_FIXTURE_SCENARIO=evidence`에서는 Advisory가 VALID여도 Scanner observation이 OSV Predicate를 명시하지 않으면 Fixture가 이를 SUPPORTED로 판단하지 않았다. 이때 Snapshot은 있지만 최종 ACCEPT Decision의 Feed Citation은 비어 있었다. 이는 Snapshot 저장과 실제 Rule 인용의 차이다. 별도 `positive`/`OSV_ADVISORY_APPLIES` Fixture에서는 감사 `judgmentJson`의 `RULE-REVIEW-OSV-HIGH`가 SATISFIED이고, Resolver가 `REVIEW`/`OSV_ADVISORY_REVIEW`를 생성했다. Decision의 `feedEvidenceIds=['osv:GHSA-w7-fixture-1234']`는 Snapshot 검증 결과의 ID와 같았다. 최신 dev의 Scanner lifecycle/custom-rule/metadata 변경 후에도 관련 정규화·Tier2 회귀 5 suites, 182 tests가 통과했다. Policy comparison fixture는 `EXECUTION_LINK` 근거를 명시해 현재 REJECT corroboration 규칙과 일치시켰고 Resolver 규칙 자체는 변경하지 않았다.

## Primary·Shadow 감사 필드

| 필드 | 생성·저장 경로와 검증 |
| --- | --- |
| `runMode`, `status` | 평가 서비스가 PRIMARY/SHADOW 및 COMPLETED/FAILED를 구분; 격리 SQL에서 requestId별 두 행 확인 |
| `provider`, `model`, `providerRequestId` | Provider Response의 메타데이터; Fixture는 `fixture`/`fixture`, request ID는 Provider가 줄 때만 저장 |
| `promptVersion`, `inputHash` | 현재 `policy-judgment-v2`, 동일 Prompt SHA-256; SQL에서 두 run의 64자 hash 확인 |
| `responseJson` | 원본 Provider 응답 envelope; Fixture `output_text`에서 원본 Judgment 복원 확인 |
| `judgmentJson` | Validator가 Rule status를 재계산한 최상위 PolicyJudgment; `judgment_json->'ruleEvaluations'` 조회 구조 유지 |
| `resolvedDecision`, `resolvedReasonCode` | 각 run의 TypeScript Resolver 결과; 최종 Decision에는 Primary만 사용 |
| `failureCode`, `durationMs`, `evaluatedAt` | 실패 코드 또는 null, 경과 시간 및 평가 시각; SQL과 실패 단위 테스트 확인 |
| `shadowOfJudgmentId`, `comparisonJson` | Shadow가 Primary Judgment와 비교되는 참조·차이 기록 |

Mock OpenAI·Claude Provider의 원본 envelope는 각각 `output[].content[].text`, `content[].text`에서 복원하고, 감사의 최상위 `judgmentJson`은 Resolver 입력을 유지하는 기존 테스트로 확인했다. 실제 GPT·Claude 호출이나 품질·비용 비교는 실행하지 않았다. Shadow의 동일·상이한 Judgment, Provider 오류, invalid JSON/Schema/Predicate/Citation, timeout은 단위 테스트로 격리 확인했다. 격리 Compose에서는 로컬 Mock HTTP 503과 지연 응답으로 Shadow FAILED 감사, failureCode, 원본 오류 응답(503), HTTP 200, Primary Decision 보존, 재요청 무중복을 SQL로 확인했다. Primary Mock HTTP 503은 활성 Policy의 `judgmentFailureDecision=HOLD`와 `POLICY_LLM_UNAVAILABLE`로 저장됐고 Shadow 성공은 이를 덮어쓰지 않았다. Primary timeout·invalid Judgment는 기존 단위 테스트로 확인한다. 현재 Compose에는 Feed·Audit·Decision을 함께 제공하는 단일 Decision DB API만 있어 Audit 또는 Decision endpoint만 선택적으로 차단하는 fault proxy를 추가하지 않았다. 저장 실패의 HTTP/failure-code 분류는 `policy-llm-audit.client.test.ts`, `decision-db.client.test.ts` 및 Policy catch 경로까지 확인했지만 부분 저장 SQL 실측은 미실행 blocker다.

## Feed 상태와 저장 결과

| 입력 상태 | Attempt | Snapshot | Decision Feed 참조 |
| --- | --- | --- | --- |
| SUCCESS, 유효 Advisory | SUCCESS 1건 | 원본/검증 결과 분리, digest·1시간 TTL | 최종 Rule이 인용한 경우에만 Snapshot ID와 `osv:` ID |
| SUCCESS, 빈 Advisory | SUCCESS 1건 | 빈 Snapshot 1건 | Snapshot ID, Feed Citation 없음 |
| SUCCESS, 잘못된 Advisory | SUCCESS 1건 | 원본 보존, `ALL_EXCLUDED` 및 제외 이유 | Snapshot ID, 제외된 Citation 없음 |
| FAILED / TIMEOUT / SKIPPED | 각각 1건 | 없음 | Snapshot ID·Feed Citation null |
| SUCCESS + `complete=false` | Contract 422 | 없음 | Attempt·Decision 생성 전 거부 |

Attempt는 requestId·scanId·package identity·상태·오류/skip 이유·pagesFetched·시작/완료 시각을 보존한다. 성공 Snapshot의 `validatedAt`+1시간이 만료 시각이다. 동일 digest의 유효 Snapshot만 재사용하고 Cache hit/실패가 TTL을 연장하지 않는 규칙, digest의 advisory·severity·range·withdrawn·검증 변화, 재평가의 `previousDecisionId` 연결은 기존 Feed persistence·reevaluation 테스트로 회귀 확인한다. 같은 requestId 재요청은 기존 Attempt·Decision·감사 행을 재사용하며 기존 Decision을 덮어쓰지 않는다. 실패 Feed 다음에 같은 package identity의 새 requestId로 성공 평가하면 이전 Decision을 보존하고 새 Snapshot·Decision을 저장한다.

## 격리 통합 실행과 제약

`whsw7420`은 별도 `whsw7420_postgres_data`를 사용했고, Compose override와 무작위 DB 비밀번호는 `/tmp`의 파일에만 두었다. 호스트 포트를 게시하지 않고 Compose 내부에서 검증했다. PostgreSQL, Evidence API, Policy DB API, Decision DB API, Policy, Scanner의 Health가 모두 healthy였다. 격리 DB SQL로 Decision·Attempt·Snapshot·Audit를 조회했고, `tests/integration/w7_shadow_feed_e2e.py`로 ATOMIC/Tier1, CORRELATED/Tier2, Advisory/빈 결과, FAILED/TIMEOUT/SKIPPED, malformed Advisory, 실패 후 복구, requestId 멱등성을 확인했다. `--osv-target` 실행은 실제 OSV Rule 인용과 Decision 참조를 검증했다.

Scanner의 Registry 설정은 `npmjs` 및 `https://registry.npmjs.org`로 고정되어 있다. 저장소에 tarball fixture와 local registry adapter가 없고 외부 npm 호출이 금지되어 Scanner API 실제 tarball Tier1/Tier2 런타임 스캔은 실행하지 않았다. PR2의 실제 Scanner→Policy→Decision DB 흐름과 이번 Fixture Evidence/Contract 검증으로 보완했다. Decision DB API를 격리 프로젝트에서 잠시 중지하니 Policy HTTP 503과 해당 requestId의 Attempt·Decision·Audit 무기록을 확인했다. 재기동 Health 후 같은 fixture 정상 흐름이 다시 통과했다. 재평가 구현은 Policy의 명시적 `POST /internal/v1/reevaluation-jobs/{id}/process`와 claim/immutable lineage 단위 테스트만 있으며 polling Worker가 Compose 서비스로 기동되지 않아 실제 Compose Job은 실행할 수 없다. Feed 재평가 Compose Job, Scanner tarball E2E, Audit/Decision 선택적 저장 실패 주입은 미실행 blocker다.

## 실행 명령과 결과

| 명령/검증 | 결과 |
| --- | --- |
| Node 24 로컬 `tsc --noEmit -p tsconfig.json`, `tsc -p tsconfig.json`, `node --test dist/**/*.test.js` (`apps/policy`) | 변경 후 17/17 test files 통과 |
| `node --test dist/evaluation/policy-evaluation.service.test.js` | 변경 후 통과 |
| `python -m pytest -q` (`apps/policy` 호스트) | 49개 이후 TestClient에서 futex 장시간 대기, 종료; 상세 재실행에서 같은 테스트 확인 |
| 격리 Docker `python -m pytest -q -p no:cacheprovider /workspace/apps/policy/tests` | 74 passed, 2 warnings |
| `python -m compileall -q app tests`; `python3 scripts/validate_evidence_schema.py` | 성공; Schema 17 assertions 통과 |
| Scanner `src/policy/policy-evaluation.request.spec.ts` | 14 passed |
| Scanner `test/policy-evaluation-contract.spec.ts` | 46 passed |
| 현재 checkout Scanner Docker build stage `pnpm --filter scanner test:unit --runInBand --no-watchman --runTestsByPath src/evidence/normalizer/evidence-normalizer.spec.ts src/analyzers/obfuscation/tier2-handoff.spec.ts test/custom-rule-p0-static.spec.ts test/custom-rule-analyzer.spec.ts test/metadata-analyzer.spec.ts --detectOpenHandles --verbose` (`--network none`) | 5 suites, 182 passed |
| Scanner `docker build --target build` | 최신 dev checkout build 성공; image `whs-w7-420-scanner-latest` |
| Scanner Docker build stage `pnpm --filter scanner typecheck` (`--network none`) | 통과 |
| 격리 `docker compose ... config --quiet`, `up -d --no-build --wait`, `ps` | 성공, 6개 서비스 healthy |
| 격리 `w7_shadow_feed_e2e.py --osv-target` | OSV Rule·Resolver·DB 참조·감사·TTL·멱등성 통과 |
| 격리 `w7_shadow_feed_e2e.py` | 5개 Feed 상태 및 malformed Advisory·실패 후 복구·complete=false·멱등성 통과; Decision DB API 재기동 뒤 재실행도 통과 |
| 격리 `w7_shadow_feed_e2e.py --shadow-failure`, `--shadow-timeout` | 로컬 Mock 503/지연 응답의 Shadow FAILED 감사와 Primary Decision 보존 통과 |
| 격리 `w7_shadow_feed_e2e.py --primary-failure` | Primary Mock 503 → HOLD·실패 감사, Shadow 비권위성 통과 |
| 격리 `w7_shadow_feed_e2e.py --feed-outage` | Decision DB API 중지 시 HTTP 503/무기록; 서비스 복구 후 정상 suite 통과 |
| `git diff --check`; 신규 파일 trailing whitespace·Secret 패턴 검사; `git status --short`; `git diff --stat`; `git diff --cached --name-only` | whitespace·Secret·lockfile 변경 없음; 4개 파일 모두 unstaged |

초기 Compose 빌드에서 Docker Hub 이미지 메타데이터와 Scanner 의존성 설치를 위해 외부 Docker/npm Registry에 연결했다. 이는 Docker 빌드 의존성 다운로드이며 Scanner의 npm package 조회나 OSV·GPT·Claude 평가 호출은 아니다. 첫 두 Compose 기동은 호스트 포트 충돌로 실패해 호스트 포트 공개를 제거했다. Python Docker 첫 실행의 2건 실패는 테스트 파일을 잘못된 경로 깊이에 mount한 것이 원인이었고, 저장소 경로 깊이를 보존한 재실행은 74건 통과했다. 호스트 `/mnt/c`에서 Scanner Tier2/Normalizer Jest는 장시간 `p9_client_rpc` I/O 대기해 종료했고 동일 파일을 Docker에서 121건 통과시켰다. 격리 Compose의 컨테이너·네트워크·임시 DB volume은 검증 후 해당 프로젝트만 정리했다. GitHub Actions는 조직 무료 사용 시간 소진으로 실제 Step 전에 실패하는 상태라 이 로컬 실행만 근거로 한다.

W7-DF-03·04·08의 Fixture/Mock 기반 코드·Contract 회귀와 격리 Policy/DB 흐름은 확인했다. Scanner 실제 tarball E2E, Compose polling 재평가 Job, Audit/Decision 선택적 저장 실패의 SQL 실측은 완료 근거에서 제외한 blocker다. DB migration, 공유 Evidence/공개 Decision Schema, Predicate Registry, Rule, Resolver 계산 기준, Prompt, Citation 검증, Provider 구현은 변경하지 않았다.
