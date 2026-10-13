import type { AnalyzerResult } from '../domain/analysis.types';
import type { AtomicEvidenceV0_1, EvidenceSignalType } from '../evidence/normalizer/evidence-normalizer.types';
import type { RestoreResult } from '../analyzers/obfuscation/obfuscation.types';
import type { Tier2Handoff } from './artifact/tier2-handoff.contract';
import { assessTier1Risk } from '../performance/tier1-risk-weighting';
import {
  type Tier3EscalationDecision,
  type Tier3GateProfile,
  type Tier3EscalationGateInput,
  type Tier3EscalationReason,
} from './tier3-escalation-gate.contract';

const STATIC_ANALYZERS = new Set(['metadata', 'custom-rule', 'guarddog']);
const STRONG_SIGNALS = new Set<EvidenceSignalType>([
  'CHILD_PROCESS',
  'SHELL_EXEC',
  'DYNAMIC_CODE_EXECUTION',
  'CREDENTIAL_READ',
  'SECRET_READ',
  'SENSITIVE_FILE_READ',
  'NETWORK_EGRESS',
  'REMOTE_FETCH',
  'FILE_WRITE',
]);
const WEAK_SIGNALS = new Set<EvidenceSignalType>([
  'LIFECYCLE_SCRIPT',
  'PREINSTALL_SCRIPT',
  'INSTALL_SCRIPT',
  'POSTINSTALL_SCRIPT',
  'METADATA_MISMATCH',
  'OBFUSCATED_CODE',
]);

/**
 * Source-mapping / re-analysis limitations describe how faithfully a restored
 * artifact can be traced back to its origin, not a failure to deobfuscate.
 * They must not be treated as hard restore uncertainty. Every other limitation
 * code — including unknown/new codes and real dynamic-restore failures — stays
 * hard so it keeps escalating conservatively.
 */
function isSoftRestoreLimitation(code: string): boolean {
  return code === 'RISK_CAPABILITY_NOT_REANALYZED'
    || code === 'WEBCRACK_SOURCE_MAP_UNAVAILABLE'
    || code === 'BABEL_SOURCE_MAP_UNAVAILABLE'
    || code === 'PAYLOAD_SOURCE_LINE_UNAVAILABLE'
    || code.startsWith('LINE_MAPPING_');
}

/**
 * Decides whether a Tier 2 result is sufficiently explained for Shadow Tier 3.
 * This function is deliberately pure: benchmark runs and the production
 * orchestrator use the exact same decision rules.
 */
export function evaluateTier3Escalation(
  input: Tier3EscalationGateInput,
): Tier3EscalationDecision {
  const profile: Tier3GateProfile = input.profile ?? 'BALANCED';
  const tier1Results = input.tier1Results.filter((result) => STATIC_ANALYZERS.has(result.analyzer));
  const tier1Findings = tier1Results.flatMap((result) => result.findings);
  const tier2Findings = input.tier2Handoff?.findings ?? [];
  const evidences = [
    ...input.tier1Evidences,
    ...(input.tier2Handoff?.atomicEvidences ?? []),
  ];
  const restoreStatuses = input.restore === undefined
    ? []
    : [
      ...input.restore.restored.map((file) => file.status),
      ...input.restore.unresolved.map((file) => file.status),
    ];
  const findingsByAnalyzer = tier1Results.filter((result) => result.findings.length > 0);
  const agreeingAnalyzerCount = sharedFindingKeyCount(findingsByAnalyzer);
  const partialRestore = input.restore?.restored.some((file) => file.status === 'PARTIAL_RESTORED') === true;
  const hardRestoreUncertainty = input.restore?.restored.some((file) => (
    file.limitations.some((code) => !isSoftRestoreLimitation(code))
  )) === true || input.restore?.unresolved.some((file) => (
    file.status === 'UNRESOLVED' || file.status === 'SKIPPED' || file.status === 'FAILED'
  )) === true;
  const unresolvedRestore = hardRestoreUncertainty;
  const hardHandoffLimitation = (input.tier2Handoff?.limitations ?? [])
    .some((item) => !isSoftRestoreLimitation(item.code));
  const strongSignalTypes = new Set(
    evidences
      .filter((evidence) => STRONG_SIGNALS.has(evidence.signal.type as EvidenceSignalType))
      .map((evidence) => evidence.signal.type as EvidenceSignalType),
  );
  const strongEvidenceCount = strongSignalTypes.size;
  const tier1Risk = assessTier1Risk({
    findings: [
      ...tier1Findings,
      ...tier2Findings.map((finding) => ({ ruleId: finding.ruleId, type: finding.kind })),
    ],
    evidences,
  });
  const threatFinding = tier1Results.some((result) => result.findings.some((finding) => (
    finding.type.startsWith('THREAT') || finding.ruleId.startsWith('threat-')
  ))) || tier2Findings.some((finding) => (
    finding.kind === 'THREAT' || finding.ruleId.startsWith('threat-')
  ));
  // Different analyzer rule namespaces are not semantic uncertainty by
  // themselves. Strong normalized evidence closes the gate when restoration
  // has no hard unresolved limitation, or when threat evidence already
  // explains a partially restored payload.
  const evidenceSufficient = tier1Risk.malicious
    && (!hardRestoreUncertainty || threatFinding);
  const analyzerDisagreement = findingsByAnalyzer.length >= 2
    && agreeingAnalyzerCount === 0
    && !evidenceSufficient;
  const weakEvidenceCount = evidences.filter((evidence) => WEAK_SIGNALS.has(evidence.signal.type as EvidenceSignalType)).length;
  const unknownPattern = (tier1Findings.length + tier2Findings.length > 0 && evidences.length === 0)
    || tier1Results.some((result) => result.status === 'FAILED' || result.status === 'TIMEOUT');
  const weakSignalCombination = evidences.length > 0
    && strongEvidenceCount === 0
    && weakEvidenceCount > 0;
  const semanticRelationUnclear = (tier2Findings.length > 0 || evidences.some((evidence) => evidence.analysisPass === 'TIER2'))
    && strongEvidenceCount < 2
    && !partialRestore
    && !unresolvedRestore;
  const conservativeTier2Route = profile === 'CONSERVATIVE'
    && input.tier2Handoff !== undefined
    && (input.restore?.restored.length ?? 0) > 0;
  const explained = evidenceSufficient
    && !analyzerDisagreement
    && !unknownPattern
    && !weakSignalCombination
    && !semanticRelationUnclear;

  const reasons: Tier3EscalationReason[] = [];
  const rationale: string[] = [];
  if (analyzerDisagreement) {
    reasons.push('ANALYZER_DISAGREEMENT');
    rationale.push('Tier 1 analyzers reported findings without a shared rule or signal identity.');
  }
  if (partialRestore && !evidenceSufficient) {
    reasons.push('PARTIAL_RESTORE');
    rationale.push('At least one Tier 2 restored file is PARTIAL_RESTORED and the available evidence does not close the uncertainty.');
  }
  if (unresolvedRestore || hardHandoffLimitation) {
    if (!evidenceSufficient) {
      reasons.push('UNRESOLVED_OBFUSCATION');
      rationale.push('Tier 2 contains hard-unresolved files or restore limitations not covered by corroborating evidence.');
    } else {
      rationale.push('Restore uncertainty is covered by corroborating normalized evidence; no semantic escalation is required.');
    }
  }
  if (weakSignalCombination) {
    reasons.push('WEAK_SIGNAL_COMBINATION');
    rationale.push('Only weak metadata/obfuscation signals are available; no strong capability signal corroborates them.');
  }
  if (semanticRelationUnclear) {
    reasons.push('SEMANTIC_RELATION_UNCLEAR');
    rationale.push('Tier 2 produced a finding/evidence, but the current evidence does not establish a strong behavior relation.');
  }
  if (unknownPattern) {
    reasons.push('UNKNOWN_PATTERN');
    rationale.push('Findings or analyzer failures could not be represented by normalized evidence.');
  }
  if (conservativeTier2Route && !reasons.includes('ANALYZER_DISAGREEMENT')) {
    reasons.push('SEMANTIC_RELATION_UNCLEAR');
    rationale.push('Conservative profile escalates every restored Tier 2 candidate for semantic confirmation.');
  }
  if (profile === 'LLM_MINIMAL' && strongEvidenceCount > 0) {
    const suppressed = reasons.filter((reason) => reason === 'WEAK_SIGNAL_COMBINATION' || reason === 'SEMANTIC_RELATION_UNCLEAR');
    for (const reason of suppressed) {
      reasons.splice(reasons.indexOf(reason), 1);
    }
    if (suppressed.length > 0) rationale.push('LLM_MINIMAL accepts corroborated strong evidence without semantic escalation.');
  }

  if (reasons.length === 0) {
    reasons.splice(0, reasons.length, 'HIGH_CONFIDENCE_STATIC');
    rationale.push(explained
      ? 'Strong normalized evidence is sufficient; analyzer namespace differences and soft restore limitations are not escalated.'
      : 'No Tier 2 uncertainty requiring an LLM escalation was observed.');
  }

  return {
    shouldEscalate: reasons.some((reason) => reason !== 'HIGH_CONFIDENCE_STATIC'),
    reasons,
    confidence: reasons.includes('UNKNOWN_PATTERN') || unresolvedRestore ? 'LOW' : reasons.length > 1 ? 'MEDIUM' : 'HIGH',
    tier1FindingCount: tier1Findings.length,
    tier2FindingCount: tier2Findings.length,
    evidenceCount: evidences.length,
    analyzerCount: findingsByAnalyzer.length,
    agreeingAnalyzerCount,
    restoreStatuses,
    rationale,
    profile,
  };
}

function sharedFindingKeyCount(results: readonly AnalyzerResult[]): number {
  if (results.length < 2) return 0;
  const keysByAnalyzer = results.map((result) => new Set(result.findings.flatMap((finding) => [
    `rule:${finding.ruleId}`,
    `type:${finding.type}`,
  ])));
  const first = keysByAnalyzer[0] ?? new Set<string>();
  return [...first].filter((key) => keysByAnalyzer.slice(1).every((keys) => keys.has(key))).length;
}
