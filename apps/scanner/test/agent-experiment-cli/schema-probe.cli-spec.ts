import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const probeIds = ['P0', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6'] as const;
const scannerRoot = resolve(__dirname, '../..');
const script = resolve(scannerRoot, 'scripts/agent-experiment-schema-probe.mjs');
const requiredDistEntries = [
  'dist/application/agent-experiment/agent-experiment-openai.provider.js',
  'dist/application/agent-experiment/agent-experiment-schema-probe.service.js',
  'dist/application/agent-experiment/agent-experiment.service.js',
  'dist/config/scanner-environment.js',
];

describe('schema probe CLI safety', () => {
  beforeAll(() => {
    for (const entry of requiredDistEntries) {
      if (!existsSync(resolve(scannerRoot, entry))) throw new Error(`Agent experiment CLI test requires a current scanner build: ${entry}`);
    }
  });

  it.each(probeIds)('emits JSON-only dry-run for %s', probeId => {
    const run = spawnSync(process.execPath, [script, '--probe-id', probeId, '--model', 'gpt-5.6-luna', '--reasoning-effort', 'medium'], {
      encoding: 'utf8',
      env: { ...process.env, OPENAI_API_KEY: '', LLM_API_KEY: '' },
    });
    if (run.status !== 0) throw new Error(`Schema probe CLI exited ${String(run.status)}: ${run.stderr || run.stdout}`);
    expect(run.status).toBe(0);
    expect(run.stderr).toBe('');
    expect(JSON.parse(run.stdout)).toMatchObject({ executionMode: 'DRY_RUN', actualCalls: 0, probe: { probeId } });
  });

  it.each([
    ['--probe-id', 'P7', '--model', 'm'],
    ['--probe-id', 'P0', '--model', 'm', '--schema-path', 'x'],
    ['--probe-id', 'P0', '--model', 'm', '--reasoning-effort', 'high'],
    ['--probe-id', 'P0', '--model', 'm', '--retry', '1'],
    ['--probe-id', 'P0', '--model', 'm', '--tools', 'enabled'],
  ])('rejects unsafe args %#', (...args) => {
    const run = spawnSync(process.execPath, [script, ...args], {
      encoding: 'utf8',
      env: { ...process.env, OPENAI_API_KEY: '', LLM_API_KEY: '' },
    });
    expect(JSON.parse(run.stdout)).toMatchObject({ status: 'FAILED', actualCalls: 0, failure: { stage: 'PREFLIGHT_FAILED' } });
  });
});
