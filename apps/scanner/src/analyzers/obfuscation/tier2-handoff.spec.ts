import type { AnalyzerResult, AnalysisContext, Finding } from '../../domain/analysis.types';
import type { AtomicEvidenceV0_1 } from '../../evidence/normalizer/evidence-normalizer.types';
import type { RestoreResult } from './obfuscation.types';
import { buildTier2Handoff } from './tier2-handoff';

const context: AnalysisContext = {
  requestId: 'request-1',
  scanId: 'scan-1',
  package: { name: 'example', version: '1.0.0' },
  artifact: {
    tarballPath: 'scan/package.tgz',
    extractedPath: 'scan/extracted',
    hash: 'a'.repeat(64),
  },
  metadata: { registryMetadata: {}, packageJson: {} },
};

const finding: Finding = {
  findingId: 'custom-rule-deobfuscated:finding-1',
  ruleId: 'custom.process-execution',
  type: 'CAPABILITY_PROCESS_EXECUTION',
  message: 'exec(decoded)',
  location: { type: 'SOURCE_FILE', path: 'package/decoded.js', startLine: 4, endLine: 4 },
  data: { match: 'exec(decoded)' },
};

const evidence: AtomicEvidenceV0_1 = {
  schemaVersion: '0.1',
  evidenceId: 'evidence-1',
  kind: 'ATOMIC',
  analysisPass: 'TIER2',
  signal: { id: 'child-process', type: 'CHILD_PROCESS', category: 'EXECUTION' },
  subject: { ecosystem: 'npm', packageName: 'example', packageVersion: '1.0.0', artifactHash: 'a'.repeat(64) },
  assertion: { summary: 'exec(decoded)', basis: 'PATTERN_MATCH' },
  sources: [{ analyzer: 'custom-rule-deobfuscated', analyzerVersion: '0.1.0', ruleId: finding.ruleId, rawFindingId: finding.findingId }],
  locations: [{ type: 'SOURCE_FILE', path: 'package/decoded.js', startLine: 4, endLine: 4, representation: 'DEOBFUSCATED', lineageStatus: 'UNMAPPED', derivedFrom: { path: 'package/index.js' } }],
  provenance: { scanId: 'scan-1', generatedBy: 'EVIDENCE_NORMALIZER', observedAt: '2026-09-27T00:00:00.000Z' },
  limitations: ['NO_SUPPORTED_TRANSFORM'],
};

const restore = {
  outputRoot: 'scan/derived/obfuscation',
  restored: [{ path: 'package/decoded.js', limitations: ['NO_SUPPORTED_TRANSFORM'] }],
  unresolved: [{ path: 'package/other.js', status: 'UNRESOLVED', reason: 'DYNAMIC_DECODE_UNRESOLVED', limitations: [], stageResults: [], detail: 'dynamic decode' }],
  durationMs: 1,
  budgetExceeded: false,
} as unknown as RestoreResult;

describe('buildTier2Handoff', () => {
  it('creates the restored artifact, projections, bindings, and limitations', () => {
    const result: AnalyzerResult = {
      requestId: 'request-1', scanId: 'scan-1', analyzer: 'custom-rule-deobfuscated', analyzerVersion: '0.1.0',
      status: 'SUCCESS', findings: [finding], errors: [],
    };
    const handoff = buildTier2Handoff({
      context,
      restore,
      derivedAnalyzerResults: [result],
      atomicEvidences: [evidence, { ...evidence, evidenceId: 'tier1', analysisPass: 'TIER1' }],
      contentSha256: 'b'.repeat(64),
    });

    expect(handoff.artifact).toMatchObject({
      representation: 'DEOBFUSCATED',
      analysisPass: 'TIER2',
      contentSha256: 'b'.repeat(64),
      derivedFromArtifactId: `artifact:${'a'.repeat(64)}`,
      lineageStatus: 'UNMAPPED',
    });
    expect(handoff.artifact.artifactId).toBe(`artifact:${'a'.repeat(64)}:deobfuscated:${'b'.repeat(64)}`);
    expect(handoff.artifactRoot).toBe('scan/derived/obfuscation');
    expect(handoff.findings).toEqual([expect.objectContaining({
      findingId: finding.findingId,
      kind: 'CAPABILITY',
      location: expect.objectContaining({ file: 'package/decoded.js', startLine: 4, endLine: 4, lineageStatus: 'UNMAPPED' }),
      rawMatch: 'exec(decoded)',
    })]);
    expect(handoff.findingBindings).toEqual([{ findingId: finding.findingId, artifactId: handoff.artifact.artifactId, filePath: 'package/decoded.js', startLine: 4, endLine: 4, lineageStatus: 'UNMAPPED', derivedFrom: { file: 'package/decoded.js' } }]);
    expect(handoff.atomicEvidences).toHaveLength(1);
    expect(handoff.evidenceBindings).toEqual([{ evidenceId: 'evidence-1', artifactId: handoff.artifact.artifactId, filePath: 'package/decoded.js', startLine: 4, endLine: 4, lineageStatus: 'UNMAPPED', derivedFrom: { file: 'package/index.js' } }]);
    expect(handoff.limitations).toEqual([
      { filePath: 'package/decoded.js', code: 'NO_SUPPORTED_TRANSFORM' },
      { filePath: 'package/other.js', code: 'DYNAMIC_DECODE_UNRESOLVED', explanation: 'dynamic decode' },
    ]);
  });

  it('propagates mapped source coordinates into the artifact, projections, and bindings', () => {
    const mappedRestore = {
      ...restore,
      restored: [{
        path: 'package/decoded.js',
        limitations: [],
        lineMapping: {
          version: '0.1.0',
          sourcePath: 'package/index.js',
          derivedPath: 'package/decoded.js',
          status: 'MAPPED',
          entries: [{ derivedLine: 4, sourceLine: 2, confidence: 'EXACT' }],
          derivedLineCount: 4,
          mappedLineCount: 1,
          limitations: [],
        },
      }],
    } as unknown as RestoreResult;
    const result: AnalyzerResult = {
      requestId: 'request-1', scanId: 'scan-1', analyzer: 'custom-rule-deobfuscated', analyzerVersion: '0.1.0',
      status: 'SUCCESS', findings: [finding], errors: [],
    };

    const handoff = buildTier2Handoff({
      context,
      restore: mappedRestore,
      derivedAnalyzerResults: [result],
      atomicEvidences: [evidence],
      contentSha256: 'b'.repeat(64),
    });

    expect(handoff.artifact).toMatchObject({ lineageStatus: 'MAPPED' });
    expect(handoff.artifact.lineMappings).toHaveLength(1);
    expect(handoff.findings[0]?.location).toMatchObject({
      file: 'package/decoded.js',
      startLine: 4,
      endLine: 4,
      lineageStatus: 'MAPPED',
      derivedFrom: { file: 'package/index.js', startLine: 2, endLine: 2 },
    });
    expect(handoff.findingBindings[0]).toMatchObject({
      lineageStatus: 'MAPPED',
      derivedFrom: { file: 'package/index.js', startLine: 2, endLine: 2 },
    });
  });

  it('forwards capability preservation with the Tier2 handoff', () => {
    const result: AnalyzerResult = {
      requestId: 'request-1', scanId: 'scan-1', analyzer: 'custom-rule-deobfuscated', analyzerVersion: '0.1.0',
      status: 'SUCCESS', findings: [finding], errors: [],
    };
    const capabilityPreservation = {
      status: 'NOT_VERIFIED' as const,
      files: [{
        originalPath: 'package/index.js',
        deobfuscatedPaths: ['package/decoded.js'],
        restoreStatus: 'PARTIAL_RESTORED' as const,
        validation: {
          before: ['capability.process.spawn'], after: null, status: 'NOT_VERIFIED' as const,
          lost: [], preserved: [], discovered: [], comparisons: [], limitations: ['CAPABILITY_COMPARISON_INCOMPLETE' as const],
        },
      }],
      limitations: ['CAPABILITY_COMPARISON_INCOMPLETE' as const],
    };
    const handoff = buildTier2Handoff({
      context,
      restore: { ...restore, capabilityPreservation },
      derivedAnalyzerResults: [result],
      atomicEvidences: [evidence],
      contentSha256: 'b'.repeat(64),
    });

    expect(handoff.capabilityPreservation).toEqual(capabilityPreservation);
  });
});
