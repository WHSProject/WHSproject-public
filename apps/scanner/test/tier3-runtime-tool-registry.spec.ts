import { loadLlmAgentEnvironment } from '../src/config/scanner-environment';
import { AgentOutputValidatorService } from '../src/llm-agent/agent-output-validator.service';
import { LlmAgentRunnerService } from '../src/llm-agent/agent-runner.service';
import { AgentInputV0_3Builder, type AgentInputV0_3Policy } from '../src/llm-agent/artifact/agent-input-v0_3.builder';
import { AGENT_OUTPUT_API_SCHEMA_V0_2 } from '../src/llm-agent/artifact/agent-output-v0_2.api-schema';
import { AGENT_OUTPUT_API_SCHEMA_V0_3 } from '../src/llm-agent/artifact/agent-output-v0_3.api-schema';
import type { GetFileRangeRequest } from '../src/llm-agent/artifact/agent-output-v0_3.contract';
import type { ValidatedAgentAnalysisPlan } from '../src/llm-agent/artifact/artifact.contract';
import { InMemoryCodeSliceRegistry } from '../src/llm-agent/artifact/code-slice.registry';
import { RuntimeCodeTool, type RuntimeToolContext } from '../src/llm-agent/artifact/runtime-code-tool';
import { AgentToolError, LlmAgentToolsService, type AgentToolUsage } from '../src/llm-agent/llm-agent-tools.service';
import { OpenAiProviderClient, type AgentProviderResponse } from '../src/llm-agent/openai-provider.client';
import { AGENT_OUTPUT_SCHEMA } from '../src/llm-agent/output-schema';
import {
  createMockArtifactResolver,
  deobfuscatedOnlyPlan,
  DEOBFUSCATED_ARTIFACT_ID,
  FIXTURE_ROOT,
  MOCK_ARCHIVE_SHA256,
  MOCK_SCAN_ID,
  mockExecutionInput,
  originalAndDeobfuscatedPlan,
  originalOnlyPlan,
  ORIGINAL_ARTIFACT_ID,
} from './fixtures/tier3-artifacts/mock-artifacts';

const settings = loadLlmAgentEnvironment({ LLM_AGENT_MAX_RETRIES: '0', LLM_AGENT_MAX_LINES_PER_SLICE: '20' });
const inputPolicy: AgentInputV0_3Policy = {
  codeSlices: { maxInitialSlices: 8, maxLinesPerSlice: 80, maxInitialCodeLines: 120, maxTotalCodeLines: 60, maxFileSizeBytes: 65536 },
  maxToolCalls: 3,
  maxAdditionalCodeRequests: 2,
};
const context = { scanId: MOCK_SCAN_ID, packageName: 'tier3-fixture', packageVersion: '1.0.0', archiveSha256: MOCK_ARCHIVE_SHA256 };
const requestId = `agent-analysis:${MOCK_SCAN_ID}:0.3.0`;

const fileRange = (id: string, artifactId: string, startLine: number, endLine: number, filePath = 'install.js'): GetFileRangeRequest => ({
  id, type: 'GET_FILE_RANGE', target: { artifactId, filePath, startLine, endLine }, reasonCode: 'NEED_CONTEXT',
});
const needsCode = (...requests: GetFileRangeRequest[]) => ({ requestId, schemaVersion: '0.3.0', status: 'NEEDS_ADDITIONAL_CODE', requests });
const completed = (assessments: unknown[] = []) => ({
  requestId, schemaVersion: '0.3.0', status: 'COMPLETED', assessments,
  summary: { verdict: 'INCONCLUSIVE', confidence: 0.3, reasonCodes: ['LIMITED_CONTEXT'] }, limitations: [], missingContext: [],
});
const assessment = {
  id: 'A-1', type: 'CORRELATED_BEHAVIOR', signal: 'ENV_READ', category: 'CREDENTIAL', basis: 'PATTERN_MATCH',
  refs: [{ id: 'R-1', sliceId: 'SLICE-R001', lines: [17, 17], role: 'SOURCE' }], flow: { source: 'R-1' }, reachability: { status: 'UNKNOWN' },
  verification: { status: 'UNVERIFIED', method: 'NONE' }, confidence: 0.4, reasonCodes: ['ENV_ACCESS'],
  claimScope: 'CODE_BEHAVIOR', limitations: [],
};
const response = (output: unknown): AgentProviderResponse => ({ text: JSON.stringify(output), model: 'mock-model', usage: {}, durationMs: 1 });

async function prepare(plan: ValidatedAgentAnalysisPlan) {
  const resolver = createMockArtifactResolver();
  const { input, registry } = await new AgentInputV0_3Builder().build(mockExecutionInput(plan, resolver), context, inputPolicy);
  return { input, registry, resolver };
}

function runner(...outputs: unknown[]) {
  const generate = jest.fn();
  for (const output of outputs) generate.mockResolvedValueOnce(response(output));
  return { generate, runner: new LlmAgentRunnerService({ generate }, new LlmAgentToolsService(), new AgentOutputValidatorService(), settings) };
}

function runnerWithEnvironment(environment: Record<string, string>, ...outputs: unknown[]) {
  const generate = jest.fn();
  for (const output of outputs) generate.mockResolvedValueOnce(response(output));
  const configured = loadLlmAgentEnvironment({ LLM_AGENT_MAX_RETRIES: '0', LLM_AGENT_MAX_LINES_PER_SLICE: '20', ...environment });
  return { generate, runner: new LlmAgentRunnerService({ generate }, new LlmAgentToolsService(), new AgentOutputValidatorService(), configured) };
}

function runnerWithLimit(maxLinesPerRequest: number, ...outputs: unknown[]) {
  const generate = jest.fn();
  for (const output of outputs) generate.mockResolvedValueOnce(response(output));
  const limited = loadLlmAgentEnvironment({ LLM_AGENT_MAX_RETRIES: '0', LLM_AGENT_MAX_LINES_PER_SLICE: String(maxLinesPerRequest) });
  return { generate, runner: new LlmAgentRunnerService({ generate }, new LlmAgentToolsService(), new AgentOutputValidatorService(), limited) };
}

describe('Tier 3 runtime tool and slice registry (#346)', () => {
  it('serves a range over the per-request limit up to the limit and tells the Agent it was cut', async () => {
    const { input, registry, resolver } = await prepare(deobfuscatedOnlyPlan);
    const { generate, runner: agent } = runnerWithLimit(5, needsCode(fileRange('REQ-1', DEOBFUSCATED_ARTIFACT_ID, 1, 18)), completed());

    const result = await agent.executeV0_3(input, { resolver, registry });

    expect(result).toMatchObject({ status: 'COMPLETED', modelCalls: 2, toolCalls: 1, additionalCodeRequests: 1 });
    expect(registry.get('SLICE-R001')).toMatchObject({ artifactId: DEOBFUSCATED_ARTIFACT_ID, startLine: 1, endLine: 5, origin: 'RUNTIME', boundaryConfidence: 'LOW' });
    expect(generate.mock.calls[1]?.[0]).toContain('"truncated":true');
    expect(result.codeRequests).toEqual([{
      requestId: 'REQ-1', artifactId: DEOBFUSCATED_ARTIFACT_ID, filePath: 'install.js',
      requestedRange: { startLine: 1, endLine: 18 }, servedRange: { startLine: 1, endLine: 5 }, truncated: true,
    }]);
    expect(JSON.stringify(result)).not.toContain(FIXTURE_ROOT);
  });

  it('records no code request when the Agent asks for none', async () => {
    const { input, registry, resolver } = await prepare(originalOnlyPlan);
    const { runner: agent } = runner(completed());
    expect(await agent.executeV0_3(input, { resolver, registry })).toMatchObject({ status: 'COMPLETED', toolCalls: 0, codeRequests: [] });
  });

  describe.each([
    ['ORIGINAL_ONLY', originalOnlyPlan, ORIGINAL_ARTIFACT_ID, 2, 4],
    ['DEOBFUSCATED_ONLY', deobfuscatedOnlyPlan, DEOBFUSCATED_ARTIFACT_ID, 16, 18],
    ['ORIGINAL_AND_DEOBFUSCATED', originalAndDeobfuscatedPlan, DEOBFUSCATED_ARTIFACT_ID, 16, 18],
  ] as const)('fixture %s', (_mode, plan, artifactId, startLine, endLine) => {
    it('turns GET_FILE_RANGE into a RUNTIME slice in the same registry and re-calls the Agent', async () => {
      const { input, registry, resolver } = await prepare(plan);
      const initial = registry.list();
      const { generate, runner: agent } = runner(needsCode(fileRange('REQ-1', artifactId, startLine, endLine)), completed([assessment]));

      const result = await agent.executeV0_3(input, { resolver, registry });

      expect(result).toMatchObject({ status: 'PARTIAL', promptVersion: 'scanner-single-agent-0.3.2', outputSchemaVersion: '0.3.0', modelCalls: 2, toolCalls: 1, additionalCodeRequests: 1 });
      const runtime = registry.get('SLICE-R001');
      expect(runtime).toMatchObject({
        artifactId, filePath: 'install.js', startLine, endLine, origin: 'RUNTIME', planningTargetId: null,
        additionalCodeRequestId: 'ACR-001', agentRequestId: 'REQ-1', selectionReason: 'Agent request REQ-1: NEED_CONTEXT',
      });
      expect(registry.list()).toEqual([...initial, runtime]);
      expect(result.slices).toEqual(registry.list());
      // The runtime slice reaches the Agent only as a tool response; the input stays INITIAL-only.
      expect(generate.mock.calls[1]?.[0]).toContain('"sliceId":"SLICE-R001"');
      expect(generate.mock.calls[1]?.[0]).toContain(JSON.stringify(runtime!.content).slice(1, -1));
      expect(input.initialCodeSlices.every((slice) => slice.origin === 'INITIAL')).toBe(true);
      expect(generate.mock.calls[0]?.[2]).toBe(AGENT_OUTPUT_API_SCHEMA_V0_3);
      expect(generate.mock.calls[0]?.[0]).toContain('whose representation analysisPlan.analysisMode allows');
      expect(JSON.stringify(result)).not.toContain(FIXTURE_ROOT);
      expect(JSON.stringify(generate.mock.calls)).not.toContain(FIXTURE_ROOT);
    });
  });

  it('keeps the same filePath apart by artifactId', async () => {
    const { input, registry, resolver } = await prepare(originalAndDeobfuscatedPlan);
    const { runner: agent } = runner(needsCode(fileRange('REQ-1', ORIGINAL_ARTIFACT_ID, 8, 8), fileRange('REQ-2', DEOBFUSCATED_ARTIFACT_ID, 17, 17)), completed());

    const result = await agent.executeV0_3(input, { resolver, registry });

    expect(result.status).toBe('COMPLETED');
    const [first, second] = [registry.get('SLICE-R001')!, registry.get('SLICE-R002')!];
    expect([first.artifactId, second.artifactId]).toEqual([ORIGINAL_ARTIFACT_ID, DEOBFUSCATED_ARTIFACT_ID]);
    expect(first.filePath).toBe(second.filePath);
    expect(first.content).toContain('process[_0x5e(1)]');
    expect(second.content).toBe('const home = process.env.HOME;');
    expect(second.additionalCodeRequestId).toBe('ACR-002');
  });

  it.each([
    ['an artifact outside analysisMode', deobfuscatedOnlyPlan, fileRange('REQ-1', ORIGINAL_ARTIFACT_ID, 1, 3), 'TOOL_REQUEST_REJECTED'],
    ['an unknown artifact', originalOnlyPlan, fileRange('REQ-1', 'ARTIFACT-UNKNOWN', 1, 3), 'TOOL_REQUEST_REJECTED'],
    ['a path outside the artifact', originalOnlyPlan, fileRange('REQ-1', ORIGINAL_ARTIFACT_ID, 1, 3, '../deobfuscated/install.js'), 'TOOL_REQUEST_REJECTED'],
  ] as const)('fails the run for %s', async (_label, plan, request, reason) => {
    const { input, registry, resolver } = await prepare(plan);
    const before = registry.list();
    const { runner: agent } = runner(needsCode(request), completed());

    const result = await agent.executeV0_3(input, { resolver, registry });

    expect(result).toMatchObject({ status: 'FAILED', failureReason: reason, toolCalls: 0 });
    expect(registry.list()).toEqual(before);
    expect(JSON.stringify(result)).not.toContain(FIXTURE_ROOT);
  });

  it.each([
    ['a missing file', {}, fileRange('REQ-1', ORIGINAL_ARTIFACT_ID, 1, 3, 'missing.js'), 'FILE_NOT_FOUND', '"reason":"FILE_NOT_FOUND"'],
    ['a range starting after the file', {}, fileRange('REQ-1', ORIGINAL_ARTIFACT_ID, 10, 12), 'RANGE_OUTSIDE_FILE', '"lineCount":9'],
    ['a file over the size limit', { LLM_AGENT_MAX_FILE_SIZE_BYTES: '10' }, fileRange('REQ-1', ORIGINAL_ARTIFACT_ID, 1, 3), 'FILE_TOO_LARGE', '"sizeBytes":'],
  ] as const)('tells the Agent that %s cannot be served and lets the run go on', async (_label, environment, request, reason, detail) => {
    const { input, registry, resolver } = await prepare(originalOnlyPlan);
    const before = registry.list();
    const { generate, runner: agent } = runnerWithEnvironment({ ...environment }, needsCode(request), completed());

    const result = await agent.executeV0_3(input, { resolver, registry });

    expect(result).toMatchObject({ status: 'COMPLETED', modelCalls: 2, toolCalls: 1, additionalCodeRequests: 1 });
    expect(registry.list()).toEqual(before);
    expect(result.codeRequests).toEqual([expect.objectContaining({ requestId: 'REQ-1', servedRange: null, truncated: false, unavailableReason: reason })]);
    expect(generate.mock.calls[1]?.[0]).toContain(`"unavailable":{"reason":"${reason}"`);
    expect(generate.mock.calls[1]?.[0]).toContain(detail);
    expect(JSON.stringify(result)).not.toContain(FIXTURE_ROOT);
  });

  it('serves the other requests of the same turn when one of them cannot be served', async () => {
    const { input, registry, resolver } = await prepare(originalOnlyPlan);
    const { runner: agent } = runner(needsCode(fileRange('REQ-1', ORIGINAL_ARTIFACT_ID, 1, 3, 'missing.js'), fileRange('REQ-2', ORIGINAL_ARTIFACT_ID, 1, 3)), completed());

    const result = await agent.executeV0_3(input, { resolver, registry });

    expect(result).toMatchObject({ status: 'COMPLETED', toolCalls: 2, additionalCodeRequests: 2 });
    expect(result.codeRequests.map((item) => [item.requestId, item.unavailableReason ?? 'SERVED'])).toEqual([['REQ-1', 'FILE_NOT_FOUND'], ['REQ-2', 'SERVED']]);
    expect(registry.get('SLICE-R002')).toMatchObject({ origin: 'RUNTIME', agentRequestId: 'REQ-2' });
  });

  describe('request budget', () => {
    const withPolicy = (fromRunner: Awaited<ReturnType<typeof prepare>>, policy: Partial<{ maxToolCalls: number; maxAdditionalCodeRequests: number }>) => (
      { ...fromRunner.input, analysisPolicy: { ...fromRunner.input.analysisPolicy, ...policy } }
    );

    it('asks for the final answer once the additional request budget is used up', async () => {
      const fromRunner = await prepare(originalOnlyPlan);
      const { generate, runner: agent } = runner(needsCode(fileRange('REQ-1', ORIGINAL_ARTIFACT_ID, 1, 3)), completed());
      const result = await agent.executeV0_3(withPolicy(fromRunner, { maxAdditionalCodeRequests: 1 }), fromRunner);
      expect(result).toMatchObject({ status: 'COMPLETED', modelCalls: 2, additionalCodeRequests: 1 });
      expect(generate.mock.calls[0]?.[0]).not.toContain('no longer available');
      expect(generate.mock.calls[1]?.[0]).toContain('no longer available');
    });

    it('makes the third Agent call a final-answer call even with request budget left', async () => {
      const fromRunner = await prepare(originalOnlyPlan);
      const { generate, runner: agent } = runner(
        needsCode(fileRange('REQ-1', ORIGINAL_ARTIFACT_ID, 1, 2)), needsCode(fileRange('REQ-2', ORIGINAL_ARTIFACT_ID, 3, 4)), completed());
      const result = await agent.executeV0_3(withPolicy(fromRunner, { maxAdditionalCodeRequests: 5, maxToolCalls: 5 }), fromRunner);
      expect(result).toMatchObject({ status: 'COMPLETED', modelCalls: 3, additionalCodeRequests: 2 });
      expect(generate.mock.calls[1]?.[0]).not.toContain('no longer available');
      expect(generate.mock.calls[2]?.[0]).toContain('no longer available');
    });

    it('still fails when the final call asks for more code anyway', async () => {
      const fromRunner = await prepare(originalOnlyPlan);
      const { runner: agent } = runner(
        needsCode(fileRange('REQ-1', ORIGINAL_ARTIFACT_ID, 1, 2)), needsCode(fileRange('REQ-2', ORIGINAL_ARTIFACT_ID, 3, 4)), needsCode(fileRange('REQ-3', ORIGINAL_ARTIFACT_ID, 5, 6)));
      const result = await agent.executeV0_3(withPolicy(fromRunner, { maxAdditionalCodeRequests: 5, maxToolCalls: 5 }), fromRunner);
      expect(result).toMatchObject({ status: 'FAILED', failureReason: 'REQUEST_LIMIT_EXCEEDED', modelCalls: 3 });
    });

    it('answers the requests over budget in the same turn and serves the ones within it', async () => {
      const fromRunner = await prepare(originalOnlyPlan);
      const { runner: agent } = runner(needsCode(
        fileRange('REQ-1', ORIGINAL_ARTIFACT_ID, 1, 2), fileRange('REQ-2', ORIGINAL_ARTIFACT_ID, 3, 4), fileRange('REQ-3', ORIGINAL_ARTIFACT_ID, 5, 6)), completed());
      const result = await agent.executeV0_3(withPolicy(fromRunner, { maxAdditionalCodeRequests: 2 }), fromRunner);
      expect(result).toMatchObject({ status: 'COMPLETED', additionalCodeRequests: 2 });
      expect(result.codeRequests.map((item) => item.unavailableReason ?? 'SERVED')).toEqual(['SERVED', 'SERVED', 'BUDGET_EXHAUSTED']);
    });
  });

  it('fails the run on a repeated request even with a new id', async () => {
    const { input, registry, resolver } = await prepare(originalOnlyPlan);
    const { runner: agent } = runner(needsCode(fileRange('REQ-1', ORIGINAL_ARTIFACT_ID, 1, 3), fileRange('REQ-2', ORIGINAL_ARTIFACT_ID, 1, 3)));
    const result = await agent.executeV0_3(input, { resolver, registry });
    expect(result).toMatchObject({ status: 'FAILED', failureReason: 'TOOL_REQUEST_REJECTED', toolCalls: 1 });
    // What was served before the rejection stays on record.
    expect(result.codeRequests).toEqual([expect.objectContaining({ requestId: 'REQ-1', requestedRange: { startLine: 1, endLine: 3 }, servedRange: { startLine: 1, endLine: 3 }, truncated: false })]);
  });

  it('fails the run when the Agent requests a tool other than GET_FILE_RANGE', async () => {
    const { input, registry, resolver } = await prepare(originalOnlyPlan);
    const { runner: agent } = runner(needsCode({ ...fileRange('REQ-1', ORIGINAL_ARTIFACT_ID, 1, 3), type: 'GET_CALLERS' } as unknown as GetFileRangeRequest));
    expect(await agent.executeV0_3(input, { resolver, registry })).toMatchObject({ status: 'FAILED', failureReason: 'OUTPUT_SCHEMA_VALIDATION_FAILED', toolCalls: 0 });
  });

  it('passes bounded structural validation details to a schema retry without echoing the raw output', async () => {
    const { input, registry, resolver } = await prepare(originalOnlyPlan);
    const invalid = { ...completed(), missingContext: [{
      kind: 'CODE_MISSING', detail: 'RAW_OUTPUT_SENTINEL', affectedAssessmentIds: [],
    }] };
    const { generate, runner: agent } = runnerWithEnvironment({ LLM_AGENT_MAX_RETRIES: '1' }, invalid, completed());

    const result = await agent.executeV0_3(input, { resolver, registry });

    expect(result).toMatchObject({ status: 'COMPLETED', modelCalls: 2 });
    const retryPrompt = generate.mock.calls[1]?.[0] as string;
    expect(retryPrompt).toContain('Schema validation failed at $.missingContext[0].affectedAssessmentIds (too_small)');
    expect(retryPrompt).toContain('expected array to have >=1 items');
    expect(retryPrompt).not.toContain('RAW_OUTPUT_SENTINEL');
  });

  describe('budgets', () => {
    const usage = (codeLines = 0): AgentToolUsage => ({ calls: 0, additionalCodeRequests: 0, codeLines, requestKeys: new Set() });
    const toolContext = (overrides: Partial<RuntimeToolContext> = {}): RuntimeToolContext => ({
      resolver: createMockArtifactResolver(), registry: new InMemoryCodeSliceRegistry(), analysisMode: 'ORIGINAL_AND_DEOBFUSCATED',
      policy: { maxToolCalls: 3, maxAdditionalCodeRequests: 2, maxTotalCodeLines: 20 }, maxLinesPerRequest: 20, maxFileSizeBytes: 65536, usage: usage(), ...overrides,
    });
    const reason = async (promise: Promise<unknown>) => promise.then(() => 'OK', (error: unknown) => (error instanceof AgentToolError ? error.reason : String(error)));
    const tool = new RuntimeCodeTool();

    it('counts the lines served, not the lines requested, against maxTotalCodeLines', async () => {
      const cut = toolContext({ maxLinesPerRequest: 5, policy: { maxToolCalls: 3, maxAdditionalCodeRequests: 3, maxTotalCodeLines: 8 } });
      const first = await tool.getFileRange(fileRange('REQ-1', DEOBFUSCATED_ARTIFACT_ID, 1, 18), cut);
      if ('unavailable' in first) throw new Error('expected a served slice');
      expect({ end: first.slice.endLine, truncated: first.truncated }).toEqual({ end: 5, truncated: true });
      expect(cut.usage.codeLines).toBe(5);
      // The next part is cut to five lines as well, which no longer fits in the budget of eight.
      await expect(tool.getFileRange(fileRange('REQ-2', DEOBFUSCATED_ARTIFACT_ID, 6, 18), cut)).resolves.toMatchObject({ unavailable: { reason: 'BUDGET_EXHAUSTED' } });
      expect(cut.usage).toMatchObject({ calls: 1, additionalCodeRequests: 1, codeLines: 5 });
      const rest = await tool.getFileRange(fileRange('REQ-3', DEOBFUSCATED_ARTIFACT_ID, 6, 8), cut);
      if ('unavailable' in rest) throw new Error('expected a served slice');
      expect({ end: rest.slice.endLine, truncated: rest.truncated }).toEqual({ end: 8, truncated: false });
      expect(cut.usage.codeLines).toBe(8);
    });

    it('still rejects the same oversized request sent again, and accepts the part after the cut', async () => {
      const cut = toolContext({ maxLinesPerRequest: 5 });
      await tool.getFileRange(fileRange('REQ-1', DEOBFUSCATED_ARTIFACT_ID, 1, 18), cut);
      expect(await reason(tool.getFileRange(fileRange('REQ-2', DEOBFUSCATED_ARTIFACT_ID, 1, 18), cut))).toBe('TOOL_REQUEST_REJECTED');
      await expect(tool.getFileRange(fileRange('REQ-3', DEOBFUSCATED_ARTIFACT_ID, 6, 18), cut)).resolves.toMatchObject({ truncated: true, slice: { startLine: 6, endLine: 10 } });
    });

    it('counts INITIAL and RUNTIME lines against maxTotalCodeLines', async () => {
      const fromRunner = await prepare(originalAndDeobfuscatedPlan);
      const initialLines = fromRunner.registry.list().reduce((sum, slice) => sum + slice.endLine - slice.startLine + 1, 0);
      expect(initialLines).toBe(27);
      const request = fileRange('REQ-1', DEOBFUSCATED_ARTIFACT_ID, 1, 18);
      const { generate, runner: agent } = runner(needsCode(request), completed());
      const result = await agent.executeV0_3({ ...fromRunner.input, analysisPolicy: { ...fromRunner.input.analysisPolicy, maxTotalCodeLines: initialLines + 17 } }, fromRunner);
      expect(result).toMatchObject({ status: 'COMPLETED', modelCalls: 2 });
      expect(result.codeRequests).toEqual([expect.objectContaining({ requestId: 'REQ-1', servedRange: null, unavailableReason: 'BUDGET_EXHAUSTED' })]);
      expect(generate.mock.calls[1]?.[0]).toContain('no longer available');

      const exact = toolContext({ usage: usage(initialLines), policy: { maxToolCalls: 3, maxAdditionalCodeRequests: 2, maxTotalCodeLines: initialLines + 18 } });
      await expect(tool.getFileRange(request, exact)).resolves.toMatchObject({ slice: { sliceId: 'SLICE-R001' } });
      expect(exact.usage.codeLines).toBe(initialLines + 18);
    });

    it('limits tool calls and additional code requests', async () => {
      const calls = toolContext({ policy: { maxToolCalls: 1, maxAdditionalCodeRequests: 5, maxTotalCodeLines: 100 } });
      await tool.getFileRange(fileRange('REQ-1', ORIGINAL_ARTIFACT_ID, 1, 2), calls);
      await expect(tool.getFileRange(fileRange('REQ-2', ORIGINAL_ARTIFACT_ID, 3, 4), calls)).resolves.toMatchObject({ unavailable: { reason: 'BUDGET_EXHAUSTED' } });
      expect(calls.usage).toMatchObject({ calls: 1, additionalCodeRequests: 1 });

      const requests = toolContext({ policy: { maxToolCalls: 5, maxAdditionalCodeRequests: 1, maxTotalCodeLines: 100 } });
      await tool.getFileRange(fileRange('REQ-1', ORIGINAL_ARTIFACT_ID, 1, 2), requests);
      await expect(tool.getFileRange(fileRange('REQ-2', ORIGINAL_ARTIFACT_ID, 3, 4), requests)).resolves.toMatchObject({ unavailable: { reason: 'BUDGET_EXHAUSTED' } });
      expect(requests.usage).toMatchObject({ calls: 1, additionalCodeRequests: 1 });
    });

    it('rejects an invalid range and trims a range past the end of the file', async () => {
      expect(await reason(tool.getFileRange(fileRange('REQ-1', ORIGINAL_ARTIFACT_ID, 5, 4), toolContext()))).toBe('TOOL_REQUEST_REJECTED');
      expect(await reason(tool.getFileRange(fileRange('REQ-1', ORIGINAL_ARTIFACT_ID, 0, 4), toolContext()))).toBe('TOOL_REQUEST_REJECTED');

      const trimmed = toolContext();
      const cutOutcome = await tool.getFileRange(fileRange('REQ-1', ORIGINAL_ARTIFACT_ID, 7, 12), trimmed);
      if ('unavailable' in cutOutcome) throw new Error('expected a served slice');
      const { slice, truncated } = cutOutcome;
      expect({ start: slice.startLine, end: slice.endLine, truncated, confidence: slice.boundaryConfidence }).toEqual({ start: 7, end: 9, truncated: true, confidence: 'LOW' });
      expect(trimmed.usage.codeLines).toBe(3);
      const whole = await tool.getFileRange(fileRange('REQ-2', ORIGINAL_ARTIFACT_ID, 1, 9), trimmed);
      if ('unavailable' in whole) throw new Error('expected a served slice');
      expect(whole.slice.boundaryConfidence).toBe('HIGH');
    });
  });

  it('keeps the 0.1.0 output schema as the provider default and forwards an explicitly selected schema unchanged', async () => {
    const fetcher = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ output: [] }) });
    const client = new OpenAiProviderClient(loadLlmAgentEnvironment({ LLM_AGENT_ENABLED: 'true', LLM_AGENT_TRIGGER_MODE: 'ALWAYS', LLM_AGENT_MODEL: 'test-model', OPENAI_API_KEY: 'test-key' }), fetcher as unknown as typeof fetch);
    const signal = new AbortController().signal;
    await client.generate('prompt', signal);
    await client.generate('prompt', signal, AGENT_OUTPUT_API_SCHEMA_V0_2);
    const schemaOf = (call: number) => JSON.parse(fetcher.mock.calls[call][1].body as string).text.format.schema;
    expect(schemaOf(0)).toEqual(JSON.parse(JSON.stringify(AGENT_OUTPUT_SCHEMA)));
    expect(schemaOf(1)).toEqual(JSON.parse(JSON.stringify(AGENT_OUTPUT_API_SCHEMA_V0_2)));
    expect(JSON.parse(fetcher.mock.calls[1][1].body as string).text.format.strict).toBe(false);
  });
});
