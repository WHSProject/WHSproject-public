import type {
  AnalysisContext,
  AnalyzerExecution,
  AnalyzerResult,
} from '../domain/analysis.types';

export type { AnalyzerExecution } from '../domain/analysis.types';

export type AnalyzerResultWithExecution<
  TResult extends AnalyzerResult = AnalyzerResult,
> = TResult & {
  execution: AnalyzerExecution;
};

/**
 * The request identity shared by every analyzer invocation.
 *
 * Analyzer-specific inputs remain separate because the analyzers consume
 * different subsets of AnalysisContext. The full context is assembled by the
 * orchestrator, while this identity is required for every result.
 */
export type AnalyzerContext = Pick<AnalysisContext, 'requestId' | 'scanId'>;

/**
 * Common analyzer entry point. AbortSignal is cooperative: analyzers that
 * cannot interrupt synchronous work must still return a normal result.
 */
export interface Analyzer<
  TInput = AnalysisContext,
  TResult extends AnalyzerResult = AnalyzerResult,
> {
  readonly name: string;
  readonly version: string;
  analyzeResult(
    input: TInput,
    context: AnalyzerContext,
    signal?: AbortSignal,
  ): TResult | Promise<TResult>;
}

/** Adds canonical execution timing without changing analyzer-specific fields. */
export function withAnalyzerExecution<TResult extends AnalyzerResult>(
  result: TResult,
  startedAt: string,
  completedAt: string,
  durationMs: number,
): AnalyzerResultWithExecution<TResult> {
  if (result.execution !== undefined) return result as AnalyzerResultWithExecution<TResult>;
  return {
    ...result,
    execution: {
      startedAt,
      completedAt,
      durationMs: Math.max(0, durationMs),
    },
  } as AnalyzerResultWithExecution<TResult>;
}
