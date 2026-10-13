import type { FindingLocation } from '../domain/analysis.types';
import type { AtomicEvidenceV0_1 } from '../evidence/normalizer/evidence-normalizer.types';

export type AgentTriggerMode = 'DISABLED' | 'ALWAYS' | 'RISK_BASED';
export type AgentTriggerCondition = 'GUARDDOG_THREAT_FOUND' | 'LIFECYCLE_WITH_PROCESS_EXECUTION' | 'SENSITIVE_ACCESS_WITH_NETWORK' | 'DOWNLOAD_WRITE_EXECUTION_COMBINATION' | 'OBFUSCATION_FOUND';
export interface AgentTriggerDecision { mode: AgentTriggerMode; shouldExecute: boolean; matchedConditions: AgentTriggerCondition[]; reason: string }
export interface AgentAnalysisPolicy { maxToolCalls: number; maxAdditionalCodeRequests: number; maxTotalCodeLines: number }
export interface AgentCodeSlice { sliceId: string; file: string; startLine: number; endLine: number; content: string; contentRedacted: boolean; selectionReason: string; relatedFindingIds: string[] }
export type AgentAnalysisTarget = 'ENV_OR_SENSITIVE_FILE_TO_NETWORK' | 'NETWORK_DOWNLOAD_TO_FILE_WRITE_TO_PROCESS_EXECUTION' | 'LIFECYCLE_TO_PROCESS_EXECUTION';
export interface AgentMissingData { type: string; description: string; impact: string }
export interface AgentLocation { file: string; startLine: number | null; endLine: number | null }
export interface AgentPackageContext {
  source: 'TARBALL_PACKAGE_MANIFEST_PROJECTION';
  packageMetadata: { name: string | null; version: string | null; description: string | null };
  main: string | null; exports: unknown; bin: unknown;
  scripts: Record<string, string>; dependencies: Record<string, string>;
  entryPoints: Array<{ type: 'MAIN' | 'BIN' | 'EXPORTS'; value: string; location: AgentLocation | null }>;
  lifecycleScripts: Array<{ name: 'preinstall' | 'install' | 'postinstall'; command: string; location: AgentLocation | null }>;
}
export interface AgentFinding { findingId: string; analyzer: string; analyzerVersion: string; ruleId: string; kind: string; description: string; location: AgentLocation | null; rawMatch: string | null }
export type AgentAtomicEvidence = Pick<AtomicEvidenceV0_1, 'evidenceId' | 'signal' | 'assertion' | 'sources' | 'limitations'> & { locations: AgentLocation[] };
export interface AgentToolDescriptor { tool: 'GET_FILE_RANGE' | 'GET_PACKAGE_METADATA' | 'GET_IMPORT_RELATIONS' | 'GET_SYMBOL_DEFINITION' | 'GET_SYMBOL_REFERENCES' | 'GET_CALLERS'; status: 'AVAILABLE' | 'PARTIAL' | 'UNAVAILABLE'; reason?: string }
export interface AgentAnalysisRequest {
  request: { analysisRequestId: string; requestType: 'MALICIOUS_CODE_ANALYSIS'; schemaVersion: string; createdAt: string; requestId: string; scanId: string; inputProfile: 'CODE_FINDING_EVIDENCE' };
  subject: { ecosystem: 'npm'; packageName: string; packageVersion: string; artifactHash: string; integrity: string };
  packageContext: AgentPackageContext; findings: AgentFinding[]; atomicEvidences: AgentAtomicEvidence[];
  analysisPolicy: AgentAnalysisPolicy; initialCodeSlices: AgentCodeSlice[]; analysisTargets: AgentAnalysisTarget[];
  toolResponseCatalog: AgentToolDescriptor[]; missingData: AgentMissingData[];
}
export interface CodeSlicePolicy { maxInitialSlices: number; maxLinesPerSlice: number; maxInitialCodeLines: number; maxTotalCodeLines: number; maxFileSizeBytes: number }
export function agentLocation(location?: FindingLocation): AgentLocation | null {
  if (!location?.path) return null;
  return { file: location.path, startLine: location.startLine ?? null, endLine: location.endLine ?? null };
}
