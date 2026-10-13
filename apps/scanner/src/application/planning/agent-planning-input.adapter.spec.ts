import type { AnalysisContext, AnalyzerResult, Finding } from '../../domain/analysis.types';
import type { NormalizationResult } from '../../evidence/normalizer/evidence-normalizer.types';
import type { CustomRuleRelationCandidate } from '../../analyzers/custom-rule/custom-rule.analyzer';
import type { ObfuscationShadowResult } from '../../analyzers/obfuscation/obfuscation.analyzer';
import type {
  RestoreResult,
  RestoredFile,
  ValidationSnapshot,
} from '../../analyzers/obfuscation/obfuscation.types';
import { buildAgentPlanningInput } from './agent-planning-input.adapter';

const context: AnalysisContext = {
  requestId: 'request-1',
  scanId: 'scan-1',
  package: { name: 'example', version: '1.0.0' },
  artifact: {
    tarballPath: '/work/artifact.tgz',
    extractedPath: '/work/extracted',
    hash: 'artifact-hash',
  },
  metadata: {
    registryMetadata: { private: 'not projected' },
    packageJson: { name: 'example', scripts: { postinstall: 'node setup.js' } },
  },
};

const normalization: NormalizationResult = {
  atomicEvidences: [{
    schemaVersion: '0.1',
    evidenceId: 'evidence-1',
    kind: 'ATOMIC',
    signal: { id: 'signal-1', type: 'LIFECYCLE_SCRIPT', category: 'EXECUTION' },
    subject: {
      ecosystem: 'npm',
      packageName: 'example',
      packageVersion: '1.0.0',
      artifactHash: 'artifact-hash',
    },
    assertion: { summary: 'postinstall exists', basis: 'METADATA_VALUE' },
    sources: [{
      analyzer: 'metadata', analyzerVersion: '0.1.0',
      ruleId: 'metadata.lifecycle.postinstall', rawFindingId: 'metadata:postinstall:0',
    }],
    locations: [{ type: 'METADATA', jsonPointer: '/scripts/postinstall' }],
    provenance: {
      scanId: 'scan-1', generatedBy: 'EVIDENCE_NORMALIZER',
      observedAt: '2026-10-01T00:00:00.000Z',
    },
    limitations: [],
  }],
  unmappedFindings: [{
    findingId: 'custom:unknown', analyzerName: 'custom-rule', analyzerVersion: '0.2.0',
    ruleId: 'unknown', mappingStatus: 'UNMAPPED', reason: 'no mapping',
  }],
  errors: [{
    code: 'INTERNAL_ERROR', stage: 'NORMALIZATION:TEST', message: 'test error', retryable: false,
  }],
  summary: {
    inputFindingCount: 2, normalizedFindingCount: 1, atomicEvidenceCount: 1,
    unmappedFindingCount: 1, invalidFindingCount: 0, deduplicatedEvidenceCount: 0,
    normalizerVersion: '0.1.0', mappingVersion: '0.5.0', mappingHash: 'mapping-hash',
  },
};

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    findingId: 'metadata:postinstall:0',
    ruleId: 'metadata.lifecycle.postinstall',
    type: 'LIFECYCLE_SCRIPT',
    message: 'postinstall script',
    location: { type: 'METADATA', jsonPointer: '/scripts/postinstall' },
    data: { scriptName: 'postinstall', scriptValue: 'node setup.js', observation: 'PRESENT' },
    rawResultRef: 'finding-raw-ref',
    ...overrides,
  };
}

function analyzer(
  name: string,
  overrides: Partial<AnalyzerResult> = {},
): AnalyzerResult {
  return {
    requestId: 'request-1', scanId: 'scan-1', analyzer: name,
    analyzerVersion: '0.2.0', status: 'SUCCESS', findings: [], errors: [],
    ...overrides,
  };
}

function validation(): ValidationSnapshot {
  const source = {
    parse: { valid: true }, bytes: 10, identifierCount: 1,
    hexIdentifierCount: 0, hexIdRatio: 0, score: 1, signals: [],
  };
  return {
    original: source,
    restored: { ...source, bytes: 20 },
    byteDelta: 10,
    byteRatio: 2,
    identifierDelta: 0,
    hexIdentifierDelta: 0,
    scoreDelta: 0,
    addedSignals: [],
    removedSignals: [],
    capability: { before: [], after: [], status: 'PRESERVED', lost: [] },
  };
}

function restoredFile(status: RestoredFile['status']): RestoredFile {
  return {
    path: 'setup.js',
    outputPath: '/work/derived/setup.js',
    status,
    ...(status === 'PARTIAL_RESTORED' ? { reason: 'PARTIAL_STAGE_FAILURE' as const } : {}),
    limitations: status === 'PARTIAL_RESTORED' ? ['STRUCTURE_STAGE_FAILED'] : [],
    stageResults: [{
      stage: 'STRING', applied: true, status: 'COMPLETED', changed: true,
    }],
    appliedStages: ['STRING'],
    payloads: [],
    originalBytes: 10,
    restoredBytes: 20,
    verifyAfter: { score: 1, hexIdRatio: 0 },
    validation: validation(),
    lineMapping: {
      version: '0.1.0', sourcePath: 'setup.js', derivedPath: 'setup.js', status: 'MAPPED',
      entries: [{ derivedLine: 1, sourceLine: 3, confidence: 'EXACT' }],
      derivedLineCount: 1, mappedLineCount: 1, limitations: [],
    },
    durationMs: 5,
  };
}

function restore(
  restored: RestoredFile[] = [],
  unresolved: RestoreResult['unresolved'] = [],
): RestoreResult {
  return {
    outputRoot: '/work/derived', restored, unresolved, durationMs: 10, budgetExceeded: false,
  };
}

function shadow(overrides: Partial<ObfuscationShadowResult> = {}): ObfuscationShadowResult {
  return {
    analyzerResult: analyzer('obfuscation'),
    derivedAnalyzerResults: [],
    evidenceCandidates: [],
    planningInput: {
      kind: 'TIER2_RESTORE_PROJECTION', requestId: 'request-1', scanId: 'scan-1',
      artifactHash: 'artifact-hash', restoreFiles: [], evidenceCandidates: [],
    },
    restore: restore(),
    summary: {
      gptMode: 'off', scannedFiles: 0, selectedFiles: 0, restoredFiles: 0,
      partialRestoredFiles: 0, unresolvedFiles: 0, newRuleIds: [],
      derivedAnalyzerStatuses: [], evidenceBundles: [],
      agentAnalysisRequest: {
        schemaVersion: '0.1', requestId: 'request-1', scanId: 'scan-1',
        sampleId: 'secret-request', purpose: 'DEOBFUSCATION_CODE_UNDERSTANDING',
        package: {
          ecosystem: 'npm', name: 'example', version: '1.0.0',
          artifactHash: 'artifact-hash', description: null, lifecycleScripts: [],
        },
        candidates: [],
      },
      gpt: { status: 'NOT_REQUESTED', durationMs: 0 },
    },
    ...overrides,
  };
}

function relation(sourceFindingId: string): CustomRuleRelationCandidate {
  return {
    relationId: 'relation-1', relationType: 'DOWNLOAD_TO_EXECUTE',
    sourceFindingIds: [sourceFindingId], sinkFindingIds: ['custom-rule:sink:0'],
    evidenceKind: 'STATIC_DATA_FLOW', analysisLevel: 'DATA_FLOW', executionContext: 'INSTALL',
    status: 'CANDIDATE',
    provenance: {
      source: 'CUSTOM_STATIC_RULE', analyzer: 'custom-rule', analyzerVersion: '0.2.0',
    },
    locations: {
      sources: [{ type: 'SOURCE_FILE', path: 'setup.js', startLine: 1 }],
      sinks: [{ type: 'SOURCE_FILE', path: 'setup.js', startLine: 2 }],
    },
    limitations: ['static candidate only'],
  };
}

function build(tier1Results: readonly AnalyzerResult[], tier2Result: ObfuscationShadowResult) {
  return buildAgentPlanningInput({ context, tier1Results, tier2Result, normalizationResult: normalization });
}

function deepFreeze(value: unknown): void {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
}

describe('buildAgentPlanningInput', () => {
  it('projects identity, Tier 1 lifecycle Finding and a normal empty selection without a handoff', () => {
    const metadata = analyzer('metadata', {
      findings: [finding()],
      rawResultRef: 'analyzer-raw-ref',
      execution: {
        startedAt: '2026-10-01T00:00:00.000Z',
        completedAt: '2026-10-01T00:00:00.001Z',
        durationMs: 1,
      },
    });
    const input = build([metadata], shadow());

    expect(input).toMatchObject({
      schemaVersion: '0.1.0',
      subject: {
        requestId: 'request-1', scanId: 'scan-1', ecosystem: 'npm',
        packageName: 'example', packageVersion: '1.0.0', artifactHash: 'artifact-hash',
      },
      tier2: { selection: { scannedFiles: 0, selectedFiles: 0 } },
    });
    expect(input.tier1.analyzers[0]?.findings[0]).toBe(metadata.findings[0]);
    expect(input.tier1.analyzers[0]?.findings[0]).toMatchObject({
      location: { jsonPointer: '/scripts/postinstall' },
      data: { scriptName: 'postinstall', scriptValue: 'node setup.js' },
      rawResultRef: 'finding-raw-ref',
    });
    expect(input.tier1.analyzers[0]).toMatchObject({
      rawResultRef: 'analyzer-raw-ref',
      execution: { durationMs: 1 },
    });
    expect(input.subject).not.toHaveProperty('artifact');
    expect(input.subject).not.toHaveProperty('metadata');
  });

  it.each(['RESTORED', 'PARTIAL_RESTORED'] as const)(
    'preserves %s restore validation, limitations and line mapping by reference',
    (status) => {
      const restoreResult = restore([restoredFile(status)]);
      const tier2Result = shadow({ restore: restoreResult });
      const input = build([], tier2Result);

      expect(input.tier2.restore).toBe(restoreResult);
      expect(input.tier2.restore?.restored[0]).toMatchObject({
        status,
        validation: { byteDelta: 10 },
        lineMapping: { sourcePath: 'setup.js', entries: [{ sourceLine: 3 }] },
      });
      if (status === 'PARTIAL_RESTORED') {
        expect(input.tier2.restore?.restored[0]).toMatchObject({
          reason: 'PARTIAL_STAGE_FAILURE', limitations: ['STRUCTURE_STAGE_FAILED'],
        });
      }
    },
  );

  it('preserves every unresolved status and reason', () => {
    const restoreResult = restore([], [
      { path: 'a.js', status: 'UNRESOLVED', reason: 'DYNAMIC_DECODE_UNRESOLVED', limitations: ['DYNAMIC_DECODE_UNRESOLVED'], stageResults: [] },
      { path: 'b.js', status: 'SKIPPED', reason: 'BUDGET_EXCEEDED', limitations: ['BUDGET_EXCEEDED'], stageResults: [] },
      { path: 'c.js', status: 'FAILED', reason: 'SOURCE_READ_FAILED', limitations: [], stageResults: [] },
    ]);

    expect(build([], shadow({ restore: restoreResult })).tier2.restore?.unresolved)
      .toEqual(restoreResult.unresolved);
  });

  it('omits selection for the safe fallback instead of projecting default zeroes', () => {
    const fallback = shadow({
      analyzerResult: analyzer('obfuscation', { status: 'FAILED' }),
      restore: undefined,
    });
    const input = build([], fallback);

    expect(input.tier2.analyzer.status).toBe('FAILED');
    expect(input.tier2).not.toHaveProperty('restore');
    expect(input.tier2).not.toHaveProperty('selection');
    expect(input.tier2).not.toHaveProperty('scanLimitHit');
  });

  it('preserves GuardDog and Custom Rule extensions on original and derived results', () => {
    const risks: Record<string, unknown>[] = [];
    const assessment = {
      score: 4, label: 'suspicious' as const, findingsCount: 1,
      scoreBreakdown: { threat: 4 }, raw: { risk_score: 4 },
    };
    const guarddog = {
      tool: { name: 'guarddog' as const, version: '2.0' },
      risks,
      toolAssessment: assessment,
      execution: {
        command: ['guarddog'], exitCode: 0, signal: null, jsonParsed: true,
        timedOut: false, outputLimitExceeded: false, sandboxMode: 'REQUIRED' as const,
      },
    };
    const originalRelation = relation('custom-rule:source:0');
    const derivedRelation = relation('custom-rule:source:0');
    const tier1GuardDog = { ...analyzer('guarddog'), guarddog };
    const tier1Custom = {
      ...analyzer('custom-rule'), relationCandidates: [] as CustomRuleRelationCandidate[],
      rawResult: { stdout: 'excluded', stderr: 'excluded', exitCode: 0, signal: null },
    };
    const derivedGuardDog = { ...analyzer('guarddog-deobfuscated'), guarddog };
    const derivedCustom = {
      ...analyzer('custom-rule-deobfuscated', {
        findings: [finding({ findingId: 'custom-rule-deobfuscated:source:0' })],
      }),
      relationCandidates: [derivedRelation],
      rawResult: { stdout: 'excluded-derived', stderr: 'excluded-derived', exitCode: 0, signal: null },
    };
    tier1Custom.relationCandidates.push(originalRelation);
    const input = build(
      [tier1GuardDog, tier1Custom],
      shadow({ derivedAnalyzerResults: [derivedGuardDog, derivedCustom] }),
    );

    expect(input.tier1.analyzers[0]?.guarddog).toEqual({ risks, toolAssessment: assessment });
    expect(input.tier1.analyzers[1]?.customRule?.relationCandidates).toEqual([originalRelation]);
    expect(input.tier2.derivedAnalyzers[0]?.guarddog).toEqual({ risks, toolAssessment: assessment });
    expect(input.tier2.derivedAnalyzers[1]?.customRule?.relationCandidates).toEqual([derivedRelation]);
    expect(input.tier2.derivedAnalyzers[1]?.customRule?.relationCandidates[0]?.sourceFindingIds)
      .toEqual(['custom-rule:source:0']);
    expect(input.tier2.derivedAnalyzers[1]?.findings[0]?.findingId)
      .toBe('custom-rule-deobfuscated:source:0');
    expect(input.tier1.analyzers[1]).not.toHaveProperty('rawResult');
    expect(input.tier2.derivedAnalyzers[1]).not.toHaveProperty('rawResult');
    expect(input.tier2).not.toHaveProperty('planningInput');
    expect(input.tier2).not.toHaveProperty('summary');
    expect(input.tier2).not.toHaveProperty('evidenceCandidates');
  });

  it('distinguishes real empty extensions from absent extensions and generic derived failures', () => {
    const withEmptyRisks = {
      ...analyzer('guarddog'),
      guarddog: {
        tool: { name: 'guarddog' as const, version: '2.0' }, risks: [],
        execution: {
          command: [], exitCode: 0, signal: null, jsonParsed: true, timedOut: false,
          outputLimitExceeded: false, sandboxMode: 'REQUIRED' as const,
        },
      },
    };
    const withEmptyRelations = { ...analyzer('custom-rule'), relationCandidates: [] };
    const input = build(
      [withEmptyRisks, withEmptyRelations, analyzer('guarddog')],
      shadow({ derivedAnalyzerResults: [analyzer('custom-rule-deobfuscated', { status: 'FAILED' })] }),
    );

    expect(input.tier1.analyzers[0]?.guarddog).toEqual({ risks: [] });
    expect(input.tier1.analyzers[1]?.customRule).toEqual({ relationCandidates: [] });
    expect(input.tier1.analyzers[2]).not.toHaveProperty('guarddog');
    expect(input.tier2.derivedAnalyzers[0]).not.toHaveProperty('customRule');
  });

  it('keeps all normalization areas once and accepts deeply frozen inputs without mutation', () => {
    const tier1 = [analyzer('metadata', { findings: [finding()] })];
    const tier2 = shadow();
    deepFreeze(context);
    deepFreeze(tier1);
    deepFreeze(tier2);
    deepFreeze(normalization);

    const input = build(tier1, tier2);

    expect(input.normalization).toBe(normalization);
    expect(input.normalization).toMatchObject({
      atomicEvidences: normalization.atomicEvidences,
      unmappedFindings: normalization.unmappedFindings,
      errors: normalization.errors,
      summary: normalization.summary,
    });
    expect(input.tier1).not.toHaveProperty('atomicEvidences');
    expect(input.tier2).not.toHaveProperty('atomicEvidences');
    expect(Object.isFrozen(tier1[0])).toBe(true);
  });
});
