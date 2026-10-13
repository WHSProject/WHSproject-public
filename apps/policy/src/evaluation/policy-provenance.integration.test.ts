import assert from 'node:assert/strict';
import test from 'node:test';
import type { EvaluationRequest } from '../contracts/evidence';
import type { PolicyJudgment, PredicateEvaluation } from '../contracts/judgment';
import type { PolicySnapshot } from '../contracts/policy';
import { HttpDecisionDbClient } from '../decision/decision-db.client';
import { buildFeedPersistencePayload, HttpFeedPersistenceClient } from '../feed/feed-persistence.client';
import type { PolicyLlmProvider } from '../llm/policy-llm.provider';
import { PolicyEvaluationService } from './policy-evaluation.service';

const policy: PolicySnapshot = {
  policyKey: 'virtual-npm-policy',
  policyVersion: 'test-1',
  ecosystem: 'npm',
  defaultDecision: 'REVIEW',
  judgmentFailureDecision: 'HOLD',
  rules: [
    {
      ruleId: 'REVIEW-COMBINED',
      priority: 100,
      effect: 'REVIEW',
      when: { allOf: [
        { predicate: 'SENSITIVE_DATA_ACCESSED' },
        { predicate: 'OSV_ADVISORY_APPLIES' },
      ] },
      minimumSupport: 'SUPPORTED',
      onUnknown: 'REVIEW',
      reasonCode: 'OSV_AND_SCANNER_REVIEW',
    },
  ],
};

const request: EvaluationRequest = {
  requestId: '10000000-0000-4000-8000-000000000101',
  scanId: '20000000-0000-4000-8000-000000000101',
  scanStatus: 'COMPLETED',
  subject: { ecosystem: 'npm', packageName: 'virtual-demo', packageVersion: '1.2.3', artifactHash: 'sha256:virtual', integrity: 'sha512-virtual' },
  evidences: [
    {
      schemaVersion: '0.1', evidenceId: 'atomic-cited', kind: 'ATOMIC',
      signal: { type: 'DATA_FLOW' },
      subject: { ecosystem: 'npm', packageName: 'virtual-demo', packageVersion: '1.2.3', artifactHash: 'sha256:virtual' },
      assertion: { summary: 'secret data reaches an external sink through an executed path' },
      provenance: { scanId: '20000000-0000-4000-8000-000000000101' },
    },
    {
      schemaVersion: '0.1', evidenceId: 'atomic-unrelated', kind: 'ATOMIC',
      signal: { type: 'PACKAGE_METADATA' },
      subject: { ecosystem: 'npm', packageName: 'virtual-demo', packageVersion: '1.2.3', artifactHash: 'sha256:virtual' },
      assertion: { summary: 'unrelated package metadata observation' },
      provenance: { scanId: '20000000-0000-4000-8000-000000000101' },
    },
    {
      schemaVersion: '0.1', evidenceId: 'llm:analysis-1:assessment-1', kind: 'LLM_ASSESSMENT',
      signal: { id: 'assessment-signal-1', type: 'MALICIOUSNESS', category: 'intent' },
      subject: { ecosystem: 'npm', packageName: 'virtual-demo', packageVersion: '1.2.3', artifactHash: 'sha256:virtual' },
      assertion: { summary: 'assessment corroborates the cited data flow', basis: 'virtual fixture' },
      intentAssessment: 'LIKELY_MALICIOUS', verificationStatus: 'VERIFIED', confidence: 0.99,
      reasonCodes: ['VIRTUAL_FIXTURE'], alternatives: [], locations: [], relatedFindingIds: [], relatedAtomicEvidenceIds: ['atomic-cited'], limitations: [],
      provenance: { scanId: '20000000-0000-4000-8000-000000000101', producerType: 'LLM_AGENT', analysisId: 'analysis-1', assessmentId: 'assessment-1', model: 'fixture' },
    },
  ],
  osvFeed: {
    source: 'OSV', feedStatus: 'SUCCESS',
    query: { ecosystem: 'npm', packageName: 'virtual-demo', packageVersion: '1.2.3' },
    advisories: [{
      id: 'GHSA-virtual-1234', aliases: ['CVE-2026-0001'],
      affected: [{ package: { ecosystem: 'npm', name: 'virtual-demo' }, ranges: [{ type: 'SEMVER', events: [{ introduced: '1.0.0' }, { fixed: '2.0.0' }] }] }],
      database_specific: { severity: 'HIGH' }, references: [{ type: 'ADVISORY', url: 'https://example.invalid/virtual' }],
    }],
    complete: true, pagesFetched: 1, collectedAt: '2026-09-23T00:00:00.000Z', completedAt: '2026-09-23T00:00:01.000Z', errorCode: null, skippedReason: null,
  },
};

function judgment(): PolicyJudgment {
  return {
    judgmentId: 'judgment-virtual-1', policyVersion: policy.policyVersion, caseStatus: 'COMPLETE', unresolved: [], conflicts: [], limitations: [],
    ruleEvaluations: [
      { ruleId: 'REVIEW-COMBINED', status: 'SATISFIED', counterEvidenceIds: [], rationale: 'virtual cited evidence', predicateEvaluations: [
        { predicate: 'SENSITIVE_DATA_ACCESSED', status: 'SUPPORTED', evidenceIds: ['atomic-cited'], assessmentIds: ['assessment-1'], feedEvidenceIds: [], codeRefs: [] },
        { predicate: 'OSV_ADVISORY_APPLIES', status: 'SUPPORTED', evidenceIds: [], assessmentIds: [], feedEvidenceIds: ['osv:GHSA-virtual-1234'], codeRefs: [] },
      ] },
    ],
  };
}

test('virtual evidence flows through judgment and persists only cited provenance', async () => {
  const provider: PolicyLlmProvider = { analyze: async () => ({ judgment: judgment(), model: 'fixture', durationMs: 1 }) };
  const evaluation = await new PolicyEvaluationService(provider).evaluate(request, policy);
  assert.equal(evaluation.decision.decision, 'REVIEW');
  assert.deepEqual(evaluation.decision.evidenceIds, ['atomic-cited']);
  assert.deepEqual(evaluation.decision.assessmentIds, ['assessment-1']);
  assert.deepEqual(evaluation.decision.feedEvidenceIds, ['osv:GHSA-virtual-1234']);

  let feedBody = '';
  const feedClient = new HttpFeedPersistenceClient('http://decision-db', 100, async (_url, init) => {
    feedBody = String(init?.body);
    return new Response(JSON.stringify({ attemptId: 'attempt-virtual', snapshotId: 'snapshot-virtual', snapshotReused: false }), { status: 201 });
  });
  const feedPayload = buildFeedPersistencePayload(request, evaluation.case.osvFeed, '2026-09-23T00:00:02.000Z');
  assert.ok(feedPayload.snapshot);
  await feedClient.save(feedPayload);

  let decisionBody = '';
  const decisionClient = new HttpDecisionDbClient('http://decision-db', 100, async (_url, init) => {
    decisionBody = String(init?.body);
    return new Response(JSON.stringify({ id: 'decision-row-virtual' }), { status: 201 });
  });
  await decisionClient.save(request, policy, evaluation.decision, '2026-09-23T00:00:03.000Z', { snapshotId: 'snapshot-virtual' });

  const persistedFeed = JSON.parse(feedBody);
  const persistedDecision = JSON.parse(decisionBody).decision;
  assert.equal(persistedFeed.attempt.requestId, request.requestId);
  assert.equal(persistedFeed.snapshot.contentDigest.length, 64);
  assert.equal(persistedDecision.decision, 'REVIEW');
  assert.deepEqual(persistedDecision.evidenceIds, ['atomic-cited']);
  assert.deepEqual(persistedDecision.assessmentIds, ['assessment-1']);
  assert.deepEqual(persistedDecision.feedEvidenceIds, ['osv:GHSA-virtual-1234']);
  assert.equal(persistedDecision.score, null);
});

for (const scenario of [
  { name: 'static', staticEvidence: true, feed: false, assessment: false },
  { name: 'feed', staticEvidence: false, feed: true, assessment: false },
  { name: 'verified assessment', staticEvidence: false, feed: false, assessment: true },
  { name: 'static and feed', staticEvidence: true, feed: true, assessment: false },
  { name: 'static and assessment', staticEvidence: true, feed: false, assessment: true },
  { name: 'static, feed, and assessment', staticEvidence: true, feed: true, assessment: true },
]) {
  test(`citation namespaces remain separate for ${scenario.name}`, async () => {
    const actualRules: PolicySnapshot = { ...policy, rules: [
      { ruleId: 'RULE-ACCEPT-BENIGN', priority: 100, effect: 'ACCEPT', when: { allOf: [{ predicate: 'BENIGN_ALTERNATIVE_SUPPORTED' }] }, minimumSupport: 'SUPPORTED', onUnknown: 'HOLD', reasonCode: 'POLICY_PASSED' },
      { ruleId: 'RULE-REVIEW-OSV-HIGH', priority: 70, effect: 'REVIEW', when: { allOf: [{ predicate: 'OSV_ADVISORY_APPLIES' }] }, minimumSupport: 'SUPPORTED', onUnknown: 'REVIEW', reasonCode: 'OSV_ADVISORY_REVIEW' },
    ] };
    const scanner: PredicateEvaluation = { predicate: 'BENIGN_ALTERNATIVE_SUPPORTED', status: scenario.staticEvidence || scenario.assessment ? 'SUPPORTED' : 'NOT_SUPPORTED', evidenceIds: scenario.staticEvidence ? ['atomic-cited'] : [], assessmentIds: scenario.assessment ? ['assessment-1'] : [], feedEvidenceIds: [], codeRefs: [] };
    const advisory: PredicateEvaluation = { predicate: 'OSV_ADVISORY_APPLIES', status: scenario.feed ? 'SUPPORTED' : 'NOT_SUPPORTED', evidenceIds: [], assessmentIds: [], feedEvidenceIds: scenario.feed ? ['osv:GHSA-virtual-1234'] : [], codeRefs: [] };
    const value: PolicyJudgment = { judgmentId: `judgment-${scenario.name}`, policyVersion: policy.policyVersion, caseStatus: 'COMPLETE', unresolved: [], conflicts: [], limitations: [], ruleEvaluations: [
      { ruleId: 'RULE-ACCEPT-BENIGN', status: scanner.status === 'SUPPORTED' ? 'SATISFIED' : 'NOT_SATISFIED', counterEvidenceIds: [], rationale: 'fixture', predicateEvaluations: [scanner] },
      { ruleId: 'RULE-REVIEW-OSV-HIGH', status: advisory.status === 'SUPPORTED' ? 'SATISFIED' : 'NOT_SATISFIED', counterEvidenceIds: [], rationale: 'fixture', predicateEvaluations: [advisory] },
    ] };
    const provider: PolicyLlmProvider = { analyze: async () => ({ judgment: value, model: 'fixture', durationMs: 1 }) };
    const scenarioRequest: EvaluationRequest = { ...request, evidences: request.evidences.map((evidence) => evidence.kind === 'LLM_ASSESSMENT'
        ? { ...evidence, assertion: { ...evidence.assertion, summary: 'Verified explanation linked to atomic-cited directly documents the benign alternative.' } }
        : evidence.evidenceId === 'atomic-cited'
          ? { ...evidence, assertion: { ...evidence.assertion, summary: 'Directly documents the concrete benign alternative for this behavior.' } }
        : evidence) };
    const result = await new PolicyEvaluationService(provider).evaluate(scenarioRequest, actualRules);
    assert.equal(result.llm.status, 'COMPLETED');
    assert.deepEqual(result.judgment.ruleEvaluations[0]!.predicateEvaluations[0]!.evidenceIds, scanner.evidenceIds);
    assert.deepEqual(result.judgment.ruleEvaluations[0]!.predicateEvaluations[0]!.assessmentIds, scanner.assessmentIds);
    assert.deepEqual(result.judgment.ruleEvaluations[1]!.predicateEvaluations[0]!.feedEvidenceIds, advisory.feedEvidenceIds);
    assert.deepEqual(result.judgment.ruleEvaluations.map((rule) => rule.status), value.ruleEvaluations.map((rule) => rule.status));
    assert.equal(result.decision.decision, scenario.staticEvidence || scenario.assessment ? 'ACCEPT' : 'REVIEW');
  });
}
