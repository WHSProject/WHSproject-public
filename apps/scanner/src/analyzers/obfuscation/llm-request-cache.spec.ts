import type {
  AgentAnalysisRequestV0_1,
  CodeUnderstandingAssistant,
  GptShadowOutcome,
} from './agent-analysis.types';
import {
  BoundedLlmResultCache,
  CachedCodeUnderstandingAssistant,
  buildLlmRequestIdentity,
  createLlmRequestHash,
} from './llm-request-cache';

describe('Tier 2 LLM request identity and cache', () => {
  it('ignores volatile IDs and non-semantic ordering while preserving semantic changes', () => {
    const first = request();
    const second = request();
    second.requestId = 'different-request';
    second.scanId = 'different-scan';
    second.candidates[0]!.evidences.reverse();
    second.candidates[0]!.matchedSignals.reverse();
    second.package = {
      lifecycleScripts: [],
      description: null,
      artifactHash: 'a'.repeat(64),
      version: '1.0.0',
      name: 'fixture',
      ecosystem: 'npm',
    };
    second.candidates[0]!.evidences = second.candidates[0]!.evidences.map((evidence) => ({
      line: evidence.line,
      path: evidence.path,
      message: evidence.message,
      ruleId: evidence.ruleId,
      analyzer: evidence.analyzer,
      tier: evidence.tier,
      evidenceId: evidence.evidenceId,
    }));

    const firstHash = createLlmRequestHash(identity(first));
    const secondHash = createLlmRequestHash(identity(second));
    expect(secondHash).toBe(firstHash);

    second.candidates[0]!.slices[0]!.code = 'changed();';
    expect(createLlmRequestHash(identity(second))).not.toBe(firstHash);
  });

  it.each([
    ['provider', { provider: 'gemini' as const }],
    ['model', { model: 'other-model' }],
    ['promptVersion', { promptVersion: 'prompt-v2' }],
    ['analyzerVersion', { analyzerVersion: 'analyzer-v2' }],
  ])('changes the hash when %s changes', (_field, change) => {
    const base = createLlmRequestHash(identity(request()));
    expect(createLlmRequestHash({ ...identity(request()), ...change })).not.toBe(base);
  });

  it('changes the hash when the request schema version changes', () => {
    const changed = request();
    (changed as { schemaVersion: string }).schemaVersion = '0.2';
    expect(createLlmRequestHash(identity(changed))).not.toBe(
      createLlmRequestHash(identity(request())),
    );
  });

  it('includes semantic fields but excludes credentials and runtime paths', () => {
    const semantic = buildLlmRequestIdentity(identity(request()));
    const serialized = JSON.stringify(semantic);
    expect(serialized).toContain('package/index.js');
    expect(serialized).toContain('a'.repeat(64));
    expect(serialized).not.toContain('api-key');
    expect(serialized).not.toContain('Authorization');
    expect(serialized).not.toContain('C:\\temp\\scanner');
  });

  it('caches only completed results and reports miss/hit metadata', async () => {
    const delegate = assistant({
      status: 'COMPLETED',
      provider: 'gpt',
      model: 'test-model',
      durationMs: 12,
      usage: { inputTokens: 4, outputTokens: 6 },
      promptVersion: 'prompt-v1',
    });
    const cached = wrapper(delegate);

    const first = await cached.analyze(request());
    const second = await cached.analyze(request());

    expect(first).toMatchObject({ cacheStatus: 'MISS', requestHash: expect.stringMatching(/^sha256:/u) });
    expect(first).toMatchObject({ durationMs: 12, usage: { inputTokens: 4, outputTokens: 6, totalTokens: 10 } });
    expect(second).toMatchObject({ cacheStatus: 'HIT', requestHash: first.requestHash });
    expect(second.usage).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
    expect(second.durationMs).toBeLessThan(first.durationMs);
    expect(delegate.analyze).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent identical requests into one provider call', async () => {
    let resolve: ((value: GptShadowOutcome) => void) | undefined;
    const pending = new Promise<GptShadowOutcome>((done) => { resolve = done; });
    const delegate: CodeUnderstandingAssistant = {
      analyze: jest.fn().mockReturnValue(pending),
    };
    const cached = wrapper(delegate);

    const firstPromise = cached.analyze(request());
    const secondPromise = cached.analyze(request());
    resolve?.({
      status: 'COMPLETED',
      provider: 'gpt',
      model: 'test-model',
      durationMs: 2,
      usage: { inputTokens: 3, outputTokens: 5, totalTokens: 8 },
    });

    const [first, second] = await Promise.all([firstPromise, secondPromise]);
    expect(first.cacheStatus).toBe('MISS');
    expect(second.cacheStatus).toBe('COALESCED');
    expect(first.usage).toEqual({ inputTokens: 3, outputTokens: 5, totalTokens: 8 });
    expect(second.usage).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
    expect(delegate.analyze).toHaveBeenCalledTimes(1);
  });

  it('removes failed in-flight calls and retries the next request', async () => {
    const delegate = assistant(
      { status: 'FAILED', provider: 'gpt', model: 'test-model', durationMs: 1 },
      { status: 'COMPLETED', provider: 'gpt', model: 'test-model', durationMs: 1 },
    );
    const cached = wrapper(delegate);

    await expect(cached.analyze(request())).resolves.toMatchObject({ cacheStatus: 'MISS', status: 'FAILED' });
    await expect(cached.analyze(request())).resolves.toMatchObject({ cacheStatus: 'MISS', status: 'COMPLETED' });
    expect(delegate.analyze).toHaveBeenCalledTimes(2);
  });

  it('expires entries and evicts the oldest entry at the bound', () => {
    let now = 1_000;
    const cache = new BoundedLlmResultCache(100, 2, () => now);
    const value = { status: 'COMPLETED' as const, durationMs: 1 };
    cache.set('a', value);
    now = 1_050;
    cache.set('b', value);
    cache.set('c', value);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.size).toBe(2);

    now = 1_101;
    expect(cache.get('b')).toBeDefined();
    now = 1_151;
    expect(cache.get('b')).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it('bypasses cache without changing provider behavior when disabled', async () => {
    const delegate = assistant({
      status: 'COMPLETED',
      provider: 'gpt',
      model: 'test-model',
      durationMs: 1,
      usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
    });
    const cached = wrapper(delegate, { enabled: false });

    const first = await cached.analyze(request());
    const second = await cached.analyze(request());

    expect(first.cacheStatus).toBe('BYPASS');
    expect(second.cacheStatus).toBe('BYPASS');
    expect(first.usage).toEqual({ inputTokens: 2, outputTokens: 1, totalTokens: 3 });
    expect(second.usage).toEqual({ inputTokens: 2, outputTokens: 1, totalTokens: 3 });
    expect(delegate.analyze).toHaveBeenCalledTimes(2);
  });
});

function wrapper(
  delegate: CodeUnderstandingAssistant,
  options: Partial<{ enabled: boolean; ttlMs: number; maxEntries: number }> = {},
): CachedCodeUnderstandingAssistant {
  return new CachedCodeUnderstandingAssistant(
    delegate,
    { provider: 'gpt', model: 'test-model', promptVersion: 'prompt-v1', analyzerVersion: 'analyzer-v1' },
    { enabled: true, ttlMs: 10_000, maxEntries: 10, ...options },
  );
}

function assistant(...outcomes: GptShadowOutcome[]): jest.Mocked<CodeUnderstandingAssistant> {
  let index = 0;
  return {
    analyze: jest.fn().mockImplementation(async () => {
      const outcome = outcomes[Math.min(index, outcomes.length - 1)] as GptShadowOutcome;
      index += 1;
      return outcome;
    }),
  };
}

function identity(requestValue: AgentAnalysisRequestV0_1) {
  return {
    provider: 'gpt' as const,
    model: 'test-model',
    promptVersion: 'prompt-v1',
    analyzerVersion: 'analyzer-v1',
    request: requestValue,
  };
}

function request(): AgentAnalysisRequestV0_1 {
  return {
    schemaVersion: '0.1',
    requestId: 'request-1',
    scanId: 'scan-1',
    sampleId: 'a'.repeat(64),
    purpose: 'DEOBFUSCATION_CODE_UNDERSTANDING',
    package: {
      ecosystem: 'npm',
      name: 'fixture',
      version: '1.0.0',
      artifactHash: 'a'.repeat(64),
      description: null,
      lifecycleScripts: [],
    },
    candidates: [{
      path: 'package/index.js',
      sourceKind: 'RESTORED',
      reason: 'RESTORED_WITH_NEW_SIGNAL',
      supportingReasons: ['RESTORED_WITH_NEW_SIGNAL', 'STRONG_RISK_COMBINATION'],
      restored: true,
      matchedSignals: ['z-signal', 'a-signal'],
      residualCapabilities: ['NETWORK'],
      derivedNewRuleIds: ['custom.network-outbound'],
      restoration: {
        status: 'RESTORED',
        limitations: [],
        stageResults: [],
        appliedStages: ['STRUCTURE'],
      },
      evidences: [
        { evidenceId: 'b', tier: 'TIER_2', analyzer: 'derived', ruleId: 'b', message: 'b', path: 'package/index.js', line: 2 },
        { evidenceId: 'a', tier: 'TIER_2', analyzer: 'derived', ruleId: 'a', message: 'a', path: 'package/index.js', line: 1 },
      ],
      slices: [{ file: 'package/index.js', startLine: 1, endLine: 1, code: 'fetch(url);' }],
    }],
  };
}
