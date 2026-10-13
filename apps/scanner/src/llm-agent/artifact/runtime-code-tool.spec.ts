import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeCodeTool } from './runtime-code-tool';
import { InMemoryCodeSliceRegistry } from './code-slice.registry';
import type { ArtifactResolver } from './artifact.contract';

function served(outcome: Awaited<ReturnType<RuntimeCodeTool['getFileRange']>>) {
  if ('unavailable' in outcome) throw new Error('expected a served slice');
  return outcome;
}

describe('RuntimeCodeTool', () => {
  let root: string;
  let resolver: ArtifactResolver;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'runtime-code-tool-'));
    await writeFile(join(root, 'index.js'), Array.from({ length: 250 }, (_, index) => `line-${index + 1}`).join('\n'));
    const descriptor = { artifactId: 'artifact', representation: 'ORIGINAL' as const, analysisPass: 'TIER1' as const,
      contentSha256: 'archive', lineageStatus: 'DIRECT' as const, producer: 'test' };
    resolver = { describe: (id) => id === 'artifact' ? descriptor : undefined, list: () => [descriptor], resolveRoot: async () => root };
  });

  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it.each([120, 200])('safely truncates an oversized request to %i lines', async (maxLinesPerRequest) => {
    const registry = new InMemoryCodeSliceRegistry();
    const usage = { calls: 0, additionalCodeRequests: 0, codeLines: 0, requestKeys: new Set<string>() };
    const outcome = await new RuntimeCodeTool().getFileRange({ id: 'request', type: 'GET_FILE_RANGE',
      target: { artifactId: 'artifact', filePath: 'index.js', startLine: 1, endLine: 240 }, reasonCode: 'MORE_CONTEXT' }, {
      resolver, registry, analysisMode: 'ORIGINAL_ONLY', policy: { maxToolCalls: 4, maxAdditionalCodeRequests: 2, maxTotalCodeLines: 1600 },
      maxLinesPerRequest, maxFileSizeBytes: 1024 * 1024, usage,
    });
    const result = served(outcome);

    expect(result.truncated).toBe(true);
    expect(result.requestedRange).toEqual({ startLine: 1, endLine: 240 });
    expect(result.servedRange).toEqual({ startLine: 1, endLine: maxLinesPerRequest });
    expect(result.slice).toMatchObject({ startLine: 1, endLine: maxLinesPerRequest });
    expect(usage).toMatchObject({ calls: 1, additionalCodeRequests: 1, codeLines: maxLinesPerRequest });
  });

  it('continues to reject an invalid range', async () => {
    await expect(new RuntimeCodeTool().getFileRange({ id: 'request', type: 'GET_FILE_RANGE',
      target: { artifactId: 'artifact', filePath: 'index.js', startLine: 0, endLine: 240 }, reasonCode: 'MORE_CONTEXT' }, {
      resolver, registry: new InMemoryCodeSliceRegistry(), analysisMode: 'ORIGINAL_ONLY',
      policy: { maxToolCalls: 4, maxAdditionalCodeRequests: 2, maxTotalCodeLines: 1600 }, maxLinesPerRequest: 120,
      maxFileSizeBytes: 1024 * 1024, usage: { calls: 0, additionalCodeRequests: 0, codeLines: 0, requestKeys: new Set<string>() },
    })).rejects.toMatchObject({ reason: 'TOOL_REQUEST_REJECTED' });
  });

  describe('files that cannot be served', () => {
    const ask = (filePath: string, maxFileSizeBytes = 1024 * 1024) => {
      const usage = { calls: 0, additionalCodeRequests: 0, codeLines: 0, requestKeys: new Set<string>() };
      const outcome = new RuntimeCodeTool().getFileRange({ id: 'request', type: 'GET_FILE_RANGE',
        target: { artifactId: 'artifact', filePath, startLine: 1, endLine: 20 }, reasonCode: 'MORE_CONTEXT' }, {
        resolver, registry: new InMemoryCodeSliceRegistry(), analysisMode: 'ORIGINAL_ONLY',
        policy: { maxToolCalls: 4, maxAdditionalCodeRequests: 2, maxTotalCodeLines: 1600 }, maxLinesPerRequest: 120, maxFileSizeBytes, usage,
      });
      return { outcome, usage };
    };

    it('answers a file over the size limit with its size and uses up one request, not any lines', async () => {
      const { outcome, usage } = ask('index.js', 100);
      expect(await outcome).toEqual({ requestedRange: { startLine: 1, endLine: 20 }, unavailable: { reason: 'FILE_TOO_LARGE', sizeBytes: expect.any(Number) } });
      expect(usage).toMatchObject({ calls: 1, additionalCodeRequests: 1, codeLines: 0 });
    });

    it('answers a binary file and a missing file', async () => {
      await writeFile(join(root, 'data.bin'), Buffer.from([1, 2, 0, 3]));
      expect(await ask('data.bin').outcome).toMatchObject({ unavailable: { reason: 'FILE_BINARY' } });
      expect(await ask('missing.js').outcome).toMatchObject({ unavailable: { reason: 'FILE_NOT_FOUND' } });
    });

    it('still rejects a path outside the package', async () => {
      await expect(ask('../outside.js').outcome).rejects.toMatchObject({ reason: 'TOOL_REQUEST_REJECTED' });
    });
  });
});
