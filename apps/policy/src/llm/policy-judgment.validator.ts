import type { EvidenceCase } from '../case/evidence-case.builder';
import type { PolicyJudgment, PredicateEvaluation, RuleEvaluation } from '../contracts/judgment';
import type { PolicyRule, PolicySnapshot } from '../contracts/policy';

const statuses = new Set(['SUPPORTED', 'NOT_SUPPORTED', 'UNKNOWN', 'CONFLICT']);
const ruleStatuses = new Set(['SATISFIED', 'NOT_SATISFIED', 'UNKNOWN', 'CONFLICT']);

export class PolicyJudgmentValidationError extends Error {
  constructor(message: string) { super(message); }
}

export function validatePolicyJudgment(value: unknown, policy: PolicySnapshot, evidenceCase: EvidenceCase): PolicyJudgment {
  return validate(value, policy, evidenceCase, false);
}

export function validatePolicyJudgmentWithComputedRuleStatus(value: unknown, policy: PolicySnapshot, evidenceCase: EvidenceCase): PolicyJudgment {
  return validate(value, policy, evidenceCase, true);
}

function validate(value: unknown, policy: PolicySnapshot, evidenceCase: EvidenceCase, computeRuleStatus: boolean): PolicyJudgment {
  try {
    return validatePolicyJudgmentInternal(value, policy, evidenceCase, computeRuleStatus);
  } catch (error) {
    if (error instanceof PolicyJudgmentValidationError) throw error;
    throw new PolicyJudgmentValidationError(error instanceof Error ? error.message : 'INVALID_POLICY_JUDGMENT');
  }
}

function validatePolicyJudgmentInternal(value: unknown, policy: PolicySnapshot, evidenceCase: EvidenceCase, computeRuleStatus: boolean): PolicyJudgment {
  if (!value || typeof value !== 'object') throw new Error('INVALID_POLICY_JUDGMENT');
  let result = value as Partial<PolicyJudgment>;
  if (result.policyVersion !== policy.policyVersion || typeof result.judgmentId !== 'string' || !['COMPLETE', 'PARTIAL', 'INCOMPLETE'].includes(result.caseStatus ?? '') || !Array.isArray(result.ruleEvaluations) || !Array.isArray(result.unresolved) || !Array.isArray(result.conflicts) || !Array.isArray(result.limitations)) throw new Error('INVALID_POLICY_JUDGMENT_HEADER');
  const incomingRules = result.ruleEvaluations;
  if (computeRuleStatus) result = { ...result, ruleEvaluations: incomingRules.map((item) => item && typeof item === 'object' ? { ...item } : item) };
  const ruleEvaluations = result.ruleEvaluations!;
  const ruleIds = new Set(policy.rules.map((rule) => rule.ruleId));
  const catalogCodes = policy.predicateCatalog ? new Set(policy.predicateCatalog.map((predicate) => predicate.code)) : undefined;
  if (catalogCodes && [...(result.unresolved ?? []), ...(result.conflicts ?? [])].some((predicate) => !catalogCodes.has(predicate))) throw new Error('INVALID_POLICY_PREDICATE_CATALOG_REF');
  if (ruleEvaluations.length !== ruleIds.size || new Set(ruleEvaluations.map((item) => item?.ruleId)).size !== ruleIds.size) throw new Error('INVALID_POLICY_RULE_COVERAGE');
  for (const ruleEvaluation of ruleEvaluations) {
    if (!ruleEvaluation || typeof ruleEvaluation !== 'object' || !ruleIds.has(ruleEvaluation.ruleId) || !ruleStatuses.has(ruleEvaluation.status) || !Array.isArray(ruleEvaluation.predicateEvaluations) || !Array.isArray(ruleEvaluation.counterEvidenceIds) || typeof ruleEvaluation.rationale !== 'string') throw new Error('INVALID_POLICY_RULE_EVALUATION');
    const rule = policy.rules.find((candidate) => candidate.ruleId === ruleEvaluation.ruleId);
    const declaredPredicates = new Set([
      ...(rule?.when.allOf ?? []),
      ...(rule?.when.anyOf ?? []),
    ].map((condition) => condition.predicate));
    for (const evidenceId of ruleEvaluation.counterEvidenceIds) {
      if (typeof evidenceId !== 'string' || !evidenceCase.evidenceIds.has(evidenceId)) throw new Error(`UNKNOWN_COUNTER_EVIDENCE_REF:${String(evidenceId)}`);
    }
    for (const predicate of ruleEvaluation.predicateEvaluations) {
      if (!predicate || typeof predicate !== 'object' || !declaredPredicates.has(predicate.predicate) || !statuses.has(predicate.status) || !Array.isArray(predicate.evidenceIds) || !Array.isArray(predicate.assessmentIds) || !Array.isArray(predicate.feedEvidenceIds)) throw new Error('INVALID_POLICY_PREDICATE_EVALUATION');
      for (const evidenceId of predicate.evidenceIds) {
        if (!evidenceCase.evidenceIds.has(evidenceId)) throw new Error(`UNKNOWN_EVIDENCE_REF:${evidenceId}`);
        const evidence = evidenceCase.request.evidences.find((candidate) => candidate.evidenceId === evidenceId);
        if (evidence?.kind === 'LLM_ASSESSMENT') throw new Error(`LLM_ASSESSMENT_MUST_USE_ASSESSMENT_ID:${evidenceId}`);
      }
      for (const assessmentId of predicate.assessmentIds) {
        const assessment = evidenceCase.assessments.find((candidate) => candidate.evidenceId === assessmentId || candidate.provenance.assessmentId === assessmentId);
        if (!assessment) throw new Error(`UNKNOWN_ASSESSMENT_REF:${assessmentId}`);
        if (assessment.verificationStatus !== 'VERIFIED') throw new Error(`UNVERIFIED_ASSESSMENT_REF:${assessmentId}`);
      }
      for (const feedEvidenceId of predicate.feedEvidenceIds) {
        if (!evidenceCase.feedEvidenceIds.has(feedEvidenceId)) throw new Error(`UNKNOWN_FEED_EVIDENCE_REF:${feedEvidenceId}`);
        if (predicate.predicate !== 'OSV_ADVISORY_APPLIES' || !requiresFeedEvidence(policy, predicate.predicate)) throw new Error(`FEED_EVIDENCE_NOT_RELEVANT:${predicate.predicate}`);
      }
      if (predicate.predicate === 'OSV_ADVISORY_APPLIES' && (predicate.evidenceIds.length > 0 || predicate.assessmentIds.length > 0)) throw new Error(`OSV_SUPPORT_REQUIRES_FEED_EVIDENCE:${predicate.predicate}`);
      if (requiresFeedEvidence(policy, predicate.predicate) && predicate.status === 'SUPPORTED' && predicate.feedEvidenceIds.length === 0) throw new Error(`FEED_SUPPORT_REQUIRES_FEED_EVIDENCE:${predicate.predicate}`);
      if (predicate.status === 'SUPPORTED' && predicate.evidenceIds.length === 0 && predicate.assessmentIds.length === 0 && predicate.feedEvidenceIds.length === 0) throw new Error(`SUPPORTED_REQUIRES_CITATION:${predicate.predicate}`);
      if (predicate.status === 'NOT_SUPPORTED' && (predicate.evidenceIds.length > 0 || predicate.assessmentIds.length > 0 || predicate.feedEvidenceIds.length > 0)) throw new Error(`NOT_SUPPORTED_CANNOT_CITE_POSITIVE_EVIDENCE:${predicate.predicate}`);
      for (const codeRef of predicate.codeRefs ?? []) {
        if (!codeRef || typeof codeRef !== 'object' || typeof codeRef.file !== 'string' || !codeRef.file.trim() || !Array.isArray(codeRef.lines) || codeRef.lines.length !== 2 || !codeRef.lines.every((line) => Number.isInteger(line) && line > 0)) throw new Error(`INVALID_CODE_REF:${predicate.predicate}`);
      }
    }
    if (ruleEvaluation.predicateEvaluations.length !== declaredPredicates.size || new Set(ruleEvaluation.predicateEvaluations.map((item) => item.predicate)).size !== declaredPredicates.size) throw new Error('INVALID_POLICY_PREDICATE_COVERAGE');
    const evaluations = ruleEvaluation.predicateEvaluations;
    const allOf = rule?.when.allOf ?? [];
    const anyOf = rule?.when.anyOf ?? [];
    const byPredicate = new Map(evaluations.map((evaluation) => [evaluation.predicate, evaluation.status]));
    const allSatisfied = allOf.every(({ predicate }) => byPredicate.get(predicate) === 'SUPPORTED');
    const anySatisfied = anyOf.length === 0 || anyOf.some(({ predicate }) => byPredicate.get(predicate) === 'SUPPORTED');
    const expectedStatus = calculateRuleStatus(rule!, evaluations);
    if (ruleEvaluation.status !== expectedStatus) {
      if (!computeRuleStatus) throw new Error(`INVALID_POLICY_RULE_STATUS:${ruleEvaluation.ruleId}`);
      ruleEvaluation.status = expectedStatus;
    }
    if (ruleEvaluation.status === 'SATISFIED' && (!allSatisfied || !anySatisfied)) throw new Error(`RULE_SATISFIED_WITHOUT_SUPPORTED_PREDICATES:${ruleEvaluation.ruleId}`);
    if (ruleEvaluation.status === 'CONFLICT' && !evaluations.some((evaluation) => evaluation.status === 'CONFLICT')) throw new Error(`RULE_CONFLICT_WITHOUT_CONFLICTING_PREDICATE:${ruleEvaluation.ruleId}`);
    if (rule?.effect === 'REJECT' && ![...allOf, ...anyOf].some(({ predicate }) => !rejectAllowed(policy, predicate)) && ruleEvaluation.status === 'SATISFIED' && !evaluations.some((evaluation) => evaluation.evidenceIds.length > 0)) throw new Error(`REJECT_REQUIRES_ATOMIC_OR_CORRELATED_EVIDENCE:${ruleEvaluation.ruleId}`);
  }
  return result as PolicyJudgment;
}

export function calculateRuleStatus(rule: PolicyRule, evaluations: PredicateEvaluation[]): RuleEvaluation['status'] {
  const byPredicate = new Map(evaluations.map((evaluation) => [evaluation.predicate, evaluation.status]));
  const allOf = rule.when.allOf ?? [];
  const anyOf = rule.when.anyOf ?? [];
  const allSatisfied = allOf.every(({ predicate }) => byPredicate.get(predicate) === 'SUPPORTED');
  const anySatisfied = anyOf.length === 0 || anyOf.some(({ predicate }) => byPredicate.get(predicate) === 'SUPPORTED');
  const hasConflict = evaluations.some((evaluation) => evaluation.status === 'CONFLICT');
  const hasUnknown = allOf.some(({ predicate }) => byPredicate.get(predicate) === 'UNKNOWN')
    || (anyOf.length > 0 && !anySatisfied && anyOf.some(({ predicate }) => byPredicate.get(predicate) === 'UNKNOWN'));
  return hasConflict ? 'CONFLICT' : allSatisfied && anySatisfied ? 'SATISFIED' : hasUnknown ? 'UNKNOWN' : 'NOT_SATISFIED';
}

function requiresFeedEvidence(policy: PolicySnapshot, predicate: string): boolean {
  return policy.predicateCatalog?.find((definition) => definition.code === predicate)?.requiresFeedEvidence ?? predicate === 'OSV_ADVISORY_APPLIES';
}

function rejectAllowed(policy: PolicySnapshot, predicate: string): boolean {
  return policy.predicateCatalog?.find((definition) => definition.code === predicate)?.rejectAllowed ?? predicate !== 'OSV_ADVISORY_APPLIES';
}
