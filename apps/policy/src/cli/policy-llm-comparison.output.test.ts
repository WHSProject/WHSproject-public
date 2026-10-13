import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PolicyLlmComparisonOutputError,
  type PolicyComparisonOutputFileSystem,
  writePolicyLlmComparisonOutputs,
} from './policy-llm-comparison.output';

class MockFileSystem implements PolicyComparisonOutputFileSystem {
  readonly files = new Map<string, string>();
  readonly directories = new Set<string>();
  failDirectory = false;
  failWrite: ((path: string) => boolean) | undefined;
  failRename: ((path: string) => boolean) | undefined;

  async access(path: string): Promise<void> {
    if (!this.files.has(path)) throw Object.assign(new Error('not found'), { code: 'ENOENT' });
  }

  async mkdir(path: string): Promise<void> {
    if (this.failDirectory) throw new Error('directory unavailable');
    this.directories.add(path);
  }

  async writeFile(path: string, content: string): Promise<void> {
    if (this.failWrite?.(path)) throw new Error('write unavailable');
    if (this.files.has(path)) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
    this.files.set(path, content);
  }

  async rename(source: string, destination: string): Promise<void> {
    if (this.failRename?.(destination)) throw new Error('rename unavailable');
    if (this.files.has(destination)) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
    const content = this.files.get(source);
    if (content === undefined) throw new Error('source unavailable');
    this.files.delete(source);
    this.files.set(destination, content);
  }

  async unlink(path: string): Promise<void> { this.files.delete(path); }
}

const json = { path: '/tmp/harness/result.json', content: '{"provider":"fixture"}' };
const csv = { path: '/tmp/harness/result.csv', content: 'fixtureId,provider\nfixture-1,fixture\n' };

test('output writer preserves normal JSON and CSV output', async () => {
  const fileSystem = new MockFileSystem();
  await writePolicyLlmComparisonOutputs(json, csv, fileSystem);
  assert.equal(fileSystem.files.get(json.path), json.content);
  assert.equal(fileSystem.files.get(csv.path), csv.content);
  assert.equal([...fileSystem.files.keys()].some((path) => path.includes('.tmp-')), false);
});

test('JSON write failure returns a stable error and leaves no partial output', async () => {
  const fileSystem = new MockFileSystem();
  fileSystem.failWrite = (path) => path.includes('result.json.tmp-');
  await assert.rejects(
    () => writePolicyLlmComparisonOutputs(json, undefined, fileSystem),
    (error: unknown) => error instanceof PolicyLlmComparisonOutputError
      && error.message === 'POLICY_LLM_HARNESS_OUTPUT_WRITE_FAILED:WRITE:JSON'
      && !error.message.includes('Bearer')
      && !error.message.includes('secret'),
  );
  assert.equal(fileSystem.files.size, 0);
});

test('CSV write failure rolls back staged JSON and preserves the provider result content', async () => {
  const fileSystem = new MockFileSystem();
  fileSystem.failWrite = (path) => path.includes('result.csv.tmp-');
  const providerResult = JSON.stringify({ provider: 'fixture', status: 'COMPLETED', decision: 'ACCEPT' });
  await assert.rejects(
    () => writePolicyLlmComparisonOutputs({ ...json, content: providerResult }, csv, fileSystem),
    (error: unknown) => error instanceof PolicyLlmComparisonOutputError
      && error.message === 'POLICY_LLM_HARNESS_OUTPUT_WRITE_FAILED:WRITE:CSV',
  );
  assert.equal(fileSystem.files.size, 0);
  assert.equal(providerResult, JSON.stringify({ provider: 'fixture', status: 'COMPLETED', decision: 'ACCEPT' }));
});

test('output directory failure does not touch provider results or operational paths', async () => {
  const fileSystem = new MockFileSystem();
  fileSystem.failDirectory = true;
  const providerResults = [{ provider: 'gpt', status: 'COMPLETED' }, { provider: 'claude', status: 'FAILED' }];
  const before = JSON.stringify(providerResults);
  await assert.rejects(
    () => writePolicyLlmComparisonOutputs(json, csv, fileSystem),
    (error: unknown) => error instanceof PolicyLlmComparisonOutputError
      && error.message === 'POLICY_LLM_HARNESS_OUTPUT_WRITE_FAILED:DIRECTORY',
  );
  assert.equal(JSON.stringify(providerResults), before);
  assert.equal(fileSystem.files.size, 0);
  assert.equal(fileSystem.files.has('/internal/v1/llm-judgments'), false);
  assert.equal(fileSystem.files.has('/internal/v1/decisions'), false);
});

test('existing output is not overwritten and no temporary file is left', async () => {
  const fileSystem = new MockFileSystem();
  fileSystem.files.set(json.path, 'existing-content');
  await assert.rejects(
    () => writePolicyLlmComparisonOutputs(json, undefined, fileSystem),
    (error: unknown) => error instanceof PolicyLlmComparisonOutputError
      && error.message === 'POLICY_LLM_HARNESS_OUTPUT_WRITE_FAILED:EXISTING_FILE:JSON',
  );
  assert.equal(fileSystem.files.get(json.path), 'existing-content');
  assert.deepEqual([...fileSystem.files.keys()], [json.path]);
});

test('commit failure rolls back already committed files', async () => {
  const fileSystem = new MockFileSystem();
  fileSystem.failRename = (path) => path.endsWith('.csv');
  await assert.rejects(
    () => writePolicyLlmComparisonOutputs(json, csv, fileSystem),
    /POLICY_LLM_HARNESS_OUTPUT_WRITE_FAILED:COMMIT:CSV/u,
  );
  assert.equal(fileSystem.files.size, 0);
});
