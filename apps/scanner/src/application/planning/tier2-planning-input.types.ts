import type { Finding } from '../../domain/analysis.types';
import type {
  RestoreLimitation,
  RestoreReason,
  RestoreStage,
  RestoreStageResult,
  RestoreStatus,
  ValidationSnapshot,
} from '../../analyzers/obfuscation/obfuscation.types';

/**
 * Internal Tier 2 facts for a future Planning Assistant.
 *
 * This is deliberately not a public Evidence contract and does not describe
 * a planner decision or an AgentAnalysisRequest.
 */
export interface Tier2PlanningInput {
  kind: 'TIER2_RESTORE_PROJECTION';
  requestId: string;
  scanId: string;
  artifactHash: string;
  restoreFiles: Tier2RestoreFileInput[];
  evidenceCandidates: Tier2PlanningCandidate[];
}

export interface Tier2RestoreFileInput {
  originalLogicalPath: string;
  status: RestoreStatus;
  derivedFiles: Tier2DerivedFileInput[];
  reason?: RestoreReason;
  limitations: RestoreLimitation[];
  appliedStages: RestoreStage[];
  stageResults: RestoreStageResult[];
  validation?: ValidationSnapshot;
}

export interface Tier2DerivedFileInput {
  logicalPath: string;
  outputRef: string;
}

export interface Tier2PlanningSourceLocation {
  originalLogicalPath: string;
  derivedLogicalPath: string;
  derivedOutputRef: string;
}

export interface Tier2DerivedSignalFact {
  ruleId: string;
  signalId: string;
  signalType: string;
  mappingStatus: 'EXACT' | 'PARTIAL';
}

export interface Tier2PlanningCandidate {
  candidateId: string;
  analyzer: string;
  analyzerVersion: string;
  ruleId: string;
  rawFindingId: string;
  finding: Finding;
  sourceLocations: Tier2PlanningSourceLocation[];
  restoreStatus: Extract<RestoreStatus, 'RESTORED' | 'PARTIAL_RESTORED'>;
  validations: Array<{
    originalLogicalPath: string;
    snapshot: ValidationSnapshot;
  }>;
  derivedNewRuleIds: string[];
  derivedSignalFacts: Tier2DerivedSignalFact[];
}
