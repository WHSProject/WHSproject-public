import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { Logger } from '@nestjs/common';
import { loadLlmAgentEnvironment } from '../config/scanner-environment';
import type { AgentAnalysisRequest } from './agent.contract';
import { AgentOutputValidatorService } from './agent-output-validator.service';
import { LlmAgentRunnerService } from './agent-runner.service';
import { LlmAgentToolsService } from './llm-agent-tools.service';
import { agentSummary, LlmEvidenceAdapter } from './llm-evidence.adapter';
import { OpenAiProviderClient, type AgentProvider, type AgentProviderResponse } from './openai-provider.client';
import type { AgentAnalysisOutput } from './output.contract';
import { buildAgentPrompt } from './agent-prompt';

const settings = loadLlmAgentEnvironment({ LLM_AGENT_MAX_RETRIES: '0' });
const request: AgentAnalysisRequest = {
  request: { analysisRequestId: 'analysis-request', requestType: 'MALICIOUS_CODE_ANALYSIS', schemaVersion: '0.2.0', createdAt: 'now', requestId: 'request', scanId: 'scan', inputProfile: 'CODE_FINDING_EVIDENCE' },
  subject: { ecosystem: 'npm', packageName: 'pkg', packageVersion: '1', artifactHash: 'hash', integrity: 'sha512-value' },
  packageContext: { source: 'TARBALL_PACKAGE_MANIFEST_PROJECTION', packageMetadata: { name: 'pkg', version: '1', description: null }, main: 'index.js', exports: null, bin: {}, scripts: {}, dependencies: {}, entryPoints: [], lifecycleScripts: [] },
  findings: [{ findingId: 'finding', analyzer: 'custom-rule', analyzerVersion: '1', ruleId: 'rule', kind: 'CAPABILITY', description: 'finding', location: { file: 'index.js', startLine: 1, endLine: 1 }, rawMatch: null }],
  atomicEvidences: [{ evidenceId: 'atomic', signal: { id: 'signal', type: 'CHILD_PROCESS', category: 'EXECUTION' }, assertion: { summary: 'execution', basis: 'PATTERN_MATCH' }, sources: [], locations: [], limitations: [] }],
  analysisPolicy: { maxToolCalls: 3, maxAdditionalCodeRequests: 2, maxTotalCodeLines: 20 },
  initialCodeSlices: [{ sliceId: 'slice', file: 'index.js', startLine: 1, endLine: 1, content: 'exec(x);', contentRedacted: false, selectionReason: 'finding', relatedFindingIds: ['finding'] }],
  analysisTargets: [], toolResponseCatalog: [{ tool: 'GET_FILE_RANGE', status: 'AVAILABLE' }, { tool: 'GET_PACKAGE_METADATA', status: 'AVAILABLE' }], missingData: [],
};
const assessment: Extract<AgentAnalysisOutput, { status: 'COMPLETED' }>['assessments'][number] = {
  id: 'assessment', type: 'CORRELATED_BEHAVIOR', signal: 'CHILD_PROCESS', category: 'EXECUTION', basis: 'PATTERN_MATCH',
  findingIds: ['finding'], atomicEvidenceIds: ['atomic'], refs: [{ id: 'ref', sliceId: 'slice', lines: [1, 1], role: 'SINK' }],
  flow: { sink: 'ref' }, reachability: { status: 'POSSIBLE' }, verification: { status: 'UNVERIFIED', method: 'NONE' }, confidence: 0.7, reasonCodes: ['CODE'],
};
const completed: Extract<AgentAnalysisOutput, { status: 'COMPLETED' }> = { requestId: 'analysis-request', schemaVersion: '0.1.0', status: 'COMPLETED', assessments: [assessment], summary: { verdict: 'SUSPICIOUS', confidence: 0.7, reasonCodes: ['CODE'] }, limitations: [], missingContext: [] };
const additional = (file = 'index.js', lines: [number, number] = [2, 2]): Extract<AgentAnalysisOutput, { status: 'NEEDS_ADDITIONAL_CODE' }> => ({ requestId: 'analysis-request', schemaVersion: '0.1.0', status: 'NEEDS_ADDITIONAL_CODE', requests: [{ id: 'tool-1', type: 'GET_FILE_RANGE', target: { file, lines }, reasonCode: 'MORE_CONTEXT', maxLines: 2 }] });
const response = (output: AgentAnalysisOutput): AgentProviderResponse => ({ text: JSON.stringify(output), model: 'mock-model', providerRequestId: 'response-id', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, durationMs: 1 });

describe('Agent runtime', () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'agent-runtime-')); await writeFile(join(root, 'index.js'), 'exec(x);\nnext();'); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });
  const validator = new AgentOutputValidatorService();
  const adapter = new LlmEvidenceAdapter();
  it('verifies grounded assessments and emits dedicated evidence', async () => {
    const validated = await validator.validate(request, completed, root, 1000);
    expect(validated.assessments[0]?.status).toBe('VERIFIED');
    const result = new LlmAgentRunnerService({ generate: jest.fn().mockResolvedValue(response(completed)) }, new LlmAgentToolsService(), validator, settings);
    const run = await result.execute(request, { scanId: 'scan', extractedPackageRoot: root });
    expect(run.status).toBe('COMPLETED');
    expect(run.failureReason).toBeUndefined();
    const { evidences } = adapter.toEvidences(request, run);
    expect(evidences).toHaveLength(1);
    expect(evidences[0]).toMatchObject({ kind: 'LLM_ASSESSMENT', relatedFindingIds: ['finding'], relatedAtomicEvidenceIds: ['atomic'], provenance: { producerType: 'LLM_AGENT', assessmentId: 'assessment' } });
    expect(evidences[0]).not.toHaveProperty('evidenceType');
    expect(evidences[0]?.kind).not.toBe('CORRELATED');
    // Evidence API and Policy reject locations outside the shared Evidence shape (#396).
    expect(evidences[0]?.locations).toEqual([{ type: 'SOURCE_FILE', path: 'index.js', startLine: 1, endLine: 1, role: 'SINK' }]);
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    addFormats(ajv);
    const validate = ajv.compile(JSON.parse(readFileSync(join(__dirname, '../../../../packages/contracts/evidence-v0.1.schema.json'), 'utf8')) as object);
    expect(validate(evidences[0]) || validate.errors).toBe(true);
  });
  it.each([
    ['both valid', false, 'COMPLETED', 2, 0],
    ['one invalid', true, 'PARTIAL', 1, 1],
    ['both invalid', 'both', 'PARTIAL', 0, 2],
  ] as const)('isolates Assessment validation: %s', async (_, invalid, status, evidenceCount, rejectedCount) => {
    const first = structuredClone(assessment);
    const second = { ...structuredClone(assessment), id: 'assessment-2', signal: 'SHELL_EXEC' };
    if (invalid === 'both') first.findingIds = ['missing-finding'];
    if (invalid) second.refs[0]!.sliceId = 'missing-slice';
    const output = { ...structuredClone(completed), assessments: [first, second] };
    const runner = new LlmAgentRunnerService({ generate: jest.fn().mockResolvedValue(response(output)) }, new LlmAgentToolsService(), validator, settings);
    const result = await runner.execute(request, { scanId: 'scan', extractedPackageRoot: root });
    const conversion = adapter.toEvidences(request, result);
    const { evidences } = conversion;
    const summary = agentSummary(result, conversion, 'ALWAYS_MODE');
    expect(summary).toMatchObject({ status, assessmentCount: 2, generatedEvidenceCount: evidenceCount, rejectedAssessmentCount: rejectedCount });
    expect(evidences).toHaveLength(evidenceCount);
  });
  it('keeps an empty valid response completed', async () => {
    const output = { ...structuredClone(completed), assessments: [] };
    const runner = new LlmAgentRunnerService({ generate: jest.fn().mockResolvedValue(response(output)) }, new LlmAgentToolsService(), validator, settings);
    const result = await runner.execute(request, { scanId: 'scan', extractedPackageRoot: root });
    expect(agentSummary(result, adapter.toEvidences(request, result), 'ALWAYS_MODE')).toMatchObject({ status: 'COMPLETED', assessmentCount: 0, rejectedAssessmentCount: 0, generatedEvidenceCount: 0 });
  });
  it('emits one evidence per distinct verified assessment and deduplicates equivalent support', async () => {
    const second = { ...structuredClone(assessment), id: 'assessment-2', signal: 'SHELL_EXEC' };
    const duplicate = { ...structuredClone(assessment), id: 'assessment-3' };
    const output = { ...structuredClone(completed), assessments: [assessment, second, duplicate] };
    const validated = await validator.validate(request, output, root, 1000);
    const result = { status: 'COMPLETED' as const, analysisId: 'analysis', validated, model: 'mock', promptVersion: 'p', outputSchemaVersion: '0.1.0', providerRequestIds: [], usage: {}, modelCalls: 1, toolCalls: 0, additionalCodeRequests: 0, durationMs: 1, limitations: [] };
    const conversion = adapter.toEvidences(request, result);
    const { evidences, failures } = conversion;
    expect(evidences).toHaveLength(2);
    expect(failures).toEqual([]);
    expect(agentSummary(result, conversion, 'ALWAYS_MODE')).toMatchObject({ status: 'COMPLETED', verifiedAssessmentCount: 3, generatedEvidenceCount: 2, rejectedAssessmentCount: 0 });
    expect(evidences.map((item) => item.evidenceId)).toEqual(['llm:analysis:assessment', 'llm:analysis:assessment-2']);
  });
  it.each([
    ['second fails', [1], ['assessment'], 1],
    ['first fails', [0], ['assessment-2'], 1],
    ['both fail', [0, 1], [], 2],
  ] as const)('isolates conversion when %s', async (_, failedIndexes, expectedIds, rejectedCount) => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const items = [structuredClone(assessment), { ...structuredClone(assessment), id: 'assessment-2', signal: 'SHELL_EXEC' }];
      for (const index of failedIndexes) Object.defineProperty(items[index], 'reasonCodes', { get: () => { throw new Error('sensitive test detail'); } });
      const validated = { output: { ...completed, assessments: items }, assessments: items.map((item) => ({ assessment: item, status: 'VERIFIED' as const, issues: [] })) };
      const result = { status: 'COMPLETED' as const, analysisId: 'analysis', validated, model: 'mock', promptVersion: 'p', outputSchemaVersion: '0.1.0', providerRequestIds: [], usage: {}, modelCalls: 1, toolCalls: 0, additionalCodeRequests: 0, durationMs: 1, limitations: [] };
      const conversion = adapter.toEvidences(request, result);
      expect(conversion.evidences.map((item) => item.provenance.assessmentId)).toEqual(expectedIds);
      expect(conversion.failures).toHaveLength(rejectedCount);
      expect(conversion.failures.every((item) => item.reason === 'EVIDENCE_CONVERSION_FAILED')).toBe(true);
      expect(agentSummary(result, conversion, 'ALWAYS_MODE')).toMatchObject({ status: 'PARTIAL', verifiedAssessmentCount: 2, generatedEvidenceCount: 2 - rejectedCount, rejectedAssessmentCount: rejectedCount });
      expect(JSON.stringify(warn.mock.calls)).not.toContain('sensitive test detail');
    } finally { warn.mockRestore(); }
  });
  it('handles one additional code round and accumulates usage', async () => {
    const generate = jest.fn().mockResolvedValueOnce(response(additional())).mockResolvedValueOnce(response(completed));
    const run = await new LlmAgentRunnerService({ generate }, new LlmAgentToolsService(), validator, settings).execute(request, { scanId: 'scan', extractedPackageRoot: root });
    expect(run).toMatchObject({ status: 'COMPLETED', modelCalls: 2, toolCalls: 1, additionalCodeRequests: 1, usage: { totalTokens: 30 } });
    expect(generate.mock.calls[1]?.[0]).toContain('next();');
  });
  it('rejects repeated or unsafe code requests without retry', async () => {
    const repeated = jest.fn().mockResolvedValue(response(additional()));
    const run = await new LlmAgentRunnerService({ generate: repeated }, new LlmAgentToolsService(), validator, settings).execute(request, { scanId: 'scan', extractedPackageRoot: root });
    expect(run.status).toBe('FAILED');
    expect(run.failureReason).toBe('TOOL_REQUEST_REJECTED');
    const unsafe = await new LlmAgentRunnerService({ generate: jest.fn().mockResolvedValue(response(additional('../outside.js'))) }, new LlmAgentToolsService(), validator, settings).execute(request, { scanId: 'scan', extractedPackageRoot: root });
    expect(unsafe.status).toBe('FAILED');
  });
  it('stops after the third model response and rejects unavailable tools', async () => {
    const generate = jest.fn().mockResolvedValueOnce(response(additional('index.js', [2, 2]))).mockResolvedValueOnce(response(additional('index.js', [1, 1]))).mockResolvedValueOnce(response(additional('index.js', [2, 2])));
    const run = await new LlmAgentRunnerService({ generate }, new LlmAgentToolsService(), validator, settings).execute(request, { scanId: 'scan', extractedPackageRoot: root });
    expect(run).toMatchObject({ status: 'FAILED', modelCalls: 3, additionalCodeRequests: 2 });
    const unsupported = additional();
    unsupported.requests[0]!.type = 'GET_CALLERS';
    const denied = await new LlmAgentRunnerService({ generate: jest.fn().mockResolvedValue(response(unsupported)) }, new LlmAgentToolsService(), validator, settings).execute(request, { scanId: 'scan', extractedPackageRoot: root });
    expect(denied.failureReason).toBe('TOOL_REQUEST_REJECTED');
  });
  it('retries parsing failure within the model call cap', async () => {
    const generate = jest.fn().mockResolvedValueOnce({ ...response(completed), text: '{' }).mockResolvedValueOnce(response(completed));
    const run = await new LlmAgentRunnerService({ generate }, new LlmAgentToolsService(), validator, loadLlmAgentEnvironment({ LLM_AGENT_MAX_RETRIES: '1' })).execute(request, { scanId: 'scan', extractedPackageRoot: root });
    expect(run).toMatchObject({ status: 'COMPLETED', modelCalls: 2 });
  });
  it('enforces cumulative code lines including initial slices', async () => {
    const constrained = structuredClone(request);
    constrained.analysisPolicy.maxTotalCodeLines = 1;
    const run = await new LlmAgentRunnerService({ generate: jest.fn().mockResolvedValue(response(additional())) }, new LlmAgentToolsService(), validator, settings).execute(constrained, { scanId: 'scan', extractedPackageRoot: root });
    expect(run.failureReason).toBe('REQUEST_LIMIT_EXCEEDED');
  });
  it('times out a provider that does not settle', async () => {
    const provider: AgentProvider = { generate: () => new Promise(() => undefined) };
    const run = await new LlmAgentRunnerService(provider, new LlmAgentToolsService(), validator, loadLlmAgentEnvironment({ LLM_AGENT_TIMEOUT_MS: '5' })).execute(request, { scanId: 'scan', extractedPackageRoot: root });
    expect(run.status).toBe('TIMEOUT');
    expect(run.failureReason).toBe('TIMEOUT');
  });
  it('rejects bad references and excludes ungrounded discoveries', async () => {
    const invalid = structuredClone(completed);
    invalid.assessments[0]!.refs[0]!.sliceId = 'missing';
    expect((await validator.validate(request, invalid, root, 1000)).assessments[0]?.status).toBe('REJECTED');
    const ungrounded = structuredClone(completed);
    delete ungrounded.assessments[0]!.findingIds;
    delete ungrounded.assessments[0]!.atomicEvidenceIds;
    const validated = await validator.validate(request, ungrounded, root, 1000);
    expect(validated.assessments[0]?.status).toBe('PARTIALLY_VERIFIED');
    expect(adapter.toEvidences(request, { status: 'COMPLETED', analysisId: 'a', validated, model: 'm', promptVersion: 'p', outputSchemaVersion: '0.1.0', providerRequestIds: [], usage: {}, modelCalls: 1, toolCalls: 0, additionalCodeRequests: 0, durationMs: 1, limitations: [] })).toEqual({ evidences: [], failures: [] });
  });
  it('rejects bad flow, evidence IDs, duplicate IDs, lines and altered source', async () => {
    const badFlow = structuredClone(completed); badFlow.assessments[0]!.flow.sink = 'unknown';
    expect((await validator.validate(request, badFlow, root, 1000)).assessments[0]?.status).toBe('REJECTED');
    const badFinding = structuredClone(completed); badFinding.assessments[0]!.findingIds = ['unknown'];
    expect((await validator.validate(request, badFinding, root, 1000)).assessments[0]?.status).toBe('REJECTED');
    const badAtomic = structuredClone(completed); badAtomic.assessments[0]!.atomicEvidenceIds = ['unknown'];
    expect((await validator.validate(request, badAtomic, root, 1000)).assessments[0]?.status).toBe('REJECTED');
    const badLine = structuredClone(completed); badLine.assessments[0]!.refs[0]!.lines = [2, 2];
    expect((await validator.validate(request, badLine, root, 1000)).assessments[0]?.status).toBe('REJECTED');
    const duplicates = structuredClone(completed); duplicates.assessments.push(structuredClone(assessment));
    expect((await validator.validate(request, duplicates, root, 1000)).assessments[1]?.status).toBe('REJECTED');
    await writeFile(join(root, 'index.js'), 'changed();\nnext();');
    expect((await validator.validate(request, completed, root, 1000)).assessments[0]?.status).toBe('REJECTED');
  });
  it('maps provider response without exposing API key', async () => {
    const fetcher = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ id: 'res-1', model: 'test-model', output: [{ content: [{ type: 'output_text', text: JSON.stringify(completed) }] }], usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7, input_tokens_details: { cached_tokens: 1 }, output_tokens_details: { reasoning_tokens: 2 } } }) });
    const client = new OpenAiProviderClient(loadLlmAgentEnvironment({ LLM_AGENT_ENABLED: 'true', LLM_AGENT_TRIGGER_MODE: 'ALWAYS', LLM_AGENT_MODEL: 'test-model', OPENAI_API_KEY: 'test-secret' }), fetcher as unknown as typeof fetch,
      { reasoningEffort: 'medium', maxOutputTokens: 32_768 });
    const result = await client.generate('prompt', new AbortController().signal);
    expect(result).toMatchObject({ providerRequestId: 'res-1', usage: { inputTokens: 3, cachedInputTokens: 1, outputTokens: 4, reasoningTokens: 2, totalTokens: 7 } });
    expect(JSON.stringify(result)).not.toContain('test-secret');
    expect(JSON.parse(fetcher.mock.calls[0]?.[1]?.body as string).text.format.type).toBe('json_schema');
    const body = JSON.parse(fetcher.mock.calls[0]?.[1]?.body as string);
    expect(body.store).toBe(false);
    expect(body.reasoning).toEqual({ effort: 'medium' });
    expect(body.max_output_tokens).toBe(32_768);
  });
  it('distinguishes an output-token truncation from an empty successful response', async () => {
    const fetcher = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ id: 'res-incomplete', model: 'test-model', status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' }, output: [], usage: { input_tokens: 3, output_tokens: 8, total_tokens: 11 } }) });
    const client = new OpenAiProviderClient(loadLlmAgentEnvironment({ LLM_AGENT_ENABLED: 'true', LLM_AGENT_TRIGGER_MODE: 'ALWAYS', LLM_AGENT_MODEL: 'test-model', OPENAI_API_KEY: 'test-secret' }), fetcher as unknown as typeof fetch,
      { reasoningEffort: 'medium', maxOutputTokens: 8 });
    await expect(client.generate('prompt', new AbortController().signal)).rejects.toMatchObject({ reason: 'OUTPUT_TRUNCATED', retryable: false });
  });
  it('keeps the production Provider request unchanged when experiment options are omitted', async () => {
    const fetcher = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ id: 'res-default', model: 'test-model',
      output: [{ content: [{ type: 'output_text', text: JSON.stringify(completed) }] }], usage: {} }) });
    const client = new OpenAiProviderClient(loadLlmAgentEnvironment({ LLM_AGENT_ENABLED: 'true', LLM_AGENT_TRIGGER_MODE: 'ALWAYS', LLM_AGENT_MODEL: 'test-model', OPENAI_API_KEY: 'test-secret' }), fetcher as unknown as typeof fetch);
    await client.generate('prompt', new AbortController().signal);
    const body = JSON.parse(fetcher.mock.calls[0]?.[1]?.body as string);
    expect(body).not.toHaveProperty('reasoning');
    expect(body).not.toHaveProperty('max_output_tokens');
  });
  it('maps Provider rate limits to the fixed reason', async () => {
    const client = new OpenAiProviderClient(loadLlmAgentEnvironment({ LLM_AGENT_ENABLED: 'true', LLM_AGENT_TRIGGER_MODE: 'ALWAYS', LLM_AGENT_MODEL: 'test-model', OPENAI_API_KEY: 'test-secret', LLM_AGENT_MAX_RETRIES: '0' }), jest.fn().mockResolvedValue({ ok: false, status: 429 }) as unknown as typeof fetch);
    const run = await new LlmAgentRunnerService(client, new LlmAgentToolsService(), validator, loadLlmAgentEnvironment({ LLM_AGENT_MAX_RETRIES: '0' })).execute(request, { scanId: 'scan', extractedPackageRoot: root });
    expect(run).toMatchObject({ status: 'FAILED', failureReason: 'RATE_LIMITED' });
    expect(JSON.stringify(run)).not.toContain('test-secret');
  });
  it('keeps package text untrusted and validates active credentials', () => {
    expect(buildAgentPrompt(request)).toContain('untrusted data');
    expect(buildAgentPrompt(request)).not.toContain('groundTruth');
    expect(() => loadLlmAgentEnvironment({ LLM_AGENT_ENABLED: 'true', LLM_AGENT_TRIGGER_MODE: 'ALWAYS', LLM_AGENT_MODEL: 'mock' })).toThrow('OPENAI_API_KEY');
    expect(loadLlmAgentEnvironment({ LLM_AGENT_ENABLED: 'false' }).OPENAI_API_KEY).toBeUndefined();
  });
});
