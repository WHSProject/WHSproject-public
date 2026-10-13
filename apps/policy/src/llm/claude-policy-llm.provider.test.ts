import assert from 'node:assert/strict';
import test from 'node:test';
import { ClaudePolicyLlmProvider } from './claude-policy-llm.provider';
import { PolicyLlmError } from './policy-llm.provider';

const judgment = { judgmentId: 'claude-1', policyVersion: 'fixture-1', caseStatus: 'COMPLETE', ruleEvaluations: [], unresolved: [], conflicts: [], limitations: [], recommendedOutcome: null };

test('Claude provider sends the shared prompt and structured PolicyJudgment schema', async () => {
  let requestUrl = '';
  let requestInit: RequestInit | undefined;
  const provider = new ClaudePolicyLlmProvider({ apiKey: 'test-key', model: 'claude-test', baseUrl: 'https://example.test' }, async (url, init) => {
    requestUrl = String(url);
    requestInit = init;
    return new Response(JSON.stringify({ id: 'msg-1', model: 'claude-test', content: [{ type: 'text', text: JSON.stringify(judgment) }], usage: { input_tokens: 12, output_tokens: 8 } }), { status: 200 });
  });

  const result = await provider.analyze('shared policy prompt', new AbortController().signal);
  assert.equal(requestUrl, 'https://example.test/v1/messages');
  assert.equal((requestInit?.headers as Record<string, string>)['anthropic-version'], '2023-06-01');
  assert.equal((requestInit?.headers as Record<string, string>)['x-api-key'], 'test-key');
  const body = JSON.parse(String(requestInit?.body)) as Record<string, any>;
  assert.equal(body.messages[0].content, 'shared policy prompt');
  assert.equal(body.output_config.format.type, 'json_schema');
  assert.match(body.output_config.format.schema.properties.ruleEvaluations.items.properties.status.description, /CONFLICT if any predicate conflicts/u);
  assert.deepEqual(result.judgment, judgment);
  assert.equal(result.providerRequestId, 'msg-1');
  assert.deepEqual(result.usage, { inputTokens: 12, outputTokens: 8, totalTokens: undefined, cachedInputTokens: undefined });
});

test('Claude provider classifies HTTP, transport, empty, and malformed responses without a network call', async () => {
  const http = new ClaudePolicyLlmProvider({ apiKey: 'test-key', model: 'claude-test', baseUrl: 'https://example.test' }, async () => new Response(JSON.stringify({ error: { type: 'bad_request' } }), { status: 400 }));
  await assert.rejects(() => http.analyze('prompt', new AbortController().signal), (error: unknown) => error instanceof PolicyLlmError && error.message === 'POLICY_LLM_HTTP_400');

  const transport = new ClaudePolicyLlmProvider({ apiKey: 'test-key', model: 'claude-test', baseUrl: 'https://example.test' }, async () => { throw new Error('offline'); });
  await assert.rejects(() => transport.analyze('prompt', new AbortController().signal), /POLICY_LLM_TRANSPORT_FAILED/u);

  const empty = new ClaudePolicyLlmProvider({ apiKey: 'test-key', model: 'claude-test', baseUrl: 'https://example.test' }, async () => new Response(JSON.stringify({ id: 'empty', content: [] }), { status: 200 }));
  await assert.rejects(() => empty.analyze('prompt', new AbortController().signal), /POLICY_LLM_EMPTY_OUTPUT/u);

  const malformed = new ClaudePolicyLlmProvider({ apiKey: 'test-key', model: 'claude-test', baseUrl: 'https://example.test' }, async () => new Response('{', { status: 200 }));
  await assert.rejects(() => malformed.analyze('prompt', new AbortController().signal), /POLICY_LLM_INVALID_RESPONSE/u);

  const invalidJson = new ClaudePolicyLlmProvider({ apiKey: 'test-key', model: 'claude-test', baseUrl: 'https://example.test' }, async () => new Response(JSON.stringify({ content: [{ type: 'text', text: '{' }] }), { status: 200 }));
  await assert.rejects(() => invalidJson.analyze('prompt', new AbortController().signal), /POLICY_LLM_INVALID_JSON/u);
});

test('Claude provider supports its timeout and caller AbortSignal', async () => {
  const hangingFetcher = async (_url: unknown, init?: RequestInit): Promise<Response> => await new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
  });
  const timeout = new ClaudePolicyLlmProvider({ apiKey: 'test-key', model: 'claude-test', baseUrl: 'https://example.test', timeoutMs: 5 }, hangingFetcher);
  await assert.rejects(() => timeout.analyze('prompt', new AbortController().signal), /POLICY_LLM_TIMEOUT/u);

  const controller = new AbortController();
  const aborted = new ClaudePolicyLlmProvider({ apiKey: 'test-key', model: 'claude-test', baseUrl: 'https://example.test' }, hangingFetcher);
  const pending = aborted.analyze('prompt', controller.signal);
  controller.abort();
  await assert.rejects(() => pending, /POLICY_LLM_ABORTED/u);
});
