import { performance } from 'node:perf_hooks';

export const SCANNER_PERFORMANCE_TARGETS = {
  packageP50Ms: 5_000,
  packageP95Ms: 15_000,
  packageP99Ms: 25_000,
  packageTimeoutMs: 30_000,
  heapGrowthBytes: 64 * 1024 * 1024,
  rssGrowthBytes: 256 * 1024 * 1024,
} as const;

export type ScannerStage =
  | 'REGISTRY'
  | 'DOWNLOAD'
  | 'EXTRACT'
  | 'HASH'
  | 'IDENTITY'
  | 'ANALYZER'
  | 'OBFUSCATION'
  | 'NORMALIZATION';

export interface MemoryUsageSample {
  rssBytes: number;
  heapUsedBytes: number;
  externalBytes: number;
  arrayBuffersBytes: number;
}

export interface StagePerformanceMeasurement {
  stage: ScannerStage;
  durationMs: number;
}

export interface AnalyzerPerformanceMeasurement {
  analyzer: string;
  durationMs: number;
  status?: string;
}

export interface ScannerPerformanceSnapshot {
  startedAt: string;
  completedAt: string;
  durationMs: number;
  stages: StagePerformanceMeasurement[];
  analyzers: AnalyzerPerformanceMeasurement[];
  memory: {
    start: MemoryUsageSample;
    end: MemoryUsageSample;
    peakObserved: MemoryUsageSample;
    heapGrowthBytes: number;
    rssGrowthBytes: number;
  };
}

export interface DurationSummary {
  count: number;
  minMs: number;
  maxMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
}

export interface DetectionQuality {
  truePositive: number;
  falsePositive: number;
  falseNegative: number;
  trueNegative: number;
  precision: number;
  recall: number;
  f1: number;
  exactMatch: boolean;
}

export interface DetectionQualityCase {
  expected: readonly string[];
  actual: readonly string[];
  universe?: readonly string[];
}

export interface DetectionQualitySummary extends Omit<DetectionQuality, 'exactMatch'> {
  caseCount: number;
  exactMatchCount: number;
  exactMatchRate: number;
}

export interface PerformanceTargetEvaluation {
  package: {
    p50WithinTarget: boolean;
    p95WithinTarget: boolean;
    p99WithinTarget: boolean;
    withinTimeout: boolean;
  };
  memory: {
    heapWithinTarget: boolean;
    rssWithinTarget: boolean;
  };
  passed: boolean;
}

export class ScannerPerformanceMeasurement {
  private readonly startedAt = new Date().toISOString();
  private readonly startedAtClock = performance.now();
  private readonly startMemory = readMemoryUsage();
  private peakMemory = this.startMemory;
  private readonly stages: StagePerformanceMeasurement[] = [];
  private readonly analyzers: AnalyzerPerformanceMeasurement[] = [];
  private readonly sampler: ReturnType<typeof setInterval>;

  constructor(private readonly sampleIntervalMs = 20) {
    if (!Number.isSafeInteger(sampleIntervalMs) || sampleIntervalMs <= 0) {
      throw new Error('Performance sample interval must be a positive integer');
    }
    this.sampler = setInterval(() => this.sampleMemory(), sampleIntervalMs);
    this.sampler.unref?.();
  }

  async measureStage<T>(stage: ScannerStage, operation: () => T | Promise<T>): Promise<T> {
    const startedAt = performance.now();
    this.sampleMemory();
    try {
      return await operation();
    } finally {
      this.sampleMemory();
      this.stages.push({ stage, durationMs: elapsedMs(startedAt) });
    }
  }

  async measureAnalyzer<T extends { status?: string }>(
    analyzer: string,
    operation: () => T | Promise<T>,
  ): Promise<T> {
    const startedAt = performance.now();
    this.sampleMemory();
    try {
      const result = await operation();
      this.analyzers.push({
        analyzer,
        durationMs: elapsedMs(startedAt),
        ...(result.status === undefined ? {} : { status: result.status }),
      });
      return result;
    } catch (error) {
      this.analyzers.push({ analyzer, durationMs: elapsedMs(startedAt) });
      throw error;
    } finally {
      this.sampleMemory();
    }
  }

  finish(): ScannerPerformanceSnapshot {
    clearInterval(this.sampler);
    const endMemory = this.sampleMemory();
    const completedAt = new Date().toISOString();
    return {
      startedAt: this.startedAt,
      completedAt,
      durationMs: Math.max(0, performance.now() - this.startedAtClock),
      stages: [...this.stages],
      analyzers: [...this.analyzers],
      memory: {
        start: this.startMemory,
        end: endMemory,
        peakObserved: this.peakMemory,
        heapGrowthBytes: endMemory.heapUsedBytes - this.startMemory.heapUsedBytes,
        rssGrowthBytes: endMemory.rssBytes - this.startMemory.rssBytes,
      },
    };
  }

  private sampleMemory(): MemoryUsageSample {
    const sample = readMemoryUsage();
    this.peakMemory = peakMemory(this.peakMemory, sample);
    return sample;
  }
}

export function summarizeDurations(durationsMs: readonly number[]): DurationSummary {
  if (durationsMs.length === 0) {
    throw new Error('At least one duration is required');
  }
  const sorted = [...durationsMs].sort((left, right) => left - right);
  return {
    count: sorted.length,
    minMs: sorted[0]!,
    maxMs: sorted[sorted.length - 1]!,
    p50Ms: percentile(sorted, 50),
    p95Ms: percentile(sorted, 95),
    p99Ms: percentile(sorted, 99),
  };
}

export function compareDetections(
  expected: readonly string[],
  actual: readonly string[],
  universe: readonly string[] = [],
): DetectionQuality {
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  const universeSet = new Set(universe);
  const truePositive = [...expectedSet].filter((value) => actualSet.has(value)).length;
  const falseNegative = [...expectedSet].filter((value) => !actualSet.has(value)).length;
  const falsePositive = [...actualSet].filter((value) => !expectedSet.has(value)).length;
  const trueNegative = [...universeSet].filter(
    (value) => !expectedSet.has(value) && !actualSet.has(value),
  ).length;
  const precision = ratio(truePositive, truePositive + falsePositive);
  const recall = ratio(truePositive, truePositive + falseNegative);

  return {
    truePositive,
    falsePositive,
    falseNegative,
    trueNegative,
    precision,
    recall,
    f1: ratio(2 * precision * recall, precision + recall),
    exactMatch: setsEqual(expectedSet, actualSet),
  };
}

export function summarizeDetectionQuality(
  cases: readonly DetectionQualityCase[],
): DetectionQualitySummary {
  if (cases.length === 0) throw new Error('At least one detection case is required');
  const results = cases.map(({ expected, actual, universe }) =>
    compareDetections(expected, actual, universe));
  const totals = results.reduce((summary, result) => ({
    truePositive: summary.truePositive + result.truePositive,
    falsePositive: summary.falsePositive + result.falsePositive,
    falseNegative: summary.falseNegative + result.falseNegative,
    trueNegative: summary.trueNegative + result.trueNegative,
  }), { truePositive: 0, falsePositive: 0, falseNegative: 0, trueNegative: 0 });
  const precision = ratio(totals.truePositive, totals.truePositive + totals.falsePositive);
  const recall = ratio(totals.truePositive, totals.truePositive + totals.falseNegative);
  const exactMatchCount = results.filter(({ exactMatch }) => exactMatch).length;

  return {
    ...totals,
    precision,
    recall,
    f1: ratio(2 * precision * recall, precision + recall),
    caseCount: cases.length,
    exactMatchCount,
    exactMatchRate: exactMatchCount / cases.length,
  };
}

export function evaluatePerformanceTargets(
  durationSummary: DurationSummary,
  snapshot: ScannerPerformanceSnapshot,
  timeoutMs = SCANNER_PERFORMANCE_TARGETS.packageTimeoutMs,
): PerformanceTargetEvaluation {
  const evaluation = {
    package: {
      p50WithinTarget: durationSummary.p50Ms <= SCANNER_PERFORMANCE_TARGETS.packageP50Ms,
      p95WithinTarget: durationSummary.p95Ms <= SCANNER_PERFORMANCE_TARGETS.packageP95Ms,
      p99WithinTarget: durationSummary.p99Ms <= SCANNER_PERFORMANCE_TARGETS.packageP99Ms,
      withinTimeout: snapshot.durationMs <= timeoutMs,
    },
    memory: {
      heapWithinTarget:
        snapshot.memory.heapGrowthBytes <= SCANNER_PERFORMANCE_TARGETS.heapGrowthBytes,
      rssWithinTarget:
        snapshot.memory.rssGrowthBytes <= SCANNER_PERFORMANCE_TARGETS.rssGrowthBytes,
    },
  };
  return {
    ...evaluation,
    passed: Object.values(evaluation.package).every(Boolean)
      && Object.values(evaluation.memory).every(Boolean),
  };
}

function readMemoryUsage(): MemoryUsageSample {
  const usage = process.memoryUsage();
  return {
    rssBytes: usage.rss,
    heapUsedBytes: usage.heapUsed,
    externalBytes: usage.external,
    arrayBuffersBytes: usage.arrayBuffers,
  };
}

function peakMemory(left: MemoryUsageSample, right: MemoryUsageSample): MemoryUsageSample {
  return {
    rssBytes: Math.max(left.rssBytes, right.rssBytes),
    heapUsedBytes: Math.max(left.heapUsedBytes, right.heapUsedBytes),
    externalBytes: Math.max(left.externalBytes, right.externalBytes),
    arrayBuffersBytes: Math.max(left.arrayBuffersBytes, right.arrayBuffersBytes),
  };
}

function elapsedMs(startedAt: number): number {
  return Math.max(0, performance.now() - startedAt);
}

function percentile(sorted: readonly number[], percentileValue: number): number {
  const index = Math.max(0, Math.ceil((percentileValue / 100) * sorted.length) - 1);
  return sorted[index]!;
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : numerator / denominator;
}

function setsEqual(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}
