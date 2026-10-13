import type { AnalyzerResult, Finding, PackageIdentity, ScanError } from '../../domain/analysis.types';
import type { AtomicEvidenceV0_1, NormalizationSummary, UnmappedFinding } from '../../evidence/normalizer/evidence-normalizer.types';

export type LocalAnalyzerStatus = 'COMPLETED' | 'UNAVAILABLE' | 'TIMEOUT' | 'FAILED' | 'SKIPPED';

export type SemgrepUnavailableReason =
  | 'SEMGREP_EXECUTABLE_NOT_FOUND'
  | 'SEMGREP_VERSION_CHECK_FAILED'
  | 'SEMGREP_RUNTIME_CONFIG_UNWRITABLE'
  | 'SEMGREP_RULESET_NOT_FOUND'
  | 'SEMGREP_TIMEOUT'
  | 'SEMGREP_ANALYSIS_NON_ZERO_EXIT';

export type SemgrepAvailability =
  | { available: true }
  | { available: false; reasonCode: SemgrepUnavailableReason };

export interface LocalStaticAnalysisRequest {
  scanId: string;
  sampleId: string;
  packageRoot: string;
  allowedArtifactRoot: string;
  subject: PackageIdentity & { ecosystem: 'npm'; artifactSha256: string };
}

export interface LocalArtifactIntegrityVerifier {
  verify(request: Pick<LocalStaticAnalysisRequest, 'sampleId' | 'packageRoot' | 'subject'>): Promise<boolean>;
}

export interface LocalAnalyzerExecution {
  name: string;
  status: LocalAnalyzerStatus;
  result: AnalyzerResult;
  durationMs: number;
  reasonCode?: string;
}

export interface LocalStaticAnalysisResult {
  status: 'COMPLETED' | 'PARTIAL' | 'FAILED';
  analyzerResults: LocalAnalyzerExecution[];
  findings: Finding[];
  atomicEvidences: AtomicEvidenceV0_1[];
  correlatedEvidences: readonly [];
  failures: ScanError[];
  unmappedFindings: UnmappedFinding[];
  normalizationSummary: NormalizationSummary;
  provenance: {
    scannerCommitSha: string;
    scannerBranch: string;
    scannerVersion: string;
    executionMode: 'LOCAL_STATIC';
    artifactBoundaryMode: 'EXTERNAL_READ_ONLY_ARTIFACT';
    allowedRootId: string;
    relativePackageRoot: string;
    artifactSha256: string;
    packageTreeDigest: string;
    analyzerVersions: Record<string, string>;
    guardDogVersion: string;
    customRuleRulesetHash: string;
    metadataAnalyzerVersion: string;
    analyzerExecutions: Array<{ name: string; status: LocalAnalyzerStatus; durationMs: number }>;
    findingSchema: { version: string; hash: string };
    evidenceSchema: { version: string; hash: string };
    evidenceMapping: { version: string; hash: string };
    networkIsolationMode: string;
    sandbox: {
      backend: string;
      imageDigest: string;
      runtimeVersion: string;
      policyVersion: string;
      verificationReasonCode?: string;
      mountPolicy: string;
      rootFilesystem: string;
      resourceLimits: { pids: number; memory: string; cpus: string; tmpfsSize: string; timeoutMs: number };
    };
    customRuleSandbox?: {
      mode: string;
      imageDigest: string;
      semgrepVersion: string;
      rulesetSha256: string;
      runtimeVersion: string;
      policyVersion: string;
      environmentVersion: string;
      verificationReasonCode?: string;
      mountPolicy: string;
      rootFilesystem: string;
      resourceLimits: { pids: number; memory: string; cpus: string; tmpfsSize: string; timeoutMs: number };
    };
    environmentAllowlistVersion: string;
    packageExecuted: false;
    lifecycleExecuted: false;
  };
}
