import type { AnalyzerResult } from '../domain/analysis.types';
import type { AtomicEvidenceV0_1 } from '../evidence/normalizer/evidence-normalizer.types';
import type { RestoreResult } from '../analyzers/obfuscation/obfuscation.types';
import type { Tier2Handoff } from './artifact/tier2-handoff.contract';

export const TIER3_ESCALATION_REASONS = [
  'HIGH_CONFIDENCE_STATIC',
  'ANALYZER_DISAGREEMENT',
  'PARTIAL_RESTORE',
  'UNRESOLVED_OBFUSCATION',
  'WEAK_SIGNAL_COMBINATION',
  'SEMANTIC_RELATION_UNCLEAR',
  'UNKNOWN_PATTERN',
] as const;

export type Tier3EscalationReason = typeof TIER3_ESCALATION_REASONS[number];

export const TIER3_GATE_PROFILES = ['CONSERVATIVE', 'BALANCED', 'LLM_MINIMAL'] as const;
export type Tier3GateProfile = typeof TIER3_GATE_PROFILES[number];

export interface Tier3EscalationGateInput {
  tier1Results: readonly AnalyzerResult[];
  tier1Evidences: readonly AtomicEvidenceV0_1[];
  tier2Handoff?: Tier2Handoff;
  restore?: RestoreResult;
  profile?: Tier3GateProfile;
}

export interface Tier3EscalationDecision {
  shouldEscalate: boolean;
  reasons: Tier3EscalationReason[];
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  tier1FindingCount: number;
  tier2FindingCount: number;
  evidenceCount: number;
  analyzerCount: number;
  agreeingAnalyzerCount: number;
  restoreStatuses: string[];
  rationale: string[];
  profile: Tier3GateProfile;
}
