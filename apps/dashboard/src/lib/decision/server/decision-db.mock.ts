import type { Decision, DecisionRecord, EvidenceRecord } from '../types'

// 표시용 목업입니다. 실제 Decision·Evidence가 아닙니다. 모양은 Decision DB API·Evidence API 응답과 같습니다.

// 사유는 엔진(apps/policy/src/decision/decision.resolver.ts) 형식입니다: 맞은 Rule의 reasonCode와 "Policy rule {ruleCode} matched.",
// 맞은 Rule이 없으면 POLICY_DEFAULT. reasonCode는 QA 예제 정책 v0.1.0(infra/postgres/migrations/policy 002·004)의 값입니다.
const REASON_CODES: Record<string, string> = {
  'RULE-REJECT-CONFIRMED-EXFIL': 'POLICY_CONFIRMED_CREDENTIAL_EXFILTRATION',
  'RULE-REJECT-CHILD-PROCESS': 'POLICY_CONFIRMED_CHILD_PROCESS_EXECUTION',
  'RULE-REJECT-REMOTE-CODE': 'POLICY_REMOTE_CODE_FETCH',
  'RULE-REJECT-SHELL-EXEC': 'MALICIOUS_SIGNAL_DETECTED',
  'RULE-REVIEW-CREDENTIAL-ACCESS': 'POLICY_CREDENTIAL_ACCESS_REVIEW',
  'RULE-REVIEW-OBFUSCATION': 'POLICY_OBFUSCATION_REVIEW',
  'RULE-REVIEW-FUNCTIONALITY-MISMATCH': 'POLICY_FUNCTIONALITY_MISMATCH',
  'RULE-HOLD-NATIVE-BINARY': 'POLICY_NATIVE_BINARY_ANALYSIS_REQUIRED',
  'RULE-HOLD-SCAN-TIMEOUT': 'ADDITIONAL_SCAN_REQUIRED',
  'RULE-ACCEPT-BENIGN': 'POLICY_PASSED',
}

let sequence = 0
function record(name: string, version: string, decision: Decision, evaluatedAt: string, rules: string[], evidenceIds: string[] = []): DecisionRecord {
  sequence += 1
  const [reasonCode, reason] = rules.length > 0
    ? [REASON_CODES[rules[0]], `Policy rule ${rules[0]} matched.`]
    : ['POLICY_DEFAULT', 'No policy rule matched; default policy decision applied.']
  return {
    decisionId: `dec_mock_${String(sequence).padStart(3, '0')}`,
    requestId: `5a4298e8-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
    scanId: `6b5399f9-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
    decision,
    reasonCode,
    reason,
    matchedRuleIds: rules,
    evidenceIds,
    assessmentIds: [],
    policyKey: 'qa-npm-policy',
    policyVersion: '0.1.0',
    subject: { ecosystem: 'npm', packageName: name, packageVersion: version, artifactHash256: `artifact-${String(sequence).padStart(3, '0')}` },
    evaluatedAt,
  }
}

export const decisionRecords: DecisionRecord[] = [
  record('minipass-fetch', '5.0.2', 'REJECT', '2026-10-01T01:12:00Z', ['RULE-REJECT-CONFIRMED-EXFIL'], ['ev_cred_npmrc', 'ev_net_post', 'ev_reach_install']),
  record('minipass-fetch', '5.0.1', 'ACCEPT', '2026-09-10T03:20:00Z', ['RULE-ACCEPT-BENIGN'], ['ev_benign_fetch']),
  record('minipass-fetch', '4.0.1', 'ACCEPT', '2026-08-02T08:41:00Z', ['RULE-ACCEPT-BENIGN'], ['ev_benign_fetch']),
  record('p-limit', '7.3.1', 'ACCEPT', '2026-10-01T00:58:00Z', ['RULE-ACCEPT-BENIGN'], ['ev_benign_purpose']),
  record('braces', '3.0.3', 'ACCEPT', '2026-10-01T00:41:00Z', ['RULE-ACCEPT-BENIGN'], ['ev_benign_purpose']),
  record('express', '5.2.1', 'ACCEPT', '2026-09-30T23:55:00Z', ['RULE-ACCEPT-BENIGN'], ['ev_benign_purpose']),
  record('glob', '13.0.6', 'HOLD', '2026-09-30T23:30:00Z', ['RULE-HOLD-SCAN-TIMEOUT'], ['ev_scan_timeout']),
  record('micromatch', '4.0.8', 'REVIEW', '2026-09-30T22:47:00Z', ['RULE-REVIEW-OBFUSCATION'], ['ev_obfuscated_bundle', 'ev_scan_partial']),
  record('semver', '7.6.3', 'ACCEPT', '2026-09-30T21:15:00Z', ['RULE-ACCEPT-BENIGN'], ['ev_benign_purpose']),
  record('chalk', '5.3.0', 'ACCEPT', '2026-09-30T20:02:00Z', ['RULE-ACCEPT-BENIGN'], ['ev_benign_purpose']),
  record('lru-cache', '11.0.2', 'ACCEPT', '2026-09-30T18:36:00Z', ['RULE-ACCEPT-BENIGN'], ['ev_benign_purpose']),
  record('node-ipc', '10.1.1', 'REJECT', '2026-09-30T17:09:00Z', ['RULE-REJECT-CHILD-PROCESS'], ['ev_spawn_shell', 'ev_reach_install']),
  record('event-stream', '3.3.6', 'REJECT', '2026-09-30T15:44:00Z', ['RULE-REJECT-REMOTE-CODE'], ['ev_postinstall_fetch', 'ev_eval_payload']),
  record('dotenv-safe-config', '1.0.4', 'REVIEW', '2026-09-30T14:20:00Z', ['RULE-REVIEW-CREDENTIAL-ACCESS'], ['ev_cred_env']),
  record('sharp', '0.34.4', 'HOLD', '2026-09-30T12:51:00Z', ['RULE-HOLD-NATIVE-BINARY'], ['ev_native_addon']),
  record('left-pad', '1.3.0', 'REVIEW', '2026-09-30T11:02:00Z', []),
  record('color-string', '2.0.1', 'REVIEW', '2026-09-30T09:37:00Z', ['RULE-REVIEW-FUNCTIONALITY-MISMATCH'], ['ev_unexpected_network']),
  record('minimist', '1.2.8', 'REVIEW', '2026-09-29T08:10:00Z', []),
  record('minimist', '1.2.8', 'ACCEPT', '2026-09-30T08:10:00Z', ['RULE-ACCEPT-BENIGN'], ['ev_benign_purpose']),
  record('debug', '4.4.3', 'ACCEPT', '2026-09-30T06:48:00Z', ['RULE-ACCEPT-BENIGN'], ['ev_benign_purpose']),
  record('rimraf', '6.0.1', 'ACCEPT', '2026-09-30T05:23:00Z', ['RULE-ACCEPT-BENIGN'], ['ev_benign_purpose']),
  record('@ctrl/tinycolor', '4.1.1', 'REJECT', '2026-09-30T03:59:00Z', ['RULE-REJECT-SHELL-EXEC'], ['ev_spawn_shell']),
  record('ws', '8.18.3', 'ACCEPT', '2026-09-30T02:31:00Z', ['RULE-ACCEPT-BENIGN'], ['ev_benign_purpose']),
  record('uuid', '13.0.0', 'ACCEPT', '2026-09-29T23:14:00Z', ['RULE-ACCEPT-BENIGN'], ['ev_benign_purpose']),
]

const evidence = (evidenceId: string, type: string, category: string, summary: string): EvidenceRecord => ({
  evidenceId,
  signal: { type, category },
  assertion: { summary },
})

export const evidenceRecords: EvidenceRecord[] = [
  evidence('ev_cred_npmrc', 'CREDENTIAL_FILE_READ', 'CREDENTIAL_AND_SENSITIVE_DATA_ACCESS', 'Reads ~/.npmrc and extracts the auth token.'),
  evidence('ev_net_post', 'NETWORK_EXFILTRATION', 'NETWORK_C2_AND_EXFILTRATION', 'Sends the collected token to an external host with an HTTP POST.'),
  evidence('ev_reach_install', 'INSTALL_HOOK_EXECUTION', 'INSTALLATION_AND_EXECUTION', 'The code path runs from the postinstall script.'),
  evidence('ev_benign_purpose', 'BENIGN_PURPOSE_MATCH', 'PACKAGE_AND_PUBLISHING_RISK', 'Observed behavior matches the documented package purpose.'),
  evidence('ev_benign_fetch', 'HTTP_CLIENT_USAGE', 'NETWORK_C2_AND_EXFILTRATION', 'Network calls match the documented fetch implementation.'),
  evidence('ev_scan_timeout', 'ANALYSIS_TIMEOUT', 'PACKAGE_AND_PUBLISHING_RISK', 'Static analysis did not finish within the time limit.'),
  evidence('ev_obfuscated_bundle', 'OBFUSCATED_CODE', 'EVASION_AND_OBFUSCATION', 'A bundled file uses string array rotation and hex-encoded identifiers.'),
  evidence('ev_scan_partial', 'PARTIAL_COVERAGE', 'PACKAGE_AND_PUBLISHING_RISK', 'Two files could not be parsed, so coverage is partial.'),
  evidence('ev_spawn_shell', 'CHILD_PROCESS_SPAWN', 'INSTALLATION_AND_EXECUTION', 'Spawns /bin/sh with a command built from downloaded content.'),
  evidence('ev_postinstall_fetch', 'REMOTE_CODE_FETCH', 'PAYLOAD_AND_DYNAMIC_CODE', 'The postinstall script downloads a script from a remote URL.'),
  evidence('ev_eval_payload', 'DYNAMIC_CODE_EXECUTION', 'PAYLOAD_AND_DYNAMIC_CODE', 'Downloaded content is passed to eval().'),
  evidence('ev_cred_env', 'ENV_SECRET_READ', 'CREDENTIAL_AND_SENSITIVE_DATA_ACCESS', 'Reads AWS_SECRET_ACCESS_KEY from process.env.'),
  evidence('ev_native_addon', 'NATIVE_BINARY_LOAD', 'INSTALLATION_AND_EXECUTION', 'Loads a prebuilt native addon that static analysis cannot inspect.'),
  evidence('ev_unexpected_network', 'UNEXPECTED_NETWORK_ACCESS', 'NETWORK_C2_AND_EXFILTRATION', 'A color parsing library opens a network connection at import time.'),
]
