import type { ScannerErrorCode } from './scanner-error-code';

export interface PackageIdentity {
  name: string;
  version: string;
}

export type LocationLineageStatus = 'DIRECT' | 'MAPPED' | 'UNMAPPED';

export interface FindingLocation {
  type: 'SOURCE_FILE' | 'METADATA';
  path?: string;
  startLine?: number;
  startColumn?: number;
  endLine?: number;
  endColumn?: number;
  jsonPointer?: string;
  representation?: 'ORIGINAL' | 'DEOBFUSCATED';
  lineageStatus?: LocationLineageStatus;
  derivedFrom?: { path: string; startLine?: number; endLine?: number };
}

export interface Finding<TData = Record<string, unknown>> {
  findingId: string;
  ruleId: string;
  type: string;
  message: string;
  location?: FindingLocation;
  data: TData;
  rawResultRef?: string;
}

export interface AnalysisContext {
  requestId: string;
  scanId: string;
  package: PackageIdentity;
  artifact: {
    tarballPath: string;
    extractedPath: string;
    hash: string;
    expectedIntegrity?: string;
    registryIntegrity?: string;
  };
  metadata: {
    registryMetadata: Record<string, unknown>;
    packageJson: Record<string, unknown>;
  };
}

export interface AnalyzerExecution {
  startedAt: string;
  completedAt: string;
  durationMs: number;
}

export type AnalyzerStatus =
  | 'SUCCESS'
  | 'PARTIAL'
  | 'FAILED'
  | 'TIMEOUT'
  | 'SKIPPED';

export interface AnalyzerResult<
  TFinding extends Finding = Finding,
  TError = ScanError,
> {
  requestId: string;
  scanId: string;
  analyzer: string;
  analyzerVersion: string;
  status: AnalyzerStatus;
  findings: TFinding[];
  errors: TError[];
  rawResultRef?: string;
  execution?: AnalyzerExecution;
}

export type ScanResultStatus = 'COMPLETED' | 'PARTIAL' | 'FAILED' | 'TIMEOUT';

export interface ScanError {
  code: ScannerErrorCode;
  stage: string;
  analyzer?: string;
  message: string;
  retryable: boolean;
}

export interface ShadowAnalysisRecord {
  analyzer: string;
  analyzerVersion: string;
  mode: 'SHADOW';
  data: unknown;
}

export interface ScanResult<TEvidence = unknown> {
  schemaVersion: string;
  requestId: string;
  scanId: string;
  subject: PackageIdentity & {
    ecosystem: 'npm';
  };
  artifactHash: string;
  status: ScanResultStatus;
  evidences: TEvidence[];
  analyzerSummaries: Array<{
    name: string;
    version?: string;
    status: AnalyzerStatus;
    findingCount: number;
    errorCount: number;
  }>;
  /** Policy 판정에는 사용하지 않고 실험·후속 Agent 핸드오프용으로만 저장한다. */
  shadowAnalyses?: ShadowAnalysisRecord[];
  errors: ScanError[];
}
