import type { EvidenceCase } from '../case/evidence-case.builder';
import type { PolicyJudgment, PredicateEvaluation } from '../contracts/judgment';
import type { PolicyPredicate, PolicyRule, PolicySnapshot, PredicateStatus } from '../contracts/policy';
import { hasRejectCorroboration } from '../decision/evidence-corroboration';

function evaluationsFor(judgment: PolicyJudgment, ruleId: string, predicate: PolicyPredicate): PredicateEvaluation[] {
  return judgment.ruleEvaluations.find((rule) => rule.ruleId === ruleId)?.predicateEvaluations.filter((evaluation) => evaluation.predicate === predicate) ?? [];
}

function statusFor(judgment: PolicyJudgment, ruleId: string, predicate: PolicyPredicate): PredicateStatus {
  if (judgment.conflicts.includes(predicate)) return 'CONFLICT';
  if (judgment.unresolved.includes(predicate)) return 'UNKNOWN';
  const evaluations = evaluationsFor(judgment, ruleId, predicate);
  if (evaluations.some((evaluation) => evaluation.status === 'CONFLICT')) return 'CONFLICT';
  if (evaluations.some((evaluation) => evaluation.status === 'SUPPORTED')) return 'SUPPORTED';
  if (evaluations.some((evaluation) => evaluation.status === 'UNKNOWN')) return 'UNKNOWN';
  return 'NOT_SUPPORTED';
}

function evaluateRule(rule: PolicyRule, judgment: PolicyJudgment, evidenceCase: EvidenceCase): { matched: boolean; uncertain: boolean; conflict: boolean; predicates: PredicateEvaluation[] } {
  const predicates = [...(rule.when.allOf ?? []), ...(rule.when.anyOf ?? [])].map(({ predicate }) => {
    const evaluation = evaluationsFor(judgment, rule.ruleId, predicate)[0];
    return evaluation
      ? { ...evaluation, evidenceIds: [...evaluation.evidenceIds], assessmentIds: [...evaluation.assessmentIds], feedEvidenceIds: [...evaluation.feedEvidenceIds], codeRefs: [...evaluation.codeRefs] }
      : { predicate, status: statusFor(judgment, rule.ruleId, predicate), evidenceIds: [], assessmentIds: [], feedEvidenceIds: [], codeRefs: [] };
  });
  const conflict = predicates.some((item) => item.status === 'CONFLICT');
  const coverageLevel = evidenceCase.coverage.status === 'COMPLETE' ? 2 : evidenceCase.coverage.status === 'PARTIAL' ? 1 : 0;
  const requiredCoverage = rule.minimumSupport === 'SUPPORTED' ? 2 : 1;
  const allStatuses = (rule.when.allOf ?? []).map(({ predicate }) => statusFor(judgment, rule.ruleId, predicate));
  const anyStatuses = (rule.when.anyOf ?? []).map(({ predicate }) => statusFor(judgment, rule.ruleId, predicate));
  const allSatisfied = allStatuses.every((status) => status === 'SUPPORTED');
  const anySatisfied = anyStatuses.length === 0 || anyStatuses.some((status) => status === 'SUPPORTED');
  const allUnknown = allStatuses.length > 0 && allStatuses.some((status) => status === 'UNKNOWN');
  const anyUnknown = anyStatuses.length > 0 && !anyStatuses.some((status) => status === 'SUPPORTED' || status === 'CONFLICT') && anyStatuses.some((status) => status === 'UNKNOWN');
  const unknown = allUnknown || anyUnknown || coverageLevel < requiredCoverage;
  const rejectCorroborated = rule.effect !== 'REJECT' || hasRejectCorroboration(evidenceCase, predicates);
  return { matched: allSatisfied && anySatisfied && rejectCorroborated, uncertain: unknown, conflict, predicates };
}

export interface RuleResolution {
  ruleId: string;
  effect: PolicyRule['effect'];
  reasonCode: string;
  matched: boolean;
  uncertain: boolean;
  conflict: boolean;
  onUnknown: PolicyRule['onUnknown'];
  minimumSupport: PolicyRule['minimumSupport'];
  predicates: PredicateEvaluation[];
  evidenceIds: string[];
  assessmentIds: string[];
  feedEvidenceIds: string[];
}

export function resolveRules(policy: PolicySnapshot, judgment: PolicyJudgment, evidenceCase: EvidenceCase): RuleResolution[] {
  return [...policy.rules].sort((a, b) => b.priority - a.priority).map((rule) => {
    const evaluation = evaluateRule(rule, judgment, evidenceCase);
    const rejectablePredicates = [...(rule.when.allOf ?? []), ...(rule.when.anyOf ?? [])].every(({ predicate }) => policy.predicateCatalog?.find((definition) => definition.code === predicate)?.rejectAllowed ?? predicate !== 'OSV_ADVISORY_APPLIES');
    // A REJECT rule cannot be satisfied by feed-only predicates. The restriction is
    // declared by the Policy DB predicate registry rather than a fixed code list.
    const independentRejectSupport = rule.effect !== 'REJECT' || rejectablePredicates;
    const evidenceIds = [...new Set(evaluation.predicates.flatMap((predicate) => predicate.evidenceIds))].sort();
    const assessmentIds = [...new Set(evaluation.predicates.flatMap((predicate) => predicate.assessmentIds))].sort();
    const feedEvidenceIds = [...new Set(evaluation.predicates.flatMap((predicate) => predicate.feedEvidenceIds))].sort();
    return { ruleId: rule.ruleId, effect: rule.effect, reasonCode: rule.reasonCode, matched: evaluation.matched && !evaluation.uncertain && !evaluation.conflict && independentRejectSupport, uncertain: evaluation.uncertain && rule.onUnknown !== 'IGNORE', conflict: evaluation.conflict, onUnknown: rule.onUnknown, minimumSupport: rule.minimumSupport, predicates: evaluation.predicates, evidenceIds, assessmentIds, feedEvidenceIds };
  });
}
