import type { AnalyzerResult, Finding } from '../../domain/analysis.types';

/**
 * GuardDog is an expensive second-pass analyzer. Cheap analyzers can justify
 * a run, but a successful empty result or a generic capability is not proof
 * that GuardDog would find nothing. Those states therefore remain runnable
 * to preserve GuardDog-only threat coverage.
 */
export type GuardDogExecutionReason =
  | 'CHEAP_ANALYZER_UNAVAILABLE'
  | 'METADATA_SIGNAL'
  | 'CUSTOM_RULE_HIGH_CONFIDENCE'
  | 'CUSTOM_RULE_CORROBORATION'
  | 'CUSTOM_RULE_MULTIPLE_CAPABILITIES'
  | 'NO_CHEAP_SIGNAL'
  | 'GENERIC_SINGLE_SIGNAL_REVIEW';

export interface GuardDogExecutionDecision {
  shouldRun: boolean;
  reason: GuardDogExecutionReason;
}

const GENERIC_RULE_IDS = new Set([
  'custom.collection-source',
  'custom.credential-source',
  'custom.sensitive-file-access',
  'custom.network-outbound',
  'custom.remote-download',
  'custom.process-execution',
  'custom.filesystem.write',
]);

const CORROBORATED_RULE_IDS = new Set([
  'custom.lifecycle-entry',
  'custom.lifecycle-process-coexistence',
  'custom.env-network-coexistence',
  'custom.sensitive-file-network-coexistence',
  'custom.download-write-coexistence',
  'custom.download-execution-coexistence',
]);

const CAPABILITY_FAMILIES = new Map([
  ['custom.collection-source', 'collection'],
  ['custom.credential-source', 'credential'],
  ['custom.sensitive-file-access', 'sensitive'],
  ['custom.network-outbound', 'network'],
  ['custom.remote-download', 'network'],
  ['custom.process-execution', 'process'],
  ['custom.filesystem.write', 'filesystem'],
]);

export function decideGuardDogExecution(
  metadataResult: AnalyzerResult,
  customRuleResult: AnalyzerResult,
): GuardDogExecutionDecision {
  if (hasAnalyzerFailure(metadataResult) || hasAnalyzerFailure(customRuleResult)) {
    return { shouldRun: true, reason: 'CHEAP_ANALYZER_UNAVAILABLE' };
  }

  if (metadataResult.findings.length > 0) {
    return { shouldRun: true, reason: 'METADATA_SIGNAL' };
  }

  const findings = customRuleResult.findings;
  if (findings.length === 0) {
    return { shouldRun: true, reason: 'NO_CHEAP_SIGNAL' };
  }

  if (findings.some(isHighConfidenceFinding)) {
    return { shouldRun: true, reason: 'CUSTOM_RULE_HIGH_CONFIDENCE' };
  }

  if (findings.some(({ ruleId }) => CORROBORATED_RULE_IDS.has(ruleId))) {
    return { shouldRun: true, reason: 'CUSTOM_RULE_CORROBORATION' };
  }

  const families = new Set(
    findings
      .map(({ ruleId }) => CAPABILITY_FAMILIES.get(ruleId))
      .filter((family): family is string => family !== undefined),
  );
  if (families.size >= 2) {
    return { shouldRun: true, reason: 'CUSTOM_RULE_MULTIPLE_CAPABILITIES' };
  }

  // A generic capability is retained as Finding/Evidence and is not itself a
  // malicious verdict, but it cannot rule out a GuardDog-only threat.
  if (findings.every(({ ruleId }) => GENERIC_RULE_IDS.has(ruleId))) {
    return { shouldRun: true, reason: 'GENERIC_SINGLE_SIGNAL_REVIEW' };
  }

  // Unknown custom-rule observations are handled conservatively so adding a
  // new detector cannot silently reduce GuardDog coverage.
  return { shouldRun: true, reason: 'CUSTOM_RULE_CORROBORATION' };
}

export function skippedGuardDogResult(
  context: Pick<AnalyzerResult, 'requestId' | 'scanId'>,
  analyzerVersion: string,
): AnalyzerResult {
  return {
    requestId: context.requestId,
    scanId: context.scanId,
    analyzer: 'guarddog',
    analyzerVersion,
    status: 'SKIPPED',
    findings: [],
    errors: [],
  };
}

function hasAnalyzerFailure(result: AnalyzerResult): boolean {
  return result.status !== 'SUCCESS' || result.errors.length > 0;
}

function isHighConfidenceFinding(finding: Finding): boolean {
  const data = finding.data as Record<string, unknown>;
  return data.confidence === 'HIGH' || finding.ruleId.startsWith('threat.');
}
