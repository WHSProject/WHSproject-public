# Scanner Analysis Baseline v0.1

## 목적

이 문서는 W4-SC-01의 기준선이다. 현재 `dev`의 Scanner 구현을 기준으로
입력, Registry metadata, Tarball/Artifact, Analyzer 실행, Metadata Analyzer 및
대표 Fixture 구성을 기록한다.

이 문서는 새로운 Scanner 정책을 정의하지 않는다. 현재 코드가 실제로 적용하는
기준과, 코드에는 존재하지만 실제 Orchestrator Scan 경로에 연결되지 않은 Known Gap을
구분한다.

## 적용 범위

- ecosystem: `npm`
- Registry: `npmjs` (`https://registry.npmjs.org`)
- Scanner application, Registry, Artifact, Metadata Analyzer, History, Domain
- GuardDog, Custom Static Rule, 공통 Analyzer Contract, Evidence 내부 구조는 참조만 한다.

## 입력 기준

`POST /internal/v1/scans`는 `requestId` UUID와 1개 이상의 `packages`를 요구한다.
각 package는 `packageName`, `version`, `integrity`를 요구하며 `integrity`는 API
경계에서 `null`일 수 있다.

Registry 조회 단계에서는 다음을 추가로 검증한다.

- package name은 valid npm package name이어야 한다.
- version은 exact semantic version이어야 한다.
- scoped package인 `@scope/name`을 지원한다.
- Registry ID는 `npmjs`만 지원한다.

`integrity`는 expected integrity 또는 Registry의 `dist.integrity` 중 하나 이상이
있어야 Artifact 다운로드를 진행할 수 있다. 둘 다 없으면 다운로드 전에
`INVALID_INPUT`이 발생한다.

## Registry Metadata 기준

| 기준 | 기본값/현재 동작 |
|---|---|
| Metadata timeout | `METADATA_TIMEOUT_MS`, 10,000ms |
| Metadata response size | `METADATA_MAX_RESPONSE_BYTES`, 2 MiB |
| HTTP retry | `fetchRetries: 0` |
| HTTP 오류 | 429/5xx retryable, 그 외 non-retryable |
| JSON | `JSON.parse`로 검증 |
| 응답 검증 | object, name, version, dist, HTTPS tarball, optional strict SRI |
| 추출 값 | `dist.tarball`, `dist.integrity`, 전체 metadata |
| `dist.shasum` | integrity로 변환하지 않음 |

Metadata URL은 npmjs Registry base URL에 package name/version을 각각 URL encode하여
생성한다. Metadata 응답 validator는 HTTPS와 credentials만 확인하고, tarball host와
DNS는 실제 다운로드 직전에 별도 검증한다.

## Tarball 및 Artifact 기준

| 기준 | 기본값/현재 동작 |
|---|---|
| 최대 다운로드 크기 | `MAX_TARBALL_BYTES`, 100 MiB |
| Connect timeout | `TARBALL_CONNECT_TIMEOUT_MS`, 5초 |
| Download timeout | `TARBALL_DOWNLOAD_TIMEOUT_MS`, 60초 |
| Redirect | `TARBALL_MAX_REDIRECTS`, 최대 3회 |
| Tarball URL | HTTPS, 정확한 `registry.npmjs.org`, public DNS |
| Content-Length | 형식, 중복, limit 초과, 실제 수신 길이 불일치 검증 |
| Integrity | sha256/sha384/sha512 SRI 검증 |
| Artifact hash | Tarball SHA-256 lowercase hex |
| Package identity | `package/package.json` name/version이 요청과 일치해야 함 |
| 임시 파일 | `.part`로 저장 후 integrity 검증 및 atomic rename |

압축 해제 시 현재 코드가 차단하는 항목은 다음과 같다.

- absolute path, `..`, backslash, NUL, Windows drive path
- symbolic link
- hard link
- 지원하지 않는 tar entry type

`MAX_EXTRACTED_BYTES`, `MAX_EXTRACTED_FILES`, `maxPathDepth`는 SafeExtractor의
직접 옵션 또는 fallback 코드에는 존재한다. 그러나 현재 Orchestrator는 해당 옵션을
전달하지 않으며 Scanner environment schema와 compose에도 연결하지 않는다.
따라서 이 세 항목은 현재 실제 Scanner Scan 경로에서는 enforcement되지 않는 Known Gap이다.
W4-SC-01에서는 runtime 연결을 구현하지 않는다.

## Scanner 실행 기준

package 단위 기본 deadline은 `SCANNER_PACKAGE_TIMEOUT_MS=240000`이다.
실행 순서는 다음과 같다.

`REGISTRY → DOWNLOAD → EXTRACT → HASH → IDENTITY → ANALYZER → NORMALIZATION`

Metadata, Custom Rule, GuardDog Analyzer는 병렬 실행된다. Analyzer 예외는 다른
Analyzer 결과를 버리지 않고 해당 Analyzer를 `FAILED`로 변환한다.

ScanResult 상태 우선순위는 다음과 같다.

1. Analyzer `TIMEOUT` → `TIMEOUT`
2. Analyzer `FAILED` → `FAILED`
3. Analyzer `PARTIAL` → `PARTIAL`
4. Normalizer unmapped/error → `PARTIAL`
5. 그 외 → `COMPLETED`

Batch 동시 실행 수는 코드 상수 `3`이다. 동일 package를 다시 Scan하면 cache/dedup하지
않고 새 `scanId`로 다시 실행한다.

Artifact cleanup은 `ScanService.finally`에서 scanId 단위로 시도한다. cleanup 오류는
로그로 남기지만 원래 Scan 결과나 오류를 대체하지 않는다.

History는 외부 DB가 아닌 process memory의 `Map`에 저장된다.

## Metadata Analyzer 기준

현재 Metadata Analyzer는 `packageJson.scripts`의 다음 필드 존재를 탐지한다.

- `preinstall`
- `install`
- `postinstall`

값이 빈 문자열이어도 Finding을 만든다. script 내용은 실행하거나 해석하지 않는다.

Registry client는 `/package/version` 경로를 조회하고, 응답 객체를
`registryMetadata`로 보존한다. 이 응답은 전체 packument가 아니라 version manifest이며,
최상위 `name`, `version`, `dist`를 확인한다. tarball의
`package/package.json`은 별도로 읽어 요청한 name/version과 일치하는지 검증한다.

Metadata Analyzer는 양쪽 version metadata에 비교 가능한 값이 모두 있을 때만
`license`와 `repository`를 비교한다. License는 문자열 또는 `{ "type": string }`을
받아 공백과 대소문자 차이를 정규화한다. Repository는 URL 문자열 또는
`{ "url": string }`을 받아 `git+`, trailing `.git`, trailing slash 표현을
정규화한다. Unsupported repository shorthand와 한쪽에만 있는 값은 비교하지 않는다.
현재는 mismatch만 Finding으로 만들며, metadata의 부재는 위험 신호가 아니다.

`maintainers`와 tarball `packageJson`의 `author`/`contributors`는 같은 개념임을
확인할 공통 schema가 없어 비교하지 않는다. Finding에는 severity 필드가 없다.

## 대표 source Fixture

저장소에 binary `.tgz`를 추가하지 않고 source Fixture를 사용한다.

```text
apps/scanner/test/fixtures/npm/
├─ normal-unscoped/package/package.json
├─ normal-unscoped/package/index.js
├─ normal-scoped/package/package.json
├─ normal-scoped/package/index.js
├─ lifecycle-scripts/package/package.json
├─ lifecycle-scripts/package/index.js
├─ identity-mismatch/package/package.json
├─ identity-mismatch/package/index.js
├─ metadata-consistent/package/package.json
├─ metadata-consistent/registry-metadata.json
├─ metadata-mismatch/package/package.json
└─ metadata-mismatch/registry-metadata.json
```

각 Fixture의 목적은 다음과 같다.

| Fixture | 목적 |
|---|---|
| `normal-unscoped` | 정상 unscoped package, lifecycle script 없음 |
| `normal-scoped` | scoped package identity와 URL 경계 |
| `lifecycle-scripts` | preinstall/install/postinstall metadata Finding |
| `identity-mismatch` | 요청 identity와 package.json identity 불일치 |
| `metadata-consistent` | license와 repository 값이 표현 차이만 있고 의미상 일치 |
| `metadata-mismatch` | registry version manifest와 tarball package.json의 license/repository 불일치 |

Artifact safety와 limit 경계는 binary Fixture로 저장하지 않고 기존 tar helper로
테스트 실행 중 생성한다. 대표 경계 케이스는 hard link, malformed archive, file count,
extracted bytes, path depth 초과다. 이 limit 테스트는 SafeExtractor에 옵션을 직접
전달하며 Orchestrator runtime 연결을 검증하지 않는다.

## 범위 제외

- GuardDog analyzer, Fixture, runtime
- Custom Static Rule analyzer, rule YAML, Fixture
- Analyzer 공통 Contract 변경
- Evidence Normalizer 및 공용 Evidence schema 변경
- extraction limit의 Orchestrator 연결
- API 입력 오류 상태 변경
- History persistence, rescan/cache, batch concurrency, timeout 정책 변경
