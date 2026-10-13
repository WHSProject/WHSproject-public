import type { AtomicEvidenceV0_1 } from '../../evidence/normalizer/evidence-normalizer.types';
import type { CapabilityPreservationReport, CapabilityPreservationFile, CapabilityValidation, CapabilityComparison, CapabilityObservation } from '../../analyzers/obfuscation/obfuscation.types';
import type { AgentAnalysisTarget } from '../agent.contract';
import type {
  AgentAnalysisMode,
  AgentCodeSlice,
  ArtifactDescriptor,
  ArtifactResolver,
  ValidatedAgentAnalysisPlan,
  ValidatedPlanningTarget,
} from './artifact.contract';

/**
 * Tier 3 Agent input 0.3.0 (issue #341). Field names and meaning mirror
 * `packages/contracts/agent-analysis-request-v0.3.schema.json`, which is the
 * Source of Truth. The 0.2.0 `AgentAnalysisRequest` in `../agent.contract`
 * remains available for the legacy non-Tier-2 Agent path.
 */

export const AGENT_INPUT_SCHEMA_VERSION_V0_3 = '0.3.0' as const;

/** Reuses the Tier 2 code-understanding capability vocabulary. */
export const FOCUS_BEHAVIORS = [
  'PROCESS_EXECUTION',
  'NETWORK_EGRESS',
  'FILE_READ',
  'FILE_WRITE',
  'ENVIRONMENT_ACCESS',
  'CREDENTIAL_ACCESS',
  'SYSTEM_INFO',
  'DYNAMIC_EXECUTION',
  'REMOTE_DOWNLOAD',
] as const;
export type FocusBehavior = (typeof FOCUS_BEHAVIORS)[number];

/** Reuses the existing Tier 3 analysis targets. */
export const ANALYSIS_TARGETS: readonly AgentAnalysisTarget[] = [
  'ENV_OR_SENSITIVE_FILE_TO_NETWORK',
  'NETWORK_DOWNLOAD_TO_FILE_WRITE_TO_PROCESS_EXECUTION',
  'LIFECYCLE_TO_PROCESS_EXECUTION',
];

export type AgentToolV0_3 = 'GET_FILE_RANGE' | 'GET_SYMBOL_DEFINITION' | 'GET_SYMBOL_REFERENCES' | 'GET_CALLERS' | 'GET_IMPORT_RELATIONS';
export interface AgentToolDescriptorV0_3 { tool: AgentToolV0_3; status: 'AVAILABLE' | 'UNAVAILABLE'; reason?: string }

/** MVP catalog: only artifact-based GET_FILE_RANGE is supported; GET_PACKAGE_METADATA is removed. */
export const AGENT_TOOL_CATALOG_V0_3: readonly AgentToolDescriptorV0_3[] = [
  { tool: 'GET_FILE_RANGE', status: 'AVAILABLE' },
  { tool: 'GET_SYMBOL_DEFINITION', status: 'UNAVAILABLE', reason: 'No symbol index exists.' },
  { tool: 'GET_SYMBOL_REFERENCES', status: 'UNAVAILABLE', reason: 'No symbol reference index exists.' },
  { tool: 'GET_CALLERS', status: 'UNAVAILABLE', reason: 'No call graph exists.' },
  { tool: 'GET_IMPORT_RELATIONS', status: 'UNAVAILABLE', reason: 'No import graph exists.' },
];

export interface FileLocation {
  file: string;
  startLine: number | null;
  endLine: number | null;
  lineageStatus?: 'DIRECT' | 'MAPPED' | 'UNMAPPED';
  derivedFrom?: { file: string; startLine?: number; endLine?: number };
}

export interface PackageContextV0_3 {
  source: 'TARBALL_PACKAGE_MANIFEST_PROJECTION';
  description: string | null;
  main: string | null;
  exports: unknown;
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
  entryPoints: Array<{ type: 'MAIN' | 'BIN' | 'EXPORTS'; value: string; location: FileLocation | null }>;
  lifecycleScripts: Array<{ name: 'preinstall' | 'install' | 'postinstall'; command: string; location: FileLocation | null }>;
}

export type FindingKind = 'CAPABILITY' | 'THREAT' | 'OTHER';

/** Tier 1 or Tier 2 analyzer finding as shown to the Agent. */
export interface Tier3FindingProjection {
  findingId: string;
  analyzer: string;
  analyzerVersion: string | null;
  ruleId: string;
  kind: FindingKind;
  description: string;
  location: FileLocation | null;
  rawMatch: string | null;
}

/** Links a Finding to the artifact (ORIGINAL or DEOBFUSCATED) it was observed in. */
export interface FindingArtifactBinding {
  findingId: string;
  artifactId: string;
  filePath: string;
  startLine?: number;
  endLine?: number;
  lineageStatus?: 'DIRECT' | 'MAPPED' | 'UNMAPPED';
  derivedFrom?: { file: string; startLine?: number; endLine?: number };
}
/** Links an Atomic Evidence to an artifact without changing Evidence v0.1. */
export interface EvidenceArtifactBinding {
  evidenceId: string;
  artifactId: string;
  filePath: string;
  startLine?: number;
  endLine?: number;
  lineageStatus?: 'DIRECT' | 'MAPPED' | 'UNMAPPED';
  derivedFrom?: { file: string; startLine?: number; endLine?: number };
}

export type ArtifactCatalog = ArtifactResolver;

/** Everything Tier 3 consumes from upstream (Tier 2 handoff + validated Planning). */
export interface Tier3ExecutionInput {
  validatedPlan: ValidatedAgentAnalysisPlan;
  artifacts: ArtifactCatalog;
  findings: Tier3FindingProjection[];
  atomicEvidences: AtomicEvidenceV0_1[];
  bindings: { findingBindings: FindingArtifactBinding[]; evidenceBindings: EvidenceArtifactBinding[] };
  packageContext: PackageContextV0_3;
  capabilityPreservation?: CapabilityPreservationReport;
  /** What a rule recorded about its own match, by Finding id. Scanner-internal: never copied into the Agent input. */
  findingAttributes?: Record<string, { sourceType?: string }>;
}

export interface AgentAnalysisPlanV0_3 {
  shouldExecute: boolean;
  analysisMode: AgentAnalysisMode;
  targets: ValidatedPlanningTarget[];
  focusBehaviors: FocusBehavior[];
  analysisTargets: AgentAnalysisTarget[];
  limitations: string[];
}

export interface MissingDataV0_3 { field: string; reason: string }

/** Agent 0.3.0 uses derivedFrom.file here; upstream/Evidence 0.1 uses path. */
export type AgentCapabilityObservation = Omit<CapabilityObservation, 'derivedFrom'> & {
  derivedFrom?: { file: string; startLine?: number; endLine?: number };
};
export type AgentCapabilityValidation = Omit<CapabilityValidation, 'comparisons'> & {
  comparisons?: Array<Omit<CapabilityComparison, 'original' | 'deobfuscated'> & {
    original: AgentCapabilityObservation[]; deobfuscated: AgentCapabilityObservation[];
  }>;
};
export type AgentCapabilityPreservationReport = Omit<CapabilityPreservationReport, 'files'> & {
  files: Array<Omit<CapabilityPreservationFile, 'validation'> & { validation: AgentCapabilityValidation }>;
};

export interface AgentAnalysisInputV0_3 {
  request: { analysisRequestId: string; requestType: 'MALICIOUS_CODE_ANALYSIS'; schemaVersion: typeof AGENT_INPUT_SCHEMA_VERSION_V0_3; scanId: string; createdAt: string | null };
  subject: { ecosystem: 'npm'; packageName: string; packageVersion: string; archiveSha256: string };
  packageContext: PackageContextV0_3;
  artifactContext: {
    artifacts: ArtifactDescriptor[];
    findingLocations: FindingArtifactBinding[];
    evidenceLocations: EvidenceArtifactBinding[];
  };
  findings: Tier3FindingProjection[];
  atomicEvidences: AtomicEvidenceV0_1[];
  analysisPlan: AgentAnalysisPlanV0_3;
  analysisPolicy: { maxToolCalls: number; maxAdditionalCodeRequests: number; maxTotalCodeLines: number };
  initialCodeSlices: AgentCodeSlice[];
  toolResponseCatalog: AgentToolDescriptorV0_3[];
  missingData: MissingDataV0_3[];
  capabilityPreservation?: AgentCapabilityPreservationReport;
}
