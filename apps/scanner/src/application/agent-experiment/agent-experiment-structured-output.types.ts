export type KeywordClassification = 'SUPPORTED' | 'UNSUPPORTED' | 'CONDITIONALLY_SUPPORTED' | 'UNKNOWN' | 'ANNOTATION_ONLY';

export interface StructuredOutputKeywordOccurrence {
  jsonPath: string;
  keyword: string;
  valueType: string;
  schemaNodeType: string;
  classification: KeywordClassification;
  reason: string;
}

export interface StructuredOutputViolation {
  severity: 'CONFIRMED_STATIC_VIOLATION' | 'LIKELY_PROVIDER_INCOMPATIBILITY' | 'ALLOWED_BUT_NON_CANONICAL';
  jsonPath: string;
  keyword: string;
  currentValue: unknown;
  rule: string;
  proposedProjection: string;
  semanticEnforcementAfterProjection: string;
}

export interface StructuredOutputMetrics {
  schemaBytes: number;
  maximumNestingDepth: number;
  totalPropertyCount: number;
  totalRequiredEntryCount: number;
  totalEnumValueCount: number;
  totalEnumStringBytes: number;
  totalIdentifierAndEnumStringBytes: number;
  objectNodeCount: number;
  arrayNodeCount: number;
  anyOfNodeCount: number;
  nullablePropertyCount: number;
}

export interface StructuredOutputLintReport {
  validForConfiguredSubset: boolean;
  metrics: StructuredOutputMetrics;
  keywordInventory: StructuredOutputKeywordOccurrence[];
  violations: StructuredOutputViolation[];
}

export interface StructuredOutputProbe {
  probeId: string;
  parentProbeId: string | null;
  includedTopLevelProperties: string[];
  schemaSha256: string;
  schemaBytes: number;
  expectedPurpose: string;
  maxCalls: 1;
}
