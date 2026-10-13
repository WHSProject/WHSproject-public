/** 난독화 파트 전용 타입. Scanner 계약에는 없는 것들이다. */

/** 난독화 신호. 필요한 복원기가 다르므로 두 갈래로 나눈다. */
export type StructuralSignal =
  | 'IDENTIFIER_MANGLING'
  | 'CONTROL_FLOW_FLATTENING'
  | 'SELF_DEFENDING'
  | 'DEBUG_PROTECTION';
export type DataSignal = 'BASE64_DECODE' | 'CHAR_CODE' | 'ESCAPED_LITERAL' | 'HEX_LITERAL';
export type AuxSignal = 'DYNAMIC_EVAL' | 'LONG_ENCODED_BLOB';
export type ObfuscationSignal = StructuralSignal | DataSignal | AuxSignal;

export type CandidateReason =
  | 'STRONG_CONTROL_FLOW_OBFUSCATION'
  | 'DYNAMIC_EXECUTION_WITH_ENCODED_LITERAL'
  | 'RISK_CAPABILITY_WITH_OBFUSCATION_SIGNAL'
  | 'EXECUTION_PATH_WITH_OBFUSCATION_SIGNAL';

export interface CandidateContext {
  /** package.json 진입점(main/bin/exports/lifecycle)이 가리키는 파일인지 여부 */
  executionPath?: boolean;
  /** Tier 1에서 확인된 위험 capability rule ID */
  riskCapabilityRuleIds?: string[];
  riskCapabilityRuleIdsByPath?: Record<string, string[]>;
}

export interface ObfuscationFeatures {
  bytes: number;
  lines: number;
  identifierCount: number;
  hexIdentifierCount: number;
  /** hex 식별자 비율. 주 판정 피처 */
  hexIdRatio: number;
  hasControlFlowFlattening: boolean;
  /** 계산된 속성의 helper 함수로 연산·호출을 우회하는 control-flow indirection 수. */
  controlFlowIndirectionCount: number;
  hasSelfDefending: boolean;
  hasDebugProtection: boolean;
  base64CallCount: number;
  charCodeCount: number;
  escapedLiteralCount: number;
  longEncodedBlobCount: number;
  /** base64 리터럴 중 디코드했을 때 출력 가능 텍스트가 되는 것. 바이너리 리소스와 구분한다. */
  decodableBlobCount: number;
  dynamicEvalCount: number;
}

export interface FileVerdict {
  /** extractedPath 기준 상대 경로 */
  path: string;
  obfuscated: boolean;
  /** 0~1 */
  score: number;
  confidence: 'HIGH' | 'MEDIUM';
  signals: ObfuscationSignal[];
  /** 후보 판정에 사용된 원시 신호. signals는 호환성을 위해 유지한다. */
  supportingSignals: ObfuscationSignal[];
  /** 후보가 된 논리적 근거. raw signal과 구분한다. */
  candidateReasons: CandidateReason[];
  executionPath: boolean;
  riskCapabilityRuleIds: string[];
  structuralCandidate: boolean;
  dataCandidate: boolean;
  /** 임계치 재조정을 위해 원값을 반드시 보존한다 */
  features: ObfuscationFeatures;
}

export type SkipReason =
  | 'TARGET_LIMIT'
  | 'SIZE_LIMIT'
  | 'MIN_SIZE'
  | 'FILE_SCAN_LIMIT'
  | 'READ_FAILED';

export interface SkippedFile {
  path: string;
  reason: SkipReason;
}

export interface SelectionResult {
  verdicts: FileVerdict[];
  targets: FileVerdict[];
  skipped: SkippedFile[];
  scannedFiles: number;
  scanLimitHit: boolean;
}



/** 복원 단계. 실행 순서는 STRUCTURE → STRING → NORMALIZE 다. */
export type RestoreStage = 'STRUCTURE' | 'STRING' | 'NORMALIZE';

export type RestoreStatus =
  | 'RESTORED'
  | 'PARTIAL_RESTORED'
  | 'UNRESOLVED'
  | 'SKIPPED'
  | 'FAILED';

export type RestoreReason =
  | 'PARSE_FAILED'
  | 'NO_SUPPORTED_TRANSFORM'
  | 'DYNAMIC_DECODE_UNRESOLVED'
  | 'VERIFY_FAILED'
  | 'BUDGET_EXCEEDED'
  | 'TOOL_UNAVAILABLE'
  | 'TOOL_FAILED'
  | 'TOOL_TIMEOUT'
  | 'PARTIAL_STAGE_FAILURE'
  | 'NO_APPLICABLE_STAGE'
  | 'SOURCE_READ_FAILED'
  | 'OUTPUT_PATH_INVALID'
  | 'OUTPUT_WRITE_FAILED';

/** Existing name retained for downstream compatibility. */
export type UnresolvedReason = RestoreReason;

export type RestoreLimitation =
  | 'ORIGINAL_PARSE_FAILED'
  | 'BUDGET_EXCEEDED'
  | 'STRUCTURE_STAGE_FAILED'
  | 'STRING_STAGE_FAILED'
  | 'NORMALIZE_STAGE_FAILED'
  | 'TOOL_TIMEOUT'
  | 'DYNAMIC_DECODE_UNRESOLVED'
  | 'NO_SUPPORTED_TRANSFORM'
  | 'SCORE_INCREASED'
  | 'RISK_CAPABILITY_NOT_REANALYZED'
  | 'LINE_MAPPING_UNMAPPED'
  | 'LINE_MAPPING_INCOMPLETE'
  | 'LINE_MAPPING_COMPOSITION_INCOMPLETE'
  | 'WEBCRACK_SOURCE_MAP_UNAVAILABLE'
  | 'BABEL_SOURCE_MAP_UNAVAILABLE'
  | 'CAPABILITY_COMPARISON_INCOMPLETE'
  | 'DERIVED_ANALYSIS_UNAVAILABLE'
  | 'PARTIAL_RESTORE_PREVENTS_COMPLETE_VERIFICATION';

export const SOURCE_LINE_MAPPING_VERSION = '0.1.0' as const;
export type LineMappingConfidence = 'EXACT' | 'APPROXIMATE';

/** One derived line and the original line it came from. */
export interface SourceLineMappingEntry {
  derivedLine: number;
  sourceLine: number;
  confidence: LineMappingConfidence;
}

/** File-level source-to-derived line provenance produced by restoration. */
export interface SourceLineMapping {
  version: typeof SOURCE_LINE_MAPPING_VERSION;
  sourcePath: string;
  derivedPath: string;
  status: 'MAPPED' | 'UNMAPPED';
  entries: SourceLineMappingEntry[];
  derivedLineCount: number;
  mappedLineCount: number;
  limitations: string[];
}

export type RestoreStageStatus =
  | 'COMPLETED'
  | 'NO_CHANGE'
  | 'FAILED'
  | 'UNAVAILABLE'
  | 'SKIPPED';

export interface RestoreStageResult {
  stage: RestoreStage;
  applied: boolean;
  status: RestoreStageStatus;
  changed: boolean;
  reason?: string;
  detail?: string;
  metadata?: {
    rounds?: number;
    transformations?: string[];
    payloadCount?: number;
    payloads?: RestorePayloadEvidence[];
    memberAccessNormalized?: number;
  };
}

export interface RestorePayloadEvidence {
  index: number;
  transform: 'EVAL_PROMOTE';
  sourceLine: number | null;
  decodedLength: number;
  sha256: string;
}

export interface ParseValidation {
  valid: boolean;
  reason?: string;
}

export interface ValidationSourceSnapshot {
  parse: ParseValidation;
  bytes: number;
  identifierCount: number;
  hexIdentifierCount: number;
  hexIdRatio: number;
  score: number;
  signals: ObfuscationSignal[];
}

export type CapabilityPreservationStatus =
  | 'PRESERVED'
  | 'LOST'
  | 'DISCOVERED'
  | 'NOT_VERIFIED'
  | 'NOT_APPLICABLE';

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
  status: CapabilityPreservationStatus;
  original: CapabilityObservation[];
  deobfuscated: CapabilityObservation[];
}

export interface CapabilityValidation {
  before: string[];
  after: string[] | null;
  status: CapabilityPreservationStatus;
  preserved?: string[];
  lost: string[];
  discovered?: string[];
  comparisons?: CapabilityComparison[];
  limitations?: RestoreLimitation[];
  originalPath?: string;
  deobfuscatedPaths?: string[];
  restoreStatus?: RestoreStatus;
}

export interface ValidationSnapshot {
  original: ValidationSourceSnapshot;
  restored: ValidationSourceSnapshot;
  byteDelta: number;
  byteRatio: number;
  identifierDelta: number;
  hexIdentifierDelta: number;
  scoreDelta: number;
  addedSignals: ObfuscationSignal[];
  removedSignals: ObfuscationSignal[];
  capability: CapabilityValidation;
}

/** eval 에서 분리된 복원 payload 와 실행 관계. */
export interface RestoredPayload {
  outputPath: string;
  /** 복원 직전 코드에서 eval 이 발견된 줄. */
  sourceLine: number | null;
  transform: 'EVAL_PROMOTE';
  lineMapping?: SourceLineMapping;
}

export interface RestoredFile {
  path: string;
  outputPath: string;
  /** 모든 적용 단계가 완료되면 RESTORED, 하나 이상의 단계가 실패하면 PARTIAL_RESTORED. */
  status: Extract<RestoreStatus, 'RESTORED' | 'PARTIAL_RESTORED'>;
  reason?: RestoreReason;
  limitations: RestoreLimitation[];
  stageResults: RestoreStageResult[];
  appliedStages: RestoreStage[];
  /** 문자열 복원으로 추출한 하위 payload 와 실행 관계 */
  payloads: RestoredPayload[];
  originalBytes: number;
  restoredBytes: number;
  /** 복원본을 다시 판정한 결과. 지표 하락 여부를 본다. */
  verifyAfter: { score: number; hexIdRatio: number };
  validation: ValidationSnapshot;
  lineMapping?: SourceLineMapping;
  durationMs: number;
}

export interface UnresolvedFile {
  path: string;
  status: Extract<RestoreStatus, 'UNRESOLVED' | 'SKIPPED' | 'FAILED'>;
  reason: RestoreReason;
  limitations: RestoreLimitation[];
  stageResults: RestoreStageResult[];
  validation?: ValidationSnapshot;
  detail?: string;
  /** File processing time; absent in older results or external fixtures. */
  durationMs?: number;
}

export interface RestoreResult {
  outputRoot: string;
  restored: RestoredFile[];
  unresolved: UnresolvedFile[];
  durationMs: number;
  budgetExceeded: boolean;
  capabilityPreservation?: CapabilityPreservationReport;
}

export interface CapabilityPreservationFile {
  originalPath: string;
  deobfuscatedPaths: string[];
  restoreStatus: RestoreStatus;
  validation: CapabilityValidation;
}

export interface CapabilityPreservationReport {
  status: CapabilityPreservationStatus;
  files: CapabilityPreservationFile[];
  limitations: RestoreLimitation[];
}

export interface Budget {
  maxFilesScanned: number;
  maxTargets: number;
  maxFileBytes: number;
  perFileTimeoutMs: number;
  totalRestoreTimeoutMs: number;
}

export const DEFAULT_BUDGET: Budget = {
  maxFilesScanned: 400,
  maxTargets: 5,
  maxFileBytes: 1_000_000,
  perFileTimeoutMs: 5_000,
  totalRestoreTimeoutMs: 30_000,
};
