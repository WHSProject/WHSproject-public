import {
  executeSealedSample,
  preflightSmokeEnvironment,
  selectSmokeCohort,
} from '../src/application/local-static-analysis/smoke-harness-phases';

describe('smoke harness phase separation', () => {
  it('selection and preflight cannot invoke an analyzer through their contracts', async () => {
    const analyzer = jest.fn();
    const selected = selectSmokeCohort(['sample-a', 'sample-b', 'sample-c']);
    const sandboxCheck = jest.fn().mockResolvedValue(undefined);
    await preflightSmokeEnvironment([sandboxCheck]);
    expect(selected).toEqual(['sample-a', 'sample-b', 'sample-c']);
    expect(Object.isFrozen(selected)).toBe(true);
    expect(sandboxCheck).toHaveBeenCalledTimes(1);
    expect(analyzer).not.toHaveBeenCalled();
  });

  it('executes only a sample in the sealed manifest', async () => {
    const manifest = { runId: 'run', sampleIds: ['sample-a'], digest: 'digest', sealed: true as const };
    const analyzer = jest.fn().mockResolvedValue('ok');
    await expect(executeSealedSample(manifest, 'sample-b', analyzer)).rejects.toThrow('SMOKE_SAMPLE_NOT_IN_SEALED_MANIFEST');
    expect(analyzer).not.toHaveBeenCalled();
    await expect(executeSealedSample(manifest, 'sample-a', analyzer)).resolves.toBe('ok');
  });
});
