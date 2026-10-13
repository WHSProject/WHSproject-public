import type { AnalyzerStatus } from '../../domain/analysis.types';
import type {
  RestoreLimitation,
  RestoreReason,
  RestoreStage,
  RestoreStageResult,
  RestoreStatus,
  ValidationSnapshot,
  CapabilityPreservationReport,
} from './obfuscation.types';

export type ObfuscationGptMode = 'off' | 'shadow';

export type FileRestoreStatus =
  Extract<RestoreStatus, 'RESTORED' | 'PARTIAL_RESTORED' | 'UNRESOLVED' | 'FAILED'>;

export type AgentSourceKind = 'ORIGINAL' | 'RESTORED';

export type RestoreValidationSummary = Pick<
  ValidationSnapshot,
  'scoreDelta' | 'identifierDelta' | 'hexIdentifierDelta' | 'addedSignals' | 'removedSignals'
>;

export interface RestoreProvenance {
  status: FileRestoreStatus;
  reason?: RestoreReason;
  limitations: RestoreLimitation[];
  stageResults: RestoreStageResult[];
  appliedStages: RestoreStage[];
  validation?: RestoreValidationSummary;
}

export type GptCandidateReason =
  | 'STRONG_RISK_COMBINATION'
  | 'DYNAMIC_EXEC_REMAINS'
  | 'RESTORED_WITH_NEW_SIGNAL'
  | 'PARTIAL_RESTORED_WITH_RISK'
  | 'UNRESOLVED_OBFUSCATION_WITH_RISK'
  | 'FAILED_WITH_RISK';

export interface FileShadowEvidence {
  evidenceId: string;
  tier: 'TIER_1' | 'TIER_2';
  analyzer: string;
  ruleId: string;
  message: string;
  path: string;
  line: number | null;
}

export interface FileEvidenceBundle {
  path: string;
  restoreStatus: FileRestoreStatus;
  appliedStages: RestoreStage[];
  restoration: RestoreProvenance;
  evidences: FileShadowEvidence[];
  newRuleIds: string[];
  capabilities: string[];
  strongCombinations: string[];
}

export interface CodeSlice {
  file: string;
  startLine: number;
  endLine: number;
  code: string;
}

export interface AgentAnalysisCandidate {
  path: string;
  sourceKind: AgentSourceKind;
  reason: GptCandidateReason;
  supportingReasons: GptCandidateReason[];
  restored: boolean;
  matchedSignals: string[];
  residualCapabilities: string[];
  derivedNewRuleIds: string[];
  restoration: {
    status: FileRestoreStatus;
    reason?: RestoreReason;
    limitations: RestoreLimitation[];
    stageResults: RestoreStageResult[];
    appliedStages: RestoreStage[];
    validation?: RestoreValidationSummary;
  };
  evidences: FileShadowEvidence[];
  slices: CodeSlice[];
}

/** Tier 2 코드 이해 Agent와 Tier 3가 함께 사용할 수 있는 Shadow 핸드오프 계약. */
export interface AgentAnalysisRequestV0_1 {
  schemaVersion: '0.1';
  requestId: string;
  scanId: string;
  sampleId: string;
  purpose: 'DEOBFUSCATION_CODE_UNDERSTANDING';
  package: {
    ecosystem: 'npm';
    name: string;
    version: string;
    artifactHash: string;
    description: string | null;
    lifecycleScripts: Array<{
      name: 'preinstall' | 'install' | 'postinstall';
      command: string;
    }>;
  };
  candidates: AgentAnalysisCandidate[];
}

export interface GptFileAnalysis {
  path: string;
  behaviors: Array<{
    capability: string;
    explanation: string;
    evidenceRefs: string[];
  }>;
  dataFlows: Array<{
    source: string;
    sink: string;
    reachable: 'TOP_LEVEL' | 'LIFECYCLE' | 'EXPORTED_ONLY' | 'DEFINED_NOT_CALLED' | 'UNKNOWN';
    explanation: string;
    evidenceRefs: string[];
  }>;
  renames: Record<string, string>;
  renameEvidenceRefs: Record<string, string[]>;
  confidence: number;
  limitations: string[];
}

export interface GptAnalysisResponse {
  files: GptFileAnalysis[];
}

export interface GptShadowOutcome {
  status: 'NOT_REQUESTED' | 'NO_CANDIDATE' | 'COMPLETED' | 'FAILED' | 'REJECTED';
  requestHash?: string;
  cacheStatus?: 'HIT' | 'MISS' | 'COALESCED' | 'BYPASS';
  provider?: 'gpt' | 'gemini';
  model?: string;
  durationMs: number;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens?: number;
  };
  analysis?: GptAnalysisResponse;
  promptVersion?: string;
  reason?: string;
}

/**
 * Tier 2 코드 이해 보조의 공용 계약. OpenAI(GPT)·Gemini 구현이 모두 이 인터페이스를 만족한다.
 * ObfuscationAnalyzer 는 provider 를 구분하지 않고 이 타입으로만 주입받는다.
 */
export interface CodeUnderstandingAssistant {
  analyze(
    request: AgentAnalysisRequestV0_1,
    signal?: AbortSignal,
  ): Promise<GptShadowOutcome>;
}

export interface ObfuscationShadowData {
  gptMode: ObfuscationGptMode;
  scannedFiles: number;
  selectedFiles: number;
  restoredFiles: number;
  partialRestoredFiles: number;
  unresolvedFiles: number;
  newRuleIds: string[];
  derivedAnalyzerStatuses: Array<{
    analyzer: string;
    status: AnalyzerStatus;
    findingCount: number;
  }>;
  evidenceBundles: FileEvidenceBundle[];
  capabilityPreservation?: CapabilityPreservationReport;
  agentAnalysisRequest?: AgentAnalysisRequestV0_1;
  gpt: GptShadowOutcome;
}
