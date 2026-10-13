import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { FixturePolicyLlmProvider, PolicyLlmError, type PolicyLlmProvider } from '../llm/policy-llm.provider';
import { buildPolicyLlmComparisonFixtures } from './policy-llm-comparison.fixtures';
import { PolicyLlmComparisonFixtureProvider } from './policy-llm-comparison.fixture-provider';
import { aggregateProviderResults, renderPolicyLlmComparisonCsv, runPolicyLlmComparison, type PolicyLlmComparisonResult } from './policy-llm-comparison.harness';

function fixtureProvider(withUsage = false, model = 'fixture-model'): PolicyLlmProvider {
  const delegate = new PolicyLlmComparisonFixtureProvider(model);
  return {
    async analyze(input, signal) {
      const result = await delegate.analyze(input, signal);
      return { ...result, usage: withUsage ? { inputTokens: 100, outputTokens: 40, totalTokens: 140 } : undefined };
    },
  };
}

test('comparison harness applies the same prompt hash and Resolver to two offline Providers', async () => {
  const fixtures = buildPolicyLlmComparisonFixtures();
  const report = await runPolicyLlmComparison(fixtures, {
    mode: 'fixture',
    providers: { gpt: { provider: fixtureProvider(true, 'gpt-fixture'), model: 'gpt-fixture' }, claude: { provider: fixtureProvider(true, 'claude-fixture'), model: 'claude-fixture' } },
    timeoutMs: 1_000,
    pricing: [
      { provider: 'gpt', model: 'gpt-fixture', currency: 'USD', inputCostPerToken: 1, outputCostPerToken: 2, tokenUnit: 1_000 },
    ],
  });

  assert.equal(report.fixtureCount, buildPolicyLlmComparisonFixtures().length);
  assert.equal(report.fixtures.length, report.fixtureCount * 2);
  assert.equal(report.fixtures[0]?.inputHash, report.fixtures[1]?.inputHash);
  assert.equal(report.providers.gpt?.summary.validJudgmentCount, report.providers.gpt?.summary.completedFixtureCount);
  assert.equal(report.providers.claude?.summary.validJudgmentCount, report.providers.claude?.summary.completedFixtureCount);
  assert.equal(report.providers.gpt?.summary.qualityEligibleFixtureCount, report.fixtureCount - 2);
  assert.equal(report.providers.gpt?.summary.validJudgmentRate, 1);
  assert.equal(report.providers.gpt?.summary.estimatedCost, Number(((report.providers.gpt?.summary.completedFixtureCount ?? 0) * 0.18).toFixed(12)));
  assert.equal(report.providers.claude?.summary.estimatedCost, null);
  assert.equal(report.providers.claude?.summary.pricingStatus, 'NOT_CONFIGURED');
  assert.equal(report.pairwise[0]?.providers.join('/'), 'gpt/claude');
  assert.equal(report.pairwise[0]?.comparableFixtureCount, report.fixtureCount - 2);
  assert.match(renderPolicyLlmComparisonCsv(report), /PAIRWISE,gpt\/claude,18/u);
  const rejected = report.fixtures.find((item) => item.fixtureId === 'rejected-assessment-excluded' && item.provider === 'gpt');
  assert.equal(rejected?.status, 'SKIPPED');
  assert.match(rejected?.inputFailureCode ?? '', /INVALID_LLM_ASSESSMENT/u);
  assert.equal(report.fixtures.find((item) => item.fixtureId === 'unverified-assessment-excluded' && item.provider === 'gpt')?.qualityEligible, false);
  assert.ok(report.fixtures.every((result) => result.qualityEligible
    ? result.promptHash?.length === 64 && result.inputHash?.length === 64 && result.policySnapshotHash.length === 64 && result.fixtureDatasetHash === report.fixtureDatasetHash
    : result.promptHash === null && result.inputHash === null && result.inputFailureCode !== undefined));
});

test('comparison harness isolates failed, invalid, timed out, and unconfigured Providers', async () => {
  const fixtures = buildPolicyLlmComparisonFixtures().slice(0, 1);
  const invalid: PolicyLlmProvider = { analyze: async () => ({ judgment: { invalid: true }, model: 'invalid', durationMs: 1 }) };
  const failed: PolicyLlmProvider = { analyze: async () => { throw new PolicyLlmError('POLICY_LLM_TRANSPORT_FAILED', true); } };
  const timeout: PolicyLlmProvider = { analyze: async (_input, signal) => await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new PolicyLlmError('POLICY_LLM_ABORTED')), { once: true })) };
  const report = await runPolicyLlmComparison(fixtures, {
    mode: 'fixture',
    providers: { gpt: { provider: invalid, model: 'invalid' }, claude: { provider: failed, model: 'failed' }, timeout: { provider: timeout, model: 'timeout' }, missing: undefined },
    timeoutMs: 5,
  });
  assert.equal(report.providers.gpt?.summary.validationFailureCount, 1);
  assert.equal(report.providers.claude?.summary.providerFailureCount, 1);
  assert.equal(report.providers.timeout?.summary.timeoutCount, 1);
  assert.equal(report.providers.missing?.summary.fixtureCount, 1);
  assert.equal(report.providers.missing?.summary.providerFailureCount, 0);
  assert.equal(report.validationFailures.length, 1);
});

test('comparison aggregation returns null for empty and unreported metrics', () => {
  const empty = aggregateProviderResults([]);
  assert.equal(empty.validJudgmentRate, null);
  assert.equal(empty.averageLatencyMs, null);
  assert.equal(empty.inputTokens, null);
  assert.equal(empty.falsePositive, 0);
  assert.equal(empty.falseNegative, 0);
  assert.equal(empty.falsePositiveRate, null);
  assert.equal(empty.falseNegativeRate, null);
  assert.equal(empty.accuracy, null);
  assert.equal(empty.p95LatencyMs, null);
  assert.equal(empty.averageTotalTokens, null);
});

function result(overrides: Partial<PolicyLlmComparisonResult> = {}): PolicyLlmComparisonResult {
  return {
    fixtureId: 'fixture', description: 'test', provider: 'gpt', model: 'mock', promptVersion: 'test', policyKey: 'policy', policyVersion: '1',
    policySnapshotHash: 'a'.repeat(64), promptHash: 'b'.repeat(64), fixtureDatasetVersion: 'fixtures-v2', fixtureDatasetHash: 'c'.repeat(64), inputHash: 'd'.repeat(64),
    startedAt: '2026-01-01T00:00:00.000Z', completedAt: '2026-01-01T00:00:00.001Z', latencyMs: 1, status: 'COMPLETED', qualityEligible: true,
    validation: { succeeded: true, expectationMatch: null }, predicates: [], citations: [], ruleStatusMatches: {}, decisionMatch: null, reasonCodeMatch: null,
    timeout: false, estimatedCost: null, pricingStatus: 'NOT_CONFIGURED', limitations: [], ...overrides,
  };
}

test('fixed fixture IDs and citation references are valid against the Policy registry and active Rules', () => {
  const fixtures = buildPolicyLlmComparisonFixtures();
  assert.equal(new Set(fixtures.map(({ fixtureId }) => fixtureId)).size, fixtures.length);
  const root = resolve(__dirname, '../../../..');
  const registry = readFileSync(resolve(root, 'infra/postgres/migrations/policy/003_predicate_registry.sql'), 'utf8');
  const rules = `${readFileSync(resolve(root, 'infra/postgres/migrations/policy/002_qa_fixture.sql'), 'utf8')}\n${readFileSync(resolve(root, 'infra/postgres/migrations/policy/004_expand_qa_policy.sql'), 'utf8')}\n${readFileSync(resolve(root, 'apps/policy/src/policy/default-policy.ts'), 'utf8')}`;
  const priorities = readFileSync(resolve(root, 'infra/postgres/migrations/policy/005_qa_policy_priority_range.sql'), 'utf8');
  for (const item of fixtures) {
    const evidenceIds = new Set(item.request.evidences.filter((entry) => entry.kind !== 'LLM_ASSESSMENT').map((entry) => entry.evidenceId));
    const assessmentIds = new Set(item.request.evidences.filter((entry) => entry.kind === 'LLM_ASSESSMENT').map((entry) => entry.provenance.assessmentId));
    const feedIds = new Set(item.request.osvFeed.advisories.map((advisory) => `osv:${String(advisory.id)}`));
    for (const rule of item.policy.rules) {
      assert.ok(rules.includes(rule.ruleId), `unregistered Rule ${rule.ruleId}`);
      if (rule.ruleId.startsWith('RULE-')) assert.ok(priorities.includes(`('${rule.ruleId}', ${rule.priority})`), `priority drift for ${rule.ruleId}`);
      for (const { predicate } of [...(rule.when.allOf ?? []), ...(rule.when.anyOf ?? [])]) assert.ok(registry.includes(`('${predicate}'`), `unregistered Predicate ${predicate}`);
    }
    for (const definition of item.policy.predicateCatalog ?? []) assert.ok(registry.includes(`('${definition.code}', '${definition.description}'`), `Predicate definition drift for ${definition.code}`);
    for (const expected of item.expected?.predicates ?? []) {
      for (const id of expected.allowedEvidenceIds ?? []) assert.ok(evidenceIds.has(id), `unknown Evidence ${id}`);
      for (const id of expected.allowedAssessmentIds ?? []) assert.ok(assessmentIds.has(id), `unknown Assessment ${id}`);
      for (const id of expected.allowedFeedEvidenceIds ?? []) assert.ok(feedIds.has(id), `unknown Feed Evidence ${id}`);
    }
  }
  const rejected = fixtures.find((item) => item.fixtureId === 'rejected-assessment-excluded')!;
  assert.equal(rejected.expected?.qualityEligible, false);
  assert.match(rejected.expected?.exclusionReason ?? '', /INVALID_LLM_ASSESSMENT/u);
  const unverified = fixtures.find((item) => item.fixtureId === 'unverified-assessment-excluded')!;
  assert.equal(unverified.expected?.qualityEligible, false);
  assert.equal(unverified.request.evidences.find((entry) => entry.kind === 'LLM_ASSESSMENT')?.verificationStatus, 'UNVERIFIED');
});

test('confusion metrics classify TP/TN/FP/FN and exclude unknown negative samples from rates', () => {
  const summary = aggregateProviderResults([
    result({ fixtureId: 'tp', predicates: [{ ruleId: 'R', predicate: 'P', expected: 'SUPPORTED', actual: 'SUPPORTED', match: true, polarity: 'POSITIVE' }] }),
    result({ fixtureId: 'tn', predicates: [{ ruleId: 'R', predicate: 'P', expected: 'NOT_SUPPORTED', actual: 'NOT_SUPPORTED', match: true, polarity: 'NEGATIVE' }] }),
    result({ fixtureId: 'fp', predicates: [{ ruleId: 'R', predicate: 'P', expected: 'NOT_SUPPORTED', actual: 'SUPPORTED', match: false, polarity: 'NEGATIVE' }] }),
    result({ fixtureId: 'fn', predicates: [{ ruleId: 'R', predicate: 'P', expected: 'SUPPORTED', actual: 'CONFLICT', match: false, polarity: 'POSITIVE' }] }),
    result({ fixtureId: 'unknown-negative', predicates: [{ ruleId: 'R', predicate: 'P', expected: 'NOT_SUPPORTED', actual: 'UNKNOWN', match: false, polarity: 'NEGATIVE' }] }),
  ]);
  assert.deepEqual([summary.truePositive, summary.trueNegative, summary.falsePositive, summary.falseNegative], [1, 1, 1, 1]);
  assert.equal(summary.falsePositiveRate, 0.5);
  assert.equal(summary.falseNegativeRate, 0.5);
  assert.equal(summary.precision, 0.5);
  assert.equal(summary.recall, 0.5);
  assert.equal(summary.specificity, 0.5);
  assert.equal(summary.accuracy, 0.5);
  assert.equal(summary.undeterminedPredicateCount, 2);
  assert.equal(JSON.stringify(summary).includes('NaN'), false);
  assert.equal(JSON.stringify(summary).includes('Infinity'), false);
});

test('Provider-level match rates include Predicate, exact Citation, Rule, Decision, and reason code comparisons', () => {
  const summary = aggregateProviderResults([result({
    predicates: [{ ruleId: 'R', predicate: 'P', expected: 'SUPPORTED', actual: 'SUPPORTED', match: true }],
    citations: [{ ruleId: 'R', predicate: 'P', match: false, actual: { evidenceIds: ['e1', 'e2'], assessmentIds: [], feedEvidenceIds: [] }, allowed: { evidenceIds: ['e1'], assessmentIds: [], feedEvidenceIds: [] } }],
    ruleStatusMatches: { R: true, R2: false }, decisionMatch: true, reasonCodeMatch: false,
  })]);
  assert.equal(summary.predicateStatusMatchRate, 1);
  assert.equal(summary.citationComparisons, 1);
  assert.equal(summary.citationMatches, 0);
  assert.equal(summary.ruleStatusComparisons, 2);
  assert.equal(summary.ruleStatusMatchRate, 0.5);
  assert.equal(summary.decisionMatchRate, 1);
  assert.equal(summary.reasonCodeMatchRate, 0);
});

test('provider summary calculates deterministic nearest-rank percentiles and token/cost averages', () => {
  const latencies = [1, 2, 3, 4, 100];
  const summary = aggregateProviderResults(latencies.map((latencyMs, index) => result({
    fixtureId: `perf-${index}`, latencyMs, usage: { inputTokens: 10 * (index + 1), outputTokens: 2, totalTokens: 10 * (index + 1) + 2, cachedInputTokens: null, totalTokensDerived: false },
    estimatedCost: 0.1, pricingStatus: 'CALCULATED',
  })));
  assert.equal(summary.minimumLatencyMs, 1);
  assert.equal(summary.averageLatencyMs, 22);
  assert.equal(summary.maximumLatencyMs, 100);
  assert.equal(summary.p50LatencyMs, 3);
  assert.equal(summary.p95LatencyMs, 100);
  assert.equal(summary.inputTokens, 150);
  assert.equal(summary.outputTokens, 10);
  assert.equal(summary.totalTokens, 160);
  assert.equal(summary.averageInputTokens, 30);
  assert.equal(summary.averageOutputTokens, 2);
  assert.equal(summary.averageTotalTokens, 32);
  assert.equal(summary.estimatedCost, 0.5);
  assert.equal(summary.averageEstimatedCostPerCompletedFixture, 0.1);
});

test('Harness rejects invalid externally supplied Pricing instead of manufacturing a cost', async () => {
  const fixture = buildPolicyLlmComparisonFixtures().find((item) => item.fixtureId === 'clear-negative')!;
  await assert.rejects(() => runPolicyLlmComparison([fixture], {
    mode: 'fixture', providers: { gpt: { provider: fixtureProvider(true), model: 'fixture-model' } }, timeoutMs: 100,
    pricing: [{ provider: 'gpt', model: 'fixture-model', currency: 'USD', inputCostPerToken: 1, outputCostPerToken: 1, tokenUnit: 0.5 }],
  }), /POLICY_HARNESS_INVALID_PRICING/u);
});

test('comparison harness excludes a provider failure instead of counting it as pairwise agreement', async () => {
  const fixture = buildPolicyLlmComparisonFixtures().find((item) => item.fixtureId === 'capability-without-invocation')!;
  const allNotSupported: PolicyLlmProvider = {
    async analyze(input) {
      const body = JSON.parse(input.trim().split('\n').at(-1)!) as { policySnapshot: { policyVersion: string; rules: Array<{ ruleId: string; when: { allOf?: Array<{ predicate: string }>; anyOf?: Array<{ predicate: string }> } }> } };
      const ruleEvaluations = body.policySnapshot.rules.map((rule) => {
        const predicates = [...(rule.when.allOf ?? []), ...(rule.when.anyOf ?? [])].map(({ predicate }) => ({ predicate, status: 'NOT_SUPPORTED', evidenceIds: [], assessmentIds: [], feedEvidenceIds: [], codeRefs: [], missing: [] }));
        return { ruleId: rule.ruleId, status: 'NOT_SATISFIED', predicateEvaluations: predicates, counterEvidenceIds: [], rationale: 'Mock output.' };
      });
      return { model: 'mock', durationMs: 2, judgment: { judgmentId: 'mock', policyVersion: body.policySnapshot.policyVersion, caseStatus: 'COMPLETE', ruleEvaluations, unresolved: [], conflicts: [], limitations: [] } };
    },
  };
  const fail: PolicyLlmProvider = { analyze: async () => { throw new PolicyLlmError('POLICY_LLM_TRANSPORT_FAILED', true); } };
  const report = await runPolicyLlmComparison([fixture], { mode: 'fixture', providers: { gpt: { provider: allNotSupported, model: 'mock' }, claude: { provider: fail, model: 'mock' } }, timeoutMs: 100 });
  assert.equal(report.pairwise[0]?.comparableFixtureCount, 0);
  assert.deepEqual(report.pairwise[0]?.excludedFixtures, [{ fixtureId: fixture.fixtureId, reason: 'FAILED:POLICY_LLM_TRANSPORT_FAILED' }]);
  assert.equal(report.pairwise[0]?.finalDecision.matchRate, null);
});

test('pairwise comparison records status/citation disagreements for comparable Fixtures', async () => {
  const fixture = buildPolicyLlmComparisonFixtures().find((item) => item.fixtureId === 'capability-without-invocation')!;
  const makeMock = (supportFirst: boolean): PolicyLlmProvider => ({
    async analyze(input) {
      const body = JSON.parse(input.trim().split('\n').at(-1)!) as {
        policySnapshot: { policyVersion: string; rules: Array<{ ruleId: string; when: { allOf?: Array<{ predicate: string }>; anyOf?: Array<{ predicate: string }> } }> };
        policyCase: { observations: Array<{ evidenceId: string }> };
      };
      const firstEvidenceId = body.policyCase.observations[0]?.evidenceId;
      const ruleEvaluations = body.policySnapshot.rules.map((rule) => {
        const predicates = [...(rule.when.allOf ?? []), ...(rule.when.anyOf ?? [])].map(({ predicate }, index) => ({
          predicate, status: supportFirst && index === 0 ? 'SUPPORTED' : 'NOT_SUPPORTED',
          evidenceIds: supportFirst && index === 0 && firstEvidenceId ? [firstEvidenceId] : [], assessmentIds: [], feedEvidenceIds: [], codeRefs: [], missing: [],
        }));
        return { ruleId: rule.ruleId, status: 'NOT_SATISFIED', predicateEvaluations: predicates, counterEvidenceIds: [], rationale: 'Mock output.' };
      });
      return { model: 'mock', durationMs: 1, judgment: { judgmentId: 'mock', policyVersion: body.policySnapshot.policyVersion, caseStatus: 'COMPLETE', ruleEvaluations, unresolved: [], conflicts: [], limitations: [] } };
    },
  });
  const report = await runPolicyLlmComparison([fixture], { mode: 'fixture', providers: { gpt: { provider: makeMock(false), model: 'mock' }, claude: { provider: makeMock(true), model: 'mock' } }, timeoutMs: 100 });
  const pair = report.pairwise[0]!;
  assert.equal(pair.comparableFixtureCount, 1);
  assert.equal(pair.predicateStatus.matchRate, 2 / 3);
  assert.equal(pair.citationSet.matchRate, 2 / 3);
  assert.equal(pair.ruleStatus.matchRate, 1);
  assert.deepEqual(pair.disagreements[0]?.items, ['predicate:RULE-REJECT-CHILD-PROCESS/CHILD_PROCESS_SPAWNED', 'citation:RULE-REJECT-CHILD-PROCESS/CHILD_PROCESS_SPAWNED']);
});

test('Fixture expected citation matching requires exact ID sets and redacts secrets', async () => {
  const fixture = buildPolicyLlmComparisonFixtures().find((item) => item.fixtureId === 'child-process-invocation')!;
  const delegate = new FixturePolicyLlmProvider();
  const provider: PolicyLlmProvider = {
    async analyze(input, signal) {
      const response = await delegate.analyze(input, signal);
      const judgment = response.judgment as { ruleEvaluations: Array<{ predicateEvaluations: Array<{ predicate: string; evidenceIds: string[]; status: string }> }> };
      const target = judgment.ruleEvaluations[0]?.predicateEvaluations.find((item) => item.predicate === 'CHILD_PROCESS_SPAWNED');
      if (target) target.evidenceIds = [...target.evidenceIds, 'fixture-install-trigger'];
      return { ...response, judgment, rawResponse: { authorization: 'Bearer highly-secret-value', message: 'sk-ant-12345678901234567890' } };
    },
  };
  const report = await runPolicyLlmComparison([fixture], { mode: 'fixture', providers: { gpt: { provider, model: 'mock' } }, timeoutMs: 100 });
  const row = report.fixtures[0]!;
  assert.equal(row.citations.find((item) => item.predicate === 'CHILD_PROCESS_SPAWNED')?.match, false);
  const serialized = JSON.stringify({ rawResponse: row.rawResponse, rawJudgment: row.rawJudgment });
  assert.equal(serialized.includes('highly-secret-value'), false);
  assert.equal(serialized.includes('sk-ant-12345678901234567890'), false);
});

test('fixture-mode providers run without external fetch calls', async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async () => { fetchCalls += 1; throw new Error('unexpected network'); }) as typeof fetch;
  try {
    await runPolicyLlmComparison(buildPolicyLlmComparisonFixtures(), {
      mode: 'fixture', providers: { gpt: { provider: new FixturePolicyLlmProvider(), model: 'offline-gpt' }, claude: { provider: new FixturePolicyLlmProvider(), model: 'offline-claude' } }, timeoutMs: 100,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(fetchCalls, 0);
});
