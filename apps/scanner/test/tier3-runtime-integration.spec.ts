import { join } from 'node:path';
import type { AnalysisContext } from '../src/domain/analysis.types';
import type { AgentAnalysisResultV0_3, LlmAgentRunnerService } from '../src/llm-agent/agent-runner.service';
import { AgentInputV0_3Builder } from '../src/llm-agent/artifact/agent-input-v0_3.builder';
import type { Tier2Handoff } from '../src/llm-agent/artifact/tier2-handoff.contract';
import { executeTier3Shadow } from '../src/llm-agent/artifact/tier3-runtime';
import { originalArtifactDescriptor } from '../src/llm-agent/artifact/runtime-artifact-resolver';
import { LlmEvidenceAdapter } from '../src/llm-agent/llm-evidence.adapter';
import { loadLlmAgentEnvironment } from '../src/config/scanner-environment';
import { DEOBFUSCATED_ARTIFACT_ID, FIXTURE_ROOT, mockExecutionInput } from './fixtures/tier3-artifacts/mock-artifacts';
import { createMockArtifactResolver, deobfuscatedOnlyPlan } from './fixtures/tier3-artifacts/mock-artifacts';

const HASH = 'a'.repeat(64);
const DERIVED_HASH = 'b'.repeat(64);

const context: AnalysisContext = {
  requestId: 'request-tier3', scanId: 'scan-tier3', package: { name: 'tier3-fixture', version: '1.0.0' },
  artifact: { tarballPath: 'package.tgz', extractedPath: join(FIXTURE_ROOT, 'original'), hash: HASH },
  metadata: { registryMetadata: {}, packageJson: { name: 'tier3-fixture', version: '1.0.0', scripts: { preinstall: 'node install.js' } } },
};

function handoff(): Tier2Handoff {
  const fixtureInput = mockExecutionInput(deobfuscatedOnlyPlan, createMockArtifactResolver());
  const originalArtifactId = `artifact:${HASH}`;
  const artifactId = `${originalArtifactId}:deobfuscated:${DERIVED_HASH}`;
  return {
    artifact: {
      artifactId, representation: 'DEOBFUSCATED', analysisPass: 'TIER2', contentSha256: DERIVED_HASH,
      derivedFromArtifactId: originalArtifactId, lineageStatus: 'UNMAPPED', producer: 'scanner-obfuscation-restore',
    },
    artifactRoot: join(FIXTURE_ROOT, 'deobfuscated'),
    findings: fixtureInput.findings,
    atomicEvidences: fixtureInput.atomicEvidences,
    findingBindings: fixtureInput.bindings.findingBindings.map((binding) => ({ ...binding, artifactId })),
    evidenceBindings: fixtureInput.bindings.evidenceBindings.map((binding) => ({ ...binding, artifactId })),
    limitations: [],
  };
}

function result(status: AgentAnalysisResultV0_3['status']): AgentAnalysisResultV0_3 {
  return {
    status, analysisId: 'analysis-tier3', promptVersion: '0.2.0', outputSchemaVersion: '0.2.0',
    providerRequestIds: [], usage: {}, modelCalls: 1, toolCalls: 0, additionalCodeRequests: 0, durationMs: 1,
    limitations: [], slices: [], codeRequests: [],
  };
}

function activeSettings() {
  return loadLlmAgentEnvironment({ LLM_AGENT_ENABLED: 'true', LLM_AGENT_TRIGGER_MODE: 'ALWAYS', LLM_AGENT_MODEL: 'test-model', OPENAI_API_KEY: 'test-key' });
}

describe('Tier 2 -> Tier 3 runtime integration', () => {
  it('keeps the disabled path isolated and records no Tier 3 evidence', async () => {
    const shadow = await executeTier3Shadow(context, handoff(), loadLlmAgentEnvironment(), {});
    expect(shadow).toMatchObject({ status: 'SKIPPED', triggerReason: 'AGENT_DISABLED', generatedEvidenceCount: 0 });
  });

  it('does not invoke the provider when a handoff has no file targets', async () => {
    const runner = { executeV0_3: jest.fn() };
    const empty = { ...handoff(), findings: [], atomicEvidences: [], findingBindings: [], evidenceBindings: [] };
    const shadow = await executeTier3Shadow(
      context, empty, activeSettings(),
      { inputBuilder: new AgentInputV0_3Builder(), runner: runner as unknown as LlmAgentRunnerService, evidenceAdapter: new LlmEvidenceAdapter() },
    );
    expect(shadow).toMatchObject({ status: 'SKIPPED', triggerReason: 'NO_TIER2_TARGETS' });
    expect(runner.executeV0_3).not.toHaveBeenCalled();
  });

  it('builds V0.3 input from the real handoff, resolves both artifacts, and keeps success Shadow-only', async () => {
    const adapter = { toEvidencesV0_3: jest.fn().mockReturnValue({ evidences: [{}], failures: [] }) };
    const runner = { executeV0_3: jest.fn().mockImplementation(async (input: { artifactContext: { artifacts: Array<{ artifactId: string; representation: string }> } }) => {
      expect(input.artifactContext.artifacts.map(({ artifactId }) => artifactId)).toEqual([
        `artifact:${HASH}`, `${`artifact:${HASH}`}:deobfuscated:${DERIVED_HASH}`,
      ]);
      expect(input.artifactContext.artifacts.find(({ representation }) => representation === 'DEOBFUSCATED')).toBeDefined();
      return result('COMPLETED');
    }) };

    const shadow = await executeTier3Shadow(
      context, handoff(), activeSettings(),
      { inputBuilder: new AgentInputV0_3Builder(), runner: runner as unknown as LlmAgentRunnerService, evidenceAdapter: adapter as unknown as LlmEvidenceAdapter },
      'c'.repeat(64),
    );

    expect(runner.executeV0_3).toHaveBeenCalledTimes(1);
    expect(adapter.toEvidencesV0_3).toHaveBeenCalledTimes(1);
    expect(shadow).toMatchObject({ status: 'COMPLETED', generatedEvidenceCount: 1, initialSliceCount: 1, runtimeSliceCount: 0 });
    expect(shadow.limitations).toContain('NO_LINE_MAPPING_FOR_DEOBFUSCATED_ARTIFACT');
  });

  it('converts runner timeout/failure into a Shadow result without throwing', async () => {
    const runner = { executeV0_3: jest.fn().mockRejectedValue(new Error('provider timeout')) };
    const shadow = await executeTier3Shadow(
      context, handoff(), activeSettings(),
      { inputBuilder: new AgentInputV0_3Builder(), runner: runner as unknown as LlmAgentRunnerService, evidenceAdapter: new LlmEvidenceAdapter() },
    );
    expect(shadow.status).toBe('FAILED');
    expect(shadow.generatedEvidenceCount).toBe(0);
  });
});
