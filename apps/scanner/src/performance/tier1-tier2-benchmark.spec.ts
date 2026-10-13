import type { AnalyzerResult, Finding } from '../domain/analysis.types';
import type { AtomicEvidenceV0_1 } from '../evidence/normalizer/evidence-normalizer.types';
import { compareTier3GateRuns, evaluateTier1Tier2Benchmark } from './tier1-tier2-benchmark';

const result = (analyzer: string, findings: Finding[] = [], status: AnalyzerResult['status'] = 'SUCCESS'): AnalyzerResult => ({
  requestId: 'request', scanId: 'scan', analyzer, analyzerVersion: 'test', status, findings, errors: [],
});

const finding = (ruleId: string): Finding => ({ findingId: ruleId, ruleId, type: 'CAPABILITY_PATTERN', message: ruleId, data: {} });

const evidence = (): AtomicEvidenceV0_1 => ({
  schemaVersion: '0.1', evidenceId: 'evidence', kind: 'ATOMIC', analysisPass: 'TIER1',
  signal: { id: 'child-process', type: 'CHILD_PROCESS', category: 'EXECUTION' },
  subject: { ecosystem: 'npm', packageName: 'fixture', packageVersion: '1.0.0', artifactHash: 'a'.repeat(64) },
  assertion: { summary: 'process execution', basis: 'PATTERN_MATCH' }, sources: [], locations: [],
  provenance: { scanId: 'scan', generatedBy: 'EVIDENCE_NORMALIZER', observedAt: '2026-01-01T00:00:00.000Z' }, limitations: [],
});

describe('Tier1/Tier2 benchmark aggregation', () => {
  it('reports confusion, routing, explainability and latency metrics from the same rows used by the gate', () => {
    const report = evaluateTier1Tier2Benchmark([
      { sampleId: 'malicious-1', truth: 'MALICIOUS', tier1Results: [result('guarddog', [finding('threat-process-download-exec'), finding('capability-process-spawn')])], tier1Evidences: [evidence()], tier1DurationMs: 10, totalDurationMs: 20 },
      { sampleId: 'benign-1', truth: 'BENIGN', tier1Results: [result('metadata')], tier1Evidences: [], tier1DurationMs: 11, totalDurationMs: 21 },
      { sampleId: 'malicious-2', truth: 'MALICIOUS', tier1Results: [result('guarddog', [finding('guarddog.unknown')])], tier1Evidences: [], tier2Handoff: { findings: [], atomicEvidences: [], limitations: [], findingBindings: [], evidenceBindings: [], artifact: {} as never, artifactRoot: '/tmp' }, tier1DurationMs: 30, tier2DurationMs: 5, totalDurationMs: 40 },
      { sampleId: 'benign-2', truth: 'BENIGN', tier1Results: [result('metadata', [finding('metadata.mismatch')])], tier1Evidences: [evidence()], tier1DurationMs: 12, totalDurationMs: 22 },
    ]);

    expect(report.sampleCount).toBe(4);
    expect(report.confusion).toMatchObject({ truePositive: 1, falsePositive: 0, trueNegative: 2, falseNegative: 1 });
    expect(report.tier2EntryRate).toBe(0.25);
    expect(report.tier3EscalationRate).toBe(0.25);
    expect(report.latencyMs).toEqual(expect.objectContaining({ tier1P50: 11, tier1P95: 30, totalP50: 21, totalP95: 40 }));
    expect(report.rows.find((row) => row.sampleId === 'malicious-2')?.escalationReasons).toContain('UNKNOWN_PATTERN');
  });

  it('compares the legacy route with the gated route without changing detection metrics', () => {
    const samples = [
      { sampleId: 'malicious', truth: 'MALICIOUS' as const, tier1Results: [result('custom-rule', [finding('custom.process')])], tier1Evidences: [evidence()], tier2Handoff: { findings: [], atomicEvidences: [], limitations: [], findingBindings: [], evidenceBindings: [], artifact: {} as never, artifactRoot: '/tmp' } },
      { sampleId: 'benign', truth: 'BENIGN' as const, tier1Results: [result('metadata')], tier1Evidences: [] },
    ];
    const before = evaluateTier1Tier2Benchmark(samples, { applyGate: false });
    const after = evaluateTier1Tier2Benchmark(samples);
    expect(compareTier3GateRuns(before, after)).toMatchObject({
      beforeEscalationRate: 0.5,
      afterEscalationRate: 0,
      expectedLlmCallReduction: 0.5,
      detectionMetricsStable: true,
    });
  });
});
