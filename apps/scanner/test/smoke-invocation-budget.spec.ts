import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AtomicSmokeInvocationBudget,
  type SmokeInvocationPolicy,
} from '../src/application/local-static-analysis/smoke-invocation-budget';

const IDS = ['sample-a', 'sample-b', 'sample-c'];

describe('AtomicSmokeInvocationBudget', () => {
  let root: string;
  let ledgerPath: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'smoke-budget-')); ledgerPath = join(root, 'ledger.json'); });
  afterEach(async () => rm(root, { recursive: true, force: true }));

  function budget(overrides: Partial<SmokeInvocationPolicy> = {}): AtomicSmokeInvocationBudget {
    return new AtomicSmokeInvocationBudget(ledgerPath, {
      runId: 'run-1', executionPurpose: 'THREE_SAMPLE_STATIC_SMOKE', approvedSampleIds: IDS,
      maxUniqueSamples: 3, maxCallsPerSampleAnalyzer: 1, maxTotalCalls: 9,
      retryLimit: 0, executionMode: 'REAL', ...overrides,
    });
  }

  it('requires a sealed immutable manifest and rejects samples outside it or the allowlist', async () => {
    const guard = budget(); await guard.initialize();
    await expect(guard.reserve('sample-a', 'guarddog', 'VERIFIED_EXTERNAL_CONTAINER')).rejects.toThrow('MANIFEST_NOT_SEALED');
    const sealed = await guard.sealManifest(IDS);
    await expect(guard.sealManifest(['sample-a'])).rejects.toThrow('SEALED_MANIFEST_IMMUTABLE');
    expect(sealed.sealed).toBe(true);
    await expect(guard.reserve('sample-d', 'guarddog', 'VERIFIED_EXTERNAL_CONTAINER')).rejects.toThrow('SAMPLE_NOT_APPROVED');
  });

  it('rejects a fourth unique sample even when it is approved', async () => {
    const guard = budget({ approvedSampleIds: [...IDS, 'sample-d'], maxUniqueSamples: 3 });
    await guard.initialize();
    await expect(guard.sealManifest([...IDS, 'sample-d'])).rejects.toThrow('UNIQUE_SAMPLE_LIMIT_EXCEEDED');
  });

  it('counts a reserved failed attempt and forbids duplicate/retry calls', async () => {
    const guard = budget(); await guard.initialize(); await guard.sealManifest(IDS);
    await guard.reserve('sample-a', 'guarddog', 'VERIFIED_EXTERNAL_CONTAINER');
    await expect(guard.reserve('sample-a', 'guarddog', 'VERIFIED_EXTERNAL_CONTAINER'))
      .rejects.toThrow('DUPLICATE_ANALYZER_INVOCATION');
    expect((await guard.read()).calls).toHaveLength(1);
  });

  it('serializes concurrent reservations so the total limit cannot be exceeded', async () => {
    const guard = budget({ maxTotalCalls: 3 }); await guard.initialize(); await guard.sealManifest(IDS);
    const attempts = IDS.flatMap((sampleId) => (['guarddog', 'metadata'] as const)
      .map((analyzer) => guard.reserve(sampleId, analyzer, 'VERIFIED_EXTERNAL_CONTAINER')));
    const settled = await Promise.allSettled(attempts);
    expect(settled.filter(({ status }) => status === 'fulfilled')).toHaveLength(3);
    expect((await guard.read()).calls).toHaveLength(3);
    expect((await guard.read()).remainingBudget).toBe(0);
  });

  it('does not consume real invocation budget for an explicitly attested mock', async () => {
    const guard = budget({ executionMode: 'MOCK' }); await guard.initialize(); await guard.sealManifest(IDS);
    const receipt = await guard.reserve('sample-a', 'guarddog', 'TEST_DOUBLE');
    expect(receipt.consumedRealBudget).toBe(false);
    expect((await guard.read()).calls).toHaveLength(0);
    await expect(guard.reserve('sample-a', 'guarddog', 'VERIFIED_EXTERNAL_CONTAINER'))
      .rejects.toThrow('BACKEND_ATTESTATION_MISMATCH');
  });

  it('enforces Custom Rule-only analyzer totals before analyzer entry', async () => {
    const guard = budget({ maxTotalCalls: 3,
      maxCallsByAnalyzer: { guarddog: 0, metadata: 0, 'custom-rule': 3 } });
    await guard.initialize(); await guard.sealManifest(IDS);
    await expect(guard.reserve('sample-a', 'guarddog', 'VERIFIED_EXTERNAL_CONTAINER'))
      .rejects.toThrow('ANALYZER_CALL_LIMIT_EXCEEDED');
    await expect(guard.reserve('sample-a', 'metadata', 'VERIFIED_EXTERNAL_CONTAINER'))
      .rejects.toThrow('ANALYZER_CALL_LIMIT_EXCEEDED');
    for (const sampleId of IDS) await guard.reserve(sampleId, 'custom-rule', 'VERIFIED_EXTERNAL_CONTAINER');
    const ledger = await guard.read();
    expect(ledger.calls.map(({ analyzer }) => analyzer)).toEqual(['custom-rule', 'custom-rule', 'custom-rule']);
  });

  it('stores no host path or environment data in its atomic ledger', async () => {
    const guard = budget(); await guard.initialize(); await guard.sealManifest(IDS);
    await guard.reserve('sample-a', 'metadata', 'VERIFIED_EXTERNAL_CONTAINER');
    const text = await readFile(ledgerPath, 'utf8');
    expect(text).not.toContain(process.cwd());
    expect(text).not.toContain('process.env');
  });
});
