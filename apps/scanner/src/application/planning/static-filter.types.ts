export type StaticFilterStatus =
  | 'STATIC_MALICIOUS'
  | 'STATIC_INCOMPLETE'
  | 'AMBIGUOUS'
  | 'NO_ESCALATION_SIGNAL';

export type StaticFilterRuleId =
  | 'M01' | 'M02' | 'M03' | 'M04' | 'M05' | 'M06' | 'M07' | 'M08'
  | 'A01' | 'A02' | 'A03' | 'A04' | 'A05' | 'A06' | 'A07' | 'A08' | 'A09' | 'A10'
  | 'I01' | 'I02' | 'I03' | 'I04' | 'I05' | 'I06' | 'I07' | 'I08' | 'I09';

export type StaticFilterReasonCode =
  | 'MALICIOUS_RULE_SATISFIED'
  | 'NO_THREAT_FINDING'
  | 'REQUIRED_RULE_HITS_PRESENT'
  | 'BEHAVIOR_LINK_UNVERIFIED'
  | 'PAYLOAD_CONTENT_UNVERIFIED'
  | 'LIFECYCLE_LINK_UNVERIFIED'
  | 'PROPAGATION_LINK_UNVERIFIED'
  | 'OBFUSCATION_UNRESOLVED'
  | 'DUAL_USE_CONTEXT_UNRESOLVED'
  | 'RELATION_CANDIDATE_UNVERIFIED'
  | 'REPRESENTATION_CONFLICT_UNVERIFIABLE'
  | 'UNCLASSIFIED_THREAT_REVIEW_REQUIRED'
  | 'ANALYZER_INCOMPLETE'
  | 'ANALYZER_SCOPE_RELEVANCE_UNKNOWN'
  | 'EVIDENCE_CONTEXT_MISSING'
  | 'NORMALIZATION_GAP'
  | 'RESTORATION_INCOMPLETE'
  | 'RESTORATION_BUDGET_EXCEEDED'
  | 'PROVENANCE_INCOMPLETE'
  | 'SCAN_COVERAGE_UNKNOWN';

export interface StaticFilterFindingRef {
  readonly analyzer: string;
  readonly findingId: string;
}

export interface StaticFilterEvidenceRef {
  readonly evidenceId: string;
}

export type StaticFilterConditionStatus =
  | 'SATISFIED'
  | 'NOT_SATISFIED'
  | 'UNVERIFIED';

export interface StaticFilterConditionDiagnostic {
  readonly condition: string;
  readonly status: StaticFilterConditionStatus;
  readonly detail: string;
}

export interface StaticFilterLinkedDiagnostic {
  readonly required: boolean;
  readonly status: 'NOT_REQUIRED' | 'CONFIRMED' | 'UNVERIFIED';
  readonly basis: readonly string[];
}

export interface StaticFilterRuleDiagnostic {
  readonly ruleId: StaticFilterRuleId;
  readonly category: 'MALICIOUS' | 'AMBIGUOUS' | 'INCOMPLETE';
  readonly outcome: 'SATISFIED' | 'NOT_APPLICABLE' | 'UNVERIFIED';
  readonly conditions: readonly StaticFilterConditionDiagnostic[];
  readonly linked: StaticFilterLinkedDiagnostic;
  readonly findingRefs: readonly StaticFilterFindingRef[];
  readonly evidenceRefs: readonly StaticFilterEvidenceRef[];
  readonly blockingConditions: readonly string[];
}

export interface StaticFilterResult {
  readonly status: StaticFilterStatus;
  readonly ruleVersion: '0.4.0';
  readonly threat: {
    readonly present: boolean;
    readonly findingRefs: readonly StaticFilterFindingRef[];
  };
  /** Rules that produced a finding, ambiguity, or incompleteness signal. */
  readonly appliedRuleIds: readonly StaticFilterRuleId[];
  readonly reasonCodes: readonly StaticFilterReasonCode[];
  readonly findingRefs: readonly StaticFilterFindingRef[];
  readonly evidenceRefs: readonly StaticFilterEvidenceRef[];
  /** Includes all M/A/I rules, including rules that were not applicable. */
  readonly diagnostics: readonly StaticFilterRuleDiagnostic[];
}
