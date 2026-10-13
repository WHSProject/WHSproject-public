import type {
  AgentAnalysisRequestV0_1,
  GptAnalysisResponse,
  GptShadowOutcome,
} from '../analyzers/obfuscation/agent-analysis.types';

export const PROMPT_EVALUATION_PROVIDERS = ['gpt', 'gemini'] as const;
export type PromptEvaluationProvider = typeof PROMPT_EVALUATION_PROVIDERS[number];

export const PROMPT_EVALUATION_STATUSES = [
  'COMPLETED',
  'REJECTED',
  'FAILED',
  'SKIPPED',
] as const;
export type PromptEvaluationStatus = typeof PROMPT_EVALUATION_STATUSES[number];

export type EvaluationReachability = GptAnalysisResponse['files'][number]['dataFlows'][number]['reachable'];

export interface BehaviorExpectation {
  path: string;
  capability: string;
}

export interface DataFlowExpectation {
  path: string;
  source: string;
  sink: string;
  reachable: EvaluationReachability;
  evidenceRefs?: string[];
}

export interface ReachabilityExpectation {
  path: string;
  source: string;
  sink: string;
  reachable: EvaluationReachability;
}

export interface ForbiddenClaims {
  behaviors: BehaviorExpectation[];
  dataFlows: DataFlowExpectation[];
}

export interface PromptEvaluationGroundTruth {
  behaviors: BehaviorExpectation[];
  dataFlows: DataFlowExpectation[];
  reachability: ReachabilityExpectation[];
  allowedEvidenceIds: string[];
  allowedPaths: string[];
  forbiddenClaims: ForbiddenClaims;
  allowedRenames?: Record<string, string>;
}

export interface EvaluationFixture {
  fixtureId: string;
  description: string;
  request: AgentAnalysisRequestV0_1;
  groundTruth: PromptEvaluationGroundTruth;
  tags: string[];
}

export interface EvaluationRuntime {
  provider: PromptEvaluationProvider;
  model: string;
  promptVersion: string;
  fixtureId: string;
  trial: number;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  status: PromptEvaluationStatus;
  cacheMode: 'BYPASS';
  cacheStatus: NonNullable<GptShadowOutcome['cacheStatus']>;
}

export interface SetMetric {
  expected: number;
  predicted: number;
  matched: number;
  falsePositive: number;
  falseNegative: number;
  precision: number;
  recall: number;
  f1: number;
}

export interface ReachabilityMetric {
  correct: number;
  incorrect: number;
  total: number;
  accuracy: number | null;
}

export interface EvidenceMetric {
  referenced: number;
  valid: number;
  invalid: number;
  complianceRate: number | null;
}

export interface PathMetric {
  referenced: number;
  valid: number;
  invalid: number;
  complianceRate: number | null;
}

export type InjectionResult = 'MODEL_SAFE' | 'VALIDATOR_BLOCKED' | 'UNSAFE_ACCEPTED';

export interface FixtureScores {
  behavior: SetMetric | null;
  dataFlow: SetMetric | null;
  reachability: ReachabilityMetric | null;
  evidence: EvidenceMetric | null;
  path: PathMetric | null;
  hallucinationCount: number;
  injection: InjectionResult | null;
}

export interface PromptEvaluationResult {
  fixtureId: string;
  description: string;
  tags: string[];
  runtime: EvaluationRuntime;
  scores: FixtureScores;
  reason?: string;
}

export interface AggregateSetMetric extends SetMetric {}

export interface PromptEvaluationSummary {
  fixtureCount: number;
  evaluationCount: number;
  completed: number;
  rejected: number;
  failed: number;
  skipped: number;
  completionRate: number | null;
  rejectionRate: number | null;
  failureRate: number | null;
  behavior: AggregateSetMetric | null;
  dataFlow: AggregateSetMetric | null;
  reachability: ReachabilityMetric | null;
  evidence: EvidenceMetric | null;
  path: PathMetric | null;
  hallucinationCount: number;
  fixturesWithHallucination: number;
  hallucinationRate: number | null;
  injection: {
    total: number;
    modelSafe: number;
    validatorBlocked: number;
    unsafeAccepted: number;
    modelSafeRate: number | null;
    defenseSuccessRate: number | null;
    unsafeAcceptedRate: number | null;
  };
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheStatusCounts: Record<string, number>;
}

export interface PromptEvaluationReport {
  provider: PromptEvaluationProvider;
  model: string;
  promptVersion: string;
  cacheMode: 'BYPASS';
  trials: number;
  summary: PromptEvaluationSummary;
  results: PromptEvaluationResult[];
}
