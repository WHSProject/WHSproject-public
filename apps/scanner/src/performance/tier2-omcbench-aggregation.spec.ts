import type { RestoreResult, SelectionResult } from '../analyzers/obfuscation/obfuscation.types';
import {
  aggregateGroup,
  buildCandidateReports,
  percentileOrNull,
  summarizeRestoration,
  summarizeRestoreDiagnostics,
  validateBenchmarkDataset,
} from './tier2-omcbench-aggregation';

describe('Tier 2 OMC benchmark aggregation', () => {
  it('reports unresolved reasons, failed stages and timing without raw parser details', () => {
    const restoration: RestoreResult = {
      outputRoot: '/private/derived', restored: [], durationMs: 12, budgetExceeded: false,
      unresolved: [{
        path: 'index.js', status: 'FAILED', reason: 'TOOL_TIMEOUT', durationMs: 10,
        limitations: ['TOOL_TIMEOUT'], detail: 'raw parser text',
        stageResults: [
          { stage: 'STRUCTURE', status: 'FAILED', applied: false, changed: false, reason: 'webcrack timeout', detail: 'raw tool details' },
          { stage: 'STRING', status: 'NO_CHANGE', applied: false, changed: false },
        ],
      }],
    };
    const report = summarizeRestoreDiagnostics(restoration);
    expect(report.files[0]).toEqual({
      path: 'index.js', status: 'FAILED', reason: 'TOOL_TIMEOUT', durationMs: 10,
      limitations: ['TOOL_TIMEOUT'], failedStages: ['STRUCTURE'],
      stageResults: [
        { stage: 'STRUCTURE', status: 'FAILED', applied: false, changed: false, reason: 'webcrack timeout' },
        { stage: 'STRING', status: 'NO_CHANGE', applied: false, changed: false, reason: null },
      ],
    });
    expect(report.reasonCounts).toEqual({ TOOL_TIMEOUT: 1 });
    expect(report.durationMs).toBe(12);
    expect(JSON.stringify(report)).not.toContain('raw');
    expect(JSON.stringify(report)).not.toContain('/private/derived');
  });

  it('distinguishes missing historic timing from measured zero and preserves no-transform status', () => {
    const restoration: RestoreResult = {
      outputRoot: 'derived', restored: [], durationMs: 4, budgetExceeded: true,
      unresolved: [
        { path: 'legacy.js', status: 'UNRESOLVED', reason: 'NO_SUPPORTED_TRANSFORM', limitations: [], stageResults: [] },
        { path: 'skipped.js', status: 'FAILED', reason: 'BUDGET_EXCEEDED', durationMs: 0, limitations: ['BUDGET_EXCEEDED'], stageResults: [] },
      ],
    };
    const report = summarizeRestoreDiagnostics(restoration);
    expect(report.files.map(({ durationMs }) => durationMs)).toEqual([null, 0]);
    expect(report.files[0]).toMatchObject({ status: 'UNRESOLVED', failedStages: [] });
    expect(report.budgetExceeded).toBe(true);
    expect(report.statusCounts).toMatchObject({ UNRESOLVED: 1, FAILED: 1 });
  });

  it('retains partial restorations as well as unresolved results', () => {
    const restoration = {
      outputRoot: 'derived', durationMs: 5, budgetExceeded: false,
      restored: [{
        path: 'partial.js', status: 'PARTIAL_RESTORED', reason: 'PARTIAL_STAGE_FAILURE', durationMs: 3,
        limitations: ['STRUCTURE_STAGE_FAILED'],
        stageResults: [{ stage: 'STRUCTURE', status: 'UNAVAILABLE', applied: false, changed: false }],
      }],
      unresolved: [],
    } as unknown as RestoreResult;
    const report = summarizeRestoreDiagnostics(restoration);
    expect(report.statusCounts.PARTIAL_RESTORED).toBe(1);
    expect(report.files[0]).toMatchObject({ status: 'PARTIAL_RESTORED', durationMs: 3, failedStages: ['STRUCTURE'] });
  });

  it('leaves invalid timing unknown and does not invent files for an empty selection', () => {
    const restoration: RestoreResult = { outputRoot: 'derived', durationMs: Number.NaN, budgetExceeded: false, restored: [], unresolved: [] };
    expect(summarizeRestoreDiagnostics(restoration)).toMatchObject({ durationMs: null, files: [], reasonCounts: {} });
    restoration.unresolved.push({ path: 'bad.js', status: 'FAILED', reason: 'SOURCE_READ_FAILED', limitations: [], stageResults: [], durationMs: -1 });
    expect(summarizeRestoreDiagnostics(restoration).files[0]?.durationMs).toBeNull();
  });

  it('keeps restore statuses, reasons, candidate evidence, and validation details', () => {
    const selection = {
      verdicts: [],
      targets: [{
        path: 'package/index.js',
        candidateReasons: ['DYNAMIC_EXECUTION_WITH_ENCODED_LITERAL'],
        supportingSignals: ['DYNAMIC_EVAL', 'BASE64_DECODE'],
      }],
      skipped: [{ path: 'package/large.js', reason: 'SIZE_LIMIT' }],
      scannedFiles: 2,
      scanLimitHit: false,
    } as unknown as SelectionResult;
    const restoration = {
      outputRoot: 'derived/obfuscation',
      restored: [],
      unresolved: [{
        path: 'package/index.js',
        status: 'FAILED',
        reason: 'PARSE_FAILED',
        limitations: ['ORIGINAL_PARSE_FAILED'],
        stageResults: [],
      }],
      durationMs: 5,
      budgetExceeded: false,
    } as unknown as RestoreResult;

    expect(summarizeRestoration(restoration)).toEqual({
      statusCounts: {
        RESTORED: 0,
        PARTIAL_RESTORED: 0,
        UNRESOLVED: 0,
        SKIPPED: 0,
        FAILED: 1,
      },
      reasonCounts: { PARSE_FAILED: 1 },
    });
    expect(buildCandidateReports(selection, restoration)[0]).toMatchObject({
      path: 'package/index.js',
      candidateReasons: ['DYNAMIC_EXECUTION_WITH_ENCODED_LITERAL'],
      supportingSignals: ['DYNAMIC_EVAL', 'BASE64_DECODE'],
      restoreStatus: 'FAILED',
      reason: 'PARSE_FAILED',
      capabilityStatus: 'NOT_REPORTED',
    });
  });

  it('rejects empty groups and zero scanned files instead of measuring zeros', () => {
    const errors = validateBenchmarkDataset(
      [{ label: 'benign' }],
      [{
        name: 'benign-package',
        label: 'benign',
        status: '완료',
        completed: true,
        scannedFiles: 0,
        candidateFiles: 0,
        skippedLargeFiles: 0,
        scanLimitHit: false,
        durationMs: 1,
      }],
    );

    expect(errors).toEqual([
      'EMPTY_SELECTED_MALICIOUS_GROUP',
      'EMPTY_COMPLETED_MALICIOUS_GROUP',
      'ZERO_SCANNED_FILES',
    ]);
  });

  it('rejects a benchmark with no package cases', () => {
    expect(validateBenchmarkDataset([], [])).toEqual([
      'NO_PACKAGE_CASES',
      'EMPTY_SELECTED_BENIGN_GROUP',
      'EMPTY_COMPLETED_BENIGN_GROUP',
      'EMPTY_SELECTED_MALICIOUS_GROUP',
      'EMPTY_COMPLETED_MALICIOUS_GROUP',
      'ZERO_SCANNED_FILES',
    ]);
  });

  it('does not calculate a candidate rate for an invalid benchmark', () => {
    const summary = aggregateGroup('benign', [{
      name: 'benign-package',
      label: 'benign',
      status: '완료',
      completed: true,
      scannedFiles: 0,
      candidateFiles: 0,
      skippedLargeFiles: 0,
      scanLimitHit: false,
      durationMs: 1,
    }], false);

    expect(summary.benignOrMaliciousCandidatePackageRate).toBeNull();
  });

  it('returns null percentiles for empty samples', () => {
    expect(percentileOrNull([], 0.5)).toBeNull();
    expect(percentileOrNull([10, 30, 20], 0.5)).toBe(20);
  });
});
