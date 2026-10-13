import type { Predicate } from '@/lib/policy/common/types'

// 조건(predicate) 임시 목록입니다. 적용 중인 정책 응답에 predicate가 없을 때만 씁니다.
// Policy DB 등록값(infra/postgres/migrations/policy/003_predicate_registry.sql)과 같은 코드여야 합니다.
// Policy가 조건 목록 API를 제공하면 server/rules.ts의 predicatesFor만 바꿉니다.
export const fallbackPredicates: Predicate[] = [
  { code: 'LIFECYCLE_TRIGGERED', description: 'The package executes this behavior from an install, lifecycle, or startup hook.', category: 'execution', rejectAllowed: true },
  { code: 'EXECUTION_PATH_REACHABLE', description: 'The analyzed code path can reach the claimed operation in the package runtime.', category: 'execution', rejectAllowed: true },
  { code: 'SENSITIVE_DATA_ACCESSED', description: 'The package reads credentials, tokens, secrets, or other sensitive local data.', category: 'data', rejectAllowed: true },
  { code: 'DATA_REACHES_EXTERNAL_SINK', description: 'Data reaches a network or other external sink controlled outside the package.', category: 'data', rejectAllowed: true },
  { code: 'DATA_REACHES_PROCESS_EXECUTION', description: 'Data reaches a child-process, shell, interpreter, or native execution sink.', category: 'execution', rejectAllowed: true },
  { code: 'BENIGN_ALTERNATIVE_SUPPORTED', description: 'The observed behavior has a directly supported benign explanation.', category: 'context', rejectAllowed: true },
  { code: 'BENIGN_ALTERNATIVE_NOT_SUPPORTED', description: 'The supplied evidence does not support a benign explanation for the behavior.', category: 'context', rejectAllowed: true },
  { code: 'FUNCTIONALITY_MISMATCH', description: 'Observed behavior is materially unrelated to the package functionality or declared purpose.', category: 'context', rejectAllowed: true },
  { code: 'REFERENCE_VALID', description: 'The package metadata, documentation, or claimed reference is supported by supplied evidence.', category: 'context', rejectAllowed: true },
  { code: 'INDEPENDENT_SUPPORT_PRESENT', description: 'The decisive claim has independent corroboration from a separate evidence source.', category: 'corroboration', rejectAllowed: true },
  { code: 'DECISIVE_LINK_UNRESOLVED', description: 'A link needed for the policy decision is missing or cannot be established.', category: 'coverage', rejectAllowed: true },
  { code: 'ANALYSIS_COVERAGE_INCOMPLETE', description: 'Required analysis coverage is incomplete for this package or execution path.', category: 'coverage', rejectAllowed: true },
  { code: 'OSV_ADVISORY_APPLIES', description: 'A validated OSV advisory applies to this package and version.', category: 'feed', rejectAllowed: false },
  { code: 'ARTIFACT_IDENTITY_MATCHES', description: 'The scanned artifact identity matches the requested package identity.', category: 'identity', rejectAllowed: true },
  { code: 'PACKAGE_INSTALL_SCRIPT_PRESENT', description: 'The package contains an install or lifecycle script that can execute during installation.', category: 'execution', rejectAllowed: true },
  { code: 'NETWORK_REQUEST_INITIATED', description: 'The package initiates an outbound network request.', category: 'network', rejectAllowed: true },
  { code: 'CHILD_PROCESS_SPAWNED', description: 'The package spawns a child process or invokes a shell command.', category: 'execution', rejectAllowed: true },
  { code: 'CREDENTIAL_SOURCE_ACCESSED', description: 'The package accesses a credential-bearing source such as environment variables or local config.', category: 'data', rejectAllowed: true },
  { code: 'REMOTE_CODE_FETCH', description: 'The package fetches executable code or a script from a remote source.', category: 'network', rejectAllowed: true },
  { code: 'NATIVE_BINARY_LOADED', description: 'The package loads a native binary or dynamically linked module.', category: 'execution', rejectAllowed: true },
  { code: 'OBFUSCATION_PRESENT', description: 'The package contains obfuscation that materially limits code or intent inspection.', category: 'analysis', rejectAllowed: true },
]
