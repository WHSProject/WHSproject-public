import type { AnalyzerResult, Finding } from '../../domain/analysis.types';
import {
  buildFileEvidenceBundles,
  selectGptCandidates,
} from './evidence-bundle';
import type { RestoreResult } from './obfuscation.types';

describe('파일별 난독화 Evidence 결합', () => {
  it('서로 다른 파일의 수집·네트워크 신호를 하나의 흐름으로 합치지 않는다', () => {
    const restore = restoreResult([
      restored('package/a.js', 'PARTIAL_RESTORED'),
      restored('package/b.js', 'PARTIAL_RESTORED'),
    ]);
    const bundles = buildFileEvidenceBundles(
      [result('custom-rule', [finding('custom.collection-source', 'package/a.js')])],
      result('obfuscation', [
        finding('obfuscation.detected', 'package/a.js'),
        finding('obfuscation.detected', 'package/b.js'),
      ]),
      [result('custom-rule-deobfuscated', [
        finding('custom.network-outbound', 'package/b.js'),
      ])],
      restore,
    );

    expect(bundles).toHaveLength(2);
    expect(bundles.every(({ strongCombinations }) =>
      !strongCombinations.includes('COLLECTION_TO_NETWORK'))).toBe(true);
    expect(bundles.find(({ path }) => path === 'package/b.js')?.newRuleIds)
      .toEqual(['custom.network-outbound']);
  });

  it('부분 복원 또는 미복원 파일에 실제 위험 신호가 있을 때만 GPT 후보로 고른다', () => {
    const restore: RestoreResult = {
      ...restoreResult([restored('package/partial.js', 'PARTIAL_RESTORED')]),
      unresolved: [{
        path: 'package/unresolved.js',
        status: 'UNRESOLVED',
        reason: 'NO_SUPPORTED_TRANSFORM',
        limitations: ['NO_SUPPORTED_TRANSFORM'],
        stageResults: [],
      }],
    };
    const bundles = buildFileEvidenceBundles(
      [result('custom-rule', [
        finding('custom.credential-source', 'package/partial.js'),
        finding('custom.collection-source', 'package/unresolved.js'),
      ])],
      result('obfuscation', [
        finding('obfuscation.detected', 'package/partial.js'),
        finding('obfuscation.unresolved', 'package/unresolved.js'),
      ]),
      [],
      restore,
    );

    expect(selectGptCandidates(bundles, restore, '/tmp/extracted'))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({
          path: 'package/partial.js',
          reason: 'PARTIAL_RESTORED_WITH_RISK',
        }),
        expect.objectContaining({
          path: 'package/unresolved.js',
          reason: 'UNRESOLVED_OBFUSCATION_WITH_RISK',
        }),
      ]));
  });

  it('복원본에 동적 실행 신호가 남으면 다른 위험 API가 없어도 후보로 고른다', () => {
    const restore = restoreResult([restored('package/eval.js', 'RESTORED')]);
    const bundles = buildFileEvidenceBundles(
      [],
      result('obfuscation', [finding('obfuscation.detected', 'package/eval.js')]),
      [result('guarddog-deobfuscated', [
        finding('threat-runtime-obfuscation-dynamic-eval', 'package/eval.js'),
      ])],
      restore,
    );

    expect(selectGptCandidates(bundles, restore, '/tmp/extracted'))
      .toEqual([expect.objectContaining({ reason: 'DYNAMIC_EXEC_REMAINS' })]);
  });

  it('Windows path와 POSIX Finding path를 같은 파일로 연결한다', () => {
    const restore = restoreResult([restored('package\\setup.js', 'PARTIAL_RESTORED')]);
    const bundles = buildFileEvidenceBundles(
      [],
      result('obfuscation', [finding('obfuscation.detected', 'package\\setup.js')]),
      [result('custom-rule-deobfuscated', [
        finding('custom.process-execution', 'package/setup.js'),
      ])],
      restore,
    );

    expect(bundles).toHaveLength(1);
    expect(bundles[0]).toMatchObject({
      path: 'package/setup.js',
      newRuleIds: ['custom.process-execution'],
      restoration: { status: 'PARTIAL_RESTORED' },
    });
    expect(selectGptCandidates(bundles, restore, '/tmp/extracted')).toEqual([
      expect.objectContaining({
        path: 'package/setup.js',
        reason: 'STRONG_RISK_COMBINATION',
        supportingReasons: expect.arrayContaining(['RESTORED_WITH_NEW_SIGNAL']),
        sourceKind: 'RESTORED',
      }),
    ]);
  });

  it('PARTIAL_RESTORED와 residual dynamic signal은 GPT 후보가 된다', () => {
    const restore = restoreResult([restored('package/eval.js', 'PARTIAL_RESTORED')]);
    const bundles = buildFileEvidenceBundles(
      [],
      result('obfuscation', [finding('obfuscation.detected', 'package/eval.js')]),
      [result('guarddog-deobfuscated', [
        finding('threat-runtime-obfuscation-dynamic-eval', 'package/eval.js'),
      ])],
      restore,
    );

    expect(selectGptCandidates(bundles, restore, '/tmp/extracted'))
      .toEqual([expect.objectContaining({ reason: 'DYNAMIC_EXEC_REMAINS' })]);
  });

  it('FAILED는 risk evidence와 함께 원본 source 후보가 된다', () => {
    const restore = restoreResult([]);
    restore.unresolved = [{
      path: 'package/failed.js',
      status: 'FAILED',
      reason: 'TOOL_FAILED',
      limitations: ['STRUCTURE_STAGE_FAILED'],
      stageResults: [{
        stage: 'STRUCTURE', applied: false, status: 'FAILED', changed: false,
      }],
    }];
    const bundles = buildFileEvidenceBundles(
      [result('custom-rule', [finding('custom.network-outbound', 'package/failed.js')])],
      result('obfuscation', [finding('obfuscation.unresolved', 'package/failed.js')]),
      [],
      restore,
    );

    expect(bundles[0]?.restoration).toMatchObject({
      status: 'FAILED',
      reason: 'TOOL_FAILED',
    });
    expect(selectGptCandidates(bundles, restore, '/tmp/extracted')).toEqual([
      expect.objectContaining({
        reason: 'FAILED_WITH_RISK',
        sourceKind: 'ORIGINAL',
        restored: false,
      }),
    ]);
  });

  it.each([
    ['RESTORED', 'RESTORED'],
    ['PARTIAL_RESTORED', 'PARTIAL_RESTORED'],
  ] as const)('%s 상태만 있고 risk가 없으면 GPT 후보가 아니다', (_label, status) => {
    const restore = restoreResult([restored('package/plain.js', status)]);
    const bundles = buildFileEvidenceBundles(
      [],
      result('obfuscation', [finding('obfuscation.technique.encoded-string', 'package/plain.js')]),
      [],
      restore,
    );

    expect(selectGptCandidates(bundles, restore, '/tmp/extracted')).toEqual([]);
  });

  it.each(['UNRESOLVED', 'FAILED'] as const)('%s 상태만 있고 risk가 없으면 GPT 후보가 아니다', (status) => {
    const restore = restoreResult([]);
    restore.unresolved = [{
      path: 'package/plain.js',
      status,
      reason: 'NO_SUPPORTED_TRANSFORM',
      limitations: ['NO_SUPPORTED_TRANSFORM'],
      stageResults: [],
    }];
    const bundles = buildFileEvidenceBundles(
      [],
      result('obfuscation', [finding('obfuscation.unresolved', 'package/plain.js')]),
      [],
      restore,
    );

    expect(selectGptCandidates(bundles, restore, '/tmp/extracted')).toEqual([]);
  });
});

function finding(ruleId: string, path: string): Finding {
  return {
    findingId: `${ruleId}:${path}`,
    ruleId,
    type: 'TEST',
    message: ruleId,
    location: { type: 'SOURCE_FILE', path, startLine: 1 },
    data: {},
  };
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

function restored(
  path: string,
  status: 'RESTORED' | 'PARTIAL_RESTORED',
): RestoreResult['restored'][number] {
  return {
    path,
    outputPath: `/tmp/restored/${path}`,
    status,
    appliedStages: ['STRUCTURE'],
    limitations: status === 'PARTIAL_RESTORED'
      ? ['DYNAMIC_DECODE_UNRESOLVED']
      : [],
    stageResults: [],
    payloads: [],
    originalBytes: 100,
    restoredBytes: 80,
    verifyAfter: { score: 0.2, hexIdRatio: 0.1 },
    validation: {
      original: {
        parse: { valid: true },
        bytes: 100,
        identifierCount: 1,
        hexIdentifierCount: 0,
        hexIdRatio: 0.1,
        score: 0.3,
        signals: [],
      },
      restored: {
        parse: { valid: true },
        bytes: 80,
        identifierCount: 1,
        hexIdentifierCount: 0,
        hexIdRatio: 0.1,
        score: 0.2,
        signals: [],
      },
      byteDelta: -20,
      byteRatio: 0.8,
      identifierDelta: 0,
      hexIdentifierDelta: 0,
      scoreDelta: -0.1,
      addedSignals: [],
      removedSignals: [],
      capability: {
        before: [],
        after: null,
        status: 'NOT_APPLICABLE',
        lost: [],
      },
    },
    durationMs: 1,
  };
}

function restoreResult(restoredFiles: RestoreResult['restored']): RestoreResult {
  return {
    outputRoot: '/tmp/restored',
    restored: restoredFiles,
    unresolved: [],
    durationMs: 1,
    budgetExceeded: false,
  };
}
