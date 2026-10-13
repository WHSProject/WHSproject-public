import type { AnalyzerResult, Finding } from '../domain/analysis.types';
import type { AtomicEvidenceV0_1 } from '../evidence/normalizer/evidence-normalizer.types';
import type { RestoreResult } from '../analyzers/obfuscation/obfuscation.types';
import type { Tier2Handoff } from './artifact/tier2-handoff.contract';
import { evaluateTier3Escalation } from './tier3-escalation-gate';

const finding = (analyzer: string, ruleId: string, type = 'CAPABILITY_PATTERN'): Finding => ({
  findingId: `${analyzer}:${ruleId}`,
  ruleId,
  type,
  message: ruleId,
  data: {},
});

const result = (analyzer: string, findings: Finding[]): AnalyzerResult => ({
  requestId: 'request',
  scanId: 'scan',
  analyzer,
  analyzerVersion: 'test',
  status: 'SUCCESS',
  findings,
  errors: [],
});

const evidence = (type: string, analysisPass: 'TIER1' | 'TIER2' = 'TIER1'): AtomicEvidenceV0_1 => ({
  schemaVersion: '0.1',
  evidenceId: `${analysisPass}:${type}`,
  kind: 'ATOMIC',
  analysisPass,
  signal: { id: type.toLowerCase(), type, category: 'EXECUTION' },
  subject: { ecosystem: 'npm', packageName: 'fixture', packageVersion: '1.0.0', artifactHash: 'a'.repeat(64) },
  assertion: { summary: type, basis: 'PATTERN_MATCH' },
  sources: [{ analyzer: 'custom-rule', analyzerVersion: 'test', ruleId: `custom.${type.toLowerCase()}`, rawFindingId: 'finding' }],
  locations: [],
  provenance: { scanId: 'scan', generatedBy: 'EVIDENCE_NORMALIZER', observedAt: '2026-01-01T00:00:00.000Z' },
  limitations: [],
});

const handoff = (atomicEvidences: AtomicEvidenceV0_1[]): Tier2Handoff => ({
  artifact: {
    artifactId: 'artifact:restored',
    representation: 'DEOBFUSCATED',
    analysisPass: 'TIER2',
    contentSha256: 'b'.repeat(64),
    derivedFromArtifactId: 'artifact:original',
    lineageStatus: 'MAPPED',
    producer: 'test',
    producerVersion: 'test',
  },
  artifactRoot: '/tmp/restored',
  findings: [
    { findingId: 'tier2:finding', analyzer: 'custom-rule-deobfuscated', analyzerVersion: 'test', ruleId: 'custom.process', kind: 'CAPABILITY', description: 'process', location: null, rawMatch: null },
  ],
  atomicEvidences,
  findingBindings: [],
  evidenceBindings: [],
  limitations: [],
});

const restore = (status: 'RESTORED' | 'PARTIAL_RESTORED' | 'UNRESOLVED'): RestoreResult => ({
  outputRoot: '/tmp/restored',
  restored: status === 'UNRESOLVED' ? [] : [{ status, path: 'package/index.js', outputPath: 'package/index.js', limitations: [], stageResults: [], appliedStages: [], payloads: [], originalBytes: 1, restoredBytes: 1, verifyAfter: { score: 0, hexIdRatio: 0 }, validation: {} as never, durationMs: 1 }],
  unresolved: status === 'UNRESOLVED' ? [{ status, path: 'package/index.js', reason: 'DYNAMIC_DECODE_UNRESOLVED', limitations: [], stageResults: [] }] : [],
  durationMs: 1,
  budgetExceeded: false,
});

describe('Tier3 escalation gate', () => {
  it('does not escalate a fully restored, corroborated result', () => {
    const shared = [finding('custom-rule', 'custom.process')];
    const decision = evaluateTier3Escalation({
      tier1Results: [result('custom-rule', shared), result('guarddog', shared)],
      tier1Evidences: [evidence('CHILD_PROCESS')],
      tier2Handoff: handoff([evidence('CHILD_PROCESS', 'TIER2'), evidence('NETWORK_EGRESS', 'TIER2')]),
      restore: restore('RESTORED'),
    });
    expect(decision).toMatchObject({ shouldEscalate: false, reasons: ['HIGH_CONFIDENCE_STATIC'], confidence: 'HIGH' });
  });

  it('escalates partial and unresolved restores with explicit reason codes', () => {
    const partial = evaluateTier3Escalation({
      tier1Results: [result('custom-rule', [finding('custom-rule', 'custom.process')])],
      tier1Evidences: [evidence('OBFUSCATED_CODE')],
      tier2Handoff: handoff([evidence('OBFUSCATED_CODE', 'TIER2')]),
      restore: restore('PARTIAL_RESTORED'),
    });
    expect(partial.shouldEscalate).toBe(true);
    expect(partial.reasons).toEqual(expect.arrayContaining(['PARTIAL_RESTORE', 'WEAK_SIGNAL_COMBINATION']));

    const unresolved = evaluateTier3Escalation({
      tier1Results: [result('custom-rule', [finding('custom-rule', 'custom.process')])],
      tier1Evidences: [evidence('OBFUSCATED_CODE')],
      tier2Handoff: handoff([]),
      restore: restore('UNRESOLVED'),
    });
    expect(unresolved.reasons).toContain('UNRESOLVED_OBFUSCATION');
  });

  it('does not call mapped-line or reanalysis limitations unresolved obfuscation', () => {
    const restored = restore('RESTORED');
    restored.restored[0]!.limitations = ['LINE_MAPPING_UNMAPPED', 'RISK_CAPABILITY_NOT_REANALYZED'];
    const noFindings = { ...handoff([]), findings: [], limitations: [
      { filePath: 'package/index.js', code: 'LINE_MAPPING_UNMAPPED' },
      { filePath: 'package/index.js', code: 'RISK_CAPABILITY_NOT_REANALYZED' },
    ] };
    const decision = evaluateTier3Escalation({ tier1Results: [], tier1Evidences: [], tier2Handoff: noFindings, restore: restored });
    expect(decision.shouldEscalate).toBe(false);
    expect(decision.reasons).toEqual(['HIGH_CONFIDENCE_STATIC']);

    restored.restored[0]!.limitations.push('DYNAMIC_DECODE_UNRESOLVED');
    expect(evaluateTier3Escalation({ tier1Results: [], tier1Evidences: [], tier2Handoff: noFindings, restore: restored }).reasons)
      .toContain('UNRESOLVED_OBFUSCATION');
  });

  it('detects disagreement and unknown patterns instead of applying a blanket suspicious rule', () => {
    const disagreement = evaluateTier3Escalation({
      tier1Results: [
        result('custom-rule', [finding('custom-rule', 'custom.process', 'UNKNOWN')]),
        result('guarddog', [finding('guarddog', 'guarddog.network', 'THREAT_INDICATOR')]),
      ],
      tier1Evidences: [evidence('CHILD_PROCESS')],
    });
    expect(disagreement.reasons).toContain('ANALYZER_DISAGREEMENT');

    const unknown = evaluateTier3Escalation({
      tier1Results: [result('guarddog', [finding('guarddog', 'guarddog.unknown')])],
      tier1Evidences: [],
      tier2Handoff: handoff([]),
    });
    expect(unknown.reasons).toContain('UNKNOWN_PATTERN');
  });

  it('supports conservative, balanced, and LLM-minimal routing profiles', () => {
    const input = {
      tier1Results: [result('custom-rule', [finding('custom-rule', 'custom.process')])],
      tier1Evidences: [evidence('CHILD_PROCESS'), evidence('NETWORK_EGRESS')],
      tier2Handoff: handoff([evidence('CHILD_PROCESS', 'TIER2')]),
      restore: restore('RESTORED'),
    };
    expect(evaluateTier3Escalation({ ...input, profile: 'CONSERVATIVE' })).toMatchObject({ profile: 'CONSERVATIVE', shouldEscalate: true });
    expect(evaluateTier3Escalation({ ...input, profile: 'BALANCED' })).toMatchObject({ profile: 'BALANCED', shouldEscalate: false });
    expect(evaluateTier3Escalation({ ...input, profile: 'LLM_MINIMAL' })).toMatchObject({ profile: 'LLM_MINIMAL', shouldEscalate: false });
  });
});
