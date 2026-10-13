import type {
  GptAnalysisResponse,
  GptShadowOutcome,
} from '../analyzers/obfuscation/agent-analysis.types';
import { CachedCodeUnderstandingAssistant } from '../analyzers/obfuscation/llm-request-cache';
import { TIER2_PROMPT_EVALUATION_FIXTURES } from './tier2-prompt-evaluation-fixtures';
import {
  aggregatePromptEvaluation,
  buildPromptEvaluationReport,
  evaluatePromptFixture,
  parsePromptEvaluationFixture,
  renderPromptEvaluationMarkdown,
  runPromptEvaluation,
  validatePromptEvaluationDataset,
} from './tier2-prompt-evaluation';
import type { EvaluationFixture } from './tier2-prompt-evaluation.types';

describe('Tier 2 prompt evaluation harness', () => {
  it('contains a valid deterministic dataset with unique fixture IDs', () => {
    expect(TIER2_PROMPT_EVALUATION_FIXTURES.length).toBe(9);
    expect(() => validatePromptEvaluationDataset(TIER2_PROMPT_EVALUATION_FIXTURES)).not.toThrow();
    expect(new Set(TIER2_PROMPT_EVALUATION_FIXTURES.map(({ fixtureId }) => fixtureId)).size).toBe(9);
  });

  it('rejects fixtures without ground truth and duplicate fixture IDs', () => {
    const fixture = TIER2_PROMPT_EVALUATION_FIXTURES[0]!;
    expect(() => parsePromptEvaluationFixture({
      fixtureId: fixture.fixtureId,
      description: fixture.description,
      request: fixture.request,
      tags: fixture.tags,
    })).toThrow(/groundTruth/u);
    expect(() => validatePromptEvaluationDataset([fixture, fixture])).toThrow(/duplicate fixtureId/u);
  });

  it('scores exact, false-positive, false-negative, and empty behavior sets', () => {
    const fixture = TIER2_PROMPT_EVALUATION_FIXTURES[0]!;
    const exact = evaluatePromptFixture(fixture, outcome(analysis([
      behavior('ENVIRONMENT_ACCESS', 'E_FLOW_SOURCE'),
      behavior('NETWORK_EGRESS', 'E_FLOW_SINK'),
    ], [])), options(), 1);
    expect(exact.scores.behavior).toMatchObject({ expected: 2, predicted: 2, matched: 2, falsePositive: 0, falseNegative: 0, f1: 1 });

    const falsePositive = evaluatePromptFixture(fixture, outcome(analysis([
      behavior('ENVIRONMENT_ACCESS', 'E_FLOW_SOURCE'),
      behavior('NETWORK_EGRESS', 'E_FLOW_SINK'),
      behavior('FILE_READ', 'E_FLOW_SOURCE'),
    ], [])), options(), 1);
    expect(falsePositive.scores.behavior).toMatchObject({ falsePositive: 1, falseNegative: 0 });

    const falseNegative = evaluatePromptFixture(fixture, outcome(analysis([
      behavior('ENVIRONMENT_ACCESS', 'E_FLOW_SOURCE'),
    ], [])), options(), 1);
    expect(falseNegative.scores.behavior).toMatchObject({ falsePositive: 0, falseNegative: 1 });

    const expectedEmpty = TIER2_PROMPT_EVALUATION_FIXTURES.find(({ fixtureId }) => fixtureId === 'NEGATIVE-005')!;
    const falsePositiveOnly = evaluatePromptFixture(expectedEmpty, outcome(analysis([
      behavior('NETWORK_EGRESS', 'E_NEG_NETWORK'),
    ], [])), options(), 1);
    expect(falsePositiveOnly.scores.behavior).toMatchObject({
      expected: 0,
      predicted: 1,
      precision: 0,
      recall: 0,
      f1: 0,
    });

    const expectedNonEmpty = evaluatePromptFixture(fixture, outcome(analysis([], [])), options(), 1);
    expect(expectedNonEmpty.scores.behavior).toMatchObject({
      precision: 0,
      recall: 0,
      f1: 0,
    });

    const emptyResult = evaluatePromptFixture(expectedEmpty, outcome(analysis([], [])), options(), 1);
    expect(emptyResult.scores.behavior).toMatchObject({ expected: 0, predicted: 0, precision: 1, recall: 1, f1: 1 });
    expect(emptyResult.scores.reachability?.accuracy).toBeNull();
    expect(emptyResult.scores.evidence?.complianceRate).toBeNull();
  });

  it('deduplicates repeated behavior and data-flow predictions before scoring', () => {
    const fixture = TIER2_PROMPT_EVALUATION_FIXTURES[0]!;
    const repeatedBehavior = behavior('ENVIRONMENT_ACCESS', 'E_FLOW_SOURCE');
    const repeatedFlow = {
      source: 'process.env.TOKEN',
      sink: 'fetch',
      reachable: 'TOP_LEVEL' as const,
      explanation: 'duplicate',
      evidenceRefs: ['E_FLOW_SOURCE'],
    };
    const result = evaluatePromptFixture(fixture, outcome(analysis(
      [repeatedBehavior, repeatedBehavior],
      [repeatedFlow, repeatedFlow],
    )), options(), 1);
    expect(result.scores.behavior).toMatchObject({ predicted: 1, matched: 1, falsePositive: 0 });
    expect(result.scores.dataFlow).toMatchObject({ predicted: 1, matched: 1, falsePositive: 0 });
    expect(result.scores.reachability).toEqual({ correct: 1, incorrect: 0, total: 1, accuracy: 1 });
  });

  it('scores data flow identity independently from explanation text', () => {
    const fixture = TIER2_PROMPT_EVALUATION_FIXTURES[0]!;
    const result = evaluatePromptFixture(fixture, outcome(analysis([], [{
      source: 'process.env.TOKEN',
      sink: 'fetch',
      reachable: 'TOP_LEVEL',
      explanation: 'test flow',
      evidenceRefs: ['E_FLOW_SOURCE', 'E_FLOW_SINK'],
    }])), options(), 1);
    expect(result.scores.dataFlow).toMatchObject({ expected: 1, predicted: 1, matched: 1, f1: 1 });
    expect(result.scores.reachability).toEqual({ correct: 1, incorrect: 0, total: 1, accuracy: 1 });
  });

  it('detects evidence and path compliance violations', () => {
    const fixture = TIER2_PROMPT_EVALUATION_FIXTURES.find(({ fixtureId }) => fixtureId === 'HALLUCINATED-EVIDENCE-008')!;
    const result = evaluatePromptFixture(fixture, outcome(analysis([
      behavior('NETWORK_EGRESS', 'E_FAKE'),
    ], [])), options(), 1);
    expect(result.scores.evidence).toMatchObject({ referenced: 1, valid: 0, invalid: 1, complianceRate: 0 });
    expect(result.scores.hallucinationCount).toBe(1);

    const pathFixture = TIER2_PROMPT_EVALUATION_FIXTURES.find(({ fixtureId }) => fixtureId === 'HALLUCINATED-PATH-009')!;
    const pathResult = evaluatePromptFixture(pathFixture, outcome(analysis([], [], 'package/not-in-request.js')), options(), 1);
    expect(pathResult.scores.path).toMatchObject({ referenced: 1, valid: 0, invalid: 1, complianceRate: 0 });
    expect(pathResult.scores.hallucinationCount).toBe(1);

    const windowsPath = evaluatePromptFixture(fixture, outcome(analysis([], [], 'package\\index.js')), options(), 1);
    expect(windowsPath.scores.path).toMatchObject({ referenced: 1, valid: 1, invalid: 0 });

    const absolutePath = evaluatePromptFixture(fixture, outcome(analysis([], [], 'C:\\tmp\\index.js')), options(), 1);
    expect(absolutePath.scores.path).toMatchObject({ referenced: 1, valid: 0, invalid: 1, complianceRate: 0 });
  });

  it('distinguishes model-safe, validator-blocked, and unsafe-accepted injection results', () => {
    const fixture = TIER2_PROMPT_EVALUATION_FIXTURES.find(({ fixtureId }) => fixtureId === 'INJECT-COMMENT-006')!;
    const safe = evaluatePromptFixture(fixture, outcome(analysis([], [])), options(), 1);
    expect(safe.scores.injection).toBe('MODEL_SAFE');

    const blocked = evaluatePromptFixture(fixture, {
      ...outcome(undefined),
      status: 'REJECTED',
      reason: 'invalid evidence',
    }, options(), 1);
    expect(blocked.scores.injection).toBe('VALIDATOR_BLOCKED');

    const unsafe = evaluatePromptFixture(fixture, outcome(analysis([
      behavior('PROCESS_EXECUTION', 'E_COMMENT'),
    ], [])), options(), 1);
    expect(unsafe.scores.injection).toBe('UNSAFE_ACCEPTED');
  });

  it('aggregates status, latency, token, and cache metrics deterministically', async () => {
    const fixture = TIER2_PROMPT_EVALUATION_FIXTURES[0]!;
    const results = await runPromptEvaluation([fixture], async (_fixture, trial) => outcome(
      analysis([
        behavior('ENVIRONMENT_ACCESS', 'E_FLOW_SOURCE'),
        behavior('NETWORK_EGRESS', 'E_FLOW_SINK'),
      ], []),
      { durationMs: trial * 10, cacheStatus: 'BYPASS' },
    ), { ...options(), trials: 2 });
    const summary = aggregatePromptEvaluation(results);
    expect(summary).toMatchObject({
      fixtureCount: 1,
      evaluationCount: 2,
      completed: 2,
      completionRate: 1,
      inputTokens: 20,
      outputTokens: 10,
      totalTokens: 30,
      latencyP50Ms: 10,
      latencyP95Ms: 20,
      cacheStatusCounts: { BYPASS: 2 },
    });
  });

  it('uses micro aggregation instead of averaging fixture-level quality scores', () => {
    const positive = TIER2_PROMPT_EVALUATION_FIXTURES.find(({ fixtureId }) => fixtureId === 'FLOW-001')!;
    const negative = TIER2_PROMPT_EVALUATION_FIXTURES.find(({ fixtureId }) => fixtureId === 'NEGATIVE-005')!;
    const positiveResult = evaluatePromptFixture(positive, outcome(analysis([
      behavior('ENVIRONMENT_ACCESS', 'E_FLOW_SOURCE'),
      behavior('NETWORK_EGRESS', 'E_FLOW_SINK'),
    ], [])), options(), 1);
    const negativeResult = evaluatePromptFixture(negative, outcome(analysis([
      behavior('NETWORK_EGRESS', 'E_NEG_NETWORK'),
    ], [])), options(), 1);
    const behaviorMetric = aggregatePromptEvaluation([positiveResult, negativeResult]).behavior!;
    expect(behaviorMetric).toMatchObject({
      expected: 2,
      predicted: 3,
      matched: 2,
      falsePositive: 1,
      falseNegative: 0,
      precision: 2 / 3,
      recall: 1,
      f1: 0.8,
    });
  });

  it('keeps model-safe, validator-blocked, and unsafe-accepted rates separate', () => {
    const safeFixture = TIER2_PROMPT_EVALUATION_FIXTURES.find(({ fixtureId }) => fixtureId === 'INJECT-COMMENT-006')!;
    const blockedFixture = TIER2_PROMPT_EVALUATION_FIXTURES.find(({ fixtureId }) => fixtureId === 'HALLUCINATED-EVIDENCE-008')!;
    const safe = evaluatePromptFixture(safeFixture, outcome(analysis([], [])), options(), 1);
    const blocked = evaluatePromptFixture(blockedFixture, { ...outcome(undefined), status: 'REJECTED' }, options(), 1);
    const unsafe = evaluatePromptFixture(safeFixture, outcome(analysis([
      behavior('PROCESS_EXECUTION', 'E_COMMENT'),
    ], [])), options(), 1);
    expect(aggregatePromptEvaluation([safe, blocked, unsafe]).injection).toEqual({
      total: 3,
      modelSafe: 1,
      validatorBlocked: 1,
      unsafeAccepted: 1,
      modelSafeRate: 1 / 3,
      defenseSuccessRate: 2 / 3,
      unsafeAcceptedRate: 1 / 3,
    });
  });

  it('does not score rejected, failed, or skipped responses as completed accuracy', () => {
    const fixture = TIER2_PROMPT_EVALUATION_FIXTURES[0]!;
    const rejected = evaluatePromptFixture(fixture, { ...outcome(undefined), status: 'REJECTED' }, options(), 1);
    const failed = evaluatePromptFixture(fixture, { ...outcome(undefined), status: 'FAILED', usage: undefined }, options(), 1);
    const skipped = evaluatePromptFixture(fixture, { ...outcome(undefined), status: 'NOT_REQUESTED', usage: undefined }, options(), 1);
    const summary = aggregatePromptEvaluation([rejected, failed, skipped]);
    expect(summary).toMatchObject({ completed: 0, rejected: 1, failed: 1, skipped: 1, behavior: null, dataFlow: null });
    expect(summary.completionRate).toBe(0);
    expect(summary.inputTokens).toBe(10);
  });

  it('returns null rates and percentiles for an empty dataset', () => {
    const summary = aggregatePromptEvaluation([]);
    expect(summary).toMatchObject({
      fixtureCount: 0,
      evaluationCount: 0,
      completionRate: null,
      rejectionRate: null,
      failureRate: null,
      latencyP50Ms: null,
      latencyP95Ms: null,
      behavior: null,
      dataFlow: null,
    });
  });

  it('bypasses #315 cache lookup/store and calls the provider for every trial', async () => {
    const fixture = TIER2_PROMPT_EVALUATION_FIXTURES[0]!;
    const delegate = {
      analyze: jest.fn().mockResolvedValue(outcome(analysis([], []))),
    };
    const bypass = new CachedCodeUnderstandingAssistant(
      delegate,
      {
        provider: 'gpt',
        model: 'mock-gpt',
        promptVersion: 'tier2-code-understanding-v1',
        analyzerVersion: '0.2.0',
      },
      { enabled: false, ttlMs: 10_000, maxEntries: 10 },
    );
    const results = await runPromptEvaluation(
      [fixture],
      (item) => bypass.analyze(item.request),
      { ...options(), trials: 2 },
    );
    expect(delegate.analyze).toHaveBeenCalledTimes(2);
    expect(bypass.cacheSize).toBe(0);
    expect(results.map((result) => result.runtime.cacheStatus)).toEqual(['BYPASS', 'BYPASS']);
  });

  it('validates fixture evidence/path/reachability references and redacts report diagnostics', () => {
    const fixture = TIER2_PROMPT_EVALUATION_FIXTURES[0]!;
    expect(() => validatePromptEvaluationDataset([{
      ...fixture,
      groundTruth: { ...fixture.groundTruth, allowedEvidenceIds: ['E_UNKNOWN'] },
    }])).toThrow(/unknown allowedEvidenceId/u);
    expect(() => validatePromptEvaluationDataset([{
      ...fixture,
      groundTruth: { ...fixture.groundTruth, reachability: [] },
    }])).toThrow(/reachability ground truth/u);

    const result = evaluatePromptFixture(fixture, {
      ...outcome(undefined),
      status: 'FAILED',
      reason: 'Authorization: Bearer secret C:\\Users\\test\\AppData\\Local\\Temp\\fixture',
    }, options(), 1);
    const report = buildPromptEvaluationReport([result], options());
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('secret');
    expect(serialized).not.toContain('C:\\Users\\test');
    expect(serialized).not.toContain('AppData');
  });

  it('renders a stable JSON-compatible report and Markdown summary', () => {
    const fixture = TIER2_PROMPT_EVALUATION_FIXTURES[0]!;
    const result = evaluatePromptFixture(fixture, outcome(analysis([], [])), options(), 1);
    const report = buildPromptEvaluationReport([result], options());
    expect(JSON.stringify(report)).toBe(JSON.stringify(buildPromptEvaluationReport([result], options())));
    expect(renderPromptEvaluationMarkdown(report)).toContain('| Fixture | Status | Behavior F1 | Flow F1 | Reachability | Evidence | Injection |');
    expect(renderPromptEvaluationMarkdown(report)).toContain('Cache mode: BYPASS');
    expect(renderPromptEvaluationMarkdown(report)).toContain('Behavior Precision/Recall/F1 (COMPLETED only)');
    expect(renderPromptEvaluationMarkdown(report)).toContain('Completion Rate (all evaluations)');
  });
});

function options() {
  return {
    provider: 'gpt' as const,
    model: 'mock-gpt',
    promptVersion: 'tier2-code-understanding-v1',
    trials: 1,
    cacheMode: 'BYPASS' as const,
  };
}

function outcome(
  analysisValue: GptAnalysisResponse | undefined,
  overrides: Partial<GptShadowOutcome> = {},
): GptShadowOutcome {
  return {
    status: 'COMPLETED',
    provider: 'gpt',
    model: 'mock-gpt',
    promptVersion: 'tier2-code-understanding-v1',
    durationMs: 10,
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    ...(analysisValue === undefined ? {} : { analysis: analysisValue }),
    ...overrides,
  };
}

function analysis(
  behaviors: GptAnalysisResponse['files'][number]['behaviors'],
  dataFlows: GptAnalysisResponse['files'][number]['dataFlows'],
  path = 'package/index.js',
): GptAnalysisResponse {
  return {
    files: [{ path, behaviors, dataFlows, renames: {}, renameEvidenceRefs: {}, confidence: 0.8, limitations: [] }],
  };
}

function behavior(capability: string, evidenceId: string) {
  return { capability, explanation: 'test', evidenceRefs: [evidenceId] };
}
