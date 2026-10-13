# W7 PR 1: Evidence Contract·Policy 통합 회귀 검증

Issue #375 · W7-DF-01 / W7-DF-02 / W7-DF-07 · 기준 `9298fb9` (`origin/dev`와 동일)

## 범위와 입력 경로

Scanner의 Evidence normalizer는 기존 Tier1 ATOMIC에서 `analysisPass`를 생략한다. Tier2 ATOMIC은 `analysisPass=TIER2`와 위치별 `representation=DEOBFUSCATED`, `lineageStatus=UNMAPPED`, `derivedFrom.path`를 만든다. Tier2 handoff와 Agent artifact descriptor의 `analysisPass`/`lineageStatus`는 artifact 메타데이터이며, 공유 Evidence에서는 최상위와 `locations[]`에 각각 놓인다. CORRELATED는 최상위 `derivedFrom.evidenceIds/findingIds`로 관측 근거를 연결한다.

Policy Evaluation API의 TypeScript parser는 요청 envelope와 Evidence 기본 필드, 이번 provenance 확장을 검사한다. EvidenceCase는 subject/scan/ID 일치와 verified Assessment 연결을 검사하고, OSV validator는 별도 feed를 검증한다. Judgment validator는 Citation namespace와 Rule status를 검사한다. TypeScript Resolver만 최종 Decision을 계산하며, Decision DB client는 `score: null`과 cited ID를 저장한다. Evidence API는 Pydantic 검증 후 `raw_json` JSONB를 저장하고 조회 시 다시 검증한다.

## Tier1·Tier2 Contract 매핑

| 위치 | Tier1 | Tier2 | Scanner / 공유 Schema / Policy TypeScript / Python |
| --- | --- | --- | --- |
| Evidence `analysisPass` | 생략 가능, `TIER1` 허용 | `TIER2` | 최상위 optional enum `TIER1`, `TIER2`; 명시적 null 거부 |
| `locations[].representation` | 생략 가능, `ORIGINAL` 허용 | `DEOBFUSCATED` | 위치별 optional enum `ORIGINAL`, `DEOBFUSCATED`; null 거부 |
| `locations[].lineageStatus` | 생략 가능, `DIRECT` 허용 | `UNMAPPED` (매핑 시 `MAPPED` vocabulary) | 위치별 optional enum `DIRECT`, `MAPPED`, `UNMAPPED`; null 거부 |
| `locations[].derivedFrom.path` | 생략 가능 | 원본 파일 경로 | `derivedFrom` optional object; 있으면 `path` 필수 비어 있지 않은 문자열, null 거부 |
| Evidence `derivedFrom` | CORRELATED의 finding/evidence ID | 동일 | 위치의 `derivedFrom.path`와 별개인 최상위 lineage |

공유 Schema는 이미 네 필드를 선언했다. 이번 변경에서 공유 Schema와 Scanner는 수정하지 않았다. Python은 생략된 optional 필드를 내부적으로 `None`으로 나타내지만 명시적 `null` 입력은 거부한다. JSONB 저장은 `exclude_none=True`로 생략된 필드를 다시 생략하고, 조회는 과거 Tier1 JSONB에 저장된 신규 필드의 `null` 기본값을 생략으로 정규화한다. TypeScript `CodeLocation` 타입을 공유 Evidence 위치 구조(`type`, `path`, 행·열, role)로 맞췄다. Python의 위치·위치 derivedFrom과 공유 Schema는 임의 필드를 거부하며 TypeScript 수신 경계도 이번 위치와 최상위 임의 필드를 거부한다. TypeScript parser는 전체 공유 JSON Schema를 구현한 범용 validator가 아니므로 다른 기존 중첩 필드 전체의 동일성은 이번 검증 범위 밖이다.

정상 사례는 필드 없는 Tier1, `TIER1`/`ORIGINAL`/`DIRECT` 위치, 그리고 `TIER2`/`DEOBFUSCATED`/`UNMAPPED`/원본 `path` 위치다. 실패 사례는 잘못된 enum·타입, 네 필드의 명시적 null, 빈/누락된 `derivedFrom.path`, 임의 최상위·위치·derivedFrom 필드다. TypeScript·Python·공유 Schema에서 이 공통 사례는 동일하게 통과/거부된다. Tier1·Tier2 Evidence API mock JSONB round-trip에서 신규 필드와 기존 필드가 보존되고 과거 Tier1 JSONB 조회도 통과한다. 아래의 실제 PostgreSQL/API 검증으로도 확인했다.

## 실제 PostgreSQL·Evidence API 검증 (2026-09-28)

`.env`에는 PostgreSQL 사용자·비밀번호 키가 있지만 값은 비어 있다. 기존 데이터를 건드리지 않기 위해 임시 파일의 무작위 로컬 자격증명으로 격리된 Compose 프로젝트 `whsw7df375`를 생성했다. 캐시된 `postgres:16-alpine`과 `whsproject-evidence-api:latest` 이미지만 사용했고, API 컨테이너에는 현재 `apps/policy/app`을 읽기 전용으로 마운트했다. PostgreSQL health가 `healthy`, Evidence API `/health`가 200이었다. `evidence_db`의 `evidences`·`evidence_locations` 테이블을 확인했다. API 쓰기는 `POST /internal/v1/evidences`, 조회는 `GET /internal/v1/evidences/{evidence_id}`다. Evidence Contract에는 `requestId`가 없어 실행 식별자 UUID는 테스트 하네스에서만 사용했다.

| 실제 시나리오 | 결과 |
| --- | --- |
| Tier2 ATOMIC POST→GET→JSONB | HTTP 201/200; 최상위 `analysisPass=TIER2`, 위치 `representation=DEOBFUSCATED`, `lineageStatus=UNMAPPED`, `derivedFrom.path=package/index.js` 모두 동일하게 보존 |
| 필드 없는 Tier1 ATOMIC POST→GET→JSONB | HTTP 201/200; 신규 필드 생략 상태로 저장, 조회 성공 |
| 과거 Tier1 JSONB 형식 | 이번 검증에서 새로 만든 별도 행에 과거 직렬화의 신규 필드 `null` 기본값을 넣고 GET; HTTP 200으로 조회 호환성 확인 |
| 잘못된 `analysisPass`·`representation`·`lineageStatus`, 명시적 `null` 2종, 중첩 임의 필드, `derivedFrom.path` 숫자 | POST 모두 HTTP 422; 실패 ID는 DB에 저장되지 않음 (7건) |

성공 실행 식별자는 `requestId=d52ed717-0f21-4286-a215-a1956aa37a04`, `scanId=e8f1d7e7-b7ec-4f0c-83fa-ebd108fc7ea7`이다. 격리 DB에는 성공 실행의 Tier2·Tier1·legacy 행 3개와 초기 검증 스크립트의 트랜잭션 가시성 오류 이전에 API가 저장한 Tier2·Tier1 행 2개, 총 **이번 실행에서 만든 5행**이 남아 있다. 초기 오류는 별도 연결의 미커밋 legacy 행을 GET으로 읽으려 한 테스트 스크립트 문제였으며, commit 후 새 UUID로 재실행해 통과했다. 기존 행은 수정·삭제하지 않았고 이 격리 DB의 테스트 행도 삭제하지 않았다. 생성된 `evidenceId`는 다음 5개다: `w7-df-375-legacy-b883859f-4ad7-44c0-b62f-35ad5b1e8d3c`, `w7-df-375-tier1-43ac77c1-fee5-4880-b334-07b264ac37b9`, `w7-df-375-tier1-683e236d-60ee-499c-89c9-9740361e3db1`, `w7-df-375-tier2-b81782fc-4e49-4834-bae9-5cdbfa150640`, `w7-df-375-tier2-d36fb495-4f67-45e7-8778-c2a13c1cb120`.

## Predicate 근거 연결표

아래 코드는 `003_predicate_registry.sql`, Rule은 `002_qa_fixture.sql`·`004_expand_qa_policy.sql`·`default-policy.ts` 기준이다. `S`는 직접 관련된 Scanner ATOMIC/CORRELATED Evidence의 `evidenceIds`, `A`는 연결된 직접 Evidence와 관계 명제를 확인한 VERIFIED Assessment의 `assessmentIds`, `F`는 검증된 OSV advisory의 `feedEvidenceIds`를 뜻한다. 불충분한 핵심 사실 또는 관계는 `UNKNOWN`; 직접 부정 근거가 있는 경우에만 `NOT_SUPPORTED`다. 모든 행의 최종 Decision 계산자는 TypeScript `resolveDecision`이다. Rule에 없는 Registry 항목도 활성 Policy가 참조할 수 있다.

| Predicate | 허용 근거·namespace | 직접 입증할 사실/관계 | 관련 Rule |
| --- | --- | --- | --- |
| LIFECYCLE_TRIGGERED | S/A | lifecycle 경로가 위험 동작을 호출 | RULE-REJECT-REMOTE-CODE |
| EXECUTION_PATH_REACHABLE | S/A | 해당 동작으로 이어지는 실행 경로 | MALWARE-EXFIL-001, RULE-REJECT-CONFIRMED-EXFIL/CHILD-PROCESS/REMOTE-CODE |
| SENSITIVE_DATA_ACCESSED | S/A | 민감 데이터 읽기 | MALWARE-EXFIL-001 |
| DATA_REACHES_EXTERNAL_SINK | S/A | source→external sink 연결 | MALWARE-EXFIL-001, RULE-REJECT-CONFIRMED-EXFIL |
| DATA_REACHES_PROCESS_EXECUTION | S/A | data→process sink 연결 | RULE-REJECT-SHELL-EXEC |
| BENIGN_ALTERNATIVE_SUPPORTED | S/A | 구체적 benign 설명의 직접 근거 | RULE-ACCEPT-BENIGN |
| BENIGN_ALTERNATIVE_NOT_SUPPORTED | S/A | 구체적 benign 대안 배제의 직접 근거; 단순 부재 불충분 | MALWARE-EXFIL-001, RULE-REJECT-CONFIRMED-EXFIL/CHILD-PROCESS/REMOTE-CODE |
| FUNCTIONALITY_MISMATCH | S/A | 실제 동작과 선언 목적의 실질적 차이 | RULE-REVIEW-FUNCTIONALITY-MISMATCH |
| REFERENCE_VALID | S/A | metadata/documentation 주장과 참조의 일치 | 활성 Rule 없음 |
| INDEPENDENT_SUPPORT_PRESENT | S/A | 별도 출처의 독립적 corroboration | RULE-REVIEW-CREDENTIAL-ACCESS/FUNCTIONALITY-MISMATCH |
| DECISIVE_LINK_UNRESOLVED | S/A | 결론에 필요한 연결이 미해결임을 직접 제시 | MALWARE-UNRESOLVED-001, RULE-HOLD-UNKNOWN-LINK |
| ANALYSIS_COVERAGE_INCOMPLETE | S/A | 필요한 분석 범위의 공백 | MALWARE-UNRESOLVED-001, RULE-HOLD-SCAN-TIMEOUT, RULE-REVIEW-OBFUSCATION, RULE-HOLD-NATIVE-BINARY |
| OSV_ADVISORY_APPLIES | F만 | advisory의 npm package/version 적용 | RULE-REVIEW-OSV-HIGH; REJECT 불가 |
| ARTIFACT_IDENTITY_MATCHES | S/A | 요청 artifact와 분석 artifact 동일성 | 활성 Rule 없음 |
| PACKAGE_INSTALL_SCRIPT_PRESENT | S/A | package metadata의 install/lifecycle script 선언 | 활성 Rule 없음 |
| NETWORK_REQUEST_INITIATED | S/A | outbound network request 시작 | 활성 Rule 없음 |
| CHILD_PROCESS_SPAWNED | S/A | 실제 코드 경로의 구체적인 spawn/shell invocation | RULE-REJECT-CHILD-PROCESS |
| CREDENTIAL_SOURCE_ACCESSED | S/A | credential-bearing source 접근 | RULE-REJECT-CONFIRMED-EXFIL, RULE-REVIEW-CREDENTIAL-ACCESS |
| REMOTE_CODE_FETCH | S/A | 원격 대상이 code/script/executable임 | RULE-REJECT-REMOTE-CODE |
| NATIVE_BINARY_LOADED | S/A | native binary/module 로드 | RULE-HOLD-NATIVE-BINARY |
| OBFUSCATION_PRESENT | S/A | 분석을 실질적으로 제한하는 난독화 | RULE-REVIEW-OBFUSCATION |

검증된 OSV advisory만 `F`가 될 수 있고, Scanner Predicate에서 `F`를 인용하면 validator가 거부한다. SUCCESS+빈 advisory는 유효한 빈 집합이다. FAILED/TIMEOUT/SKIPPED와 `complete=false`는 advisory를 판단 근거로 쓰지 않는다. Feed 장애는 무관한 Scanner Predicate를 바꾸지 않는다. Assessment summary·malicious label만으로는 Predicate를 지원하지 않는다. source와 sink의 공존, 일반 network capability, child-process API 참조도 관계나 실제 invocation의 직접 근거가 아니다. Rule의 effect·priority는 Predicate status를 바꾸지 않고, validator가 allOf/anyOf/CONFLICT로 Rule status를 계산한다.

## 회귀와 실행 결과

TypeScript 전체 테스트는 Evidence/Assessment/Feed ID namespace, 없는 Citation, Citation 없는 SUPPORTED, OSV 오용, Prompt Injection, benign 대안 부재 추론, source/sink 공존, network→remote code 과대 판단, child-process capability 구분, UNKNOWN·allOf·anyOf·CONFLICT, primary timeout/error/invalid JSON/invalid Judgment/Citation, shadow 격리, OSV 상태, DB 저장 실패, Feed 저장 실패 분리, Resolver, Feed persistence 및 reevaluation을 포함한다. 추가 통합 fixture는 QA policy의 실제 `RULE-ACCEPT-BENIGN`·`RULE-REVIEW-OSV-HIGH`와 등록 Predicate로 Static, Feed, VERIFIED Assessment, 세 가지 조합을 검사한다. Provider는 fixture/mock만 사용한다.

| 명령 | 결과 |
| --- | --- |
| Node 24.21.0에서 `pnpm typecheck` (`apps/policy`) | 통과, engine 경고 없음 |
| Node 24.21.0에서 `pnpm build && pnpm test` (`apps/policy`) | 통과, 17 test files, engine 경고 없음 |
| `node --test dist/contracts/evidence-provenance.test.js dist/llm/policy-judgment.validator.test.js dist/policy/policy-rule.resolver.test.js dist/evaluation/policy-evaluation.service.test.js dist/evaluation/policy-provenance.integration.test.js dist/llm/policy-osv-integration.test.js dist/feed/feed-persistence.client.test.js dist/reevaluation/reevaluation.processor.test.js` | 통과, 관련 8 test files |
| `./.venv/bin/python -m pytest -q` (`apps/policy`) | 통과, 40 tests |
| `./.venv/bin/python -m compileall -q app tests` (`apps/policy`) | 통과 |
| `python3 apps/policy/scripts/validate_evidence_schema.py` | 통과, 17 assertions |
| `apps/policy/.venv/bin/python /tmp/whs_w7_df_375_api_check.py` | 로컬 PostgreSQL/API 실측: 3건 조회 성공, 7건 HTTP 422 거부; 실행용 스크립트는 `/tmp`에만 생성 |
| Node 24.21.0에서 `pnpm test --runInBand --no-watchman --roots=src --roots=test --runTestsByPath test/policy-evaluation-contract.spec.ts src/analyzers/obfuscation/tier2-handoff.spec.ts test/tier3-llm-evidence-binding.spec.ts --detectOpenHandles --verbose` | 통과, 3 suites / 54 tests |
| Node 24.21.0에서 `pnpm test --runInBand --no-watchman --roots=src/policy --runTestsByPath src/policy/policy-evaluation.request.spec.ts --detectOpenHandles --verbose` | 통과, 1 suite / 14 tests |
| Node 24.21.0에서 `pnpm test --runInBand --no-watchman --roots=src/evidence/normalizer --runTestsByPath src/evidence/normalizer/evidence-normalizer.spec.ts --detectOpenHandles --verbose` | 통과, 1 suite / 116 tests |
| `docker compose --env-file /tmp/whs-w7-df-375-compose.env -p whsw7df375 config --quiet` | 통과 |
| `git diff --check` | 통과 |

기존 첫 실행은 Node 22여서 Node 24 engine 경고가 있었으나 이번 후속 검증은 설치된 Node 24.21.0으로 재실행했다. Scanner의 처음 넓은 Jest 실행은 테스트명 출력 전에 장시간 대기해 중단됐다. Node 24에서 `--listTests`도 약 1분 걸렸고, 대상 5개 파일 명시 실행은 앞의 두 suite가 PASS였지만 300초 timeout으로 명령이 종료됐다. 그때 마지막으로 완료된 파일은 `src/policy/policy-evaluation.request.spec.ts`였다. Jest 프로세스는 Linux `/mnt/c` 마운트의 `p9_client_rpc` I/O 대기 상태로 관찰됐으며, 테스트 본문이나 열린 핸들에서 멈춘 근거는 없었다. 이후 파일별로 root를 좁힌 실행은 **5 suites / 184 tests 모두 통과하고 정상 종료**했다. `--detectOpenHandles`에서 열린 핸들 경고가 없었고 `--forceExit`는 사용하지 않았다. 실제 GPT·Claude·OSV 외부 네트워크와 전체 Docker 서비스 기동 기반 통합 smoke는 실행하지 않았다. Scanner runtime target·timeout은 이번 범위에서 변경하지 않았다.

W7-DF-01은 네 필드의 수신·strict 중첩·Schema/Python/TypeScript 사례·JSONB 경로 검증, W7-DF-02는 세 Citation namespace와 실제 Rule 조합 및 Resolver 결과 검증, W7-DF-07은 기존 Policy LLM·OSV·Provider·저장 실패 회귀 유지와 추가 조합 테스트를 완료 근거로 판단한다. 공개 Decision Schema, DB schema, Policy Rule/Registry/Resolver, Prompt, score 정책은 변경하지 않았다.
