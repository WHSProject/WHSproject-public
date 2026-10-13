import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { detect } from './detector';
import { runRestorePipeline, validateRestore } from './restore.pipeline';
import { restoreStructure } from './structure-restorer';
import { summarizeRestoreDiagnostics } from '../../performance/tier2-omcbench-aggregation';
import type { Budget, FileVerdict } from './obfuscation.types';

jest.mock('./structure-restorer', () => ({ restoreStructure: jest.fn() }));

const mockedRestoreStructure = jest.mocked(restoreStructure);

const budget: Budget = {
  maxFilesScanned: 20,
  maxTargets: 20,
  maxFileBytes: 1024 * 1024,
  perFileTimeoutMs: 5000,
  totalRestoreTimeoutMs: 30_000,
};

function target(path: string, source: string, context: Parameters<typeof detect>[2] = {}): FileVerdict {
  return detect(path, source, context);
}

describe('restore pipeline contract', () => {
  let root: string;
  let extractedPath: string;
  let outputRoot: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'scanner-restore-pipeline-'));
    extractedPath = join(root, 'extracted');
    outputRoot = join(root, 'derived');
    await mkdir(extractedPath, { recursive: true });
    mockedRestoreStructure.mockReset();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('restores a supported string payload and preserves the source', async () => {
    const original = [
      "const encoded = Buffer.from('Y29uc29sZS5sb2coJ2hlbGxvJyk7', 'base64').toString();",
      'eval(encoded);',
    ].join('\n');
    await writeFile(join(extractedPath, 'setup.js'), original, 'utf8');
    const selected = target('setup.js', original, { executionPath: true });

    const result = await runRestorePipeline({
      extractedPath,
      outputRoot,
      targets: [selected],
      budget,
    });

    expect(result.unresolved).toHaveLength(0);
    expect(result.restored).toHaveLength(1);
    expect(result.restored[0]).toMatchObject({
      status: 'RESTORED',
      limitations: expect.not.arrayContaining(['DYNAMIC_DECODE_UNRESOLVED']),
      appliedStages: expect.arrayContaining(['STRING']),
      stageResults: expect.arrayContaining([
        expect.objectContaining({ stage: 'STRING', applied: true, status: 'COMPLETED' }),
      ]),
      validation: expect.objectContaining({
        original: expect.objectContaining({ parse: { valid: true } }),
        restored: expect.objectContaining({ parse: { valid: true } }),
      }),
    });
    expect(result.restored[0]?.lineMapping).toMatchObject({
      version: '0.1.0',
      sourcePath: 'setup.js',
      derivedPath: 'setup.js',
    });
    expect(result.restored[0]?.lineMapping?.entries.length).toBeGreaterThan(0);
    expect(result.restored[0]?.payloads[0]?.lineMapping).toMatchObject({
      status: 'MAPPED',
      sourcePath: 'setup.js',
      derivedPath: 'setup.js.payload-1.js',
      entries: [{ derivedLine: 1, sourceLine: 2, confidence: 'APPROXIMATE' }],
    });
    const stringStage = result.restored[0]?.stageResults.find(({ stage }) => stage === 'STRING');
    expect(stringStage?.metadata?.payloads).toEqual([
      expect.objectContaining({
        index: 0,
        transform: 'EVAL_PROMOTE',
        decodedLength: expect.any(Number),
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      }),
    ]);
    expect(result.restored[0]?.validation.byteRatio).toBeGreaterThan(0);
    expect(await readFile(join(extractedPath, 'setup.js'), 'utf8')).toBe(original);
    await expect(readFile(join(outputRoot, 'setup.js'), 'utf8')).resolves.toContain("console.log('hello')");
  });

  it.each([
    "function label() { const key = 'label'; record(key); } function count() { let key = 0; key++; record(key); }",
    "const label = 'label'; record(label); export { label };",
  ])('preserves binding positions through string restoration and validation: %s', async (source) => {
    await writeFile(join(extractedPath, 'source.js'), source);
    const result = await runRestorePipeline({
      extractedPath, outputRoot, targets: [target('source.js', source)], budget,
    });
    expect(result.unresolved).toEqual([]);
    expect(result.restored).toHaveLength(1);
    expect(result.restored[0]).toMatchObject({
      status: 'RESTORED',
      validation: { original: { parse: { valid: true } }, restored: { parse: { valid: true } } },
      appliedStages: expect.arrayContaining(['STRING']),
    });
    expect(await readFile(join(extractedPath, 'source.js'), 'utf8')).toBe(source);
    expect(mockedRestoreStructure).not.toHaveBeenCalled();
  });

  it('reports unsupported dynamic decoding as unresolved rather than silently restored', async () => {
    const source = 'const codes = getCodes(); eval(String.fromCharCode(...codes));';
    await writeFile(join(extractedPath, 'setup.js'), source, 'utf8');
    const selected = target('setup.js', source, { executionPath: true });

    const result = await runRestorePipeline({
      extractedPath,
      outputRoot,
      targets: [selected],
      budget,
    });

    expect(result.restored).toHaveLength(0);
    expect(result.unresolved[0]).toMatchObject({
      status: 'UNRESOLVED',
      reason: 'DYNAMIC_DECODE_UNRESOLVED',
      limitations: expect.arrayContaining(['DYNAMIC_DECODE_UNRESOLVED']),
      durationMs: expect.any(Number),
    });
    const report = summarizeRestoreDiagnostics(result);
    expect(report.files[0]?.durationMs).toBeGreaterThanOrEqual(0);
    expect(report.files[0]?.stageResults).toHaveLength(3);
    expect(report.files[0]?.reason).toBe('DYNAMIC_DECODE_UNRESOLVED');
  });

  it('records source-read failure timing before any transform stage executes', async () => {
    const result = await runRestorePipeline({ extractedPath, outputRoot, targets: [target('missing.js', 'const a = 1;')], budget });
    expect(result.unresolved[0]).toMatchObject({ reason: 'SOURCE_READ_FAILED', stageResults: [], durationMs: expect.any(Number) });
    expect(result.unresolved[0]?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('records zero file work for targets not started due to cancellation', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runRestorePipeline({ extractedPath, outputRoot, targets: [target('skipped.js', 'const a = 1;')], budget, signal: controller.signal });
    expect(result.budgetExceeded).toBe(true);
    expect(result.unresolved[0]).toMatchObject({ reason: 'BUDGET_EXCEEDED', stageResults: [], durationMs: 0 });
    expect(mockedRestoreStructure).not.toHaveBeenCalled();
  });

  it('records output-write failure timing while preserving completed stage diagnostics', async () => {
    const original = "const encoded = Buffer.from('aGk=', 'base64').toString();";
    await writeFile(join(extractedPath, 'setup.js'), original);
    await writeFile(outputRoot, 'not a directory');
    const result = await runRestorePipeline({ extractedPath, outputRoot, targets: [target('setup.js', original)], budget });
    expect(result.unresolved[0]).toMatchObject({ reason: 'OUTPUT_WRITE_FAILED', durationMs: expect.any(Number) });
    expect(summarizeRestoreDiagnostics(result).files[0]).toMatchObject({
      reason: 'OUTPUT_WRITE_FAILED',
      stageResults: expect.arrayContaining([expect.objectContaining({ stage: 'STRING', status: 'COMPLETED' })]),
    });
  });

  it.each([
    "eval(\"const local = 'inside'; record(local);\");",
    "eval(\"'use strict'; var local = 'inside';\");",
  ])('keeps scope-sensitive eval unresolved without publishing a promoted payload: %s', async (source) => {
    await writeFile(join(extractedPath, 'setup.js'), source, 'utf8');
    const result = await runRestorePipeline({
      extractedPath, outputRoot, targets: [target('setup.js', source)], budget,
    });
    expect(result.restored).toEqual([]);
    expect(result.unresolved).toEqual([expect.objectContaining({
      status: 'UNRESOLVED',
      reason: 'DYNAMIC_DECODE_UNRESOLVED',
      stageResults: expect.arrayContaining([
        expect.objectContaining({ stage: 'STRING', status: 'NO_CHANGE', applied: false }),
      ]),
    })]);
    expect(await readFile(join(extractedPath, 'setup.js'), 'utf8')).toBe(source);
    expect(mockedRestoreStructure).not.toHaveBeenCalled();
  });

  it('keeps a usable string result as partial when structure restoration fails', async () => {
    const source = "const encoded = Buffer.from('Y29uc29sZS5sb2coJ2hpJyk7', 'base64').toString();";
    await writeFile(join(extractedPath, 'setup.js'), source, 'utf8');
    mockedRestoreStructure.mockResolvedValue({ status: 'FAILED', reason: 'webcrack timeout', durationMs: 1 });
    const selected: FileVerdict = {
      ...target('setup.js', source, { executionPath: true }),
      structuralCandidate: true,
    };

    const result = await runRestorePipeline({ extractedPath, outputRoot, targets: [selected], budget });

    expect(result.unresolved).toHaveLength(0);
    expect(result.restored[0]).toMatchObject({
      status: 'PARTIAL_RESTORED',
      reason: 'PARTIAL_STAGE_FAILURE',
      limitations: expect.arrayContaining(['STRUCTURE_STAGE_FAILED', 'TOOL_TIMEOUT']),
      stageResults: expect.arrayContaining([
        expect.objectContaining({ stage: 'STRUCTURE', status: 'FAILED', applied: false }),
        expect.objectContaining({ stage: 'STRING', status: 'COMPLETED', applied: true }),
      ]),
    });
  });

  it('keeps tool failure distinct from a no-op skip', async () => {
    const source = 'module.exports = 42;';
    await writeFile(join(extractedPath, 'setup.js'), source, 'utf8');
    mockedRestoreStructure.mockResolvedValue({ status: 'UNAVAILABLE', reason: 'webcrack unavailable', durationMs: 1 });
    const selected: FileVerdict = {
      ...target('setup.js', source),
      structuralCandidate: true,
    };

    const result = await runRestorePipeline({ extractedPath, outputRoot, targets: [selected], budget });

    expect(result.restored).toHaveLength(0);
    expect(result.unresolved[0]).toMatchObject({
      status: 'FAILED',
      reason: 'TOOL_UNAVAILABLE',
      limitations: expect.arrayContaining(['STRUCTURE_STAGE_FAILED']),
    });
  });

  it('reports a parse failure after a stage produces invalid output', async () => {
    const source = 'const encoded = String.fromCharCode(97, 98, 99);';
    await writeFile(join(extractedPath, 'setup.js'), source, 'utf8');
    mockedRestoreStructure.mockResolvedValue({ status: 'COMPLETED', code: 'const = ;', durationMs: 1 });
    const selected: FileVerdict = {
      ...target('setup.js', source),
      structuralCandidate: true,
    };

    const result = await runRestorePipeline({ extractedPath, outputRoot, targets: [selected], budget });

    expect(result.restored).toHaveLength(0);
    expect(result.unresolved[0]).toMatchObject({ status: 'FAILED', reason: 'PARSE_FAILED' });
    expect(result.unresolved[0]?.validation?.restored.parse.valid).toBe(false);
  });

  it('records a selected no-op as unresolved rather than skipped', async () => {
    const source = 'module.exports = 42;';
    await writeFile(join(extractedPath, 'setup.js'), source, 'utf8');
    const detected = target('setup.js', source);
    const selected: FileVerdict = { ...detected, obfuscated: true };

    const result = await runRestorePipeline({
      extractedPath,
      outputRoot,
      targets: [selected],
      budget,
    });

    expect(result.restored).toHaveLength(0);
    expect(result.unresolved[0]).toMatchObject({
      status: 'UNRESOLVED',
      reason: 'NO_SUPPORTED_TRANSFORM',
      stageResults: expect.arrayContaining([
        expect.objectContaining({ stage: 'STRUCTURE', status: 'SKIPPED', applied: false }),
        expect.objectContaining({ stage: 'STRING', status: 'NO_CHANGE', applied: false }),
      ]),
    });
  });

  it('does not fail solely because the restored score increased', async () => {
    const source = 'const value = 1;';
    const restoredCode = [
      'const _0x1234 = 0; const _0xabcd = 1;',
      "const ops = { 'next': function (x) { return x; } };",
      'while (true) { switch (state) { case 0: state = ops.next(1); break; default: break; } }',
    ].join('\n');
    await writeFile(join(extractedPath, 'setup.js'), source, 'utf8');
    mockedRestoreStructure.mockResolvedValue({ status: 'COMPLETED', code: restoredCode, durationMs: 1 });
    const selected: FileVerdict = {
      ...target('setup.js', source),
      structuralCandidate: true,
    };

    const result = await runRestorePipeline({ extractedPath, outputRoot, targets: [selected], budget });
    const file = result.restored[0];

    expect(file?.validation.scoreDelta).toBeGreaterThan(0);
    expect(file?.status).toBe('RESTORED');
    expect(file?.limitations).toEqual(expect.arrayContaining(['SCORE_INCREASED']));
    expect(result.unresolved).toHaveLength(0);
  });

  it('captures UTF-8 metrics, signal deltas, parse failures, and capability limitation', () => {
    const original = [
      "const encoded = Buffer.from('Y29uc29sZS5sb2coJ2hpJyk7', 'base64').toString();",
      'eval(encoded);',
    ].join('\n');
    const restored = "const text = 'こんにちは';";
    const selected = target('setup.js', original, {
      executionPath: true,
      riskCapabilityRuleIds: ['capability.process.spawn'],
    });
    const validation = validateRestore(original, restored, selected);
    const invalid = validateRestore(original, 'const = ;', selected);

    expect(validation.original.bytes).toBe(Buffer.byteLength(original, 'utf8'));
    expect(validation.restored.bytes).toBe(Buffer.byteLength(restored, 'utf8'));
    expect(validation.byteDelta).toBe(validation.restored.bytes - validation.original.bytes);
    expect(validation.identifierDelta)
      .toBe(validation.restored.identifierCount - validation.original.identifierCount);
    expect(validation.identifierDelta).toBeLessThan(0);
    expect(validation.hexIdentifierDelta).toBe(0);
    expect(validation.addedSignals).toEqual([]);
    expect(validation.removedSignals).toEqual(expect.arrayContaining([
      'BASE64_DECODE',
      'DYNAMIC_EVAL',
    ]));
    expect(validation.capability).toMatchObject({
      before: ['capability.process.spawn'],
      after: null,
      status: 'NOT_VERIFIED',
      lost: [],
    });
    expect(validation.scoreDelta).toBe(validation.restored.score - validation.original.score);
    expect(invalid.restored.parse.valid).toBe(false);
    expect(invalid.restored.parse.reason).toEqual(expect.any(String));
  });
});
