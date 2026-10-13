import type { EvidenceCase } from '../case/evidence-case.builder';
import type { PredicateEvaluation } from '../contracts/judgment';

const LIFECYCLE_SIGNALS = new Set(['LIFECYCLE_SCRIPT', 'PREINSTALL_SCRIPT', 'INSTALL_SCRIPT', 'POSTINSTALL_SCRIPT']);
const PROCESS_SIGNALS = new Set(['CHILD_PROCESS', 'SHELL_EXEC', 'DYNAMIC_CODE_EXECUTION']);
const SENSITIVE_SIGNALS = new Set(['SENSITIVE_FILE_READ']);
const CREDENTIAL_SIGNALS = new Set(['CREDENTIAL_READ', 'SECRET_READ']);
const DIRECT_RELATION_BASES = new Set(['DATA_FLOW', 'EXECUTION_LINK', 'TOOL_CORRELATION']);

/**
 * A REJECT rule needs more than a cited generic capability. The existing
 * Evidence contract already carries the signal type, source rule and basis,
 * so the production resolver can apply the same narrow corroboration policy
 * without adding a schema field or a new enum.
 */
export function hasRejectCorroboration(
  evidenceCase: EvidenceCase,
  predicates: readonly PredicateEvaluation[],
): boolean {
  // Only evidence cited by the rule's predicate evaluations may corroborate
  // that rule. Unrelated evidence in the same package must not authorize a
  // REJECT through a different rule.
  const citedEvidenceIds = new Set(predicates.flatMap(({ evidenceIds }) => evidenceIds));
  const observations = evidenceCase.observations.filter((evidence) => citedEvidenceIds.has(evidence.evidenceId));
  if (observations.some((evidence) => typeof evidence.assertion.basis === 'string' && DIRECT_RELATION_BASES.has(evidence.assertion.basis))) return true;

  const signals = new Set(observations.map(({ signal }) => signal.type));
  const lifecycleDownloadExecution = hasAny(signals, LIFECYCLE_SIGNALS)
    && signals.has('REMOTE_FETCH')
    && hasAny(signals, PROCESS_SIGNALS);
  const sensitiveReadNetwork = hasAny(signals, SENSITIVE_SIGNALS) && signals.has('NETWORK_EGRESS');
  const credentialSourceNetwork = hasAny(signals, CREDENTIAL_SIGNALS) && signals.has('NETWORK_EGRESS');
  const threatWithCapability = observations.some(isThreatEvidence)
    && observations.some(isCapabilityEvidence);
  if (lifecycleDownloadExecution || sensitiveReadNetwork || credentialSourceNetwork || threatWithCapability) return true;

  return predicates
    .flatMap(({ assessmentIds }) => assessmentIds)
    .some((assessmentId) => {
      const assessment = evidenceCase.assessments.find((candidate) =>
        candidate.evidenceId === assessmentId || candidate.provenance.assessmentId === assessmentId);
      return assessment !== undefined
        && (assessment.intentAssessment === 'SUSPICIOUS' || assessment.intentAssessment === 'LIKELY_MALICIOUS')
        && assessment.relatedAtomicEvidenceIds.length >= 2;
    });
}

function isThreatEvidence(evidence: EvidenceCase['observations'][number]): boolean {
  return evidence.signal.id?.startsWith('threat.') === true
    || evidence.sources?.some(({ ruleId }) => typeof ruleId === 'string' && ruleId.startsWith('threat-')) === true;
}

function isCapabilityEvidence(evidence: EvidenceCase['observations'][number]): boolean {
  return evidence.signal.id?.startsWith('capability.') === true
    || evidence.sources?.some(({ ruleId }) => typeof ruleId === 'string' && ruleId.startsWith('capability-')) === true;
}

function hasAny(values: ReadonlySet<string>, candidates: ReadonlySet<string>): boolean {
  return [...candidates].some((candidate) => values.has(candidate));
}
