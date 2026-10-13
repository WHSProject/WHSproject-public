import assert from 'node:assert/strict';
import test from 'node:test';
import { OpenAiPolicyLlmProvider, PolicyLlmError } from './policy-llm.provider';

test('OpenAI provider accepts a DB-registered custom predicate and preserves raw response', async () => {
  const judgment = {
    judgmentId: 'gpt-custom-1', policyVersion: '1', caseStatus: 'COMPLETE', ruleEvaluations: [], unresolved: [], conflicts: [], limitations: [], recommendedOutcome: null,
  };
  let requestBody: Record<string, unknown> | undefined;
  const provider = new OpenAiPolicyLlmProvider({ apiKey: 'test-key', model: 'gpt-test', baseUrl: 'https://example.test' }, async (_url, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({
      id: 'resp-custom-1', model: 'gpt-test', usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 }, output: [{ content: [{ type: 'output_text', text: JSON.stringify(judgment) }] }],
    }), { status: 200 });
  });

  const result = await provider.analyze('custom prompt', new AbortController().signal);
  assert.deepEqual(result.judgment, judgment);
  assert.equal(result.providerRequestId, 'resp-custom-1');
  assert.deepEqual(result.usage, { inputTokens: 11, outputTokens: 7, totalTokens: 18, cachedInputTokens: undefined });
  assert.equal((result.rawResponse as { id: string }).id, 'resp-custom-1');
  assert.ok(JSON.stringify(requestBody).includes('"pattern":"^[A-Z][A-Z0-9_]{2,63}$"'));
  const schema = (requestBody as any).text.format.schema;
  assert.match(schema.properties.ruleEvaluations.items.properties.status.description, /CONFLICT if any predicate conflicts/u);
});

test('OpenAI provider constrains citation arrays to IDs from their matching PolicyCase namespace', async () => {
  let requestBody: Record<string, any> | undefined;
  const provider = new OpenAiPolicyLlmProvider({ apiKey: 'test-key', model: 'gpt-test', baseUrl: 'https://example.test' }, async (_url, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, any>;
    return new Response(JSON.stringify({ id: 'resp-citations', model: 'gpt-test', output: [{ content: [{ type: 'output_text', text: '{}' }] }] }), { status: 200 });
  });
  const policyCase = {
    observations: [{ evidenceId: 'atomic:allowed' }],
    assessments: [
      { evidenceId: 'llm:analysis:verified', verificationStatus: 'VERIFIED', provenance: { assessmentId: 'assessment:allowed' } },
      { evidenceId: 'llm:analysis:unverified', verificationStatus: 'UNVERIFIED', provenance: { assessmentId: 'assessment:blocked' } },
    ],
    osvEvidence: [{ feedEvidenceId: 'osv:allowed' }],
  };
  await provider.analyze(`prompt\n${JSON.stringify({ policyCase })}`, new AbortController().signal);
  const schema = requestBody!.text.format.schema;
  const predicateProperties = schema.properties.ruleEvaluations.items.properties.predicateEvaluations.items.properties;
  assert.deepEqual(predicateProperties.evidenceIds.items.enum, ['atomic:allowed']);
  assert.deepEqual(predicateProperties.assessmentIds.items.enum, ['llm:analysis:verified', 'assessment:allowed']);
  assert.deepEqual(predicateProperties.feedEvidenceIds.items.enum, ['osv:allowed']);
  assert.deepEqual(schema.properties.ruleEvaluations.items.properties.counterEvidenceIds.items.enum, ['atomic:allowed', 'llm:analysis:verified', 'llm:analysis:unverified']);
  assert.ok(!JSON.stringify(schema).includes('assessment:blocked'));
});

test('OpenAI provider schema does not permit fabricated citations when a namespace is empty', async () => {
  let requestBody: Record<string, any> | undefined;
  const provider = new OpenAiPolicyLlmProvider({ apiKey: 'test-key', model: 'gpt-test', baseUrl: 'https://example.test' }, async (_url, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, any>;
    return new Response(JSON.stringify({ id: 'resp-no-citations', model: 'gpt-test', output: [{ content: [{ type: 'output_text', text: '{}' }] }] }), { status: 200 });
  });
  await provider.analyze(`prompt\n${JSON.stringify({ policyCase: { observations: [], assessments: [], osvEvidence: [] } })}`, new AbortController().signal);
  const schema = requestBody!.text.format.schema;
  const predicateProperties = schema.properties.ruleEvaluations.items.properties.predicateEvaluations.items.properties;
  assert.deepEqual(predicateProperties.evidenceIds.items.enum, ['']);
  assert.deepEqual(predicateProperties.assessmentIds.items.enum, ['']);
  assert.deepEqual(predicateProperties.feedEvidenceIds.items.enum, ['']);
});

test('OpenAI provider preserves a safe raw JSON error body for HTTP failures', async () => {
  const provider = new OpenAiPolicyLlmProvider({ apiKey: 'test-key', model: 'gpt-test', baseUrl: 'https://example.test' }, async () => new Response(JSON.stringify({ error: { code: 'bad_request' } }), { status: 400 }));
  await assert.rejects(() => provider.analyze('prompt', new AbortController().signal), (error: unknown) => {
    assert.ok(error instanceof PolicyLlmError);
    assert.equal(error.message, 'POLICY_LLM_HTTP_400');
    assert.deepEqual(error.rawResponse, { error: { code: 'bad_request' } });
    return true;
  });
});

test('OpenAI provider classifies empty, malformed JSON, and schema-shaped output failures without network access', async () => {
  const empty = new OpenAiPolicyLlmProvider({ apiKey: 'test-key', model: 'gpt-test', baseUrl: 'https://example.test' }, async () => new Response(JSON.stringify({ id: 'empty', output: [] }), { status: 200 }));
  await assert.rejects(() => empty.analyze('prompt', new AbortController().signal), /POLICY_LLM_EMPTY_OUTPUT/u);

  const malformed = new OpenAiPolicyLlmProvider({ apiKey: 'test-key', model: 'gpt-test', baseUrl: 'https://example.test' }, async () => new Response('{', { status: 200 }));
  await assert.rejects(() => malformed.analyze('prompt', new AbortController().signal), /POLICY_LLM_INVALID_RESPONSE/u);

  const schemaShaped = new OpenAiPolicyLlmProvider({ apiKey: 'test-key', model: 'gpt-test', baseUrl: 'https://example.test' }, async () => new Response(JSON.stringify({ id: 'invalid-judgment', output: [{ content: [{ type: 'output_text', text: '{"not":"a PolicyJudgment"}' }] }] }), { status: 200 }));
  const response = await schemaShaped.analyze('prompt', new AbortController().signal);
  assert.deepEqual(response.judgment, { not: 'a PolicyJudgment' });
  assert.equal(response.provider, 'openai');
});
