import type {
  AnalysisContext,
  AnalyzerResult,
  Finding,
  FindingLocation,
} from '../../domain/analysis.types';

export interface GuardDogRawOutput {
  package?: unknown;
  issues?: unknown;
  errors?: unknown;
  results?: unknown;
  risk_score?: unknown;
  risks?: unknown;
  [key: string]: unknown;
}

export interface GuardDogSourceFindingRaw {
  identifies?: unknown;
  location?: unknown;
  code?: unknown;
  match?: unknown;
  message?: unknown;
  [key: string]: unknown;
}

export interface GuardDogRawRisk {
  name?: unknown;
  category?: unknown;
  severity?: unknown;
  mitre_tactics?: unknown;
  threat_identifies?: unknown;
  threat_rule?: unknown;
  threat_description?: unknown;
  threat_location?: unknown;
  threat_code?: unknown;
  threat_match?: unknown;
  capability_identifies?: unknown;
  capability_rule?: unknown;
  file_path?: unknown;
  [key: string]: unknown;
}

export type GuardDogRiskLabel =
  | 'no_risks_detected'
  | 'low'
  | 'suspicious'
  | 'high_risk';

export interface GuardDogToolAssessment {
  score: number;
  label: GuardDogRiskLabel;
  findingsCount: number;
  scoreBreakdown: Record<string, unknown>;
  raw: Record<string, unknown>;
}

export type GuardDogFindingType =
  | 'CAPABILITY'
  | 'THREAT_INDICATOR'
  | 'UNKNOWN';

export interface GuardDogFindingData extends Record<string, unknown> {
  identifies?: string;
  code?: string;
  match?: string;
  guarddog: {
    resultRuleId: string;
    rawResult: Record<string, unknown>;
  };
}

export type GuardDogFinding = Pick<
  Finding<GuardDogFindingData>,
  'findingId' | 'ruleId' | 'type' | 'message' | 'location' | 'data'
> & {
  type: GuardDogFindingType;
  location?: FindingLocation;
};

export interface GuardDogReportedError {
  ruleOrStage: string;
  message: string;
}

export type GuardDogParserWarningKind =
  | 'UNSUPPORTED_RULE_RESULT'
  | 'INVALID_FINDING'
  | 'INVALID_REPORTED_ERROR'
  | 'INVALID_RISK';

export interface GuardDogParserWarning {
  kind: GuardDogParserWarningKind;
  message: string;
  ruleId?: string;
  occurrenceIndex?: number;
  riskIndex?: number;
}

export interface GuardDogParsedOutput {
  package: unknown;
  issues: unknown;
  findings: GuardDogFinding[];
  reportedErrors: GuardDogReportedError[];
  warnings: GuardDogParserWarning[];
  risks: GuardDogRawRisk[];
  toolAssessment: GuardDogToolAssessment;
  hasRuleInterpretationFailures: boolean;
}

export type GuardDogOutputParserErrorKind =
  | 'EMPTY_OUTPUT'
  | 'INVALID_JSON'
  | 'INVALID_TOP_LEVEL'
  | 'INVALID_RESULTS'
  | 'INVALID_ERRORS'
  | 'INVALID_RISKS'
  | 'INVALID_RISK_SCORE';

export class GuardDogOutputParserError extends Error {
  constructor(
    readonly kind: GuardDogOutputParserErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'GuardDogOutputParserError';
  }
}

export type GuardDogSandboxMode = 'REQUIRED' | 'DISABLED';

export type GuardDogArtifactBoundary =
  | { mode: 'SCANNER_WORKSPACE' }
  | { mode: 'EXTERNAL_READ_ONLY_ARTIFACT'; allowedArtifactRoot: string };

export type GuardDogNetworkIsolation =
  | { mode: 'SCANNER_SANDBOX' }
  | { mode: 'VERIFIED_NETWORK_NONE'; mechanism: string }
  | { mode: 'UNVERIFIED' };

export interface GuardDogAnalyzerInput {
  context: AnalysisContext;
  /** Omitted by production callers, preserving the Scanner workspace policy. */
  artifactBoundary?: GuardDogArtifactBoundary;
  networkIsolation?: GuardDogNetworkIsolation;
}

export interface GuardDogAnalyzerOptions {
  executable: string;
  toolVersion: string;
  workspaceRoot: string;
  timeoutMs: number;
  killGraceMs: number;
  sandboxMode: GuardDogSandboxMode;
  maxOutputBytes: number;
  rules?: readonly string[];
  excludeRules?: readonly string[];
}

export interface GuardDogProcessRequest {
  executable: string;
  args: readonly string[];
  timeoutMs: number;
  killGraceMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
  externalArtifact?: {
    packageRoot: string;
    containerPackageRoot: '/analysis/package';
  };
}

export interface GuardDogProcessError {
  code?: string;
  message: string;
}

export interface GuardDogTerminationError {
  signal: NodeJS.Signals;
  message: string;
}

export interface GuardDogProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  timedOut: boolean;
  outputLimitExceeded: boolean;
  command: string[];
  processError?: GuardDogProcessError;
  terminationErrors: GuardDogTerminationError[];
}

export interface GuardDogProcessExecution {
  command: string[];
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  jsonParsed: boolean;
  timedOut: boolean;
  outputLimitExceeded: boolean;
  sandboxMode: GuardDogSandboxMode;
}

type GuardDogAnalyzerResultBase = Pick<
  AnalyzerResult<GuardDogFinding>,
  | 'requestId'
  | 'scanId'
  | 'analyzer'
  | 'analyzerVersion'
  | 'status'
  | 'findings'
  | 'errors'
>;

export type GuardDogAnalyzerResult = GuardDogAnalyzerResultBase & {
  execution: NonNullable<AnalyzerResult['execution']>;
  guarddog: {
    tool: {
      name: 'guarddog';
      version: string;
    };
    issues?: unknown;
    risks: GuardDogRawRisk[];
    toolAssessment?: GuardDogToolAssessment;
    execution: GuardDogProcessExecution;
  };
};
