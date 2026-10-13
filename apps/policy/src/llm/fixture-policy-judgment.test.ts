import assert from 'node:assert/strict';
import test from 'node:test';
import { buildEvidenceCase } from '../case/evidence-case.builder';
import type { EvaluationRequest } from '../contracts/evidence';
import type { PolicyJudgment } from '../contracts/judgment';
import type { PolicySnapshot } from '../contracts/policy';
import { resolveDecision } from '../decision/decision.resolver';
import { buildPolicyPrompt } from './policy-llm.prompt';
import { validatePolicyJudgment } from './policy-judgment.validator';
import { FixturePolicyLlmProvider } from './policy-llm.provider';

const policy: PolicySnapshot = {
  policyKey: 'custom-fixture-policy', policyVersion: '1.0.0', ecosystem: 'npm', defaultDecision: 'ACCEPT', judgmentFailureDecision: 'HOLD',
  predicateCatalog: [{ code: 'CUSTOM_BEHAVIOR_MATCH', description: 'A tenant-defined behavior is present.', category: 'custom', rejectAllowed: true }],
  rules: [{ ruleId: 'CUSTOM-REVIEW', priority: 100, effect: 'REVIEW', when: { allOf: [{ predicate: 'CUSTOM_BEHAVIOR_MATCH' }] }, minimumSupport: 'SUPPORTED', onUnknown: 'HOLD', reasonCode: 'CUSTOM_BEHAVIOR' }],
};

const request: EvaluationRequest = {
  requestId: 'req-custom-fixture', scanId: 'scan-custom-fixture', scanStatus: 'COMPLETED',
  subject: { ecosystem: 'npm', packageName: 'custom-demo', packageVersion: '1.0.0', artifactHash: 'sha256:custom', integrity: 'sha512-custom' },
  evidences: [{
    schemaVersion: '0.1', evidenceId: 'custom-atomic-1', kind: 'ATOMIC', signal: { type: 'CUSTOM_BEHAVIOR_MATCH' },
    subject: { ecosystem: 'npm', packageName: 'custom-demo', packageVersion: '1.0.0', artifactHash: 'sha256:custom' },
    assertion: { summary: 'CUSTOM_BEHAVIOR_MATCH was observed in the analyzed path.' },
    provenance: { scanId: 'scan-custom-fixture' },
  }],
  osvFeed: { source: 'OSV', feedStatus: 'SKIPPED', query: { ecosystem: 'npm', packageName: 'custom-demo', packageVersion: '1.0.0' }, advisories: [], complete: false, pagesFetched: 0, collectedAt: null, completedAt: null, errorCode: null, skippedReason: 'DISABLED' },
};

async function runFixture(scenario: 'positive' | 'negative'): Promise<PolicyJudgment> {
  const evidenceCase = buildEvidenceCase(request);
  const response = await new FixturePolicyLlmProvider({ scenario, targetPredicate: 'CUSTOM_BEHAVIOR_MATCH' }).analyze(buildPolicyPrompt(evidenceCase, policy), new AbortController().signal);
  return validatePolicyJudgment(response.judgment, policy, evidenceCase);
}

test('custom predicate fixture supports a positive judgment and resolver decision', async () => {
  const judgment = await runFixture('positive');
  const predicate = judgment.ruleEvaluations[0]?.predicateEvaluations[0];
  assert.equal(predicate?.status, 'SUPPORTED');
  assert.deepEqual(predicate?.evidenceIds, ['custom-atomic-1']);
  assert.equal(resolveDecision(policy, judgment, buildEvidenceCase(request)).decision, 'REVIEW');
});

test('custom predicate fixture supports a negative judgment without a false citation', async () => {
  const judgment = await runFixture('negative');
  const predicate = judgment.ruleEvaluations[0]?.predicateEvaluations[0];
  assert.equal(predicate?.status, 'NOT_SUPPORTED');
  assert.deepEqual(predicate?.evidenceIds, []);
  assert.equal(resolveDecision(policy, judgment, buildEvidenceCase(request)).decision, 'ACCEPT');
});
