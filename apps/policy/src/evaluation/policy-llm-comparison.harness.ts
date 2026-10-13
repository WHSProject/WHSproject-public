import { buildEvidenceCase, type EvidenceCase } from '../case/evidence-case.builder';
import { createHash } from 'node:crypto';
import type { EvaluationRequest } from '../contracts/evidence';
import type { PolicyJudgment, PredicateEvaluation } from '../contracts/judgment';
import type { PolicySnapshot, PredicateStatus } from '../contracts/policy';
import { resolveDecision, type ResolvedDecision } from '../decision/decision.resolver';
import { POLICY_LLM_PROMPT_VERSION, buildPolicyPrompt } from '../llm/policy-llm.prompt';
import { policyLlmInputHash } from '../llm/policy-llm.audit';
import {
  PolicyLlmError,
  type PolicyLlmProvider,
  type PolicyLlmResponse,
  type PolicyLlmUsage,
} from '../llm/policy-llm.provider';
import { PolicyJudgmentValidationError, validatePolicyJudgment } from '../llm/policy-judgment.validator';

export const POLICY_LLM_COMPARISON_HARNESS_VERSION = 'policy-llm-comparison-v2';
export const POLICY_LLM_COMPARISON_FIXTURE_DATASET_VERSION = 'policy-llm-comparison-fixtures-v2';

export interface ExpectedPredicateEvaluation {
  ruleId: string;
  predicate: string;
  status: PredicateStatus;
  allowedEvidenceIds?: string[];
  allowedAssessmentIds?: string[];
  allowedFeedEvidenceIds?: string[];
  /** Set only when the fixture has an unambiguous positive/negative meaning. */
  polarity?: 'POSITIVE' | 'NEGATIVE';
}

export interface PolicyLlmComparisonFixture {
  fixtureId: string;
  description?: string;
  request: EvaluationRequest;
  policy: PolicySnapshot;
  expected?: {
    predicates?: ExpectedPredicateEvaluation[];
    ruleStatuses?: Record<string, PolicyJudgment['ruleEvaluations'][number]['status']>;
    finalDecision?: ResolvedDecision['decision'];
    reasonCode?: string;
    validation?: boolean;
    qualityEligible?: boolean;
    exclusionReason?: string;
  };
}

export interface HarnessProvider {
  provider: PolicyLlmProvider;
  model: string;
}

export interface PricingConfig {
  provider: string;
  model: string;
  currency: string;
  inputCostPerToken: number;
  outputCostPerToken: number;
  /** Number of tokens represented by each configured unit, e.g. 1_000_000. */
  tokenUnit: number;
  cachedInputCostPerToken?: number;
}

export interface PolicyLlmComparisonOptions {
  mode: 'fixture' | 'live';
  providers: Record<string, HarnessProvider | undefined>;
  timeoutMs: number;
  pricing?: PricingConfig[];
  signal?: AbortSignal;
  now?: () => Date;
}

export interface CitationComparison {
  ruleId: string;
  predicate: string;
  match: boolean | null;
  actual: { evidenceIds: string[]; assessmentIds: string[]; feedEvidenceIds: string[] };
  allowed?: { evidenceIds?: string[]; assessmentIds?: string[]; feedEvidenceIds?: string[] };
}

export interface PredicateComparison {
  ruleId: string;
  predicate: string;
  expected: PredicateStatus;
  actual?: PredicateStatus;
  match: boolean;
  polarity?: 'POSITIVE' | 'NEGATIVE';
}

export interface PolicyLlmComparisonResult {
  fixtureId: string;
  description?: string;
  provider: string;
  model: string;
  promptVersion: string;
  policyKey: string;
  policyVersion: string;
  policyHash?: string;
  policySnapshotHash: string;
  promptHash: string | null;
  fixtureDatasetVersion: string;
  fixtureDatasetHash: string;
  inputHash: string | null;
  startedAt: string;
  completedAt: string;
  latencyMs: number;
  status: 'COMPLETED' | 'FAILED' | 'SKIPPED';
  qualityEligible: boolean;
  exclusionReason?: string;
  validation: { expected?: boolean; succeeded: boolean | null; failureCode?: string; expectationMatch: boolean | null };
  rawJudgment?: unknown;
  rawResponse?: unknown;
  predicates: PredicateComparison[];
  citations: CitationComparison[];
  ruleStatusMatches: Record<string, boolean>;
  finalDecision?: ResolvedDecision;
  decisionMatch: boolean | null;
  reasonCodeMatch: boolean | null;
  providerFailureCode?: string;
  inputFailureCode?: string;
  validationFailureCode?: string;
  timeout: boolean;
  providerRequestId?: string;
  usage?: NormalizedUsage;
  estimatedCost: number | null;
  pricingStatus: 'CALCULATED' | 'NOT_CONFIGURED' | 'NOT_REPORTED';
  limitations: string[];
}

export interface NormalizedUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  cachedInputTokens: number | null;
  totalTokensDerived: boolean;
}

export interface ProviderComparisonSummary {
  fixtureCount: number;
  qualityEligibleFixtureCount: number;
  completedFixtureCount: number;
  validJudgmentCount: number;
  validJudgmentRate: number | null;
  predicateEvaluations: number;
  predicateStatusMatches: number;
  predicateStatusMatchRate: number | null;
  citationComparisons: number;
  citationMatches: number;
  citationMatchRate: number | null;
  ruleStatusComparisons: number;
  ruleStatusMatches: number;
  ruleStatusMatchRate: number | null;
  decisionComparisons: number;
  decisionMatches: number;
  decisionMatchRate: number | null;
  reasonCodeComparisons: number;
  reasonCodeMatches: number;
  reasonCodeMatchRate: number | null;
  providerFailureCount: number;
  failedRequestCount: number;
  validationFailureCount: number;
  timeoutCount: number;
  averageLatencyMs: number | null;
  minimumLatencyMs: number | null;
  maximumLatencyMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  estimatedCost: number | null;
  pricingStatus: 'CALCULATED' | 'NOT_CONFIGURED' | 'NOT_REPORTED';
  falsePositive: number | null;
  falseNegative: number | null;
  truePositive: number;
  trueNegative: number;
  falsePositiveRate: number | null;
  falseNegativeRate: number | null;
  precision: number | null;
  recall: number | null;
  specificity: number | null;
  accuracy: number | null;
  undeterminedPredicateCount: number;
  p50LatencyMs: number | null;
  p95LatencyMs: number | null;
  averageInputTokens: number | null;
  averageOutputTokens: number | null;
  averageTotalTokens: number | null;
  averageEstimatedCostPerCompletedFixture: number | null;
}

export interface ProviderPairwiseComparison {
  providers: [string, string];
  comparableFixtureCount: number;
  excludedFixtures: Array<{ fixtureId: string; reason: string }>;
  predicateStatus: { comparisons: number; matches: number; matchRate: number | null };
  citationSet: { comparisons: number; matches: number; matchRate: number | null };
  ruleStatus: { comparisons: number; matches: number; matchRate: number | null };
  finalDecision: { comparisons: number; matches: number; matchRate: number | null };
  reasonCode: { comparisons: number; matches: number; matchRate: number | null };
  disagreements: Array<{ fixtureId: string; items: string[] }>;
}

export interface PolicyLlmComparisonReport {
  harnessVersion: string;
  mode: 'fixture' | 'live';
  startedAt: string;
  completedAt: string;
  promptVersion: string;
  fixtureDatasetVersion: string;
  fixtureDatasetHash: string;
  fixtureCount: number;
  fixtures: PolicyLlmComparisonResult[];
  providers: Record<string, { model?: string; summary: ProviderComparisonSummary }>;
  validationFailures: Array<{ fixtureId: string; provider: string; failureCode: string }>;
  tokenUsage: Record<string, { inputTokens: number | null; outputTokens: number | null; totalTokens: number | null }>;
  pricing: { configured: boolean; currency?: string; providers: string[]; inputs: PricingConfig[] };
  estimatedCost: Record<string, number | null>;
  limitations: string[];
  pairwise: ProviderPairwiseComparison[];
}

export async function runPolicyLlmComparison(
  fixtures: readonly PolicyLlmComparisonFixture[],
  options: PolicyLlmComparisonOptions,
): Promise<PolicyLlmComparisonReport> {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) throw new Error('POLICY_HARNESS_INVALID_TIMEOUT');
  if ((options.pricing ?? []).some((item) => !validPricing(item))) throw new Error('POLICY_HARNESS_INVALID_PRICING');
  const startedAt = (options.now ?? (() => new Date()))().toISOString();
  const results: PolicyLlmComparisonResult[] = [];
  const providerNames = Object.keys(options.providers);
  const fixtureDatasetHash = hashCanonical(fixtures);

  for (const fixture of fixtures) {
    let evidenceCase: EvidenceCase;
    let prompt: string;
    let inputHash: string;
    try {
      evidenceCase = buildEvidenceCase(fixture.request);
      prompt = buildPolicyPrompt(evidenceCase, fixture.policy);
      inputHash = policyLlmInputHash(prompt);
    } catch (error) {
      const failureCode = error instanceof Error ? error.message : 'EVIDENCE_CASE_INVALID';
      for (const providerName of providerNames) {
        const model = options.providers[providerName]?.model ?? 'not-configured';
        results.push(baseResult(fixture, providerName, model, null, null, fixtureDatasetHash, startedAt, 0, {
          status: 'SKIPPED',
          validation: { expected: fixture.expected?.validation, succeeded: null, expectationMatch: fixture.expected?.validation === undefined ? null : false },
          inputFailureCode: `EVIDENCE_CASE_REJECTED:${failureCode}`,
          limitations: [fixture.expected?.exclusionReason ?? 'EVIDENCE_CASE_REJECTED'],
        }));
      }
      continue;
    }
    for (const providerName of providerNames) {
      results.push(await evaluateFixture(fixture, evidenceCase, prompt, inputHash, fixtureDatasetHash, providerName, options));
    }
  }

  const completedAt = (options.now ?? (() => new Date()))().toISOString();
  return buildReport(results, fixtures.length, fixtureDatasetHash, options, startedAt, completedAt);
}

async function evaluateFixture(
  fixture: PolicyLlmComparisonFixture,
  evidenceCase: EvidenceCase,
  prompt: string,
  inputHash: string | null,
  fixtureDatasetHash: string,
  providerName: string,
  options: PolicyLlmComparisonOptions,
): Promise<PolicyLlmComparisonResult> {
  const configured = options.providers[providerName];
  const model = configured?.model ?? 'not-configured';
  const started = performance.now();
  const startedAt = new Date().toISOString();
  const expectedValidation = fixture.expected?.validation;
  if (!configured) {
    return baseResult(fixture, providerName, model, inputHash, prompt, fixtureDatasetHash, startedAt, performance.now() - started, {
      status: 'SKIPPED',
      validation: { expected: expectedValidation, succeeded: null, expectationMatch: expectedValidation === undefined ? null : false },
      limitations: ['PROVIDER_NOT_CONFIGURED'],
    });
  }

  let response: PolicyLlmResponse | undefined;
  try {
    response = await withTimeout(
      (signal) => configured.provider.analyze(prompt, signal),
      options.timeoutMs,
      options.signal,
    );
    let judgment: PolicyJudgment;
    try {
      judgment = validatePolicyJudgment(response.judgment, fixture.policy, evidenceCase);
    } catch (error) {
      const failureCode = error instanceof PolicyJudgmentValidationError
        ? error.message
        : error instanceof Error ? error.message : 'INVALID_POLICY_JUDGMENT';
      return baseResult(fixture, providerName, response.model || model, inputHash, prompt, fixtureDatasetHash, startedAt, performance.now() - started, {
        status: 'FAILED',
        validation: { expected: expectedValidation, succeeded: false, failureCode, expectationMatch: expectedValidation === undefined ? null : expectedValidation === false },
        rawJudgment: response.judgment,
        rawResponse: response.rawResponse,
        providerRequestId: response.providerRequestId,
        usage: normalizeUsage(response.usage),
        validationFailureCode: failureCode,
        timeout: false,
        limitations: ['JUDGMENT_VALIDATION_FAILED'],
      });
    }

    const decision = resolveDecision(fixture.policy, judgment, evidenceCase);
    const usage = normalizeUsage(response.usage);
    const comparison = compareExpected(fixture, judgment, decision);
    const pricing = calculateCost(providerName, response.model || model, usage, options.pricing);
    return baseResult(fixture, providerName, response.model || model, inputHash, prompt, fixtureDatasetHash, startedAt, performance.now() - started, {
      status: 'COMPLETED',
      validation: { expected: expectedValidation, succeeded: true, expectationMatch: expectedValidation === undefined ? null : expectedValidation === true },
      rawJudgment: response.judgment,
      rawResponse: response.rawResponse,
      providerRequestId: response.providerRequestId,
      usage,
      ...comparison,
      estimatedCost: pricing.cost,
      pricingStatus: pricing.status,
      limitations: usage ? [] : ['TOKEN_USAGE_NOT_REPORTED'],
    });
  } catch (error) {
    const failureCode = error instanceof PolicyLlmError
      ? error.message
      : error instanceof Error ? error.message : 'POLICY_LLM_UNKNOWN_FAILURE';
    const timeout = failureCode === 'POLICY_LLM_TIMEOUT';
    const isValidation = failureCode.startsWith('POLICY_LLM_INVALID_JUDGMENT:');
    const rawResponse = error instanceof PolicyLlmError ? error.rawResponse : undefined;
    return baseResult(fixture, providerName, response?.model ?? model, inputHash, prompt, fixtureDatasetHash, startedAt, performance.now() - started, {
      status: 'FAILED',
      validation: { expected: expectedValidation, succeeded: null, expectationMatch: expectedValidation === undefined ? null : false },
      rawJudgment: response?.judgment,
      rawResponse: response?.rawResponse ?? rawResponse,
      providerRequestId: response?.providerRequestId,
      providerFailureCode: isValidation ? undefined : failureCode,
      validationFailureCode: isValidation ? failureCode : undefined,
      timeout,
      limitations: [timeout ? 'PROVIDER_TIMEOUT' : 'PROVIDER_FAILED'],
    });
  }
}

function baseResult(
  fixture: PolicyLlmComparisonFixture,
  provider: string,
  model: string,
  inputHash: string | null,
  prompt: string | null,
  fixtureDatasetHash: string,
  startedAt: string,
  latencyMs: number,
  partial: Partial<PolicyLlmComparisonResult> & Pick<PolicyLlmComparisonResult, 'status' | 'validation' | 'limitations'>,
): PolicyLlmComparisonResult {
  return {
    fixtureId: fixture.fixtureId,
    description: fixture.description,
    provider,
    model,
    promptVersion: POLICY_LLM_PROMPT_VERSION,
    policyKey: fixture.policy.policyKey,
    policyVersion: fixture.policy.policyVersion,
    policyHash: fixture.policy.policyHash,
    policySnapshotHash: hashCanonical(fixture.policy),
    promptHash: prompt ? hashCanonical(prompt) : null,
    fixtureDatasetVersion: POLICY_LLM_COMPARISON_FIXTURE_DATASET_VERSION,
    fixtureDatasetHash,
    inputHash,
    startedAt,
    completedAt: new Date().toISOString(),
    latencyMs: Math.max(0, latencyMs),
    status: partial.status,
    qualityEligible: fixture.expected?.qualityEligible !== false,
    exclusionReason: fixture.expected?.exclusionReason,
    validation: partial.validation,
    rawJudgment: redactSecrets(partial.rawJudgment),
    rawResponse: redactSecrets(partial.rawResponse),
    predicates: partial.predicates ?? [],
    citations: partial.citations ?? [],
    ruleStatusMatches: partial.ruleStatusMatches ?? {},
    finalDecision: partial.finalDecision,
    decisionMatch: partial.decisionMatch ?? null,
    reasonCodeMatch: partial.reasonCodeMatch ?? null,
    providerFailureCode: partial.providerFailureCode,
    inputFailureCode: partial.inputFailureCode,
    validationFailureCode: partial.validationFailureCode,
    timeout: partial.timeout ?? false,
    providerRequestId: partial.providerRequestId,
    usage: partial.usage,
    estimatedCost: partial.estimatedCost ?? null,
    pricingStatus: partial.pricingStatus ?? 'NOT_REPORTED',
    limitations: partial.limitations,
  };
}

function compareExpected(fixture: PolicyLlmComparisonFixture, judgment: PolicyJudgment, decision: ResolvedDecision): Partial<PolicyLlmComparisonResult> {
  const expected = fixture.expected;
  const predicates = (expected?.predicates ?? []).map((item) => {
    const actual = judgment.ruleEvaluations.find((rule) => rule.ruleId === item.ruleId)?.predicateEvaluations.find((predicate) => predicate.predicate === item.predicate);
    return { ruleId: item.ruleId, predicate: item.predicate, expected: item.status, actual: actual?.status, match: actual?.status === item.status, polarity: item.polarity };
  });
  const citations = (expected?.predicates ?? [])
    .filter((item) => item.allowedEvidenceIds !== undefined || item.allowedAssessmentIds !== undefined || item.allowedFeedEvidenceIds !== undefined)
    .map((item) => {
      const actual = judgment.ruleEvaluations.find((rule) => rule.ruleId === item.ruleId)?.predicateEvaluations.find((predicate) => predicate.predicate === item.predicate);
      const actualCitation = {
        evidenceIds: [...(actual?.evidenceIds ?? [])].sort(),
        assessmentIds: [...(actual?.assessmentIds ?? [])].sort(),
        feedEvidenceIds: [...(actual?.feedEvidenceIds ?? [])].sort(),
      };
      const allowed = { evidenceIds: item.allowedEvidenceIds, assessmentIds: item.allowedAssessmentIds, feedEvidenceIds: item.allowedFeedEvidenceIds };
      const match = subset(actualCitation.evidenceIds, item.allowedEvidenceIds)
        && subset(actualCitation.assessmentIds, item.allowedAssessmentIds)
        && subset(actualCitation.feedEvidenceIds, item.allowedFeedEvidenceIds);
      return { ruleId: item.ruleId, predicate: item.predicate, match, actual: actualCitation, allowed };
    });
  const ruleStatusMatches: Record<string, boolean> = {};
  for (const [ruleId, status] of Object.entries(expected?.ruleStatuses ?? {})) {
    ruleStatusMatches[ruleId] = judgment.ruleEvaluations.find((rule) => rule.ruleId === ruleId)?.status === status;
  }
  return {
    predicates,
    citations,
    ruleStatusMatches,
    finalDecision: decision,
    decisionMatch: expected?.finalDecision === undefined ? null : decision.decision === expected.finalDecision,
    reasonCodeMatch: expected?.reasonCode === undefined ? null : decision.reasonCode === expected.reasonCode,
  };
}

function subset(actual: string[], allowed: string[] | undefined): boolean {
  return allowed === undefined ? true : sameSet(actual, allowed);
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  const sortedLeft = [...new Set(left)].sort();
  const sortedRight = [...new Set(right)].sort();
  return sortedLeft.length === sortedRight.length && sortedLeft.every((value, index) => value === sortedRight[index]);
}

function normalizeUsage(usage: PolicyLlmUsage | undefined): NormalizedUsage | undefined {
  if (!usage) return undefined;
  const inputTokens = numberOrNull(usage.inputTokens);
  const outputTokens = numberOrNull(usage.outputTokens);
  const explicitTotal = numberOrNull(usage.totalTokens);
  const derived = explicitTotal === null && inputTokens !== null && outputTokens !== null;
  return {
    inputTokens,
    outputTokens,
    totalTokens: explicitTotal ?? (derived ? inputTokens + outputTokens : null),
    cachedInputTokens: numberOrNull(usage.cachedInputTokens),
    totalTokensDerived: derived,
  };
}

function numberOrNull(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function calculateCost(provider: string, model: string, usage: NormalizedUsage | undefined, pricing: PricingConfig[] | undefined): { cost: number | null; status: PolicyLlmComparisonResult['pricingStatus'] } {
  if (!pricing || pricing.length === 0) return { cost: null, status: 'NOT_CONFIGURED' };
  const config = pricing.find((item) => item.provider === provider && item.model === model);
  if (!config) return { cost: null, status: 'NOT_CONFIGURED' };
  if (!usage || usage.inputTokens === null || usage.outputTokens === null) return { cost: null, status: 'NOT_REPORTED' };
  if (!validPricing(config)) return { cost: null, status: 'NOT_CONFIGURED' };
  const cached = Math.min(usage.cachedInputTokens ?? 0, usage.inputTokens);
  const regularInput = Math.max(0, usage.inputTokens - cached);
  const inputCost = config.cachedInputCostPerToken === undefined
    ? usage.inputTokens * config.inputCostPerToken
    : regularInput * config.inputCostPerToken + cached * config.cachedInputCostPerToken;
  const cost = (inputCost + usage.outputTokens * config.outputCostPerToken) / config.tokenUnit;
  return Number.isFinite(cost) ? { cost: roundDecimal(cost), status: 'CALCULATED' } : { cost: null, status: 'NOT_CONFIGURED' };
}

function roundDecimal(value: number): number {
  return Math.round((value + Number.EPSILON) * 1e12) / 1e12;
}

function validPricing(value: PricingConfig): boolean {
  return typeof value.provider === 'string' && value.provider.trim().length > 0
    && typeof value.model === 'string' && value.model.trim().length > 0
    && typeof value.currency === 'string' && value.currency.trim().length > 0
    && Number.isFinite(value.inputCostPerToken) && value.inputCostPerToken >= 0
    && Number.isFinite(value.outputCostPerToken) && value.outputCostPerToken >= 0
    && Number.isSafeInteger(value.tokenUnit) && value.tokenUnit > 0
    && (value.cachedInputCostPerToken === undefined || (Number.isFinite(value.cachedInputCostPerToken) && value.cachedInputCostPerToken >= 0));
}

function buildReport(results: PolicyLlmComparisonResult[], fixtureCount: number, fixtureDatasetHash: string, options: PolicyLlmComparisonOptions, startedAt: string, completedAt: string): PolicyLlmComparisonReport {
  const providerNames = Object.keys(options.providers);
  const providers: PolicyLlmComparisonReport['providers'] = {};
  const validationFailures: PolicyLlmComparisonReport['validationFailures'] = [];
  const tokenUsage: PolicyLlmComparisonReport['tokenUsage'] = {};
  const estimatedCost: PolicyLlmComparisonReport['estimatedCost'] = {};
  for (const provider of providerNames) {
    const providerResults = results.filter((result) => result.provider === provider);
    providers[provider] = { model: providerResults.find((result) => result.model !== 'not-configured')?.model, summary: aggregateProviderResults(providerResults) };
    for (const result of providerResults) if (result.validationFailureCode) validationFailures.push({ fixtureId: result.fixtureId, provider, failureCode: result.validationFailureCode });
    const summary = providers[provider].summary;
    tokenUsage[provider] = { inputTokens: summary.inputTokens, outputTokens: summary.outputTokens, totalTokens: summary.totalTokens };
    estimatedCost[provider] = summary.estimatedCost;
  }
  return {
    harnessVersion: POLICY_LLM_COMPARISON_HARNESS_VERSION,
    mode: options.mode,
    startedAt,
    completedAt,
    promptVersion: POLICY_LLM_PROMPT_VERSION,
    fixtureCount,
    fixtureDatasetVersion: POLICY_LLM_COMPARISON_FIXTURE_DATASET_VERSION,
    fixtureDatasetHash,
    fixtures: results,
    providers,
    validationFailures,
    tokenUsage,
    pricing: { configured: (options.pricing?.length ?? 0) > 0, currency: options.pricing?.[0]?.currency, providers: (options.pricing ?? []).map((item) => `${item.provider}/${item.model}`), inputs: options.pricing ?? [] },
    estimatedCost,
    limitations: [
      'Evaluation-only output; no Primary, Shadow, audit, or Decision DB writes are performed.',
      'Positive/negative metrics include only predicates with explicit fixture polarity; negative UNKNOWN/CONFLICT is neither TN nor FP.',
      'Citation matches require exact set equality for every citation namespace declared by the fixture; undeclared comparisons are NOT_APPLICABLE.',
      'Rates with a zero denominator are null. Percentiles use nearest-rank over ascending attempted-request latencies.',
    ],
    pairwise: buildPairwiseComparisons(results, providerNames),
  };
}

export function aggregateProviderResults(results: readonly PolicyLlmComparisonResult[]): ProviderComparisonSummary {
  const completed = results.filter((result) => result.status === 'COMPLETED');
  const valid = completed.filter((result) => result.validation.succeeded === true);
  const predicates = results.flatMap((result) => result.predicates);
  const citations = results.flatMap((result) => result.citations);
  const ruleMatches = Object.values(results.flatMap((result) => Object.values(result.ruleStatusMatches)));
  const decisions = results.map((result) => result.decisionMatch).filter((value): value is boolean => value !== null);
  const reasons = results.map((result) => result.reasonCodeMatch).filter((value): value is boolean => value !== null);
  const latency = results.filter((result) => result.status !== 'SKIPPED').map((result) => result.latencyMs);
  const usage = sumUsage(results);
  const costs = results.map((result) => result.estimatedCost).filter((value): value is number => value !== null);
  const pricingStatus = completed.some((result) => result.pricingStatus === 'CALCULATED') ? 'CALCULATED' : completed.some((result) => result.pricingStatus === 'NOT_REPORTED') ? 'NOT_REPORTED' : 'NOT_CONFIGURED';
  const polarities = predicates.filter((predicate) => predicate.polarity !== undefined && predicate.actual !== undefined);
  const truePositive = polarities.filter((predicate) => predicate.polarity === 'POSITIVE' && predicate.actual === 'SUPPORTED').length;
  const falseNegative = polarities.filter((predicate) => predicate.polarity === 'POSITIVE' && predicate.actual !== 'SUPPORTED').length;
  const falsePositive = polarities.filter((predicate) => predicate.polarity === 'NEGATIVE' && predicate.actual === 'SUPPORTED').length;
  const trueNegative = polarities.filter((predicate) => predicate.polarity === 'NEGATIVE' && predicate.actual === 'NOT_SUPPORTED').length;
  const positiveCount = truePositive + falseNegative;
  const negativeCount = trueNegative + falsePositive;
  const reportedInput = results.map((result) => result.usage?.inputTokens).filter((value): value is number => value !== undefined && value !== null);
  const reportedOutput = results.map((result) => result.usage?.outputTokens).filter((value): value is number => value !== undefined && value !== null);
  const reportedTotal = results.map((result) => result.usage?.totalTokens).filter((value): value is number => value !== undefined && value !== null);
  return {
    fixtureCount: results.length,
    qualityEligibleFixtureCount: results.filter((result) => result.qualityEligible).length,
    completedFixtureCount: completed.length,
    validJudgmentCount: valid.length,
    validJudgmentRate: rate(valid.length, results.filter((result) => result.qualityEligible).length),
    predicateEvaluations: predicates.length,
    predicateStatusMatches: predicates.filter((predicate) => predicate.match).length,
    predicateStatusMatchRate: rate(predicates.filter((predicate) => predicate.match).length, predicates.length),
    citationComparisons: citations.length,
    citationMatches: citations.filter((citation) => citation.match).length,
    citationMatchRate: rate(citations.filter((citation) => citation.match).length, citations.length),
    ruleStatusComparisons: ruleMatches.length,
    ruleStatusMatches: ruleMatches.filter(Boolean).length,
    ruleStatusMatchRate: rate(ruleMatches.filter(Boolean).length, ruleMatches.length),
    decisionComparisons: decisions.length,
    decisionMatches: decisions.filter(Boolean).length,
    decisionMatchRate: rate(decisions.filter(Boolean).length, decisions.length),
    reasonCodeComparisons: reasons.length,
    reasonCodeMatches: reasons.filter(Boolean).length,
    reasonCodeMatchRate: rate(reasons.filter(Boolean).length, reasons.length),
    providerFailureCount: results.filter((result) => result.providerFailureCode !== undefined).length,
    validationFailureCount: results.filter((result) => result.validationFailureCode !== undefined).length,
    timeoutCount: results.filter((result) => result.timeout).length,
    failedRequestCount: results.filter((result) => result.status === 'FAILED').length,
    averageLatencyMs: latency.length === 0 ? null : latency.reduce((sum, value) => sum + value, 0) / latency.length,
    minimumLatencyMs: latency.length === 0 ? null : Math.min(...latency),
    maximumLatencyMs: latency.length === 0 ? null : Math.max(...latency),
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    estimatedCost: costs.length === 0 || costs.length !== completed.length ? null : roundDecimal(costs.reduce((sum, value) => sum + value, 0)),
    pricingStatus,
    falsePositive,
    falseNegative,
    truePositive,
    trueNegative,
    falsePositiveRate: rate(falsePositive, negativeCount),
    falseNegativeRate: rate(falseNegative, positiveCount),
    precision: rate(truePositive, truePositive + falsePositive),
    recall: rate(truePositive, truePositive + falseNegative),
    specificity: rate(trueNegative, trueNegative + falsePositive),
    accuracy: rate(truePositive + trueNegative, truePositive + trueNegative + falsePositive + falseNegative),
    undeterminedPredicateCount: predicates.filter((predicate) => predicate.actual === 'UNKNOWN' || predicate.actual === 'CONFLICT').length,
    p50LatencyMs: percentile(latency, 0.5),
    p95LatencyMs: percentile(latency, 0.95),
    averageInputTokens: average(reportedInput),
    averageOutputTokens: average(reportedOutput),
    averageTotalTokens: average(reportedTotal),
    averageEstimatedCostPerCompletedFixture: costs.length === 0 || costs.length !== completed.length ? null : roundDecimal(costs.reduce((sum, value) => sum + value, 0) / completed.length),
  };
}

function rate(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function average(values: readonly number[]): number | null {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Nearest-rank percentile: sorted[ceil(p*n)-1], for p in (0, 1]. */
function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] ?? null;
}

function sumUsage(results: readonly PolicyLlmComparisonResult[]): { inputTokens: number | null; outputTokens: number | null; totalTokens: number | null } {
  const usages = results.map((result) => result.usage);
  return {
    inputTokens: sumKnown(usages.map((usage) => usage?.inputTokens ?? null)),
    outputTokens: sumKnown(usages.map((usage) => usage?.outputTokens ?? null)),
    totalTokens: sumKnown(usages.map((usage) => usage?.totalTokens ?? null)),
  };
}

function sumKnown(values: Array<number | null>): number | null {
  const reported = values.filter((value): value is number => value !== null);
  return reported.length === 0 ? null : reported.reduce((sum, value) => sum + value, 0);
}

function buildPairwiseComparisons(results: readonly PolicyLlmComparisonResult[], providers: readonly string[]): ProviderPairwiseComparison[] {
  const pairs: ProviderPairwiseComparison[] = [];
  for (let leftIndex = 0; leftIndex < providers.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < providers.length; rightIndex += 1) {
      const leftName = providers[leftIndex]!;
      const rightName = providers[rightIndex]!;
      const leftResults = new Map(results.filter((result) => result.provider === leftName).map((result) => [result.fixtureId, result]));
      const rightResults = new Map(results.filter((result) => result.provider === rightName).map((result) => [result.fixtureId, result]));
      const fixtureIds = [...new Set([...leftResults.keys(), ...rightResults.keys()])].sort();
      const excludedFixtures: ProviderPairwiseComparison['excludedFixtures'] = [];
      const disagreements: ProviderPairwiseComparison['disagreements'] = [];
      const counts = {
        predicateStatus: { comparisons: 0, matches: 0 }, citationSet: { comparisons: 0, matches: 0 },
        ruleStatus: { comparisons: 0, matches: 0 }, finalDecision: { comparisons: 0, matches: 0 }, reasonCode: { comparisons: 0, matches: 0 },
      };
      let comparableFixtureCount = 0;
      for (const fixtureId of fixtureIds) {
        const left = leftResults.get(fixtureId);
        const right = rightResults.get(fixtureId);
        const reason = !left || !right ? 'PROVIDER_RESULT_MISSING'
          : left.status !== 'COMPLETED' ? `${left.status}:${left.providerFailureCode ?? left.validationFailureCode ?? left.limitations[0] ?? 'NO_RESULT'}`
            : right.status !== 'COMPLETED' ? `${right.status}:${right.providerFailureCode ?? right.validationFailureCode ?? right.limitations[0] ?? 'NO_RESULT'}`
              : left.validation.succeeded !== true ? `LEFT_VALIDATION_FAILED:${left.validationFailureCode ?? 'UNKNOWN'}`
                : right.validation.succeeded !== true ? `RIGHT_VALIDATION_FAILED:${right.validationFailureCode ?? 'UNKNOWN'}` : undefined;
        if (reason) { excludedFixtures.push({ fixtureId, reason }); continue; }
        comparableFixtureCount += 1;
        const mismatch: string[] = [];
        const leftJudgment = judgmentRecord(left!.rawJudgment);
        const rightJudgment = judgmentRecord(right!.rawJudgment);
        const leftRules = evaluationMap(leftJudgment);
        const rightRules = evaluationMap(rightJudgment);
        for (const ruleId of [...new Set([...leftRules.keys(), ...rightRules.keys()])].sort()) {
          const leftRule = leftRules.get(ruleId);
          const rightRule = rightRules.get(ruleId);
          if (leftRule?.status !== undefined || rightRule?.status !== undefined) {
            counts.ruleStatus.comparisons += 1;
            if (leftRule?.status === rightRule?.status) counts.ruleStatus.matches += 1;
            else mismatch.push(`ruleStatus:${ruleId}`);
          }
          const leftPredicates = new Map((leftRule?.predicateEvaluations ?? []).map((item) => [item.predicate, item]));
          const rightPredicates = new Map((rightRule?.predicateEvaluations ?? []).map((item) => [item.predicate, item]));
          for (const predicate of [...new Set([...leftPredicates.keys(), ...rightPredicates.keys()])].sort()) {
            const leftEvaluation = leftPredicates.get(predicate);
            const rightEvaluation = rightPredicates.get(predicate);
            counts.predicateStatus.comparisons += 1;
            if (leftEvaluation?.status === rightEvaluation?.status) counts.predicateStatus.matches += 1;
            else mismatch.push(`predicate:${ruleId}/${predicate}`);
            counts.citationSet.comparisons += 1;
            if (citationSetKey(leftEvaluation) === citationSetKey(rightEvaluation)) counts.citationSet.matches += 1;
            else mismatch.push(`citation:${ruleId}/${predicate}`);
          }
        }
        counts.finalDecision.comparisons += 1;
        if (left!.finalDecision?.decision === right!.finalDecision?.decision) counts.finalDecision.matches += 1;
        else mismatch.push('finalDecision');
        counts.reasonCode.comparisons += 1;
        if (left!.finalDecision?.reasonCode === right!.finalDecision?.reasonCode) counts.reasonCode.matches += 1;
        else mismatch.push('reasonCode');
        if (mismatch.length > 0) disagreements.push({ fixtureId, items: mismatch });
      }
      pairs.push({
        providers: [leftName, rightName], comparableFixtureCount, excludedFixtures,
        predicateStatus: { ...counts.predicateStatus, matchRate: rate(counts.predicateStatus.matches, counts.predicateStatus.comparisons) },
        citationSet: { ...counts.citationSet, matchRate: rate(counts.citationSet.matches, counts.citationSet.comparisons) },
        ruleStatus: { ...counts.ruleStatus, matchRate: rate(counts.ruleStatus.matches, counts.ruleStatus.comparisons) },
        finalDecision: { ...counts.finalDecision, matchRate: rate(counts.finalDecision.matches, counts.finalDecision.comparisons) },
        reasonCode: { ...counts.reasonCode, matchRate: rate(counts.reasonCode.matches, counts.reasonCode.comparisons) },
        disagreements,
      });
    }
  }
  return pairs;
}

function judgmentRecord(value: unknown): { ruleEvaluations?: Array<{ ruleId?: string; status?: string; predicateEvaluations?: Array<{ predicate?: string; status?: string; evidenceIds?: string[]; assessmentIds?: string[]; feedEvidenceIds?: string[] }> }> } {
  return value !== null && typeof value === 'object' && Array.isArray((value as { ruleEvaluations?: unknown }).ruleEvaluations)
    ? value as { ruleEvaluations: Array<{ ruleId?: string; status?: string; predicateEvaluations?: Array<{ predicate?: string; status?: string; evidenceIds?: string[]; assessmentIds?: string[]; feedEvidenceIds?: string[] }> }> }
    : {};
}

function evaluationMap(judgment: ReturnType<typeof judgmentRecord>): Map<string, NonNullable<ReturnType<typeof judgmentRecord>['ruleEvaluations']>[number]> {
  return new Map((judgment.ruleEvaluations ?? []).filter((item): item is typeof item & { ruleId: string } => typeof item.ruleId === 'string').map((item) => [item.ruleId, item]));
}

function citationSetKey(value: { evidenceIds?: string[]; assessmentIds?: string[]; feedEvidenceIds?: string[] } | undefined): string {
  return hashCanonical({ evidenceIds: [...new Set(value?.evidenceIds ?? [])].sort(), assessmentIds: [...new Set(value?.assessmentIds ?? [])].sort(), feedEvidenceIds: [...new Set(value?.feedEvidenceIds ?? [])].sort() });
}

function hashCanonical(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

async function withTimeout<T>(operation: (signal: AbortSignal) => Promise<T>, timeoutMs: number, parentSignal?: AbortSignal): Promise<T> {
  if (parentSignal?.aborted) throw new PolicyLlmError('POLICY_LLM_ABORTED');
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    const operationPromise = operation(controller.signal);
    const timeoutPromise = new Promise<T>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new PolicyLlmError('POLICY_LLM_TIMEOUT', true)); }, timeoutMs); });
    const abortPromise = parentSignal ? new Promise<T>((_, reject) => {
      onAbort = () => { controller.abort(); reject(new PolicyLlmError('POLICY_LLM_ABORTED')); };
      parentSignal.addEventListener('abort', onAbort, { once: true });
    }) : undefined;
    return await Promise.race(abortPromise ? [operationPromise, timeoutPromise, abortPromise] : [operationPromise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
    if (parentSignal && onAbort) parentSignal.removeEventListener('abort', onAbort);
  }
}

function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => {
      if (/api[-_]?key|authorization|secret|token/iu.test(key)) return [key, '[REDACTED]'];
      return [key, redactSecrets(item)];
    }));
  }
  if (typeof value === 'string') return value
    .replace(/Bearer\s+[^\s"']+/giu, 'Bearer [REDACTED]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|sk-ant-[A-Za-z0-9_-]{16,})\b/giu, '[REDACTED]')
    .replace(/((?:api[-_ ]?key|authorization|secret|access[-_ ]?token)\s*[:=]\s*["']?)[^\s,"'}]+/giu, '$1[REDACTED]');
  return value;
}

export function renderPolicyLlmComparisonCsv(report: PolicyLlmComparisonReport): string {
  const headers = [
    'fixtureId', 'provider', 'model', 'status', 'validation', 'decision', 'reasonCode', 'latencyMs', 'inputTokens', 'outputTokens', 'totalTokens', 'estimatedCost',
    'harnessVersion', 'mode', 'fixtureDatasetVersion', 'fixtureDatasetHash', 'qualityEligible', 'exclusionReason', 'promptVersion', 'policyVersion', 'policySnapshotHash', 'promptHash', 'inputHash', 'inputFailureCode', 'validationFailureCode', 'providerFailureCode', 'pricingStatus', 'rowType', 'pairwiseProviders', 'comparableFixtureCount',
    'predicateStatusComparisons', 'predicateStatusMatches', 'predicateStatusMatchRate', 'citationSetComparisons', 'citationSetMatches', 'citationSetMatchRate', 'ruleStatusComparisons', 'ruleStatusMatches', 'ruleStatusMatchRate', 'decisionComparisons', 'decisionMatches', 'decisionMatchRate', 'reasonCodeComparisons', 'reasonCodeMatches', 'reasonCodeMatchRate', 'excludedFixtures', 'disagreements',
  ];
  const rows: unknown[][] = report.fixtures.map((result) => [
    result.fixtureId, result.provider, result.model, result.status, result.validation.succeeded, result.finalDecision?.decision ?? '', result.finalDecision?.reasonCode ?? '', result.latencyMs,
    result.usage?.inputTokens ?? '', result.usage?.outputTokens ?? '', result.usage?.totalTokens ?? '', result.estimatedCost ?? '', report.harnessVersion, report.mode, result.fixtureDatasetVersion,
    result.fixtureDatasetHash, result.qualityEligible, result.exclusionReason ?? '', result.promptVersion, result.policyVersion, result.policySnapshotHash, result.promptHash, result.inputHash,
    result.inputFailureCode ?? '', result.validationFailureCode ?? '', result.providerFailureCode ?? '', result.pricingStatus, 'FIXTURE', ...Array.from({ length: 19 }, () => ''),
  ]);
  for (const pair of report.pairwise) {
    rows.push([
      '', '', '', '', '', '', '', '', '', '', '', '', report.harnessVersion, report.mode, report.fixtureDatasetVersion, report.fixtureDatasetHash, '', '', report.promptVersion, '', '', '', '', '', '', '', '', 'PAIRWISE', pair.providers.join('/'), pair.comparableFixtureCount,
      pair.predicateStatus.comparisons, pair.predicateStatus.matches, pair.predicateStatus.matchRate ?? '', pair.citationSet.comparisons, pair.citationSet.matches, pair.citationSet.matchRate ?? '', pair.ruleStatus.comparisons, pair.ruleStatus.matches, pair.ruleStatus.matchRate ?? '',
      pair.finalDecision.comparisons, pair.finalDecision.matches, pair.finalDecision.matchRate ?? '', pair.reasonCode.comparisons, pair.reasonCode.matches, pair.reasonCode.matchRate ?? '', JSON.stringify(pair.excludedFixtures), JSON.stringify(pair.disagreements),
    ]);
  }
  return [headers, ...rows].map((row) => row.map((value) => csvCell(value)).join(',')).join('\n') + '\n';
}

function csvCell(value: unknown): string {
  const stringValue = String(value ?? '');
  return /[",\n]/u.test(stringValue) ? `"${stringValue.replace(/"/gu, '""')}"` : stringValue;
}
