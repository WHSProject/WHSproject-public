import type { Finding } from '../../domain/analysis.types';
import type { Tier2EvidenceCandidate } from './evidence-candidate-gate';
import { buildTier2PlanningInput } from './tier2-planning-input';
import type { FileEvidenceBundle } from './agent-analysis.types';
import type { RestoreResult } from './obfuscation.types';

describe('Tier2 PlanningInput projection', () => {
  it('preserves identity, restore inventory, payload paths, validation and derived signal facts', () => {
    const validation = validationSnapshot();
    const finding = findingValue('custom.process-execution', 'package\\index.js.payload-1.js');
    const candidate = candidateValue(finding);
    const restore = restoreValue(validation);
    const input = buildTier2PlanningInput(
      context(),
      restore,
      [candidate],
      [bundle('package/index.js', ['custom.process-execution'])],
    );

    expect(input).toMatchObject({
      kind: 'TIER2_RESTORE_PROJECTION',
      requestId: 'request-1',
      scanId: 'scan-1',
      artifactHash: 'artifact-hash',
    });
    expect(input.restoreFiles[0]).toMatchObject({
      originalLogicalPath: 'package/index.js',
      status: 'PARTIAL_RESTORED',
      derivedFiles: [
        { logicalPath: 'package/index.js', outputRef: 'C:/derived/package/index.js' },
        { logicalPath: 'package/index.js.payload-1.js', outputRef: 'C:/derived/package/index.js.payload-1.js' },
      ],
      validation,
    });
    expect(input.evidenceCandidates[0]).toMatchObject({
      analyzer: 'custom-rule-deobfuscated',
      analyzerVersion: 'custom-v1',
      ruleId: 'custom.process-execution',
      rawFindingId: 'raw-1',
      finding,
      restoreStatus: 'PARTIAL_RESTORED',
      validations: [{ originalLogicalPath: 'package/index.js', snapshot: validation }],
      derivedNewRuleIds: ['custom.process-execution'],
      derivedSignalFacts: [{
        ruleId: 'custom.process-execution',
        signalId: 'capability.process.spawn',
        signalType: 'CHILD_PROCESS',
        mappingStatus: 'PARTIAL',
      }],
    });
    expect(input.evidenceCandidates[0]?.sourceLocations).toEqual([
      {
        originalLogicalPath: 'package/index.js',
        derivedLogicalPath: 'package/index.js.payload-1.js',
        derivedOutputRef: 'C:/derived/package/index.js.payload-1.js',
      },
      {
        originalLogicalPath: 'package/index.js',
        derivedLogicalPath: 'package/index.js',
        derivedOutputRef: 'C:/derived/package/index.js',
      },
    ]);
  });

  it('keeps restore-only files and all non-candidate statuses in deterministic order', () => {
    const restore = restoreValue(validationSnapshot());
    restore.restored.push({
      ...restore.restored[0]!,
      path: 'package/other.js',
      outputPath: 'C:/derived/package/other.js',
      payloads: [],
    });
    restore.unresolved = [
      unresolved('package/z-skipped.js', 'SKIPPED'),
      unresolved('package/a-failed.js', 'FAILED'),
      unresolved('package/m-unresolved.js', 'UNRESOLVED'),
    ];

    const input = buildTier2PlanningInput(context(), restore, [], []);

    expect(input.evidenceCandidates).toEqual([]);
    expect(input.restoreFiles.map(({ originalLogicalPath, status }) => `${originalLogicalPath}:${status}`)).toEqual([
      'package/a-failed.js:FAILED',
      'package/index.js:PARTIAL_RESTORED',
      'package/m-unresolved.js:UNRESOLVED',
      'package/other.js:PARTIAL_RESTORED',
      'package/z-skipped.js:SKIPPED',
    ]);
  });

  it('preserves a fully RESTORED status without making a planning decision', () => {
    const restore = restoreValue(validationSnapshot());
    restore.restored[0]!.status = 'RESTORED';
    const candidate = candidateValue(findingValue('custom.process-execution', 'package/index.js'));
    candidate.restoreStatus = 'RESTORED';

    const input = buildTier2PlanningInput(context(), restore, [candidate], []);

    expect(input.restoreFiles[0]?.status).toBe('RESTORED');
    expect(input.evidenceCandidates[0]?.restoreStatus).toBe('RESTORED');
  });

  it('does not create a signal fact for a non-risk obfuscation-only candidate', () => {
    const finding = findingValue('obfuscation.restored', 'package/index.js');
    const candidate = candidateValue(finding);
    const input = buildTier2PlanningInput(
      context(),
      restoreValue(validationSnapshot()),
      [candidate],
      [],
    );

    expect(input.evidenceCandidates[0]?.derivedSignalFacts).toEqual([]);
  });

  it('preserves behavior and obfuscation mapping facts without reclassifying obfuscation', () => {
    const finding = findingValue('threat-process-powershell-encoded', 'package/index.js');
    const candidate = candidateValue(finding, 'guarddog-deobfuscated');
    const input = buildTier2PlanningInput(
      context(),
      restoreValue(validationSnapshot()),
      [candidate],
      [],
    );

    expect(input.evidenceCandidates).toHaveLength(1);
    expect(input.evidenceCandidates[0]?.derivedSignalFacts).toEqual([
      {
        ruleId: 'threat-process-powershell-encoded',
        signalId: 'threat.code.powershell-encoded',
        signalType: 'OBFUSCATED_CODE',
        mappingStatus: 'PARTIAL',
      },
      {
        ruleId: 'threat-process-powershell-encoded',
        signalId: 'threat.process.powershell-command',
        signalType: 'SHELL_EXEC',
        mappingStatus: 'PARTIAL',
      },
    ]);
    expect(input.evidenceCandidates[0]?.derivedSignalFacts.map(({ signalType }) => signalType)).toEqual([
      'OBFUSCATED_CODE',
      'SHELL_EXEC',
    ]);
  });

  it('preserves behavior and lifecycle mapping facts without mixing their meanings', () => {
    const finding = findingValue('threat-process-hooks', 'package/index.js');
    const candidate = candidateValue(finding, 'guarddog-deobfuscated');
    const input = buildTier2PlanningInput(
      context(),
      restoreValue(validationSnapshot()),
      [candidate],
      [],
    );

    expect(input.evidenceCandidates).toHaveLength(1);
    expect(input.evidenceCandidates[0]?.derivedSignalFacts).toEqual([
      {
        ruleId: 'threat-process-hooks',
        signalId: 'threat.lifecycle.install-hook',
        signalType: 'LIFECYCLE_SCRIPT',
        mappingStatus: 'PARTIAL',
      },
      {
        ruleId: 'threat-process-hooks',
        signalId: 'threat.process.hook-command',
        signalType: 'CHILD_PROCESS',
        mappingStatus: 'PARTIAL',
      },
    ]);
    expect(input.evidenceCandidates[0]?.derivedSignalFacts.map(({ signalType }) => signalType)).toEqual([
      'LIFECYCLE_SCRIPT',
      'CHILD_PROCESS',
    ]);
  });

  it('does not mix Tier1 analyzer facts into a Tier2 candidate projection', () => {
    const finding = findingValue('capability-network-outbound', 'package/index.js');
    const candidate = candidateValue(finding, 'guarddog-deobfuscated');
    const input = buildTier2PlanningInput(
      context(),
      restoreValue(validationSnapshot()),
      [candidate],
      [bundle('package/index.js', ['capability-network-outbound'])],
    );

    expect(input.evidenceCandidates).toHaveLength(1);
    expect(input.evidenceCandidates[0]?.analyzer).toBe('guarddog-deobfuscated');
    expect(input.evidenceCandidates[0]?.derivedSignalFacts).toEqual([
      {
        ruleId: 'capability-network-outbound',
        signalId: 'capability.network.outbound',
        signalType: 'NETWORK_EGRESS',
        mappingStatus: 'EXACT',
      },
    ]);
  });
});

function context() {
  return { requestId: 'request-1', scanId: 'scan-1', artifact: { hash: 'artifact-hash' } };
}

function findingValue(ruleId: string, path: string): Finding {
  return {
    findingId: 'raw-1',
    ruleId,
    type: 'CAPABILITY',
    message: 'test finding',
    location: { type: 'SOURCE_FILE', path, startLine: 1 },
    data: {},
  };
}

function candidateValue(finding: Finding, analyzer = 'custom-rule-deobfuscated'): Tier2EvidenceCandidate {
  return {
    analyzer: analyzer as Tier2EvidenceCandidate['analyzer'],
    analyzerVersion: analyzer === 'guarddog-deobfuscated' ? 'guarddog-v1' : 'custom-v1',
    finding,
    ruleId: finding.ruleId,
    rawFindingId: finding.findingId,
    requestId: 'request-1',
    scanId: 'scan-1',
    artifactHash: 'artifact-hash',
    path: 'package/index.js.payload-1.js',
    paths: ['package\\index.js.payload-1.js', 'package/index.js'],
    originalPath: 'package/index.js',
    originalPaths: ['package/index.js', 'package/index.js'],
    derivedPath: 'package/index.js.payload-1.js',
    derivedPaths: ['package\\index.js.payload-1.js', 'package/index.js'],
    derivedOutputPath: 'C:/derived/package/index.js.payload-1.js',
    derivedOutputPaths: ['C:/derived/package/index.js.payload-1.js', 'C:/derived/package/index.js'],
    locations: [
      { type: 'SOURCE_FILE', path: 'package/index.js.payload-1.js', startLine: 1 },
      { type: 'SOURCE_FILE', path: 'package/index.js', startLine: 1 },
    ],
    limitations: ['STRING_STAGE_FAILED'],
    restoreStatus: 'PARTIAL_RESTORED',
  };
}

function bundle(path: string, newRuleIds: string[]): Pick<FileEvidenceBundle, 'path' | 'newRuleIds'> {
  return { path, newRuleIds };
}

function restoreValue(validation: RestoreResult['restored'][number]['validation']): RestoreResult {
  return {
    outputRoot: 'C:/derived',
    restored: [{
      path: 'package/index.js',
      outputPath: 'C:/derived/package/index.js',
      status: 'PARTIAL_RESTORED',
      reason: 'PARTIAL_STAGE_FAILURE',
      limitations: ['STRING_STAGE_FAILED'],
      stageResults: [{ stage: 'STRING', applied: true, status: 'FAILED', changed: false }],
      appliedStages: ['STRUCTURE'],
      payloads: [{ outputPath: 'C:/derived/package/index.js.payload-1.js', sourceLine: 2, transform: 'EVAL_PROMOTE' }],
      originalBytes: 10,
      restoredBytes: 12,
      verifyAfter: { score: 0.2, hexIdRatio: 0.1 },
      validation,
      durationMs: 1,
    }],
    unresolved: [],
    durationMs: 1,
    budgetExceeded: false,
  };
}

function unresolved(path: string, status: 'UNRESOLVED' | 'FAILED' | 'SKIPPED'): RestoreResult['unresolved'][number] {
  return {
    path,
    status,
    reason: 'TOOL_FAILED',
    limitations: ['TOOL_TIMEOUT'],
    stageResults: [],
  };
}

function validationSnapshot(): RestoreResult['restored'][number]['validation'] {
  return {
    original: {
      parse: { valid: true },
      bytes: 10,
      identifierCount: 2,
      hexIdentifierCount: 1,
      hexIdRatio: 0.5,
      score: 0.8,
      signals: ['HEX_LITERAL'],
    },
    restored: {
      parse: { valid: true },
      bytes: 12,
      identifierCount: 3,
      hexIdentifierCount: 0,
      hexIdRatio: 0,
      score: 0.2,
      signals: [],
    },
    byteDelta: 2,
    byteRatio: 1.2,
    identifierDelta: 1,
    hexIdentifierDelta: -1,
    scoreDelta: -0.6,
    addedSignals: [],
    removedSignals: ['HEX_LITERAL'],
    capability: {
      before: ['capability-process-spawn'],
      after: ['capability-process-spawn'],
      status: 'PRESERVED',
      lost: [],
    },
  };
}
