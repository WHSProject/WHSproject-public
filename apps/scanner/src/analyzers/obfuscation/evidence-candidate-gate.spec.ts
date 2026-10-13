import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { AnalyzerResult, Finding } from '../../domain/analysis.types';
import { collectTier2EvidenceCandidates as collectCandidates } from './evidence-candidate-gate';
import type { RestoreResult } from './obfuscation.types';

describe('Tier2 evidence candidate gate', () => {
  let root: string;
  let outputRoot: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'scanner-tier2-candidate-gate-'));
    outputRoot = join(root, 'derived', 'obfuscation');
    await mkdir(outputRoot, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it.each(['custom-rule-deobfuscated', 'guarddog-deobfuscated'] as const)(
    'includes a RESTORED risk Finding from %s',
    async (analyzer) => {
      const restored = await restoredFile(outputRoot, 'package/index.js', 'RESTORED');
      const ruleId = analyzer === 'guarddog-deobfuscated'
        ? 'capability-network-outbound'
        : 'custom.process-execution';
      const candidates = await collectTier2EvidenceCandidates(
        [result(analyzer, [finding(ruleId, 'package/index.js', 2, 2)])],
        restoreResult(outputRoot, [restored]),
      );

      expect(candidates).toEqual([
        expect.objectContaining({
          analyzer,
          path: 'package/index.js',
          restoreStatus: 'RESTORED',
          finding: expect.objectContaining({ ruleId }),
        }),
      ]);
    },
  );

  it('includes GuardDog threat mappings with behavior signal types', async () => {
    const restored = await restoredFile(outputRoot, 'package/index.js', 'RESTORED');
    const candidates = await collectTier2EvidenceCandidates(
      [result('guarddog-deobfuscated', [finding('threat-network-exfiltration', 'package/index.js', 2, 2)])],
      restoreResult(outputRoot, [restored]),
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      ruleId: 'threat-network-exfiltration',
      rawFindingId: 'threat-network-exfiltration:package/index.js',
    });
  });

  it('excludes GuardDog findings mapped only to obfuscation', async () => {
    const restored = await restoredFile(outputRoot, 'package/index.js', 'RESTORED');
    const candidates = await collectTier2EvidenceCandidates(
      [result('guarddog-deobfuscated', [finding('threat-runtime-obfuscation-pyarmor', 'package/index.js', 2, 2)])],
      restoreResult(outputRoot, [restored]),
    );

    expect(candidates).toEqual([]);
  });

  it('does not include a restored file when only an obfuscation status Finding exists', async () => {
    const restored = await restoredFile(outputRoot, 'package/index.js', 'RESTORED');
    const candidates = await collectTier2EvidenceCandidates(
      [result('custom-rule-deobfuscated', [finding('obfuscation.restored', 'package/index.js', 1, 1)])],
      restoreResult(outputRoot, [restored]),
    );

    expect(candidates).toEqual([]);
  });

  it('does not include RESTORED status without a risk Finding', async () => {
    const restored = await restoredFile(outputRoot, 'package/index.js', 'RESTORED');
    const candidates = await collectTier2EvidenceCandidates(
      [result('custom-rule-deobfuscated', [])],
      restoreResult(outputRoot, [restored]),
    );

    expect(candidates).toEqual([]);
  });

  it.each(['UNRESOLVED', 'FAILED', 'SKIPPED'] as const)(
    'excludes %s restore results',
    async (status) => {
      const candidates = await collectTier2EvidenceCandidates(
        [result('custom-rule-deobfuscated', [finding('custom.process-execution', 'package/index.js', 1, 1)])],
        restoreResult(outputRoot, [], [{
          path: 'package/index.js',
          status,
          reason: 'NO_SUPPORTED_TRANSFORM',
          limitations: ['NO_SUPPORTED_TRANSFORM'],
          stageResults: [],
        }]),
      );

      expect(candidates).toEqual([]);
    },
  );

  it('excludes a Finding whose derived file does not exist', async () => {
    const outputPath = join(outputRoot, 'package', 'missing.js');
    const candidates = await collectTier2EvidenceCandidates(
      [result('custom-rule-deobfuscated', [finding('custom.process-execution', 'package/missing.js', 1, 1)])],
      restoreResult(outputRoot, [restoredMetadata('package/missing.js', 'RESTORED', outputPath)]),
    );

    expect(candidates).toEqual([]);
  });

  it.each([
    ['line outside file', 'package/index.js', 4, 4],
    ['zero start line', 'package/index.js', 0, 1],
    ['end before start', 'package/index.js', 2, 1],
  ] as const)('excludes a Finding with %s', async (_label, path, startLine, endLine) => {
    const restored = await restoredFile(outputRoot, 'package/index.js', 'RESTORED');
    const candidates = await collectTier2EvidenceCandidates(
      [result('guarddog-deobfuscated', [finding('capability-network-outbound', path, startLine, endLine)])],
      restoreResult(outputRoot, [restored]),
    );

    expect(candidates).toEqual([]);
  });

  it('rejects absolute and derived-root paths even when the source file exists', async () => {
    const restored = await restoredFile(outputRoot, 'package/index.js', 'RESTORED');
    const absolutePath = join(outputRoot, 'package', 'index.js');
    const candidates = await collectTier2EvidenceCandidates(
      [result('custom-rule-deobfuscated', [
        finding('custom.process-execution', absolutePath, 1, 1),
        finding('custom.process-execution', 'derived/obfuscation/package/index.js', 1, 1),
      ])],
      restoreResult(outputRoot, [restored]),
    );

    expect(candidates).toEqual([]);
  });

  it('rejects traversal paths and accepts Windows separators', async () => {
    const restored = await restoredFile(outputRoot, 'package/index.js', 'RESTORED');
    const candidates = await collectTier2EvidenceCandidates(
      [result('custom-rule-deobfuscated', [
        finding('custom.process-execution', 'package\\index.js', 1, 1),
        finding('custom.process-execution', 'package/../outside.js', 1, 1),
      ])],
      restoreResult(outputRoot, [restored]),
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.path).toBe('package/index.js');
  });

  it('rejects a restored output path that does not match its logical derived path', async () => {
    const expectedPath = join(outputRoot, 'package', 'index.js');
    const actualPath = join(outputRoot, 'package', 'other.js');
    await mkdir(dirname(expectedPath), { recursive: true });
    await writeFile(expectedPath, 'const expected = true;\n', 'utf8');
    await writeFile(actualPath, 'const actual = true;\n', 'utf8');

    const candidates = await collectTier2EvidenceCandidates(
      [result('custom-rule-deobfuscated', [finding('custom.process-execution', 'package/index.js', 1, 1)])],
      restoreResult(outputRoot, [restoredMetadata('package/index.js', 'RESTORED', actualPath)]),
    );

    expect(candidates).toEqual([]);
  });

  it('rejects a symlink escape outside the derived root', async () => {
    const outsideRoot = join(root, 'outside');
    await mkdir(outsideRoot, { recursive: true });
    await writeFile(join(outsideRoot, 'index.js'), 'fetch(url);\n', 'utf8');
    const packagePath = join(outputRoot, 'package');
    try {
      await symlink(outsideRoot, packagePath, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return;
      throw error;
    }

    const candidates = await collectTier2EvidenceCandidates(
      [result('custom-rule-deobfuscated', [finding('custom.process-execution', 'package/index.js', 1, 1)])],
      restoreResult(outputRoot, [restoredMetadata('package/index.js', 'RESTORED', join(packagePath, 'index.js'))]),
    );

    expect(candidates).toEqual([]);
  });

  it('validates every source location while ignoring metadata locations', async () => {
    const restored = await restoredFile(outputRoot, 'package/index.js', 'PARTIAL_RESTORED');
    const candidateFinding: Finding = {
      ...finding('custom.lifecycle-process-coexistence', 'package/index.js', 2, 2),
      location: { type: 'METADATA', jsonPointer: '/scripts/install' },
      data: {
        locations: [
          { type: 'METADATA', jsonPointer: '/scripts/install' },
          { type: 'SOURCE_FILE', path: 'package/index.js', startLine: 2, endLine: 2 },
        ],
      },
    };
    const candidates = await collectTier2EvidenceCandidates(
      [result('custom-rule-deobfuscated', [candidateFinding])],
      restoreResult(outputRoot, [restored]),
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      restoreStatus: 'PARTIAL_RESTORED',
      originalPath: 'package/index.js',
      derivedPath: 'package/index.js',
      requestId: 'request-1',
      scanId: 'scan-1',
      artifactHash: 'artifact-hash',
      paths: ['package/index.js'],
    });
  });

  it('rejects a finding when any referenced source location is invalid', async () => {
    const restored = await restoredFile(outputRoot, 'package/index.js', 'RESTORED');
    const candidateFinding: Finding = {
      ...finding('custom.env-network-coexistence', 'package/index.js', 2, 2),
      data: {
        locations: [
          { type: 'SOURCE_FILE', path: 'package/index.js', startLine: 2, endLine: 2 },
          { type: 'SOURCE_FILE', path: 'package/missing.js', startLine: 1, endLine: 1 },
        ],
      },
    };
    const candidates = await collectTier2EvidenceCandidates(
      [result('custom-rule-deobfuscated', [candidateFinding])],
      restoreResult(outputRoot, [restored]),
    );

    expect(candidates).toEqual([]);
  });

  it('rejects lifecycle-only metadata and accepts source-backed lifecycle behavior', async () => {
    const restored = await restoredFile(outputRoot, 'package/index.js', 'RESTORED');
    const lifecycleOnly: Finding = {
      ...finding('custom.lifecycle-entry', 'package/index.js'),
      location: { type: 'METADATA', jsonPointer: '/scripts/install' },
      data: { locations: [{ type: 'METADATA', jsonPointer: '/scripts/install' }] },
    };
    const sourceBacked = finding('custom.lifecycle-process-coexistence', 'package/index.js', 2, 2);
    const candidates = await collectTier2EvidenceCandidates(
      [result('custom-rule-deobfuscated', [lifecycleOnly, sourceBacked])],
      restoreResult(outputRoot, [restored]),
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.ruleId).toBe('custom.lifecycle-process-coexistence');
  });

  it('requires a start line, accepts start-line-only findings, and handles empty files', async () => {
    const emptyPath = 'package/empty.js';
    const empty = await restoredFile(outputRoot, emptyPath, 'RESTORED', '');
    const startOnly = await restoredFile(outputRoot, 'package/start-only.js', 'RESTORED');
    const candidates = await collectTier2EvidenceCandidates(
      [result('custom-rule-deobfuscated', [
        finding('custom.process-execution', emptyPath, 1, 1),
        finding('custom.process-execution', 'package/start-only.js', 1),
        finding('custom.process-execution', 'package/no-line.js'),
      ])],
      restoreResult(outputRoot, [empty, startOnly]),
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.path).toBe('package/start-only.js');
  });

  it('uses the existing trailing-newline line numbering convention', async () => {
    const path = 'package/trailing-newline.js';
    const restored = await restoredFile(outputRoot, path, 'RESTORED', 'const value = 1;\n');
    const candidates = await collectTier2EvidenceCandidates(
      [result('custom-rule-deobfuscated', [finding('custom.process-execution', path, 2, 2)])],
      restoreResult(outputRoot, [restored]),
    );

    expect(candidates).toHaveLength(1);
  });

  it('keeps Tier1 findings out of the derived candidate set', async () => {
    const restored = await restoredFile(outputRoot, 'package/index.js', 'RESTORED');
    const candidates = await collectTier2EvidenceCandidates(
      [
        result('custom-rule', [finding('custom.process-execution', 'package/index.js', 1, 1)]),
        result('custom-rule-deobfuscated', [finding('custom.network-outbound', 'package/index.js', 2, 2)]),
      ],
      restoreResult(outputRoot, [restored]),
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      analyzer: 'custom-rule-deobfuscated',
      finding: { ruleId: 'custom.network-outbound' },
    });
  });
});

function finding(
  ruleId: string,
  path: string,
  startLine?: number,
  endLine?: number,
  data: Record<string, unknown> = {},
): Finding {
  return {
    findingId: `${ruleId}:${path}`,
    ruleId,
    type: 'CAPABILITY_PATTERN',
    message: ruleId,
    location: {
      type: 'SOURCE_FILE',
      path,
      ...(startLine === undefined ? {} : { startLine }),
      ...(endLine === undefined ? {} : { endLine }),
    },
    data,
  };
}

function collectTier2EvidenceCandidates(
  derivedResults: AnalyzerResult[],
  restore: RestoreResult,
) {
  return collectCandidates(derivedResults, restore, {
    requestId: 'request-1',
    scanId: 'scan-1',
    artifactHash: 'artifact-hash',
  });
}

function result(analyzer: string, findings: Finding[]): AnalyzerResult {
  return {
    requestId: 'request-1',
    scanId: 'scan-1',
    analyzer,
    analyzerVersion: 'test',
    status: 'SUCCESS',
    findings,
    errors: [],
  };
}

async function restoredFile(
  outputRoot: string,
  path: string,
  status: 'RESTORED' | 'PARTIAL_RESTORED',
  content = 'const value = 1;\nfetch(url);\n',
): Promise<RestoreResult['restored'][number]> {
  const outputPath = join(outputRoot, path);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, content, 'utf8');
  return restoredMetadata(path, status, outputPath);
}

function restoredMetadata(
  path: string,
  status: 'RESTORED' | 'PARTIAL_RESTORED',
  outputPath: string,
): RestoreResult['restored'][number] {
  return {
    path,
    outputPath,
    status,
    limitations: [],
    stageResults: [],
    appliedStages: ['STRING'],
    payloads: [],
    originalBytes: 20,
    restoredBytes: 30,
    verifyAfter: { score: 0.1, hexIdRatio: 0 },
    validation: {} as RestoreResult['restored'][number]['validation'],
    durationMs: 1,
  };
}

function restoreResult(
  outputRoot: string,
  restored: RestoreResult['restored'],
  unresolved: RestoreResult['unresolved'] = [],
): RestoreResult {
  return {
    outputRoot,
    restored,
    unresolved,
    durationMs: 1,
    budgetExceeded: false,
  };
}
