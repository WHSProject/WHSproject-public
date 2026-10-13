import type { PolicyPredicate, PredicateStatus } from './policy';

export interface PredicateEvaluation {
  predicate: PolicyPredicate;
  status: PredicateStatus;
  evidenceIds: string[];
  assessmentIds: string[];
  /** Policy-local feed references. These are never Scanner Evidence IDs. */
  feedEvidenceIds: string[];
  codeRefs: Array<{ file: string; lines: [number, number] }>;
  missing?: string[];
}

export interface RuleEvaluation {
  ruleId: string;
  status: 'SATISFIED' | 'NOT_SATISFIED' | 'UNKNOWN' | 'CONFLICT';
  predicateEvaluations: PredicateEvaluation[];
  counterEvidenceIds: string[];
  rationale: string;
}

export interface PolicyJudgment {
  judgmentId: string;
  policyVersion: string;
  caseStatus: 'COMPLETE' | 'PARTIAL' | 'INCOMPLETE';
  ruleEvaluations: RuleEvaluation[];
  unresolved: PolicyPredicate[];
  conflicts: PolicyPredicate[];
  limitations: string[];
  recommendedOutcome?: 'ACCEPT' | 'REJECT' | 'HOLD' | 'REVIEW';
}
