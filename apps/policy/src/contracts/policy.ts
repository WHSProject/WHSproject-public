import type { Decision } from './evidence';

export type PredicateStatus = 'SUPPORTED' | 'NOT_SUPPORTED' | 'UNKNOWN' | 'CONFLICT';
export type SupportLevel = 'SUPPORTED' | 'PARTIAL';

/** Predicate codes are registered by Policy DB and may be extended without a TS deploy. */
export type PolicyPredicate = string;

export interface PolicyPredicateDefinition {
  code: PolicyPredicate;
  description: string;
  category?: string;
  requiresFeedEvidence?: boolean;
  rejectAllowed?: boolean;
}

export interface PolicyPredicateCondition {
  predicate: PolicyPredicate;
}

export interface PolicyRule {
  ruleId: string;
  name?: string;
  priority: number;
  effect: Decision;
  when: { allOf?: PolicyPredicateCondition[]; anyOf?: PolicyPredicateCondition[] };
  minimumSupport: SupportLevel;
  onUnknown: 'HOLD' | 'REVIEW' | 'IGNORE';
  reasonCode: string;
}

export interface PolicySnapshot {
  policyKey: string;
  policyVersion: string;
  ecosystem: 'npm';
  defaultDecision: Decision;
  judgmentFailureDecision: 'HOLD' | 'REVIEW';
  rules: PolicyRule[];
  /** Supplied by Policy DB. Optional only for unit-test snapshots created in code. */
  predicateCatalog?: PolicyPredicateDefinition[];
  policyHash?: string;
}
