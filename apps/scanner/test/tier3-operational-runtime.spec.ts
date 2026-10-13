import { loadLlmAgentEnvironment } from '../src/config/scanner-environment';
import type { AgentAnalysisResultV0_3, LlmAgentRunnerService } from '../src/llm-agent/agent-runner.service';
import { AgentInputV0_3Builder } from '../src/llm-agent/artifact/agent-input-v0_3.builder';
import { executeTier3V0_3, toTier3ShadowResult } from '../src/llm-agent/artifact/tier3-runtime';
import type { LlmAssessmentEvidence, LlmEvidenceAdapter } from '../src/llm-agent/llm-evidence.adapter';
import type { ValidatedAssessment } from '../src/llm-agent/output.contract';
import {
  createMockArtifactResolver,
  deobfuscatedOnlyPlan,
  MOCK_ARCHIVE_SHA256,
  MOCK_SCAN_ID,
  mockExecutionInput,
  originalOnlyPlan,
} from './fixtures/tier3-artifacts/mock-artifacts';

const settings = loadLlmAgentEnvironment({
  LLM_AGENT_ENABLED: 'true', LLM_AGENT_TRIGGER_MODE: 'ALWAYS',
  LLM_AGENT_MODEL: 'test-model', OPENAI_API_KEY: 'test-key',
});
const context = {
  scanId: MOCK_SCAN_ID, packageName: 'tier3-fixture', packageVersion: '1.0.0',
  archiveSha256: MOCK_ARCHIVE_SHA256,
};

function runResult(
  status: AgentAnalysisResultV0_3['status'],
  slices: AgentAnalysisResultV0_3['slices'] = [],
  assessments: ValidatedAssessment[] = [],
): AgentAnalysisResultV0_3 {
  return {
    status, analysisId: 'analysis-operational', promptVersion: '0.2.0', outputSchemaVersion: '0.2.0',
    providerRequestIds: [], usage: {}, modelCalls: 1, toolCalls: 0, additionalCodeRequests: 0,
    durationMs: 2, limitations: [], slices, codeRequests: [],
    ...(assessments.length === 0 ? {} : { validated: { output: {} as never, assessments } }),
  };
}

function evidence(findingId: string): LlmAssessmentEvidence {
  return {
    schemaVersion: '0.1', evidenceId: 'llm:analysis-operational:A-1', kind: 'LLM_ASSESSMENT',
    signal: { id: 'ENV_READ', type: 'ENV_READ', category: 'CREDENTIAL' },
    subject: { ecosystem: 'npm', packageName: 'tier3-fixture', packageVersion: '1.0.0', artifactHash: MOCK_ARCHIVE_SHA256 },
    assertion: { summary: 'Environment access', basis: 'PATTERN_MATCH' }, executionContext: { flow: {} },
    reachability: { status: 'POSSIBLE' }, intentAssessment: 'SUSPICIOUS', verificationStatus: 'VERIFIED',
    confidence: 0.7, reasonCodes: ['ENV_ACCESS'], alternatives: [], locations: [],
    relatedFindingIds: [findingId], relatedAtomicEvidenceIds: [], sources: [], limitations: [],
    provenance: { scanId: MOCK_SCAN_ID, producerType: 'LLM_AGENT', analysisId: 'analysis-operational', assessmentId: 'A-1',
      agentType: 'SINGLE_AGENT', agentVersion: '0.1.0', model: 'mock', promptVersion: '0.2.0', inputSchemaVersion: '0.3.0', outputSchemaVersion: '0.2.0' },
  };
}

function assessment(findingId: string): ValidatedAssessment {
  return {
    status: 'VERIFIED', issues: [],
    assessment: {
      id: 'A-1', type: 'CORRELATED_BEHAVIOR', signal: 'ENV_READ', category: 'CREDENTIAL', basis: 'PATTERN_MATCH',
      findingIds: [findingId], refs: [{ id: 'R-1', sliceId: 'SLICE-001-1', lines: [8, 8], role: 'SOURCE' }],
      flow: {}, reachability: { status: 'POSSIBLE' }, verification: { status: 'VERIFIED', method: 'DETERMINISTIC_VALIDATOR' },
      confidence: 0.7, reasonCodes: ['ENV_ACCESS'], intentAssessment: 'SUSPICIOUS',
    },
  };
}

describe('Tier 3 V0.3 operational result', () => {
  it.each([
    ['original-only', originalOnlyPlan, 'tier1:env-read:1'],
    ['restored', deobfuscatedOnlyPlan, 'tier2:env-read:1'],
  ] as const)('returns verified Evidence and keeps input, assessed and cited Finding scopes separate (%s)', async (_name, plan, findingId) => {
    const execution = mockExecutionInput(plan, createMockArtifactResolver());
    const runner = { executeV0_3: jest.fn().mockImplementation(async (_input, runtime) => runResult('COMPLETED', runtime.registry.list(), [assessment(findingId)])) };
    const adapter = { toEvidencesV0_3: jest.fn().mockReturnValue({ evidences: [evidence(findingId)], failures: [] }) };

    const result = await executeTier3V0_3({
      execution, context, settings, triggerReason: 'STATIC_FILTER',
      dependencies: { inputBuilder: new AgentInputV0_3Builder(), runner: runner as unknown as LlmAgentRunnerService, evidenceAdapter: adapter as unknown as LlmEvidenceAdapter },
    });

    expect(runner.executeV0_3).toHaveBeenCalledTimes(1);
    expect(adapter.toEvidencesV0_3).toHaveBeenCalledTimes(1);
    expect(result.evidences).toHaveLength(1);
    expect(result.summary).toMatchObject({ status: 'COMPLETED', generatedEvidenceCount: 1, triggerReason: 'STATIC_FILTER' });
    expect(result.inputFindingIds).toEqual([findingId]);
    expect(result.assessedFindingIds).toEqual([findingId]);
    expect(result.citedFindingIds).toEqual([findingId]);
    expect(toTier3ShadowResult(result)).toMatchObject({ status: 'COMPLETED', generatedEvidenceCount: 1 });
  });

  it('keeps valid siblings and reports item conversion failures as PARTIAL', async () => {
    const execution = mockExecutionInput(originalOnlyPlan);
    const findingId = 'tier1:env-read:1';
    const runner = { executeV0_3: jest.fn().mockImplementation(async (_input, runtime) => runResult('COMPLETED', runtime.registry.list(), [assessment(findingId)])) };
    const adapter = { toEvidencesV0_3: jest.fn().mockReturnValue({
      evidences: [evidence(findingId)], failures: [{ assessmentId: 'A-2', reason: 'EVIDENCE_CONVERSION_FAILED' }],
    }) };
    const result = await executeTier3V0_3({ execution, context, settings, triggerReason: 'STATIC_FILTER',
      dependencies: { inputBuilder: new AgentInputV0_3Builder(), runner: runner as unknown as LlmAgentRunnerService, evidenceAdapter: adapter as unknown as LlmEvidenceAdapter } });

    expect(result.evidences).toHaveLength(1);
    expect(result.conversionFailures).toEqual([{ assessmentId: 'A-2', reason: 'EVIDENCE_CONVERSION_FAILED' }]);
    expect(result.summary).toMatchObject({ status: 'PARTIAL', generatedEvidenceCount: 1, rejectedAssessmentCount: 1 });
  });

  it('distinguishes a completed run with no Evidence from execution failure', async () => {
    const execution = mockExecutionInput(originalOnlyPlan);
    const runner = { executeV0_3: jest.fn().mockImplementation(async (_input, runtime) => runResult('COMPLETED', runtime.registry.list())) };
    const result = await executeTier3V0_3({ execution, context, settings, triggerReason: 'STATIC_FILTER', dependencies: {
      inputBuilder: new AgentInputV0_3Builder(), runner: runner as unknown as LlmAgentRunnerService,
      evidenceAdapter: { toEvidencesV0_3: jest.fn().mockReturnValue({ evidences: [], failures: [] }) } as unknown as LlmEvidenceAdapter,
    } });
    expect(result.summary).toMatchObject({ status: 'COMPLETED', generatedEvidenceCount: 0 });
    expect(result.executionFailure).toBeUndefined();
  });

  it.each([
    ['FAILED', 'PROVIDER_ERROR'],
    ['TIMEOUT', 'TIMEOUT'],
  ] as const)('preserves a Runner %s result and failure reason', async (status, failureReason) => {
    const execution = mockExecutionInput(originalOnlyPlan);
    const runner = { executeV0_3: jest.fn().mockImplementation(async (_input, runtime) => ({
      ...runResult(status, runtime.registry.list()), failureReason,
    })) };
    const result = await executeTier3V0_3({ execution, context, settings, triggerReason: 'STATIC_FILTER', dependencies: {
      inputBuilder: new AgentInputV0_3Builder(), runner: runner as unknown as LlmAgentRunnerService,
      evidenceAdapter: { toEvidencesV0_3: jest.fn().mockReturnValue({ evidences: [], failures: [] }) } as unknown as LlmEvidenceAdapter,
    } });
    expect(result.summary).toMatchObject({ status, failureReason });
    expect(result.executionFailure).toEqual({ stage: 'RUNNER', reason: failureReason });
    expect(result.evidences).toEqual([]);
  });

  it('preserves builder failure, runner failure, timeout, and total conversion failure stages', async () => {
    const execution = mockExecutionInput(originalOnlyPlan);
    const adapter = { toEvidencesV0_3: jest.fn().mockReturnValue({ evidences: [], failures: [] }) } as unknown as LlmEvidenceAdapter;
    const builderFailure = await executeTier3V0_3({ execution, context, settings, triggerReason: 'STATIC_FILTER', dependencies: {
      inputBuilder: { build: jest.fn().mockRejectedValue(new Error('build')) } as unknown as AgentInputV0_3Builder,
      runner: { executeV0_3: jest.fn() } as unknown as LlmAgentRunnerService, evidenceAdapter: adapter,
    } });
    expect(builderFailure).toMatchObject({ summary: { status: 'FAILED', failureReason: 'INPUT_BUILD_FAILED' }, executionFailure: { stage: 'INPUT_BUILD' } });

    const runnerFailure = await executeTier3V0_3({ execution, context, settings, triggerReason: 'STATIC_FILTER', dependencies: {
      inputBuilder: new AgentInputV0_3Builder(), runner: { executeV0_3: jest.fn().mockRejectedValue(new Error('provider')) } as unknown as LlmAgentRunnerService, evidenceAdapter: adapter,
    } });
    expect(runnerFailure).toMatchObject({ summary: { status: 'FAILED', failureReason: 'INTERNAL_ERROR' }, executionFailure: { stage: 'RUNNER' } });

    const controller = new AbortController(); controller.abort();
    const timedOut = await executeTier3V0_3({ execution, context, settings, triggerReason: 'STATIC_FILTER', signal: controller.signal, dependencies: {
      inputBuilder: new AgentInputV0_3Builder(), runner: { executeV0_3: jest.fn() } as unknown as LlmAgentRunnerService, evidenceAdapter: adapter,
    } });
    expect(timedOut).toMatchObject({ summary: { status: 'TIMEOUT', failureReason: 'TIMEOUT' }, executionFailure: { stage: 'INPUT_BUILD', reason: 'TIMEOUT' } });

    const conversionFailure = await executeTier3V0_3({ execution, context, settings, triggerReason: 'STATIC_FILTER', dependencies: {
      inputBuilder: new AgentInputV0_3Builder(),
      runner: { executeV0_3: jest.fn().mockImplementation(async (_input, runtime) => runResult('COMPLETED', runtime.registry.list(), [assessment('tier1:env-read:1')])) } as unknown as LlmAgentRunnerService,
      evidenceAdapter: { toEvidencesV0_3: jest.fn().mockImplementation(() => { throw new Error('conversion'); }) } as unknown as LlmEvidenceAdapter,
    } });
    expect(conversionFailure).toMatchObject({ summary: { status: 'PARTIAL', generatedEvidenceCount: 0 }, executionFailure: { stage: 'EVIDENCE_CONVERSION' } });
    expect(conversionFailure.conversionFailures).toEqual([{ assessmentId: 'A-1', reason: 'EVIDENCE_CONVERSION_FAILED' }]);
  });

  it('returns a dependency failure without starting a run', async () => {
    const execution = mockExecutionInput(originalOnlyPlan);
    const result = await executeTier3V0_3({
      execution, context, settings, triggerReason: 'STATIC_FILTER_STATIC_INCOMPLETE', dependencies: {},
    });
    expect(result).toMatchObject({
      evidences: [], summary: { status: 'FAILED', failureReason: 'INTERNAL_ERROR' },
      executionFailure: { stage: 'DEPENDENCY', reason: 'INTERNAL_ERROR' },
    });
  });

  it('does not mutate the prepared execution input', async () => {
    const execution = mockExecutionInput(originalOnlyPlan);
    const before = JSON.stringify({ plan: execution.validatedPlan, findings: execution.findings, evidences: execution.atomicEvidences, bindings: execution.bindings, context: execution.packageContext });
    const runner = { executeV0_3: jest.fn().mockImplementation(async (_input, runtime) => runResult('COMPLETED', runtime.registry.list())) };
    await executeTier3V0_3({ execution, context, settings, triggerReason: 'STATIC_FILTER', dependencies: {
      inputBuilder: new AgentInputV0_3Builder(), runner: runner as unknown as LlmAgentRunnerService,
      evidenceAdapter: { toEvidencesV0_3: jest.fn().mockReturnValue({ evidences: [], failures: [] }) } as unknown as LlmEvidenceAdapter,
    } });
    expect(JSON.stringify({ plan: execution.validatedPlan, findings: execution.findings, evidences: execution.atomicEvidences, bindings: execution.bindings, context: execution.packageContext })).toBe(before);
  });
});
