export type Decision = 'ACCEPT' | 'REJECT' | 'HOLD' | 'REVIEW';
export type ScanStatus = 'COMPLETED' | 'PARTIAL' | 'FAILED' | 'TIMEOUT';

export interface OsvFeed {
  source: 'OSV';
  feedStatus: 'SUCCESS' | 'FAILED' | 'TIMEOUT' | 'SKIPPED';
  query: { ecosystem: string; packageName: string; packageVersion: string };
  advisories: Array<Record<string, unknown>>;
  complete: boolean;
  pagesFetched: number;
  collectedAt: string | null;
  completedAt: string | null;
  errorCode: string | null;
  skippedReason: string | null;
}

export interface Subject {
  ecosystem: 'npm';
  packageName: string;
  packageVersion: string;
  artifactHash: string;
  integrity?: string;
}

export interface EvidenceProvenance {
  scanId: string;
  producerType?: string;
  analysisId?: string;
  assessmentId?: string;
  model?: string;
  promptVersion?: string;
  inputSchemaVersion?: string;
  outputSchemaVersion?: string;
  [key: string]: unknown;
}

export interface CodeLocation {
  type: 'SOURCE_FILE' | 'METADATA';
  path?: string | null;
  startLine?: number | null;
  startColumn?: number | null;
  endLine?: number | null;
  endColumn?: number | null;
  jsonPointer?: string | null;
  role?: 'OBSERVATION' | 'SOURCE' | 'SINK' | 'ENTRYPOINT' | 'TRIGGER' | 'TRANSFORM' | 'CONDITION' | 'CONTEXT' | null;
  representation?: 'ORIGINAL' | 'DEOBFUSCATED';
  lineageStatus?: 'DIRECT' | 'MAPPED' | 'UNMAPPED';
  derivedFrom?: { path: string; startLine?: number; endLine?: number };
}

export type EvidenceTaxonomy =
  | 'INSTALLATION_AND_EXECUTION' | 'DISCOVERY_AND_COLLECTION'
  | 'CREDENTIAL_AND_SENSITIVE_DATA_ACCESS' | 'NETWORK_C2_AND_EXFILTRATION'
  | 'PAYLOAD_AND_DYNAMIC_CODE' | 'FILESYSTEM_AND_SYSTEM_MODIFICATION'
  | 'PERSISTENCE_AND_PROPAGATION' | 'EVASION_AND_OBFUSCATION'
  | 'PACKAGE_AND_PUBLISHING_RISK';

export type CapabilityStatus = 'PRESERVED' | 'LOST' | 'DISCOVERED' | 'NOT_VERIFIED' | 'NOT_APPLICABLE';
export type RestoreStatus = 'RESTORED' | 'PARTIAL_RESTORED' | 'UNRESOLVED' | 'SKIPPED' | 'FAILED';

export interface CapabilityObservation {
  analyzer: string;
  analyzerVersion: string;
  ruleId: string;
  findingId: string;
  path: string;
  startLine?: number;
  endLine?: number;
  representation: 'ORIGINAL' | 'DEOBFUSCATED';
  lineageStatus: 'DIRECT' | 'MAPPED' | 'UNMAPPED';
  derivedFrom?: { path: string; startLine?: number; endLine?: number };
}

export interface CapabilityComparison {
  capability: string;
  status: CapabilityStatus;
  original: CapabilityObservation[];
  deobfuscated: CapabilityObservation[];
}

export interface CapabilityPreservation {
  before: string[];
  after: string[] | null;
  status: CapabilityStatus;
  preserved: string[];
  lost: string[];
  discovered: string[];
  comparisons: CapabilityComparison[];
  limitations: string[];
  originalPath?: string;
  deobfuscatedPaths?: string[];
  restoreStatus?: RestoreStatus;
}

export interface EvidenceBase {
  schemaVersion: string;
  evidenceId: string;
  kind: 'ATOMIC' | 'CORRELATED';
  analysisPass?: 'TIER1' | 'TIER2';
  taxonomy?: EvidenceTaxonomy;
  action?: string;
  signal: { id?: string; type: string; category?: string };
  subject: Subject;
  assertion: { summary: string; basis?: string };
  locations?: CodeLocation[];
  derivedFrom?: { evidenceIds?: string[]; findingIds?: string[] };
  sources?: Array<Record<string, unknown>>;
  provenance: EvidenceProvenance;
  limitations?: string[];
  capabilityPreservation?: CapabilityPreservation;
}

export interface LlmAssessmentEvidence {
  schemaVersion: '0.1';
  evidenceId: string;
  kind: 'LLM_ASSESSMENT';
  analysisPass?: 'TIER1' | 'TIER2';
  taxonomy?: EvidenceTaxonomy;
  action?: string;
  capabilityPreservation?: CapabilityPreservation;
  signal: { id: string; type: string; category: string };
  subject: Subject;
  assertion: { summary: string; basis: string };
  executionContext?: { flow: Record<string, unknown> };
  reachability?: Record<string, unknown>;
  intentAssessment?: 'BENIGN_LIKELY' | 'DUAL_USE' | 'SUSPICIOUS' | 'LIKELY_MALICIOUS' | 'UNKNOWN';
  verificationStatus?: 'VERIFIED' | 'PARTIALLY_VERIFIED' | 'UNVERIFIED' | 'REJECTED';
  confidence?: number;
  reasonCodes: string[];
  alternatives?: Array<Record<string, unknown>>;
  locations: CodeLocation[];
  relatedFindingIds: string[];
  relatedAtomicEvidenceIds: string[];
  sources?: Array<Record<string, unknown>>;
  limitations: string[];
  provenance: EvidenceProvenance & {
    producerType: 'LLM_AGENT';
    analysisId: string;
    assessmentId: string;
  };
}

export type Evidence = EvidenceBase | LlmAssessmentEvidence;

export interface EvaluationRequest {
  requestId: string;
  scanStatus: ScanStatus;
  scanId: string;
  subject: Subject & { integrity: string };
  evidences: Evidence[];
  osvFeed: OsvFeed;
  agentAnalysisSummary?: Record<string, unknown>;
  expectedArtifactHash?: string | null;
  score?: number | null;
}
