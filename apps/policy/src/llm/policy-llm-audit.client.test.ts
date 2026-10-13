import assert from 'node:assert/strict';
import test from 'node:test';
import { HttpPolicyLlmAuditClient } from './policy-llm-audit.client';

test('LLM audit client sends original prompt, judgment, response, and shadow comparison', async () => {
  let body = '';
  const client = new HttpPolicyLlmAuditClient('http://decision-db', 100, async (_url, init) => {
    body = String(init?.body);
    return new Response(JSON.stringify({ id: 'audit-row-1' }), { status: 201 });
  });
  const result = await client.save({
    runMode: 'SHADOW', requestId: 'req', scanId: 'scan', policyKey: 'policy', policyVersion: '1',
    provider: 'openai', promptVersion: 'policy-judgment-v1', inputHash: 'a'.repeat(64), evaluatedAt: '2026-09-25T00:00:00.000Z',
    judgmentId: 'j-shadow', status: 'COMPLETED', prompt: 'policy prompt', model: 'gpt-shadow',
    judgmentJson: { judgmentId: 'j-shadow' }, responseJson: { id: 'provider-response' },
    resolvedDecision: 'REVIEW', resolvedReasonCode: 'REVIEW_SIGNAL', shadowOfJudgmentId: 'j-primary',
    comparison: { primaryDecision: 'ACCEPT', shadowDecision: 'REVIEW', decisionChanged: true, primaryReasonCode: 'POLICY_DEFAULT', shadowReasonCode: 'REVIEW_SIGNAL', reasonCodeChanged: true },
  });
  assert.deepEqual(result, { auditDbId: 'audit-row-1', status: 'SAVED' });
  const payload = JSON.parse(body).audit;
  assert.equal(payload.prompt, 'policy prompt');
  assert.equal(payload.provider, 'openai');
  assert.equal(payload.promptVersion, 'policy-judgment-v1');
  assert.equal(payload.inputHash, 'a'.repeat(64));
  assert.equal(payload.evaluatedAt, '2026-09-25T00:00:00.000Z');
  assert.deepEqual(payload.judgmentJson, { judgmentId: 'j-shadow' });
  assert.equal(payload.shadowOfJudgmentId, 'j-primary');
  assert.equal(payload.comparison.decisionChanged, true);
});

test('LLM audit client preserves top-level ruleEvaluations and the original provider response', async () => {
  let payload: Record<string, any> | undefined;
  const client = new HttpPolicyLlmAuditClient('http://decision-db', 100, async (_url, init) => {
    payload = JSON.parse(String(init?.body)) as Record<string, any>;
    return new Response(JSON.stringify({ id: 'audit-row-derived' }), { status: 201 });
  });
  const originalJudgment = { ruleEvaluations: [{ ruleId: 'R', status: 'NOT_SATISFIED' }] };
  const evaluatedJudgment = { ruleEvaluations: [{ ruleId: 'R', status: 'UNKNOWN' }] };
  const rawResponse = { id: 'provider-raw', output: [{ content: [{ type: 'output_text', text: JSON.stringify(originalJudgment) }] }] };
  await client.save({
    runMode: 'PRIMARY', requestId: 'req', scanId: 'scan', policyKey: 'policy', policyVersion: '1',
    provider: 'openai', promptVersion: 'policy-judgment-v2', inputHash: 'b'.repeat(64), evaluatedAt: '2026-09-27T00:00:00.000Z',
    judgmentId: 'j-derived', status: 'COMPLETED', prompt: 'policy prompt',
    judgmentJson: evaluatedJudgment, responseJson: rawResponse,
  });
  assert.deepEqual(payload?.audit.judgmentJson.ruleEvaluations, evaluatedJudgment.ruleEvaluations);
  assert.equal(payload?.audit.judgmentJson.ruleEvaluations[0].status, 'UNKNOWN');
  assert.deepEqual(payload?.audit.responseJson, rawResponse);
  assert.deepEqual(JSON.parse(payload?.audit.responseJson.output[0].content[0].text), originalJudgment);
});
