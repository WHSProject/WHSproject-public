import type { CandidateTraceEntry } from './context-check.contract';

/**
 * Local candidate trace for Smoke and Pilot runs, relative to the scanner app
 * root. The directory is git-ignored. Scanner runs and tests never write it;
 * only a script that passes `onCandidateTrace` and calls `formatCandidateTrace`
 * does.
 */
export const CANDIDATE_TRACE_RELATIVE_PATH = 'reports/validation/context-check-candidate-trace.ndjson';

export interface CandidateTraceRun {
  /** Tells the lines of one run apart from those of other runs in the same file. */
  runId: string;
  /** ISO 8601 time the entries were written. */
  recordedAt: string;
}

/**
 * One JSON object per line. Fields are copied by name, so nothing beyond the
 * listed fields (no code, no settings) can reach the file.
 */
export function formatCandidateTrace(entries: readonly CandidateTraceEntry[], run: CandidateTraceRun): string {
  return entries.map((entry) => JSON.stringify({
    runId: run.runId,
    recordedAt: run.recordedAt,
    groupId: entry.groupId,
    context: entry.context,
    depth: entry.depth,
    kind: entry.kind,
    artifactId: entry.artifactId,
    filePath: entry.filePath,
    candidateStartLine: entry.candidateStartLine,
    candidateEndLine: entry.candidateEndLine,
    selectedStartLine: entry.selectedStartLine,
    selectedEndLine: entry.selectedEndLine,
    lineCount: entry.lineCount,
    ...(entry.symbol === undefined ? {} : { symbol: entry.symbol }),
    selected: entry.selected,
    exclusionReason: entry.exclusionReason,
    lowConfidenceMissing: entry.lowConfidenceMissing,
    score: entry.score,
    confidence: entry.confidence,
  })).map((line) => `${line}\n`).join('');
}
