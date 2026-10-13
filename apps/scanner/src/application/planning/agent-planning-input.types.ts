import type {
  AnalyzerExecution,
  AnalyzerStatus,
  Finding,
  ScanError,
} from '../../domain/analysis.types';
import type { NormalizationResult } from '../../evidence/normalizer/evidence-normalizer.types';
import type {
  GuardDogRawRisk,
  GuardDogToolAssessment,
} from '../../analyzers/guarddog/guarddog.types';
import type { CustomRuleRelationCandidate } from '../../analyzers/custom-rule/custom-rule.analyzer';
import type { RestoreResult } from '../../analyzers/obfuscation/obfuscation.types';

export interface AgentPlanningSubject {
  readonly requestId: string;
  readonly scanId: string;
  readonly ecosystem: 'npm';
  readonly packageName: string;
  readonly packageVersion: string;
  readonly artifactHash: string;
}

export interface AgentPlanningAnalyzerSnapshot {
  readonly analyzer: string;
  readonly analyzerVersion: string;
  readonly status: AnalyzerStatus;
  readonly findings: readonly Finding[];
  readonly errors: readonly ScanError[];
  readonly execution?: AnalyzerExecution;
  readonly rawResultRef?: string;
  readonly guarddog?: {
    readonly risks: readonly GuardDogRawRisk[];
    readonly toolAssessment?: GuardDogToolAssessment;
  };
  readonly customRule?: {
    /**
     * Candidate references are preserved verbatim. In particular, derived Finding IDs
     * are not repaired here and candidates are not promoted to linked Evidence.
     */
    readonly relationCandidates: readonly CustomRuleRelationCandidate[];
  };
}

export interface AgentPlanningTier2Selection {
  /**
   * JS-family files collected during traversal. This is neither the number of
   * successfully analyzed files nor the complete eligible-file population.
   */
  readonly scannedFiles: number;
  /** Files selected as restore targets. */
  readonly selectedFiles: number;
}

export interface AgentPlanningInputV0_1 {
  readonly schemaVersion: '0.1.0';
  readonly subject: AgentPlanningSubject;
  readonly tier1: {
    readonly analyzers: readonly AgentPlanningAnalyzerSnapshot[];
  };
  readonly tier2: {
    readonly analyzer: AgentPlanningAnalyzerSnapshot;
    readonly derivedAnalyzers: readonly AgentPlanningAnalyzerSnapshot[];
    /** Internal paths remain valid only for the existing artifact lifetime. */
    readonly restore?: RestoreResult;
    /**
     * Absent for the safe fallback. These counts do not prove analysis coverage;
     * target exclusions and scan-limit details are not retained by the current
     * ObfuscationShadowResult contract.
     */
    readonly selection?: AgentPlanningTier2Selection;
  };
  readonly normalization: NormalizationResult;
}
