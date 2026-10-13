import { attachCapabilityPreservation } from './capability-preservation';
import type { AnalyzerResult, Finding } from '../../domain/analysis.types';
import type { RestoreResult, RestoredFile } from './obfuscation.types';

const hash = 'a'.repeat(64);

function finding(analyzer: string, ruleId: string, path: string, index = 0): Finding {
  return {
    findingId: `${analyzer}:${ruleId}:${path}:${index}`,
    ruleId,
    type: ruleId.startsWith('threat-') ? 'THREAT_INDICATOR' : 'CAPABILITY_PATTERN',
    message: ruleId,
    location: { type: 'SOURCE_FILE', path, startLine: 1, endLine: 1 },
    data: { locations: [{ type: 'SOURCE_FILE', path, startLine: 1, endLine: 1 }] },
  };
}

function result(analyzer: string, findings: Finding[], status: AnalyzerResult['status'] = 'SUCCESS'): AnalyzerResult {
  return {
    requestId: 'request-1',
    scanId: 'scan-1',
    analyzer,
    analyzerVersion: 'test',
    status,
    findings,
    errors: [],
  };
}

function restored(path: string, status: RestoredFile['status'] = 'RESTORED'): RestoredFile {
  return {
    path,
    outputPath: `derived/${path}`,
    status,
    limitations: ['RISK_CAPABILITY_NOT_REANALYZED'],
    stageResults: [],
    appliedStages: ['NORMALIZE'],
    payloads: [],
    originalBytes: 10,
    restoredBytes: 10,
    verifyAfter: { score: 0.1, hexIdRatio: 0 },
    validation: {
      original: { parse: { valid: true }, bytes: 10, identifierCount: 1, hexIdentifierCount: 0, hexIdRatio: 0, score: 0.1, signals: [] },
      restored: { parse: { valid: true }, bytes: 10, identifierCount: 1, hexIdentifierCount: 0, hexIdRatio: 0, score: 0.1, signals: [] },
      byteDelta: 0, byteRatio: 1, identifierDelta: 0, hexIdentifierDelta: 0, scoreDelta: 0, addedSignals: [], removedSignals: [],
      capability: { before: [], after: null, status: 'NOT_APPLICABLE', lost: [] },
    },
    durationMs: 1,
  };
}

function restore(files: RestoredFile[]): RestoreResult {
  return { outputRoot: 'derived', restored: files, unresolved: [], durationMs: 1, budgetExceeded: false };
}

describe('Capability Preservation', () => {
  it('does not report verification limits when no file entered restoration', () => {
    const output = attachCapabilityPreservation(
      { outputRoot: 'derived', restored: [], unresolved: [], durationMs: 1, budgetExceeded: false },
      [],
      [],
    );

    expect(output.capabilityPreservation).toEqual({ status: 'NOT_APPLICABLE', files: [], limitations: [] });
  });

  it('uses canonical capability IDs and marks A/B as preserved', () => {
    const original = result('guarddog', [
      finding('guarddog', 'capability-process-spawn', 'package/index.js'),
      finding('guarddog', 'capability-network-outbound', 'package/index.js'),
    ]);
    const derived = result('guarddog-deobfuscated', [
      finding('guarddog-deobfuscated', 'capability-process-spawn', 'package/index.js'),
      finding('guarddog-deobfuscated', 'capability-network-outbound', 'package/index.js'),
    ]);

    const output = attachCapabilityPreservation(restore([restored('package/index.js')]), [original], [derived]);
    const validation = output.restored[0]!.validation.capability;

    expect(validation.before).toEqual(['capability.network.outbound', 'capability.process.spawn']);
    expect(validation.after).toEqual(validation.before);
    expect(validation.status).toBe('PRESERVED');
    expect(output.restored[0]!.limitations).not.toContain('RISK_CAPABILITY_NOT_REANALYZED');
    expect(validation.comparisons?.map(({ capability, status }) => [capability, status])).toEqual([
      ['capability.network.outbound', 'PRESERVED'],
      ['capability.process.spawn', 'PRESERVED'],
    ]);
  });

  it('marks a missing capability LOST only after complete derived analysis', () => {
    const output = attachCapabilityPreservation(
      restore([restored('package/index.js')]),
      [result('guarddog', [
        finding('guarddog', 'capability-process-spawn', 'package/index.js'),
        finding('guarddog', 'capability-network-outbound', 'package/index.js'),
      ])],
      [result('guarddog-deobfuscated', [finding('guarddog-deobfuscated', 'capability-process-spawn', 'package/index.js')])],
    );
    const validation = output.restored[0]!.validation.capability;

    expect(validation.status).toBe('LOST');
    expect(validation.lost).toEqual(['capability.network.outbound']);
    expect(validation.comparisons?.find(({ capability }) => capability === 'capability.network.outbound')?.status).toBe('LOST');
  });

  it('reports new derived capabilities as DISCOVERED without changing preserved originals', () => {
    const output = attachCapabilityPreservation(
      restore([restored('package/index.js')]),
      [result('guarddog', [finding('guarddog', 'capability-process-spawn', 'package/index.js')])],
      [result('guarddog-deobfuscated', [
        finding('guarddog-deobfuscated', 'capability-process-spawn', 'package/index.js'),
        finding('guarddog-deobfuscated', 'capability-network-outbound', 'package/index.js'),
      ])],
    );
    const validation = output.restored[0]!.validation.capability;

    expect(validation.status).toBe('PRESERVED');
    expect(validation.preserved).toEqual(['capability.process.spawn']);
    expect(validation.discovered).toEqual(['capability.network.outbound']);
    expect(validation.comparisons?.find(({ capability }) => capability === 'capability.network.outbound')?.status).toBe('DISCOVERED');
  });

  it('does not turn analyzer failure or partial restore into LOST', () => {
    const failed = attachCapabilityPreservation(
      restore([restored('package/index.js')]),
      [result('guarddog', [finding('guarddog', 'capability-process-spawn', 'package/index.js')])],
      [result('guarddog-deobfuscated', [], 'FAILED')],
    );
    expect(failed.restored[0]!.validation.capability.status).toBe('NOT_VERIFIED');
    expect(failed.restored[0]!.validation.capability.lost).toEqual([]);

    const partial = attachCapabilityPreservation(
      restore([restored('package/index.js', 'PARTIAL_RESTORED')]),
      [result('guarddog', [finding('guarddog', 'capability-process-spawn', 'package/index.js')])],
      [result('guarddog-deobfuscated', [], 'SUCCESS')],
    );
    expect(partial.restored[0]!.validation.capability.status).toBe('NOT_VERIFIED');
    expect(partial.restored[0]!.validation.capability.comparisons?.[0]?.status).toBe('NOT_VERIFIED');
    expect(partial.restored[0]!.validation.capability.limitations).toEqual(expect.arrayContaining([
      'CAPABILITY_COMPARISON_INCOMPLETE',
      'PARTIAL_RESTORE_PREVENTS_COMPLETE_VERIFICATION',
    ]));
  });

  it('aggregates duplicate analyzer findings and preserves mapped provenance across files', () => {
    const file = restored('package/index.js');
    file.lineMapping = {
      version: '0.1.0', sourcePath: 'package/index.js', derivedPath: 'package/index.js', status: 'MAPPED',
      entries: [{ derivedLine: 4, sourceLine: 2, confidence: 'EXACT' }], derivedLineCount: 4, mappedLineCount: 1, limitations: [],
    };
    const output = attachCapabilityPreservation(
      restore([file, restored('package/other.js')]),
      [
        result('custom-rule', [finding('custom-rule', 'custom.lifecycle-process-coexistence', 'package/index.js')]),
        result('guarddog', [finding('guarddog', 'capability-process-spawn', 'package/index.js')]),
      ],
      [result('guarddog-deobfuscated', [{ ...finding('guarddog-deobfuscated', 'capability-process-spawn', 'package/index.js'), location: { type: 'SOURCE_FILE', path: 'package/index.js', startLine: 4, endLine: 4 }, data: { locations: [{ type: 'SOURCE_FILE', path: 'package/index.js', startLine: 4, endLine: 4 }] } }])],
    );
    const validation = output.restored[0]!.validation.capability;
    const comparison = validation.comparisons?.find(({ capability }) => capability === 'capability.process.spawn');

    expect(validation.comparisons).toHaveLength(1);
    expect(comparison?.status).toBe('PRESERVED');
    expect(comparison?.deobfuscated[0]).toMatchObject({ lineageStatus: 'MAPPED', derivedFrom: { path: 'package/index.js', startLine: 2, endLine: 2 } });
    expect(output.capabilityPreservation?.files).toHaveLength(2);
  });
});
