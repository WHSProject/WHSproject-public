import {
  SCANNER_PERFORMANCE_TARGETS,
  ScannerPerformanceMeasurement,
  compareDetections,
  evaluatePerformanceTargets,
  summarizeDetectionQuality,
  summarizeDurations,
} from '../src/performance/scanner-performance';

describe('Scanner performance measurements', () => {
  it('records stage, analyzer, package, and observed memory measurements', async () => {
    const measurement = new ScannerPerformanceMeasurement(1);

    await measurement.measureStage('REGISTRY', async () => {
      await new Promise((resolve) => setTimeout(resolve, 2));
    });
    await measurement.measureAnalyzer('metadata', async () => {
      await new Promise((resolve) => setTimeout(resolve, 2));
      return { status: 'SUCCESS' };
    });

    const snapshot = measurement.finish();

    expect(snapshot.durationMs).toBeGreaterThanOrEqual(0);
    expect(snapshot.stages).toEqual([
      expect.objectContaining({ stage: 'REGISTRY' }),
    ]);
    expect(snapshot.analyzers).toEqual([
      expect.objectContaining({ analyzer: 'metadata', status: 'SUCCESS' }),
    ]);
    expect(snapshot.memory.start.rssBytes).toBeGreaterThan(0);
    expect(snapshot.memory.peakObserved.rssBytes).toBeGreaterThanOrEqual(
      snapshot.memory.start.rssBytes,
    );
  });

  it('summarizes durations with deterministic nearest-rank percentiles', () => {
    expect(summarizeDurations([30, 10, 20, 40, 50])).toEqual({
      count: 5,
      minMs: 10,
      maxMs: 50,
      p50Ms: 30,
      p95Ms: 50,
      p99Ms: 50,
    });
  });

  it('evaluates the package latency and memory gates', async () => {
    const measurement = new ScannerPerformanceMeasurement();
    const snapshot = measurement.finish();
    const evaluation = evaluatePerformanceTargets(
      summarizeDurations([100, 200, 300]),
      snapshot,
    );

    expect(evaluation.passed).toBe(true);
    expect(SCANNER_PERFORMANCE_TARGETS.packageTimeoutMs).toBe(30_000);
  });
});

describe('Scanner detection quality measurements', () => {
  it('calculates precision, recall, F1, and exact match without duplicate inflation', () => {
    expect(compareDetections(
      ['rule-a', 'rule-a', 'rule-b'],
      ['rule-a', 'rule-c', 'rule-c'],
      ['rule-a', 'rule-b', 'rule-c'],
    )).toEqual({
      truePositive: 1,
      falsePositive: 1,
      falseNegative: 1,
      trueNegative: 0,
      precision: 0.5,
      recall: 0.5,
      f1: 0.5,
      exactMatch: false,
    });
  });

  it('aggregates a golden corpus by detection identity', () => {
    const universe = ['rule-a', 'rule-b'];
    expect(summarizeDetectionQuality([
      { expected: [], actual: [], universe },
      { expected: ['rule-a'], actual: ['rule-a'], universe },
      { expected: ['rule-a', 'rule-b'], actual: ['rule-a'], universe },
    ])).toMatchObject({
      caseCount: 3,
      truePositive: 2,
      falsePositive: 0,
      falseNegative: 1,
      trueNegative: 3,
      precision: 1,
      recall: 2 / 3,
      exactMatchCount: 2,
      exactMatchRate: 2 / 3,
    });
  });
});
