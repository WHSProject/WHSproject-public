import type {
  AnalyzerResult,
  Finding,
  FindingLocation,
  ScanError,
} from '../../domain/analysis.types';
import type {
  CapabilityValidation,
  SourceLineMapping,
} from '../../analyzers/obfuscation/obfuscation.types';

export type EvidenceAssertionBasis =
  | 'PATTERN_MATCH'
  | 'METADATA_VALUE'
  | 'CO_OCCURRENCE'
  | 'EXECUTION_LINK'
  | 'DATA_FLOW'
  | 'TOOL_CORRELATION';

/** Signal types consumed by the Policy scoring and rule engine. */
export type EvidenceSignalType =
  | 'OBFUSCATED_CODE'
  | 'REMOTE_FETCH'
  | 'CHILD_PROCESS'
  | 'SHELL_EXEC'
  | 'DYNAMIC_CODE_EXECUTION'
  | 'ENV_READ'
  | 'FILE_READ'
  | 'FILE_WRITE'
  | 'FILE_DELETE'
  | 'AUTOSTART'
  | 'KEYSTROKE_CAPTURE'
  | 'REMOTE_DEPENDENCY'
  | 'LIFECYCLE_SCRIPT'
  | 'SYSTEM_INFO'
  | 'CREDENTIAL_READ'
  | 'SECRET_READ'
  | 'SENSITIVE_FILE_READ'
  | 'NETWORK_EGRESS'
  | 'PREINSTALL_SCRIPT'
  | 'INSTALL_SCRIPT'
  | 'POSTINSTALL_SCRIPT'
  | 'METADATA_MISMATCH'
  | 'TYPOSQUATTING'
  | 'DEPENDENCY_CONFUSION';

export type EvidenceSignalCategory =
  | 'METADATA'
  | 'FILESYSTEM'
  | 'EXECUTION'
  | 'ENVIRONMENT'
  | 'NETWORK'
  | 'SYSTEM'
  | 'CODE';

export type EvidenceTaxonomy =
  | 'INSTALLATION_AND_EXECUTION'
  | 'DISCOVERY_AND_COLLECTION'
  | 'CREDENTIAL_AND_SENSITIVE_DATA_ACCESS'
  | 'NETWORK_C2_AND_EXFILTRATION'
  | 'PAYLOAD_AND_DYNAMIC_CODE'
  | 'FILESYSTEM_AND_SYSTEM_MODIFICATION'
  | 'PERSISTENCE_AND_PROPAGATION'
  | 'EVASION_AND_OBFUSCATION'
  | 'PACKAGE_AND_PUBLISHING_RISK';

export interface NormalizationInput {
  requestId: string;
  scanId: string;
  subject: {
    ecosystem: 'npm';
    packageName: string;
    packageVersion: string;
    artifactHash: string;
  };
  artifactRoot: string;
  analyzerResults: AnalyzerResult[];
  /** Validated Tier 2 candidates; raw shadow analyzer results are not accepted here. */
  tier2Candidates?: readonly Tier2EvidenceCandidateInput[];
}

export interface Tier2EvidenceCandidateInput {
  requestId: string;
  scanId: string;
  artifactHash: string;
  analyzer: string;
  analyzerVersion: string;
  ruleId: string;
  rawFindingId: string;
  finding: Finding;
  /** Derived logical locations already validated by the Tier 2 candidate gate. */
  locations: readonly FindingLocation[];
  /** Original package-relative path for each corresponding derived location. */
  originalPaths: readonly string[];
  originalPath: string;
  restoreStatus: 'RESTORED' | 'PARTIAL_RESTORED';
  limitations: readonly string[];
  /** Mapping from the derived finding lines back to the original file. */
  lineMapping?: SourceLineMapping;
  /** Per-file mappings when one Tier 2 finding cites multiple restored files. */
  lineMappings?: readonly SourceLineMapping[];
  capabilityPreservation?: CapabilityValidation;
}

export interface AtomicEvidenceV0_1 {
  schemaVersion: '0.1';
  evidenceId: string;
  kind: 'ATOMIC';
  analysisPass?: 'TIER1' | 'TIER2';
  signal: {
    id: string;
    type: string;
    // Public contract compatibility: registered values use EvidenceSignalCategory.
    category: string;
  };
  /** Optional semantic classification copied from the Mapping Target. */
  taxonomy?: EvidenceTaxonomy;
  action?: string;
  subject: NormalizationInput['subject'];
  assertion: {
    summary: string;
    basis: EvidenceAssertionBasis;
  };
  sources: EvidenceSource[];
  locations: FindingLocation[];
  provenance: {
    scanId: string;
    generatedBy: 'EVIDENCE_NORMALIZER';
    observedAt: string;
  };
  limitations: string[];
  capabilityPreservation?: CapabilityValidation;
}

export interface EvidenceSource {
  analyzer: string;
  analyzerVersion: string;
  ruleId: string;
  rawFindingId: string;
}

export type UnmappedStatus = 'AMBIGUOUS' | 'UNMAPPED' | 'INVALID';

export interface UnmappedFinding {
  findingId?: string;
  analyzerName: string;
  analyzerVersion: string;
  ruleId?: string;
  mappingStatus: UnmappedStatus;
  reason: string;
  location?: FindingLocation;
  signal?: null;
  taxonomy?: EvidenceTaxonomy | null;
  rawResultRef?: string;
}

export interface NormalizationSummary {
  inputFindingCount: number;
  normalizedFindingCount: number;
  atomicEvidenceCount: number;
  unmappedFindingCount: number;
  invalidFindingCount: number;
  deduplicatedEvidenceCount: number;
  normalizerVersion: string;
  mappingVersion: string;
  mappingHash: string;
}

export interface NormalizationResult {
  atomicEvidences: AtomicEvidenceV0_1[];
  unmappedFindings: UnmappedFinding[];
  errors: ScanError[];
  summary: NormalizationSummary;
}

export interface EvidenceMappingTarget {
  signalId: string;
  signalType: EvidenceSignalType;
  // Public contract compatibility: registered values use EvidenceSignalCategory.
  signalCategory: string;
  taxonomy?: EvidenceTaxonomy;
  action?: string;
  assertionBasis: EvidenceAssertionBasis;
  limitations: readonly string[];
}

export interface MappedEvidenceRule {
  analyzerName: string;
  ruleId: string;
  mappingStatus: 'EXACT' | 'PARTIAL';
  targets: readonly [EvidenceMappingTarget, ...EvidenceMappingTarget[]];
  mappingVersion: string;
}

export interface AmbiguousEvidenceRule {
  analyzerName: string;
  ruleId: string;
  mappingStatus: 'AMBIGUOUS';
  targets: readonly [];
  mappingVersion: string;
  reason: string;
}

export interface InvalidEvidenceRule {
  analyzerName: string;
  ruleId: string;
  mappingStatus: 'INVALID';
  targets: readonly [];
  mappingVersion: string;
  reason: string;
}

export type EvidenceMappingRule =
  | MappedEvidenceRule
  | AmbiguousEvidenceRule
  | InvalidEvidenceRule;
