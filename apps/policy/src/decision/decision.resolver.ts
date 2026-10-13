import type { EvidenceCase } from '../case/evidence-case.builder';
import type { Decision } from '../contracts/evidence';
import type { PolicyJudgment } from '../contracts/judgment';
import type { PolicySnapshot } from '../contracts/policy';
import { resolveRules } from '../policy/policy-rule.resolver';

export interface ResolvedDecision {
  decision: Decision;
  reasonCode: string;
  reason: string;
  matchedRuleIds: string[];
  evidenceIds: string[];
  assessmentIds: string[];
  feedEvidenceIds: string[];
  judgmentId: string;
  policyVersion: string;
  policyHash?: string;
}

export function resolveDecision(policy: PolicySnapshot, judgment: PolicyJudgment, evidenceCase: EvidenceCase): ResolvedDecision {
  const resolutions = resolveRules(policy, judgment, evidenceCase);
  const reject = resolutions.find((item) => item.matched && item.effect === 'REJECT');
  if (reject) return result('REJECT', reject.reasonCode, matchedRuleReason(policy, reject.ruleId), [reject.ruleId], policy, judgment, resolutions);
  if (judgment.conflicts.length > 0 || resolutions.some((item) => item.conflict)) return result('REVIEW', 'POLICY_EVIDENCE_CONFLICT', 'Evidence conflicts prevent a deterministic policy decision.', resolutions.filter((item) => item.conflict).map((item) => item.ruleId), policy, judgment, resolutions);
  const coverageBlocked = evidenceCase.coverage.status !== 'COMPLETE'
    && !resolutions.some((item) => item.matched && item.minimumSupport === 'PARTIAL');
  if (judgment.unresolved.length > 0 || resolutions.some((item) => item.uncertain) || coverageBlocked) {
    const unknownDecision = resolutions.some((item) => item.uncertain && item.onUnknown === 'REVIEW') ? 'REVIEW' : 'HOLD';
    return result(unknownDecision, unknownDecision === 'REVIEW' ? 'POLICY_DECISIVE_EVIDENCE_REVIEW' : 'POLICY_DECISIVE_EVIDENCE_UNKNOWN', 'A decisive policy condition is unresolved or coverage is incomplete.', resolutions.filter((item) => item.uncertain).map((item) => item.ruleId), policy, judgment, resolutions);
  }
  const matched = resolutions.filter((item) => item.matched);
  const selected = matched[0];
  return result(selected?.effect ?? policy.defaultDecision, selected?.reasonCode ?? 'POLICY_DEFAULT', selected ? matchedRuleReason(policy, selected.ruleId) : 'No policy rule matched; default policy decision applied.', matched.map((item) => item.ruleId), policy, judgment, resolutions);
}

function matchedRuleReason(policy: PolicySnapshot, ruleId: string): string {
  return policy.rules.find((rule) => rule.ruleId === ruleId)?.name?.trim() || `Policy rule ${ruleId} matched.`;
}

function result(decision: Decision, reasonCode: string, reason: string, matchedRuleIds: string[], policy: PolicySnapshot, judgment: PolicyJudgment, resolutions: ReturnType<typeof resolveRules>): ResolvedDecision {
  const selected = resolutions.filter((resolution) => matchedRuleIds.includes(resolution.ruleId));
  return {
    decision,
    reasonCode,
    reason,
    matchedRuleIds,
    // Keep decisive Rule order (priority order, with REJECT handled first) and its predicate order.
    // Dashboard uses the first Evidence IDs as representative support for the decision.
    evidenceIds: [...new Set(selected.flatMap((resolution) => resolution.evidenceIds))],
    assessmentIds: [...new Set(selected.flatMap((resolution) => resolution.assessmentIds))].sort(),
    feedEvidenceIds: [...new Set(selected.flatMap((resolution) => resolution.feedEvidenceIds))].sort(),
    judgmentId: judgment.judgmentId,
    policyVersion: policy.policyVersion,
    policyHash: policy.policyHash,
  };
}
