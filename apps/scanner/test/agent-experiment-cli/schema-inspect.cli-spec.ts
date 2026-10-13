import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const scannerRoot = resolve(__dirname, '../..');
const script = resolve(scannerRoot, 'scripts/agent-experiment-schema-inspect.mjs');
const requiredDistEntries = [
  'dist/application/agent-experiment/agent-experiment-output.schema.js',
  'dist/application/agent-experiment/agent-experiment-structured-output-linter.js',
];

describe('experiment schema inspection CLI', () => {
  beforeAll(() => {
    for (const entry of requiredDistEntries) {
      if (!existsSync(resolve(scannerRoot, entry))) throw new Error(`Agent experiment CLI test requires a current scanner build: ${entry}`);
    }
  });

  it('emits JSON only and reports zero current violations', () => {
    const run = spawnSync(process.execPath, [script], {
      encoding: 'utf8',
      env: { ...process.env, OPENAI_API_KEY: '', LLM_API_KEY: '' },
    });
    if (run.status !== 0) throw new Error(`Schema inspection CLI exited ${String(run.status)}: ${run.stderr || run.stdout}`);
    expect(run.status).toBe(0);
    expect(run.stderr).toBe('');
    const output = JSON.parse(run.stdout) as { validForConfiguredSubset: boolean; violations: unknown[]; probePlan: unknown[] };
    expect(output).toMatchObject({ validForConfiguredSubset: true, violations: [] });
    expect(output.probePlan).toHaveLength(7);
  });
});
