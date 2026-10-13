import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentPlanningInputV0_1 } from '../../application/planning/agent-planning-input.types';
import type { RestoreResult, SourceLineMapping } from '../../analyzers/obfuscation/obfuscation.types';
import type { AnalysisContext, AnalyzerResult, Finding } from '../../domain/analysis.types';
import type { AtomicEvidenceV0_1, NormalizationResult } from '../../evidence/normalizer/evidence-normalizer.types';
import { readArtifactSource } from './code-slice.factory';
import { AgentInputV0_3Builder } from './agent-input-v0_3.builder';
import type { ArtifactDescriptor } from './artifact.contract';
import { buildPlanningTier3ExecutionInput } from './planning-tier3-execution-input';

const HASH = 'a'.repeat(64);
const ORIGINAL_ID = `artifact:${HASH}`;
const DERIVED_HASH = 'b'.repeat(64);
const DERIVED_ID = `${ORIGINAL_ID}:deobfuscated:${DERIVED_HASH}`;

describe('Planning to Tier 3 execution input', () => {
  let root: string;
  let originalRoot: string;
  let restoredRoot: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'planning-tier3-'));
    originalRoot = join(root, 'original');
    restoredRoot = join(root, 'restored');
    await mkdir(originalRoot);
    await mkdir(restoredRoot);
    await writeFile(join(originalRoot, 'index.js'), 'const original = process.env.TOKEN;\n');
    await writeFile(join(restoredRoot, 'index.js'), 'const restored = process.env.TOKEN;\n');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('builds and consumes an original-only input without a Tier2Handoff', async () => {
    const execution = buildPlanningTier3ExecutionInput({
      context: context(originalRoot),
      planningInput: planningInput({ tier1: [snapshot('guarddog', [finding('tier1-finding', 'index.js')])] }),
    });

    expect(execution.artifacts.list()).toEqual([expect.objectContaining({
      artifactId: ORIGINAL_ID, representation: 'ORIGINAL', analysisPass: 'TIER1',
    })]);
    expect(execution.validatedPlan).toMatchObject({
      shouldExecute: true, analysisMode: 'ORIGINAL_ONLY',
      targets: [expect.objectContaining({ artifactId: ORIGINAL_ID, filePath: 'index.js' })],
    });
    const built = await new AgentInputV0_3Builder().build(execution, {
      scanId: 'scan', packageName: 'pkg', packageVersion: '1.0.0', archiveSha256: HASH,
    }, policy());
    expect(built.input.initialCodeSlices[0]).toMatchObject({ artifactId: ORIGINAL_ID, content: expect.stringContaining('original') });
    expect(JSON.stringify(built.input)).not.toContain(originalRoot);
  });

  it('keeps unresolved and safe-fallback facts as limitations on original-only plans', () => {
    const unresolved = planningInput({
      tier1: [snapshot('guarddog', [finding('threat', 'index.js')])],
      restore: restoreResult([], [{
        path: 'index.js', status: 'UNRESOLVED', reason: 'TOOL_FAILED', limitations: ['DYNAMIC_DECODE_UNRESOLVED'], stageResults: [],
      }]),
      tier2Status: 'PARTIAL',
    });
    const unresolvedExecution = buildPlanningTier3ExecutionInput({ context: context(originalRoot), planningInput: unresolved });
    expect(unresolvedExecution.validatedPlan.analysisMode).toBe('ORIGINAL_ONLY');
    expect(unresolvedExecution.validatedPlan.limitations).toEqual(expect.arrayContaining([
      'ANALYZER_PARTIAL:obfuscation',
      'RESTORATION_UNRESOLVED:index.js:TOOL_FAILED',
      'RESTORATION_LIMITATION:index.js:DYNAMIC_DECODE_UNRESOLVED',
    ]));

    const fallback = planningInput({ tier1: [snapshot('guarddog', [finding('threat', 'index.js')])], tier2Status: 'FAILED' });
    const fallbackExecution = buildPlanningTier3ExecutionInput({ context: context(originalRoot), planningInput: fallback });
    expect(fallbackExecution.validatedPlan.limitations).toContain('ANALYZER_FAILED:obfuscation');
    expect(fallbackExecution.validatedPlan.analysisMode).toBe('ORIGINAL_ONLY');
  });

  it('separates the same relative path in original and restored artifacts', async () => {
    const mapping = lineMapping();
    const restore = restoreResult([restoredFile(mapping)], []);
    const input = planningInput({
      tier1: [snapshot('guarddog', [finding('same-id-original', 'index.js')])],
      derived: [snapshot('guarddog-deobfuscated', [finding('same-id-derived', 'index.js')])],
      restore,
      evidences: [evidence('tier1-evidence', 'same-id-original', 'guarddog'), evidence('tier2-evidence', 'same-id-derived', 'guarddog-deobfuscated', 'TIER2')],
    });
    const execution = buildPlanningTier3ExecutionInput({
      context: context(originalRoot), planningInput: input,
      restoredArtifact: { descriptor: restoredDescriptor(mapping), root: restoredRoot },
    });

    expect(execution.validatedPlan.analysisMode).toBe('ORIGINAL_AND_DEOBFUSCATED');
    expect(execution.bindings.findingBindings).toEqual(expect.arrayContaining([
      expect.objectContaining({ findingId: 'same-id-original', artifactId: ORIGINAL_ID, filePath: 'index.js' }),
      expect.objectContaining({ findingId: 'same-id-derived', artifactId: DERIVED_ID, filePath: 'index.js', lineageStatus: 'MAPPED' }),
    ]));
    expect(execution.bindings.evidenceBindings).toEqual(expect.arrayContaining([
      expect.objectContaining({ evidenceId: 'tier1-evidence', artifactId: ORIGINAL_ID }),
      expect.objectContaining({ evidenceId: 'tier2-evidence', artifactId: DERIVED_ID }),
    ]));
    expect(execution.atomicEvidences.map(({ evidenceId }) => evidenceId)).toEqual(['tier1-evidence', 'tier2-evidence']);

    const built = await new AgentInputV0_3Builder().build(execution, {
      scanId: 'scan', packageName: 'pkg', packageVersion: '1.0.0', archiveSha256: HASH,
    }, policy());
    expect(built.input.initialCodeSlices.map(({ artifactId, content }) => ({ artifactId, content }))).toEqual(expect.arrayContaining([
      { artifactId: ORIGINAL_ID, content: expect.stringContaining('original') },
      { artifactId: DERIVED_ID, content: expect.stringContaining('restored') },
    ]));
  });

  it('keeps a usable partial restoration and generic derived failure limitations', () => {
    const mapping = lineMapping();
    const partial = restoredFile(mapping);
    partial.status = 'PARTIAL_RESTORED';
    partial.limitations = ['PARTIAL_RESTORE_PREVENTS_COMPLETE_VERIFICATION'];
    const input = planningInput({
      tier1: [snapshot('guarddog', [finding('original', 'index.js')])],
      derived: [snapshot('custom-rule-deobfuscated', [finding('derived', 'index.js')]), snapshot('guarddog-deobfuscated', [], 'FAILED')],
      restore: restoreResult([partial], []),
    });
    const execution = buildPlanningTier3ExecutionInput({
      context: context(originalRoot), planningInput: input,
      restoredArtifact: { descriptor: restoredDescriptor(mapping), root: restoredRoot },
    });

    expect(execution.validatedPlan.analysisMode).toBe('ORIGINAL_AND_DEOBFUSCATED');
    expect(execution.validatedPlan.limitations).toEqual(expect.arrayContaining([
      'PARTIAL_RESTORATION:index.js',
      'RESTORATION_LIMITATION:index.js:PARTIAL_RESTORE_PREVENTS_COMPLETE_VERIFICATION',
      'ANALYZER_FAILED:guarddog-deobfuscated',
    ]));
    expect(execution.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ findingId: 'derived', analyzer: 'custom-rule-deobfuscated' }),
    ]));
  });

  it('preserves unbound findings and reports unavailable restored artifacts without inventing an original binding', () => {
    const input = planningInput({
      derived: [snapshot('custom-rule-deobfuscated', [finding('derived', 'index.js')])],
      restore: restoreResult([restoredFile(lineMapping())], []),
      normalization: {
        atomicEvidences: [],
        unmappedFindings: [{ analyzerName: 'custom-rule-deobfuscated', analyzerVersion: '1', findingId: 'derived', ruleId: 'threat-x', mappingStatus: 'UNMAPPED', reason: 'fixture' }],
        errors: [], summary: normalizationSummary(),
      },
    });
    const execution = buildPlanningTier3ExecutionInput({
      context: context(originalRoot), planningInput: input,
      restoredArtifactUnavailableReason: 'RESTORED_ARTIFACT_HASH_FAILED',
    });

    expect(execution.findings).toEqual([expect.objectContaining({ findingId: 'derived', analyzer: 'custom-rule-deobfuscated' })]);
    expect(execution.bindings.findingBindings).toEqual([]);
    expect(execution.validatedPlan.limitations).toEqual(expect.arrayContaining([
      'RESTORED_ARTIFACT_HASH_FAILED', 'RESTORED_ARTIFACT_UNAVAILABLE',
      'FINDING_CODE_BINDING_UNAVAILABLE:custom-rule-deobfuscated:derived:ARTIFACT_UNAVAILABLE',
      'NORMALIZATION_UNMAPPED:custom-rule-deobfuscated:derived',
    ]));
  });

  it('falls back to the original artifact when a supplied restored descriptor is invalid', () => {
    const input = planningInput({
      tier1: [snapshot('guarddog', [finding('original', 'index.js')])],
      derived: [snapshot('guarddog-deobfuscated', [finding('derived', 'index.js')])],
      restore: restoreResult([restoredFile(lineMapping())], []),
    });
    const invalid = { ...restoredDescriptor(lineMapping()), contentSha256: 'not-a-sha256' };
    const execution = buildPlanningTier3ExecutionInput({
      context: context(originalRoot), planningInput: input,
      restoredArtifact: { descriptor: invalid, root: restoredRoot },
    });
    expect(execution.artifacts.list()).toHaveLength(1);
    expect(execution.validatedPlan.analysisMode).toBe('ORIGINAL_ONLY');
    expect(execution.validatedPlan.limitations).toEqual(expect.arrayContaining([
      'RESTORED_ARTIFACT_PREPARATION_FAILED', 'RESTORED_ARTIFACT_UNAVAILABLE',
    ]));
  });

  it('keeps metadata and raw-only findings while recording missing code bindings', () => {
    const metadata: Finding = {
      findingId: 'metadata-hook', ruleId: 'metadata.lifecycle.postinstall', type: 'METADATA', message: 'hook',
      location: { type: 'METADATA', jsonPointer: '/scripts/postinstall' }, data: { scriptName: 'postinstall' },
    };
    const execution = buildPlanningTier3ExecutionInput({
      context: context(originalRoot),
      planningInput: planningInput({ tier1: [snapshot('metadata', [metadata]), snapshot('guarddog', [finding('raw-only', 'index.js')])] }),
    });
    expect(execution.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ findingId: 'metadata-hook', location: null }),
      expect.objectContaining({ findingId: 'raw-only' }),
    ]));
    expect(execution.validatedPlan.limitations).toContain('FINDING_CODE_BINDING_UNAVAILABLE:metadata:metadata-hook:NON_SOURCE_LOCATION');
  });

  it('rejects identity mismatches and invalid original artifact preparation', () => {
    const input = planningInput();
    expect(() => buildPlanningTier3ExecutionInput({
      context: { ...context(originalRoot), scanId: 'different' }, planningInput: input,
    })).toThrow('Planning input subject does not match AnalysisContext');
    expect(() => buildPlanningTier3ExecutionInput({
      context: { ...context(originalRoot), artifact: { ...context(originalRoot).artifact, extractedPath: '' } }, planningInput: input,
    })).toThrow('Original artifact preparation failed');
  });

  it('rejects duplicate analyzer-scoped Finding IDs that v0.3 cannot represent without rewriting', () => {
    const input = planningInput({
      tier1: [snapshot('guarddog', [finding('duplicate', 'index.js')]), snapshot('custom-rule', [finding('duplicate', 'index.js')])],
    });
    expect(() => buildPlanningTier3ExecutionInput({ context: context(originalRoot), planningInput: input }))
      .toThrow('Tier 3 input cannot represent duplicate Finding IDs: duplicate');
  });

  it('does not mutate frozen input and retains the existing traversal defense', async () => {
    const input = planningInput({ tier1: [snapshot('guarddog', [finding('finding', 'index.js')])] });
    deepFreeze(input);
    const execution = buildPlanningTier3ExecutionInput({ context: context(originalRoot), planningInput: input });
    expect(input.tier1.analyzers[0]?.findings[0]?.findingId).toBe('finding');
    await expect(readArtifactSource(execution.artifacts, ORIGINAL_ID, '../outside.js', 1024)).rejects.toMatchObject({ reason: 'FILE_REJECTED' });
  });
});

function context(extractedPath: string): AnalysisContext {
  return {
    requestId: 'request', scanId: 'scan', package: { name: 'pkg', version: '1.0.0' },
    artifact: { tarballPath: join(extractedPath, '..', 'package.tgz'), extractedPath, hash: HASH },
    metadata: { registryMetadata: {}, packageJson: { name: 'pkg', version: '1.0.0', main: 'index.js' } },
  };
}

function planningInput(options: {
  tier1?: AgentPlanningInputV0_1['tier1']['analyzers'];
  derived?: AgentPlanningInputV0_1['tier2']['derivedAnalyzers'];
  tier2Status?: AnalyzerResult['status'];
  restore?: RestoreResult;
  evidences?: AtomicEvidenceV0_1[];
  normalization?: NormalizationResult;
} = {}): AgentPlanningInputV0_1 {
  return {
    schemaVersion: '0.1.0',
    subject: { requestId: 'request', scanId: 'scan', ecosystem: 'npm', packageName: 'pkg', packageVersion: '1.0.0', artifactHash: HASH },
    tier1: { analyzers: options.tier1 ?? [] },
    tier2: {
      analyzer: snapshot('obfuscation', [], options.tier2Status ?? 'SUCCESS'),
      derivedAnalyzers: options.derived ?? [],
      ...(options.restore === undefined ? {} : { restore: options.restore }),
    },
    normalization: options.normalization ?? {
      atomicEvidences: options.evidences ?? [], unmappedFindings: [], errors: [], summary: normalizationSummary(),
    },
  };
}

function snapshot(analyzer: string, findings: Finding[], status: AnalyzerResult['status'] = 'SUCCESS') {
  return { analyzer, analyzerVersion: '1', status, findings, errors: [] } as const;
}

function finding(findingId: string, path: string): Finding {
  return {
    findingId, ruleId: findingId === 'threat' ? 'threat-network-exfiltration' : 'capability-network-outbound',
    type: findingId === 'threat' ? 'THREAT_INDICATOR' : 'CAPABILITY', message: findingId,
    location: { type: 'SOURCE_FILE', path, startLine: 1, endLine: 1 }, data: { match: 'process.env.TOKEN' },
  };
}

function evidence(evidenceId: string, findingId: string, analyzer: string, analysisPass?: 'TIER1' | 'TIER2'): AtomicEvidenceV0_1 {
  return {
    schemaVersion: '0.1', evidenceId, kind: 'ATOMIC', ...(analysisPass === undefined ? {} : { analysisPass }),
    signal: { id: 'capability.network.outbound', type: 'NETWORK_EGRESS', category: 'NETWORK' },
    subject: { ecosystem: 'npm', packageName: 'pkg', packageVersion: '1.0.0', artifactHash: HASH },
    assertion: { summary: 'network', basis: 'PATTERN_MATCH' },
    sources: [{ analyzer, analyzerVersion: '1', ruleId: 'capability-network-outbound', rawFindingId: findingId }],
    locations: [{ type: 'SOURCE_FILE', path: 'index.js', startLine: 1, endLine: 1 }],
    provenance: { scanId: 'scan', generatedBy: 'EVIDENCE_NORMALIZER', observedAt: '2026-10-03T00:00:00.000Z' }, limitations: [],
  };
}

function lineMapping(): SourceLineMapping {
  return {
    version: '0.1.0', sourcePath: 'index.js', derivedPath: 'index.js', status: 'MAPPED',
    entries: [{ derivedLine: 1, sourceLine: 1, confidence: 'EXACT' }], derivedLineCount: 1, mappedLineCount: 1, limitations: [],
  };
}

function restoredDescriptor(mapping: SourceLineMapping): ArtifactDescriptor {
  return {
    artifactId: DERIVED_ID, representation: 'DEOBFUSCATED', analysisPass: 'TIER2', contentSha256: DERIVED_HASH,
    derivedFromArtifactId: ORIGINAL_ID, lineageStatus: 'MAPPED', lineMappings: [mapping], producer: 'scanner-obfuscation-restore', producerVersion: '0.2.0',
  };
}

function restoredFile(mapping: SourceLineMapping): RestoreResult['restored'][number] {
  return {
    path: 'index.js', outputPath: 'index.js', status: 'RESTORED', limitations: [], stageResults: [], appliedStages: [], payloads: [],
    originalBytes: 10, restoredBytes: 10, verifyAfter: { score: 0, hexIdRatio: 0 }, durationMs: 1, lineMapping: mapping,
    validation: {
      original: { parse: { valid: true }, bytes: 10, identifierCount: 1, hexIdentifierCount: 0, hexIdRatio: 0, score: 0, signals: [] },
      restored: { parse: { valid: true }, bytes: 10, identifierCount: 1, hexIdentifierCount: 0, hexIdRatio: 0, score: 0, signals: [] },
      byteDelta: 0, byteRatio: 1, identifierDelta: 0, hexIdentifierDelta: 0, scoreDelta: 0, addedSignals: [], removedSignals: [],
      capability: { before: [], after: [], status: 'PRESERVED', lost: [] },
    },
  };
}

function restoreResult(restored: RestoreResult['restored'], unresolved: RestoreResult['unresolved']): RestoreResult {
  return { outputRoot: '/internal/restored', restored, unresolved, durationMs: 1, budgetExceeded: false };
}

function normalizationSummary(): NormalizationResult['summary'] {
  return {
    inputFindingCount: 0, normalizedFindingCount: 0, atomicEvidenceCount: 0, unmappedFindingCount: 0,
    invalidFindingCount: 0, deduplicatedEvidenceCount: 0, normalizerVersion: '0.1.0', mappingVersion: '1', mappingHash: HASH,
  };
}

function policy() {
  return {
    codeSlices: { maxInitialSlices: 10, maxLinesPerSlice: 120, maxInitialCodeLines: 800, maxTotalCodeLines: 1040, maxFileSizeBytes: 1024 * 1024 },
    maxToolCalls: 4, maxAdditionalCodeRequests: 2,
  };
}

function deepFreeze(value: unknown): void {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return;
  Object.freeze(value);
  for (const nested of Object.values(value)) deepFreeze(nested);
}
