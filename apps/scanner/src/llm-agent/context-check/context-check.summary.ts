import type {
  ContextCheckRecord, ContextRecheckRecord, ContextState, ContextWitnessPath, ProgramIndexRecord, RecheckOutcome,
} from './context-check.contract';

/** Counts of one check for the scan's Shadow record: what was asked, answered and added. Holds no code, paths or findings. */
export interface ContextCheckSummary {
  status: ContextCheckRecord['status'];
  groupCount: number;
  questionCount: number;
  states: Record<ContextState, number>;
  omittedQuestionCount: number;
  skippedGroupCount: number;
  addedTargetCount: number;
  addedSliceCount: number;
  addedLineCount: number;
  executionPathStatementCount: number;
  unresolvedContextCount: number;
  /** Whole-package index: whether it was built, how much it covered, and how many Findings it tied to what runs the package. */
  programIndexStatus?: ProgramIndexRecord['status'];
  indexedFileCount?: number;
  parseFailureCount?: number;
  programIndexLimits?: string[];
  confirmedTriggerPathCount?: number;
  completeInputFlowCount?: number;
  /** Paths with one probable step that the model's answer settled, paths cut at a depth limit, and paths with more probable steps than may be settled. */
  conditionallyResolvedCount?: number;
  depthLimitedCount?: number;
  probableEdgeLimitedCount?: number;
  /** Witness paths of all contexts: how many were built, were complete, were added whole, and why the rest were not added. */
  witnessPathCount?: number;
  completeWitnessPathCount?: number;
  addedWitnessPathCount?: number;
  witnessPathFailures?: Record<string, number>;
  /** Why paths that were offered for selection were not added. */
  witnessPathExclusions?: Record<string, number>;
  /** The second call: what was asked again, what it changed and what it cost. Absent when it is off. */
  recheckQuestionCount?: number;
  recheckCallCount?: number;
  /** Provider calls whose failure was specifically the configured timeout, not another transport error. */
  recheckTimeoutCount?: number;
  recheckOutcomes?: Record<RecheckOutcome, number>;
  /** Share of the questions asked again whose answer became VISIBLE. */
  recheckResolvedRate?: number;
  /** Contexts Scanner settled that were asked again for the record, and how many of them the second answer rated VISIBLE. */
  scannerSettledChecked?: number;
  scannerSettledAgreed?: number;
  recheckLatencyMs?: number;
  recheckInputTokens?: number;
  recheckOutputTokens?: number;
  /** Time and tokens of the second call per context it resolved; absent when it resolved none. */
  recheckMsPerResolved?: number;
  recheckTokensPerResolved?: number;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  /** Initial and recheck provider calls that hit the configured deadline. */
  providerTimeoutCount?: number;
  failureReason?: string;
}

function witnessPathCounts(paths: readonly ContextWitnessPath[]): Pick<ContextCheckSummary,
  'witnessPathCount' | 'completeWitnessPathCount' | 'addedWitnessPathCount' | 'witnessPathFailures' | 'witnessPathExclusions'> {
  const failures: Record<string, number> = {};
  const exclusions: Record<string, number> = {};
  for (const path of paths) {
    if (path.failureReason !== undefined) failures[path.failureReason] = (failures[path.failureReason] ?? 0) + 1;
    if (path.exclusionReason !== undefined) exclusions[path.exclusionReason] = (exclusions[path.exclusionReason] ?? 0) + 1;
  }
  return {
    witnessPathCount: paths.length, completeWitnessPathCount: paths.filter((path) => path.complete).length,
    addedWitnessPathCount: paths.filter((path) => path.outcome === 'ADDED').length, witnessPathFailures: failures, witnessPathExclusions: exclusions,
  };
}

function witnessCounts(record: ContextCheckRecord): Pick<ContextCheckSummary, 'conditionallyResolvedCount' | 'depthLimitedCount' | 'probableEdgeLimitedCount'> {
  const witnesses = [
    ...record.executionEvidence.flatMap((group) => group.findings.flatMap((finding) => (finding.reach ? [finding.reach] : []))),
    ...(record.inputWitnesses ?? []),
  ];
  return {
    conditionallyResolvedCount: witnesses.filter((item) => item.conditional.resolved).length,
    depthLimitedCount: witnesses.filter((item) => item.limits.includes('DEPTH_LIMIT')).length,
    probableEdgeLimitedCount: witnesses.filter((item) => item.limits.includes('PROBABLE_EDGE_LIMIT')).length,
  };
}

function recheckCounts(recheck: ContextRecheckRecord): Partial<ContextCheckSummary> {
  const outcomes: Record<RecheckOutcome, number> = { RESOLVED: 0, UNRESOLVED: 0, IMPROVED_UNRESOLVED: 0, REGRESSED: 0, RECHECK_UNAVAILABLE: 0 };
  for (const question of recheck.questions) outcomes[question.outcome] += 1;
  const tokens = (recheck.usage.inputTokens ?? 0) + (recheck.usage.outputTokens ?? 0);
  return {
    recheckQuestionCount: recheck.questions.length, recheckCallCount: recheck.callCount, recheckOutcomes: outcomes,
    recheckTimeoutCount: recheck.timeoutCallCount ?? 0,
    recheckResolvedRate: recheck.questions.length === 0 ? 0 : outcomes.RESOLVED / recheck.questions.length,
    recheckLatencyMs: recheck.latencyMs, recheckInputTokens: recheck.usage.inputTokens ?? 0, recheckOutputTokens: recheck.usage.outputTokens ?? 0,
    scannerSettledChecked: recheck.scannerSettled?.length ?? 0, scannerSettledAgreed: recheck.scannerSettled?.filter((item) => item.agreed).length ?? 0,
    ...(outcomes.RESOLVED === 0 ? {} : { recheckMsPerResolved: recheck.latencyMs / outcomes.RESOLVED, recheckTokensPerResolved: tokens / outcomes.RESOLVED }),
  };
}

export function summarizeContextCheck(record: ContextCheckRecord): ContextCheckSummary {
  const states: Record<ContextState, number> = { VISIBLE: 0, PARTIAL: 0, MISSING: 0 };
  for (const item of record.states) states[item.state] += 1;
  const providerTimeoutCount = (record.failureReason === 'TIMEOUT' ? 1 : 0) + (record.recheck?.timeoutCallCount ?? 0);
  return {
    status: record.status, groupCount: record.groupCount, questionCount: record.states.length, states,
    omittedQuestionCount: record.omittedQuestions.length, skippedGroupCount: record.skippedGroups.length,
    addedTargetCount: record.addedTargetCount, addedSliceCount: record.addedSliceCount, addedLineCount: record.addedLineCount,
    executionPathStatementCount: record.executionPathStatements.length, unresolvedContextCount: record.unresolvedContextCount,
    ...(record.programIndex === undefined ? {} : {
      programIndexStatus: record.programIndex.status, indexedFileCount: record.programIndex.parsedFileCount, parseFailureCount: record.programIndex.parseFailureCount,
      programIndexLimits: [...record.programIndex.appliedLimits],
      confirmedTriggerPathCount: record.executionEvidence.reduce((sum, group) => sum + group.findings.filter((finding) => finding.reach?.status === 'CONFIRMED').length, 0),
      completeInputFlowCount: (record.inputWitnesses ?? []).filter((item) => item.status === 'COMPLETE').length,
      ...witnessCounts(record),
      ...witnessPathCounts(record.witnessPaths ?? []),
    }),
    ...(record.recheck === undefined ? {} : recheckCounts(record.recheck)),
    ...(record.model === undefined ? {} : { model: record.model }),
    ...(record.usage?.inputTokens === undefined ? {} : { inputTokens: record.usage.inputTokens }),
    ...(record.usage?.outputTokens === undefined ? {} : { outputTokens: record.usage.outputTokens }),
    ...(providerTimeoutCount === 0 ? {} : { providerTimeoutCount }),
    ...(record.failureReason === undefined ? {} : { failureReason: record.failureReason }),
  };
}

export function emptyRecord(status: ContextCheckRecord['status'], groupCount = 0): ContextCheckRecord {
  return {
    status, groupCount, states: [], addedTargetCount: 0, addedSliceCount: 0, addedLineCount: 0, unresolvedContextCount: 0,
    skippedGroups: [], preservedReasons: [], restorationStatus: [], omittedQuestions: [], executionEvidence: [], executionPathStatements: [],
  };
}
