import type {
  FileVerdict,
  RestoreResult,
  SelectionResult,
  ValidationSnapshot,
} from '../analyzers/obfuscation/obfuscation.types';

export const RESTORE_STATUS_KEYS = [
  'RESTORED',
  'PARTIAL_RESTORED',
  'UNRESOLVED',
  'SKIPPED',
  'FAILED',
] as const;

export type RestoreStatusKey = typeof RESTORE_STATUS_KEYS[number];

type RestoreFile = RestoreResult['restored'][number] | RestoreResult['unresolved'][number];

export interface CandidateReport {
  path: string;
  candidateReasons: FileVerdict['candidateReasons'];
  supportingSignals: FileVerdict['supportingSignals'];
  restoreStatus: RestoreStatusKey | 'NOT_RETURNED';
  reason?: string;
  limitations: string[];
  stageResults: RestoreFile['stageResults'];
  validation?: ValidationSnapshot;
  capabilityStatus: ValidationSnapshot['capability']['status'] | 'NOT_REPORTED';
}

export interface RestoreSummary {
  statusCounts: Record<RestoreStatusKey, number>;
  reasonCounts: Record<string, number>;
}

export interface BenchmarkCase {
  name: string;
  label: string;
  status: string;
  completed: boolean;
  scannedFiles: number;
  candidateFiles: number;
  skippedLargeFiles: number;
  scanLimitHit: boolean;
  analysisMs?: number;
  durationMs: number;
  selection?: SelectionResult;
  restoration?: RestoreResult;
  error?: string;
  candidateReports?: CandidateReport[];
}

export interface GroupSummary {
  label: string;
  packages: number;
  withCandidate: number;
  candidateFiles: number;
  scannedFiles: number;
  skippedLargeFiles: number;
  scanLimitPackages: number;
  benignOrMaliciousCandidatePackageRate: number | null;
  analysisDurations: number[];
  durations: number[];
  restore: RestoreSummary;
  selectionSkipped: Record<string, number>;
}

export function summarizeRestoration(restoration: RestoreResult): RestoreSummary {
  const statusCounts = createStatusCounts();
  const reasonCounts: Record<string, number> = {};

  for (const file of [...restoration.restored, ...restoration.unresolved]) {
    statusCounts[file.status] += 1;
    if (file.reason !== undefined) reasonCounts[file.reason] = (reasonCounts[file.reason] ?? 0) + 1;
  }

  return { statusCounts, reasonCounts };
}

/** Compact pilot diagnostics, without source text, raw parser errors or output paths. */
export function summarizeRestoreDiagnostics(restoration: RestoreResult) {
  const duration = (value: number | undefined): number | null => (
    value !== undefined && Number.isFinite(value) && value >= 0 ? value : null
  );
  return {
    durationMs: duration(restoration.durationMs),
    budgetExceeded: restoration.budgetExceeded,
    ...summarizeRestoration(restoration),
    files: [...restoration.restored, ...restoration.unresolved].map((file) => ({
      path: file.path,
      status: file.status,
      reason: file.reason ?? null,
      durationMs: duration(file.durationMs),
      limitations: [...file.limitations],
      failedStages: file.stageResults.filter(({ status }) => status === 'FAILED' || status === 'UNAVAILABLE')
        .map(({ stage }) => stage),
      stageResults: file.stageResults.map(({ stage, applied, status, changed, reason }) => ({
        stage, applied, status, changed, reason: reason ?? null,
      })),
    })),
  };
}

export function summarizeSelection(selection: SelectionResult): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const file of selection.skipped) counts[file.reason] = (counts[file.reason] ?? 0) + 1;
  return counts;
}

export function buildCandidateReports(
  selection: SelectionResult,
  restoration: RestoreResult,
): CandidateReport[] {
  const restoredByPath = new Map<string, RestoreFile>();
  for (const file of [...restoration.restored, ...restoration.unresolved]) {
    restoredByPath.set(file.path, file);
  }

  return selection.targets.map((target) => {
    const restored = restoredByPath.get(target.path);
    return {
      path: target.path,
      candidateReasons: target.candidateReasons,
      supportingSignals: target.supportingSignals,
      restoreStatus: restored?.status ?? 'NOT_RETURNED',
      ...(restored?.reason === undefined ? {} : { reason: restored.reason }),
      limitations: restored?.limitations ?? [],
      stageResults: restored?.stageResults ?? [],
      ...(restored?.validation === undefined ? {} : { validation: restored.validation }),
      capabilityStatus: restored?.validation?.capability.status ?? 'NOT_REPORTED',
    };
  });
}

export function aggregateGroup(
  label: string,
  cases: readonly BenchmarkCase[],
  measured: boolean,
): GroupSummary {
  const group = cases.filter((item) => item.label === label && item.completed);
  const candidatePackages = group.filter((item) => item.candidateFiles > 0).length;
  const restore = mergeRestoreSummaries(group.map((item) => (
    item.restoration === undefined ? emptyRestoreSummary() : summarizeRestoration(item.restoration)
  )));
  const selectionSkipped = mergeCounts(group.map((item) => (
    item.selection === undefined ? {} : summarizeSelection(item.selection)
  )));

  return {
    label,
    packages: group.length,
    withCandidate: candidatePackages,
    candidateFiles: group.reduce((sum, item) => sum + item.candidateFiles, 0),
    scannedFiles: group.reduce((sum, item) => sum + item.scannedFiles, 0),
    skippedLargeFiles: group.reduce((sum, item) => sum + item.skippedLargeFiles, 0),
    scanLimitPackages: group.filter((item) => item.scanLimitHit).length,
    benignOrMaliciousCandidatePackageRate: measured && group.length > 0
      ? candidatePackages / group.length
      : null,
    analysisDurations: group.flatMap((item) => item.analysisMs === undefined ? [] : [item.analysisMs]),
    durations: group.map((item) => item.durationMs),
    restore,
    selectionSkipped,
  };
}

export function validateBenchmarkDataset(
  selectedCases: readonly Pick<BenchmarkCase, 'label'>[],
  completedCases: readonly BenchmarkCase[],
): string[] {
  const errors: string[] = [];
  if (selectedCases.length === 0) errors.push('NO_PACKAGE_CASES');

  for (const label of ['benign', 'malicious']) {
    if (!selectedCases.some((item) => item.label === label)) errors.push(`EMPTY_SELECTED_${label.toUpperCase()}_GROUP`);
    if (!completedCases.some((item) => item.label === label && item.completed)) {
      errors.push(`EMPTY_COMPLETED_${label.toUpperCase()}_GROUP`);
    }
  }

  const scannedFiles = completedCases.reduce((sum, item) => sum + item.scannedFiles, 0);
  if (scannedFiles === 0) errors.push('ZERO_SCANNED_FILES');
  return errors;
}

export function percentileOrNull(values: readonly number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * fraction) - 1] ?? null;
}

function createStatusCounts(): Record<RestoreStatusKey, number> {
  return Object.fromEntries(RESTORE_STATUS_KEYS.map((status) => [status, 0])) as Record<RestoreStatusKey, number>;
}

function emptyRestoreSummary(): RestoreSummary {
  return { statusCounts: createStatusCounts(), reasonCounts: {} };
}

function mergeRestoreSummaries(summaries: readonly RestoreSummary[]): RestoreSummary {
  const merged = emptyRestoreSummary();
  for (const summary of summaries) {
    for (const status of RESTORE_STATUS_KEYS) merged.statusCounts[status] += summary.statusCounts[status];
    merged.reasonCounts = mergeCounts([merged.reasonCounts, summary.reasonCounts]);
  }
  return merged;
}

function mergeCounts(counts: readonly Record<string, number>[]): Record<string, number> {
  return counts.reduce<Record<string, number>>((merged, current) => {
    for (const [key, value] of Object.entries(current)) merged[key] = (merged[key] ?? 0) + value;
    return merged;
  }, {});
}
