import type { AnalyzerResult } from '../domain/analysis.types';
import type { AtomicEvidenceV0_1 } from '../evidence/normalizer/evidence-normalizer.types';
import type { Tier2Handoff } from '../llm-agent/artifact/tier2-handoff.contract';
import { evaluateTier3Escalation } from '../llm-agent/tier3-escalation-gate';
import type { Tier3EscalationDecision, Tier3GateProfile } from '../llm-agent/tier3-escalation-gate.contract';
import type { RestoreResult } from '../analyzers/obfuscation/obfuscation.types';
import { assessTier1Risk } from './tier1-risk-weighting';

export type BenchmarkTruth = 'BENIGN' | 'MALICIOUS';

export interface Tier1Tier2BenchmarkSample {
  sampleId: string;
  truth: BenchmarkTruth;
  tier1Results: readonly AnalyzerResult[];
  tier1Evidences: readonly AtomicEvidenceV0_1[];
  tier2Handoff?: Tier2Handoff;
  restore?: RestoreResult;
  tier1DurationMs?: number;
  tier2DurationMs?: number;
  totalDurationMs?: number;
  gateProfile?: Tier3GateProfile;
}

export interface ConfusionMatrix {
  truePositive: number;
  falsePositive: number;
  trueNegative: number;
  falseNegative: number;
  precision: number | null;
  recall: number | null;
  f1: number | null;
  falsePositiveRate: number | null;
  falseNegativeRate: number | null;
}

export interface Tier1Tier2BenchmarkRow {
  sampleId: string;
  truth: BenchmarkTruth;
  predictedMalicious: boolean;
  tier1Completed: boolean;
  tier1FindingCount: number;
  tier2FindingCount: number;
  tier2Entered: boolean;
  explainableWithoutTier3: boolean;
  tier3Escalated: boolean;
  escalationReasons: Tier3EscalationDecision['reasons'];
  tier1DurationMs: number | null;
  tier2DurationMs: number | null;
  totalDurationMs: number | null;
}

export interface Tier1Tier2BenchmarkReport {
  sampleCount: number;
  gateApplied: boolean;
  rows: Tier1Tier2BenchmarkRow[];
  confusion: ConfusionMatrix;
  tier1CompletionRate: number | null;
  tier2EntryRate: number | null;
  explainableWithoutTier3Rate: number | null;
  tier3EscalationRate: number | null;
  latencyMs: {
    tier1P50: number | null;
    tier1P95: number | null;
    tier2P50: number | null;
    tier2P95: number | null;
    totalP50: number | null;
    totalP95: number | null;
  };
}

export interface Tier3GateComparison {
  beforeEscalationRate: number | null;
  afterEscalationRate: number | null;
  escalationRateDelta: number | null;
  expectedLlmCallReduction: number | null;
  beforeTotalP95Ms: number | null;
  afterTotalP95Ms: number | null;
  totalP95DeltaMs: number | null;
  detectionMetricsStable: boolean;
}

export interface Tier1Tier2BenchmarkOptions {
  applyGate?: boolean;
}

/** Evaluates a fixed dataset without invoking any provider or external process. */
export function evaluateTier1Tier2Benchmark(
  samples: readonly Tier1Tier2BenchmarkSample[],
  options: Tier1Tier2BenchmarkOptions = {},
): Tier1Tier2BenchmarkReport {
  const gateApplied = options.applyGate !== false;
  const rows = samples.map((sample) => {
    const decision = gateApplied
      ? evaluateTier3Escalation({
        tier1Results: sample.tier1Results,
        tier1Evidences: sample.tier1Evidences,
        ...(sample.tier2Handoff === undefined ? {} : { tier2Handoff: sample.tier2Handoff }),
        ...(sample.restore === undefined ? {} : { restore: sample.restore }),
        ...(sample.gateProfile === undefined ? {} : { profile: sample.gateProfile }),
      })
      : undefined;
    const tier1FindingCount = sample.tier1Results.reduce((sum, result) => sum + result.findings.length, 0);
    const tier2FindingCount = sample.tier2Handoff?.findings.length ?? 0;
    const tier1Risk = assessTier1Risk({
      findings: [
        ...sample.tier1Results.flatMap((result) => result.findings),
        ...(sample.tier2Handoff?.findings ?? []).map((finding) => ({ ruleId: finding.ruleId, type: finding.kind })),
      ],
      evidences: [
        ...sample.tier1Evidences,
        ...(sample.tier2Handoff?.atomicEvidences ?? []),
      ],
    });
    return {
      sampleId: sample.sampleId,
      truth: sample.truth,
      predictedMalicious: tier1Risk.malicious,
      tier1Completed: sample.tier1Results.every((result) => result.status !== 'FAILED' && result.status !== 'TIMEOUT'),
      tier1FindingCount,
      tier2FindingCount,
      tier2Entered: sample.tier2Handoff !== undefined,
      explainableWithoutTier3: gateApplied ? !decision?.shouldEscalate : sample.tier2Handoff === undefined,
      tier3Escalated: gateApplied ? decision?.shouldEscalate === true : sample.tier2Handoff !== undefined,
      escalationReasons: decision?.reasons ?? [],
      tier1DurationMs: sample.tier1DurationMs ?? null,
      tier2DurationMs: sample.tier2DurationMs ?? null,
      totalDurationMs: sample.totalDurationMs ?? null,
    } satisfies Tier1Tier2BenchmarkRow;
  });
  const confusion = buildConfusion(rows);
  const count = rows.length;
  return {
    sampleCount: count,
    gateApplied,
    rows,
    confusion,
    tier1CompletionRate: rate(rows.filter((row) => row.tier1Completed).length, count),
    tier2EntryRate: rate(rows.filter((row) => row.tier2Entered).length, count),
    explainableWithoutTier3Rate: rate(rows.filter((row) => row.explainableWithoutTier3).length, count),
    tier3EscalationRate: rate(rows.filter((row) => row.tier3Escalated).length, count),
    latencyMs: {
      tier1P50: percentile(rows.map((row) => row.tier1DurationMs).filter(isNumber), 0.5),
      tier1P95: percentile(rows.map((row) => row.tier1DurationMs).filter(isNumber), 0.95),
      tier2P50: percentile(rows.map((row) => row.tier2DurationMs).filter(isNumber), 0.5),
      tier2P95: percentile(rows.map((row) => row.tier2DurationMs).filter(isNumber), 0.95),
      totalP50: percentile(rows.map((row) => row.totalDurationMs).filter(isNumber), 0.5),
      totalP95: percentile(rows.map((row) => row.totalDurationMs).filter(isNumber), 0.95),
    },
  };
}

export function compareTier3GateRuns(
  before: Tier1Tier2BenchmarkReport,
  after: Tier1Tier2BenchmarkReport,
): Tier3GateComparison {
  const beforeRate = before.tier3EscalationRate;
  const afterRate = after.tier3EscalationRate;
  return {
    beforeEscalationRate: beforeRate,
    afterEscalationRate: afterRate,
    escalationRateDelta: beforeRate === null || afterRate === null ? null : afterRate - beforeRate,
    expectedLlmCallReduction: beforeRate === null || afterRate === null ? null : beforeRate - afterRate,
    beforeTotalP95Ms: before.latencyMs.totalP95,
    afterTotalP95Ms: after.latencyMs.totalP95,
    totalP95DeltaMs: before.latencyMs.totalP95 === null || after.latencyMs.totalP95 === null
      ? null
      : after.latencyMs.totalP95 - before.latencyMs.totalP95,
    detectionMetricsStable: JSON.stringify(before.confusion) === JSON.stringify(after.confusion),
  };
}

function buildConfusion(rows: readonly Tier1Tier2BenchmarkRow[]): ConfusionMatrix {
  const truePositive = rows.filter((row) => row.truth === 'MALICIOUS' && row.predictedMalicious).length;
  const falsePositive = rows.filter((row) => row.truth === 'BENIGN' && row.predictedMalicious).length;
  const trueNegative = rows.filter((row) => row.truth === 'BENIGN' && !row.predictedMalicious).length;
  const falseNegative = rows.filter((row) => row.truth === 'MALICIOUS' && !row.predictedMalicious).length;
  const precision = ratio(truePositive, truePositive + falsePositive);
  const recall = ratio(truePositive, truePositive + falseNegative);
  return {
    truePositive,
    falsePositive,
    trueNegative,
    falseNegative,
    precision,
    recall,
    f1: precision === null || recall === null || precision + recall === 0 ? null : 2 * precision * recall / (precision + recall),
    falsePositiveRate: ratio(falsePositive, falsePositive + trueNegative),
    falseNegativeRate: ratio(falseNegative, falseNegative + truePositive),
  };
}

function rate(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function percentile(values: readonly number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? null;
}

function isNumber(value: number | null): value is number {
  return value !== null && Number.isFinite(value);
}
