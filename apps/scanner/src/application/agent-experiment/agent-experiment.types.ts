import type { AgentFindingV0_3 } from '../agent-input/agent-finding-projection';
import type { AtomicEvidenceV0_1 } from '../../evidence/normalizer/evidence-normalizer.types';
import type { AgentAnalysisOutput, AgentUsage, ValidatedAgentAnalysisResult } from '../../llm-agent/output.contract';

export const AGENT_EXPERIMENT_REQUEST_CONTRACT = 'agent-analysis-request/0.3' as const;
export const SCANNER_ARTIFACT_INPUT_CONTRACT = 'scanner-artifact-analysis-input/0.3' as const;
export const AGENT_EXPERIMENT_RESULT_VERSION = '1.1.0' as const;
export const AGENT_EXPERIMENT_MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;
export const AGENT_EXPERIMENT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

export type AgentExperimentInputProfile = 'CODE_ONLY' | 'CODE_FINDING' | 'CODE_FINDING_EVIDENCE';

export interface AgentExperimentLocation {
  file: string;
  startLine: number | null;
  endLine: number | null;
}

export interface AgentExperimentCodeSlice {
  sliceId: string;
  file: string;
  startLine: number;
  endLine: number;
  content: string;
  contentSha256: string;
  sourceSha256: string;
  contentRedacted: boolean;
  redactionTypes: string[];
  boundaryConfidence: 'HIGH' | 'MEDIUM' | 'LOW';
  selectionReason: string;
  relatedFindingIds: string[];
}

export interface AgentExperimentRequestV0_3 {
  request: {
    analysisRequestId: string;
    requestType: 'MALICIOUS_CODE_ANALYSIS';
    inputProfile: AgentExperimentInputProfile;
    schemaVersion: '0.3.0';
    sampleId: string;
    createdAt: string | null;
  };
  subject: { ecosystem: 'npm'; packageName: string; packageVersion: string; archiveSha256: string };
  packageContext: {
    source: 'TARBALL_PACKAGE_MANIFEST_PROJECTION';
    description: string | null;
    main: string | null;
    exports: unknown;
    scripts: Record<string, unknown>;
    dependencies: Record<string, unknown>;
    entryPoints: Array<{ type: 'MAIN' | 'BIN' | 'EXPORTS'; value: unknown; location: AgentExperimentLocation }>;
    lifecycleScripts: Array<{ name: 'preinstall' | 'install' | 'postinstall'; command: string; location: AgentExperimentLocation }>;
  };
  findings: AgentFindingV0_3[];
  atomicEvidences: Array<AtomicEvidenceV0_1 & { sourceType?: unknown }>;
  analysisPolicy: { maxToolCalls?: number; maxAdditionalCodeRequests?: number; maxTotalCodeLines?: number };
  initialCodeSlices: AgentExperimentCodeSlice[];
  analysisTargets: Array<'ENV_OR_SENSITIVE_FILE_TO_NETWORK' | 'NETWORK_DOWNLOAD_TO_FILE_WRITE_TO_PROCESS_EXECUTION' | 'LIFECYCLE_TO_PROCESS_EXECUTION'>;
  toolResponseCatalog: Array<{ tool: string; status: 'AVAILABLE' | 'UNAVAILABLE'; indexPath?: string; reason?: string }>;
  missingData: Array<{ field: string; reason: string }>;
}

export interface AgentExperimentProviderResult {
  provider: 'openai';
  model: string | null;
  responseId: string | null;
  durationMs: number | null;
  totalDurationMs: number | null;
  usage: AgentUsage | null;
}

export interface AgentExperimentResultEnvelope {
  contractVersion: typeof AGENT_EXPERIMENT_RESULT_VERSION;
  executionMode: 'DRY_RUN' | 'LIVE';
  request: {
    schemaVersion: '0.3.0';
    sampleId: string;
    inputProfile: AgentExperimentInputProfile;
    payloadSha256: string;
    promptSha256: string;
  };
  provider: AgentExperimentProviderResult;
  reasoning: { requestedEffort: 'medium'; configurationSource: 'AGENT_EXPERIMENT_EXPLICIT' };
  status: 'VALIDATED' | 'COMPLETED' | 'FAILED' | 'TIMEOUT';
  responseValidation: 'PASS' | 'FAIL';
  analysisOutcome: 'COMPLETED' | 'NEEDS_ADDITIONAL_CODE' | 'UNAVAILABLE';
  toolDisposition: 'NOT_APPLICABLE' | 'NOT_EXECUTED_BY_EXPERIMENT_POLICY' | 'UNAVAILABLE';
  additionalModelRounds: 0;
  outcomeDetailCode: 'ADDITIONAL_CODE_REQUESTED_TOOL_DISABLED' | null;
  rawModelOutput: string | null;
  validatedResult: ValidatedAgentAnalysisResult | AgentAnalysisOutput | null;
  validationFailures: string[];
  error: { code: string; message: string; provider?: {
    httpStatus: number; requestId: string | null;
    error: { type: string | null; code: string | null; param: string | null; message: string };
    errorFingerprint: string; bodyTruncated: boolean;
  } } | null;
}

export interface AgentExperimentExecutionOptions {
  live: boolean;
  timeoutMs: number;
  maxRetries: 0;
  model: string;
  reasoningEffort: 'medium';
}

export type CompletedAgentExperimentOutput = Extract<AgentAnalysisOutput, { status: 'COMPLETED' }>;
