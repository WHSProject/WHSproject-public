import type { StaticFilterResult } from '../../application/planning/static-filter.types';
import type { CodeSlicePolicy } from '../agent.contract';
import type { AgentInputV0_3BuildResult } from '../artifact/agent-input-v0_3.builder';
import type { Tier3ExecutionInput } from '../artifact/agent-analysis-input.contract';
import type { AgentCodeSlice } from '../artifact/artifact.contract';
import type { SliceSupplementBudget } from '../artifact/artifact-code-slice.builder';
import { readArtifactSource } from '../artifact/code-slice.factory';
import { validateExpansionCandidates, type CandidateOutcome } from './candidate-validation';
import { emptyRecord, summarizeContextCheck, type ContextCheckSummary } from './context-check.summary';
import { missingContext, routingNotes, triggerStartNotes, withMissingData } from './missing-data';
import { settleConditional } from './conditional-settlement';
import { createWitnessSupport, shownIn, type Shown } from './witness-support';
import {
  artifactFileKey,
  CONTEXT_CHECK_LIMITS,
  CONTEXT_TARGET_ID_PREFIX,
  ContextCheckProviderError,
  questionKey,
  type CandidateTraceEntry,
  type ContextCheckTiming,
  type ContextCheckRecord,
  type ExecutionPathStatementRecord,
  type ExpansionCandidate,
  type GroupExecutionEvidence,
  type ContextCode,
  type ContextWitnessPath,
  type ContextRecheckRecord,
  type InputWitnessRecord,
  type ProgramIndexRecord,
  type TriggerReachRecord,
  type LifecycleTriggerQuestion,
  type TriggerEvidenceMode,
  type ContextCheckProvider,
  type ContextCheckResponse,
  type ContextState,
  type ContextStateRecord,
  type WitnessSupport,
  type FindingGroup,
  type SkippedGroupRecord,
} from './context-check.contract';
import {
  buildContextCheckRequest, estimateRequestChars, explorationClass, planFindingGroups, probableAnswerSettles, witnessAwareContextState,
  type PathStatementCode, type RequestExecutionEvidence,
} from './context-questions';
import { statementUsesOnlyLiterals } from './code-units';
import { executionPathCandidates, resolveExecutionEvidence } from './execution-evidence';
import { resolveTriggerOmissions } from './trigger-omission';
import { candidateKey, generateExpansionCandidates, type UnresolvedContext } from './expansion-candidates';
import { buildActionPaths, flowPath, pathOf } from './program-index/context-witness';
import { selectWitnessPaths, triggerPath, uncovered, type PathRequest } from './witness-selection';
import { runRecheck } from './recheck';
import { findInputWitness } from './program-index/input-witness';
import { symbolHolding } from './program-index/trigger-witness';
import { buildPackageProgramIndex, indexedSource, type PackageProgramIndex } from './program-index/program-index';

export interface ContextCheckInput {
  enabled: boolean;
  provider?: ContextCheckProvider;
  execution: Tier3ExecutionInput;
  /** Input built from the plan as it stands; returned unchanged whenever nothing is expanded. */
  built: AgentInputV0_3BuildResult;
  /**
   * Runs the Slice Builder again for a copy of the plan with expansion targets
   * appended. The appended targets are sliced from `supplement`, not from the
   * regular INITIAL budget, so the slices already built stay as they are.
   */
  rebuild(execution: Tier3ExecutionInput, supplement: SliceSupplementBudget): Promise<AgentInputV0_3BuildResult>;
  policy: CodeSlicePolicy;
  /**
   * Static filter result, when the caller has one. Its diagnostics tie reasons to
   * Findings, and a reason adds contexts only to the groups holding those
   * Findings. Omitted means every group asks its base contexts.
   */
  staticFilter?: Pick<StaticFilterResult, 'diagnostics'>;
  /**
   * Receives what candidate validation did with every candidate, for Smoke and
   * Pilot runs. Diagnostic only: nothing of it reaches the Agent input or the
   * record, and an error thrown here never changes the outcome.
   */
  onCandidateTrace?: (entries: readonly CandidateTraceEntry[]) => void;
  /** Measurement runs only; omitted means `OMIT_WHEN_RUN_AT_LOAD`. */
  lifecycleTriggerQuestion?: LifecycleTriggerQuestion;
  /** Measurement runs only; omitted means `INSTRUCTION_WITH_PATH`. */
  triggerEvidence?: TriggerEvidenceMode;
  /**
   * Whether the whole-package program index is built (default). Without it, and
   * whenever its build fails, the check works file by file as it did before.
   */
  programIndex?: boolean;
  /**
   * Whether the provider is asked once more, with the final slices, about the
   * contexts code was added for. Off unless set: the check then makes one call.
   */
  recheck?: boolean;
  /** Measurement runs only: also ask the second request about what Scanner settled, for the record. */
  recheckVerifyScannerSettled?: boolean;
  /** Measurement runs only. Omitted values preserve the product defaults. */
  measurementLimits?: {
    maxExpansionLines: number;
    maxExpansionTargets: number;
    maxLinesPerCandidate: number;
  };
  signal?: AbortSignal;
}

export { summarizeContextCheck, type ContextCheckSummary };

export interface ContextCheckOutcome { built: AgentInputV0_3BuildResult; record: ContextCheckRecord }

/**
 * Projects validation back to the exact ranges that became real targets. A
 * rejected candidate disappears; a partially selected candidate cannot later
 * masquerade as its original complete range or witness path.
 */
export function acceptedCandidateRanges(
  candidates: readonly ExpansionCandidate[],
  validation: { targets: Array<{ targetId: string; artifactId: string; filePath: string; preferredRange?: { startLine: number; endLine: number } }>; outcomes: readonly CandidateOutcome[] },
): Array<{ candidate: ExpansionCandidate; targetId: string }> {
  const targets = new Map(validation.targets.map((target) => [target.targetId, target]));
  return candidates.flatMap((candidate, position) => {
    const outcome = validation.outcomes[position];
    if (!outcome) return [];
    const ids = [...new Set([...(outcome.targetId ? [outcome.targetId] : []), ...outcome.creditedTargetIds])];
    return ids.flatMap((targetId) => {
      const target = targets.get(targetId);
      const range = target?.preferredRange;
      if (!target || !range) return [];
      const units = candidate.units.filter((unit) => unit.startLine >= range.startLine && unit.endLine <= range.endLine);
      if (units.length === 0) return [];
      return [{
        targetId,
        candidate: { ...candidate, artifactId: target.artifactId, filePath: target.filePath, startLine: range.startLine, endLine: range.endLine, units },
      }];
    });
  });
}

/**
 * Lines the expansion may add: at most one GET_FILE_RANGE request's worth, and
 * only as far as one more such request still fits in the total code budget
 * afterwards. Only lines are set aside; the Agent's call and request limits are
 * not touched.
 */
export function expansionLineBudget(policy: CodeSlicePolicy, currentCodeLines: number): number {
  return Math.min(CONTEXT_CHECK_LIMITS.maxExpansionLines, policy.maxTotalCodeLines - currentCodeLines - policy.maxLinesPerSlice);
}

function stateRecords(
  groups: readonly FindingGroup[], response: ContextCheckResponse,
  support: (groupId: string, context: ContextCode) => WitnessSupport = () => 'PROBABLE',
): ContextStateRecord[] {
  return groups.flatMap((group) => group.contexts.map((context) => {
    const answer = response.answers[questionKey(group.groupId, context)] ?? { score: 0, confidence: 0 };
    return {
      groupId: group.groupId, filePath: group.filePath, behavior: group.behavior, context,
      state: witnessAwareContextState(answer, support(group.groupId, context), context), score: answer.score, confidence: answer.confidence,
    };
  }));
}

/**
 * Groups whose INPUT is still not shown after the expansion. Adding code is not
 * enough: every first-hop INPUT statement has to be in the slices and show a
 * direct source, or call one statically identified function whose complete
 * definition is in the slices and relies on nothing that is not shown.
 */
export function groupsWithUnresolvedInput(
  candidates: readonly ExpansionCandidate[], outcomes: readonly CandidateOutcome[], builtTargetIds: ReadonlySet<string>,
): Set<string> {
  const shown = (index: number) => {
    const outcome = outcomes[index];
    if (!outcome) return false;
    return outcome.alreadySupplied || (outcome.targetId !== null && builtTargetIds.has(outcome.targetId))
      || outcome.creditedTargetIds.some((targetId) => builtTargetIds.has(targetId));
  };
  const unresolved = new Set<string>();
  const groups = new Set(candidates.filter((candidate) => candidate.context === 'INPUT').map((candidate) => candidate.groupId));
  for (const groupId of groups) {
    const indexes = candidates.map((candidate, index) => ({ candidate, index }))
      .filter(({ candidate }) => candidate.groupId === groupId && candidate.context === 'INPUT');
    const statements = indexes.filter(({ candidate }) => candidate.depth === 1 && candidate.inputSource !== undefined);
    const resolved = statements.length > 0 && statements.every(({ candidate, index }) => {
      if (!shown(index)) return false;
      if (candidate.inputSource === 'DIRECT') return true;
      if (candidate.inputSource !== 'CALL' || candidate.dependsOn === undefined) return false;
      const definition = indexes.find((item) => candidateKey(item.candidate) === candidate.dependsOn);
      return definition !== undefined && definition.candidate.inputSource === 'DIRECT' && shown(definition.index);
    });
    if (!resolved) unresolved.add(groupId);
  }
  return unresolved;
}

/**
 * Groups whose TRIGGER is still not shown after the expansion. Adding lifecycle
 * or entry code is not enough: the slices have to hold the statement that
 * requires or imports the group's file, or a call to an imported function
 * together with that function's complete definition and the statement in it
 * that requires the group's file. Shown means every line of the statement lies
 * in a slice of the same artifact and file.
 */
export function groupsWithUnresolvedTrigger(candidates: readonly ExpansionCandidate[], slices: readonly AgentCodeSlice[]): Set<string> {
  const shown = (candidate: ExpansionCandidate, unit: { startLine: number; endLine: number }) => {
    const ranges = slices.filter((slice) => slice.artifactId === candidate.artifactId && slice.filePath === candidate.filePath);
    for (let line = unit.startLine; line <= unit.endLine; line += 1) {
      if (!ranges.some((slice) => line >= slice.startLine && line <= slice.endLine)) return false;
    }
    return true;
  };
  const triggers = candidates.filter((candidate) => candidate.context === 'TRIGGER');
  const unresolved = new Set<string>();
  for (const groupId of new Set(triggers.map((candidate) => candidate.groupId))) {
    const ofGroup = triggers.filter((candidate) => candidate.groupId === groupId);
    const resolved = ofGroup.some((candidate) => {
      if (candidate.depth !== 1 || candidate.triggerUnit === undefined || !shown(candidate, candidate.triggerUnit)) return false;
      // A require held in a declaration only runs through the statement that uses it.
      if (!candidate.units.some((unit) => unit.executable === true && shown(candidate, unit))) return false;
      if (candidate.triggerSource === 'DIRECT') return true;
      if (candidate.triggerSource !== 'CALL' || candidate.dependsOn === undefined) return false;
      const definition = ofGroup.find((item) => candidateKey(item) === candidate.dependsOn);
      return definition !== undefined && definition.triggerSource === 'DIRECT' && definition.units.every((unit) => shown(definition, unit));
    });
    if (!resolved) unresolved.add(groupId);
  }
  return unresolved;
}

/**
 * Groups whose TRIGGER the program index settles: every Finding of the group
 * has a path from a lifecycle or entry file that is confirmed step by step,
 * and every statement of that path is in the slices; any one of a Finding's
 * paths will do. A callback that is only
 * registered, a timer and an outside event never give such a path.
 */
export function groupsWithWitnessedTrigger(evidence: readonly GroupExecutionEvidence[], slices: readonly AgentCodeSlice[]): Set<string> {
  return new Set(evidence
    .filter((group) => group.findings.length > 0 && group.findings.every((finding) => (
      [...(finding.reach ? [finding.reach] : []), ...(finding.reachAlternatives ?? [])]
        .some((reach) => reach.status === 'CONFIRMED' && reach.statements.every((statement) => shownIn(slices, statement)))
    )))
    .map((group) => group.groupId));
}

/**
 * Groups whose INPUT the program index settles: the flow of every Finding that
 * uses a traceable value reaches its sources without an unresolved step, and
 * the statements on both sides of every step are in the slices.
 */
export function groupsWithWitnessedInput(witnesses: readonly InputWitnessRecord[], slices: readonly AgentCodeSlice[]): Set<string> {
  const groups = new Set<string>();
  for (const groupId of new Set(witnesses.map((item) => item.groupId))) {
    const ofGroup = witnesses.filter((item) => item.groupId === groupId);
    const traced = ofGroup.filter((item) => item.status !== 'NONE');
    if (traced.length > 0 && traced.every((item) => item.status === 'COMPLETE' && item.statements.every((statement) => shownIn(slices, statement)))) groups.add(groupId);
  }
  return groups;
}

function indexRecord(index: PackageProgramIndex | undefined, requested: boolean, includeTiming = false): ProgramIndexRecord {
  const diagnostics = index?.diagnostics;
  return {
    status: index ? 'BUILT' : requested ? 'UNAVAILABLE' : 'NOT_REQUESTED',
    candidateFileCount: diagnostics?.candidateFileCount ?? 0, parsedFileCount: diagnostics?.parsedFileCount ?? 0, parseFailureCount: diagnostics?.parseFailureCount ?? 0,
    excludedFileCount: diagnostics?.excludedFiles.length ?? 0, totalSourceBytes: diagnostics?.totalSourceBytes ?? 0, symbolCount: diagnostics?.symbolCount ?? 0,
    callEdgeCount: diagnostics?.callEdgeCount ?? 0, moduleEdgeCount: diagnostics?.moduleEdgeCount ?? 0, unresolvedModuleEdgeCount: diagnostics?.unresolvedModuleEdgeCount ?? 0,
    appliedLimits: [...(diagnostics?.appliedLimits ?? [])], limitations: [...(diagnostics?.limitations ?? []), ...(index || !requested ? [] : ['PROGRAM_INDEX_BUILD_FAILED'])],
    durationMs: diagnostics?.durationMs ?? 0,
    ...(!includeTiming || diagnostics?.timing === undefined ? {} : { timing: { ...diagnostics.timing } }),
  };
}

function reportTrace(input: ContextCheckInput, entries: readonly CandidateTraceEntry[]): void {
  if (!input.onCandidateTrace) return;
  try {
    input.onCandidateTrace(entries.map((entry) => ({ ...entry })));
  } catch {
    // Tracing is diagnostic; it must not change what the Agent receives.
  }
}


/** Slices shown to the model: everything except files that only dropped groups refer to. */
function slicesFor(slices: readonly AgentCodeSlice[], asked: readonly FindingGroup[], dropped: readonly FindingGroup[]): AgentCodeSlice[] {
  const kept = new Set(asked.map((group) => artifactFileKey(group.artifactId, group.filePath)));
  const removed = new Set(dropped.map((group) => artifactFileKey(group.artifactId, group.filePath)).filter((key) => !kept.has(key)));
  return slices.filter((slice) => !removed.has(artifactFileKey(slice.artifactId, slice.filePath)));
}

const skippedFor = (group: FindingGroup, reason: SkippedGroupRecord['reason']): SkippedGroupRecord => (
  { filePath: group.filePath, behavior: group.behavior, findingIds: [...group.findingIds], reason }
);

/**
 * Asks the provider once whether the INITIAL slices show each context of every
 * Finding group, then adds directly linked code for the contexts that are not
 * visible. With `recheck` the provider is then asked once more about those
 * contexts, with the final slices; there is no second expansion. Every failure
 * short of an aborted scan leaves the already-built input in place, so the
 * Tier 3 Agent always runs with at least what it would have had without this step.
 */
export async function runContextCheck(input: ContextCheckInput): Promise<ContextCheckOutcome> {
  const measureTiming = input.measurementLimits !== undefined;
  const checkStarted = performance.now();
  const timing: ContextCheckTiming = {
    artifactDiscoveryMs: 0, sourceReadMs: 0, astParseMs: 0, graphBuildMs: 0, witnessSearchMs: 0,
    candidateValidationMs: 0, witnessSelectionMs: 0, sliceRebuildMs: 0, jevInitialMs: 0, jevRecheckMs: 0, totalMs: 0,
  };
  const { built, execution, signal } = input;
  const bindingOf = (group: Pick<FindingGroup, 'artifactId' | 'filePath'>, findingId: string) => execution.bindings.findingBindings
    .find((candidate) => candidate.findingId === findingId && candidate.artifactId === group.artifactId && candidate.filePath === group.filePath);
  if (!input.enabled || !input.provider) return { built, record: emptyRecord('DISABLED') };
  const slices = built.input.initialCodeSlices;
  let plan = planFindingGroups(execution, slices, input.staticFilter?.diagnostics ?? []);
  // Every supported file of the package is parsed once here and shared by all groups. When that fails, or is turned
  // off, nothing below depends on it: the check falls back to reading the files of the groups one by one.
  const indexRequested = input.programIndex !== false && plan.groups.length > 0;
  let index: PackageProgramIndex | undefined;
  if (indexRequested) {
    try {
      index = await buildPackageProgramIndex({
        resolver: execution.artifacts, packageContext: execution.packageContext, maxFileSizeBytes: input.policy.maxFileSizeBytes,
        priorityPaths: [...new Set(plan.groups.map((group) => group.filePath))], signal,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
    }
  }
  if (index) {
    // With the index, a Finding line the slices do not hold is still read, so a Finding is grouped by what its line shows.
    const indexed = index;
    const lines = new Map<string, string[] | undefined>();
    plan = planFindingGroups(execution, slices, input.staticFilter?.diagnostics ?? [], (artifactId, filePath, line) => {
      const key = artifactFileKey(artifactId, filePath);
      if (!lines.has(key)) lines.set(key, indexedSource(indexed, { artifactId, filePath })?.split('\n'));
      return lines.get(key)?.[line - 1];
    });
  }
  const skippedGroups = [...plan.skippedGroups];
  const programIndex = indexRecord(index, indexRequested, measureTiming);
  Object.assign(timing, programIndex.timing ?? {});
  // A TRIGGER question that would only confirm a lifecycle fact Scanner already holds is not sent.
  const omittedQuestions = await resolveTriggerOmissions({
    groups: plan.groups, execution, mode: input.lifecycleTriggerQuestion ?? 'OMIT_WHEN_RUN_AT_LOAD', maxFileSizeBytes: input.policy.maxFileSizeBytes, signal,
    ...(index ? { parseCache: index.parseCache } : {}),
  });
  // What Scanner knows about how each Finding is reached; always recorded, and sent to the model unless a measurement run turns it off.
  const initialWitnessStarted = performance.now();
  const executionEvidence = await resolveExecutionEvidence({ groups: plan.groups, execution, maxFileSizeBytes: input.policy.maxFileSizeBytes, signal, ...(index ? { index } : {}) });
  const evidenceMode = input.triggerEvidence ?? 'INSTRUCTION_WITH_PATH';
  const executionPathStatements: ExecutionPathStatementRecord[] = [];
  // The value flow of every Finding of a group that asks INPUT. It is traced before the model is asked, because a
  // flow with one probable edge is supplied as code up front; a complete flow is only used once INPUT comes back unresolved.
  const inputWitnesses: InputWitnessRecord[] = [];
  const witnessPaths: ContextWitnessPath[] = [];
  const conditionalInputPaths = new Set<ContextWitnessPath>();
  const track = (path: ContextWitnessPath): ContextWitnessPath => {
    path.pathId = `WP-${witnessPaths.length + 1}`;
    witnessPaths.push(path);
    return path;
  };
  const { supportFor, sliceErrors } = createWitnessSupport({ index, execution, groups: plan.groups, witnessPaths, executionEvidence });
  /** The best TRIGGER path of every Finding; the alternatives are only offered once the model has answered. */
  const primaryTrigger = new Map<ContextWitnessPath, TriggerReachRecord>();
  const selectionOrder = { next: 1 };
  if (index) {
    for (const group of executionEvidence) {
      for (const finding of group.findings) {
        if (!finding.reach) continue;
        primaryTrigger.set(track(triggerPath(group.groupId, finding.findingId, finding.reach)), finding.reach);
        for (const reach of finding.reachAlternatives ?? []) track(triggerPath(group.groupId, finding.findingId, reach));
      }
    }
    for (const group of plan.groups.filter(({ contexts }) => contexts.includes('INPUT'))) {
      for (const findingId of group.findingIds) {
        const binding = bindingOf(group, findingId);
        if (typeof binding?.startLine !== 'number') continue;
        try {
          const witness = findInputWitness(index, { artifactId: group.artifactId, filePath: group.filePath }, { startLine: binding.startLine, endLine: binding.endLine ?? binding.startLine });
          const traced = witness.statements.map(({ artifactId, filePath, startLine, endLine }) => ({ artifactId, filePath, startLine, endLine }));
          inputWitnesses.push({
            groupId: group.groupId, findingId, status: witness.status, edgeCount: witness.edges.length, statements: traced,
            unresolvedReasons: [...new Set([...witness.unresolved.map((entry) => entry.reason), ...witness.limitations])],
            exploredDepth: witness.exploredDepth, probableEdgeCount: witness.probableEdgeCount, limits: [...witness.limitations],
            conditional: { eligible: witness.conditional.eligible, resolved: false, reason: witness.conditional.reason },
          });
          // A Finding that uses no traceable value has no flow to show.
          const path = witness.status === 'NONE'
            ? pathOf('INPUT', { groupId: group.groupId, findingId, behavior: group.behavior }, [], [], 'NO_COMPLETE_PATH')
            : flowPath('INPUT', { groupId: group.groupId, findingId, behavior: group.behavior }, witness);
          track(path);
          if (witness.conditional.eligible) conditionalInputPaths.add(path);
        } catch (error) {
          if (signal?.aborted) throw error;
        }
      }
    }
  }
  timing.witnessSearchMs += performance.now() - initialWitnessStarted;
  let answered: ContextCheckResponse | undefined;
  const routing = () => ({
    skippedGroups, preservedReasons: plan.preservedReasons, restorationStatus: plan.restorationStatus, omittedQuestions, executionEvidence, executionPathStatements,
    programIndex, ...(inputWitnesses.length === 0 ? {} : { inputWitnesses }), ...(witnessPaths.length === 0 ? {} : { witnessPaths }),
  });
  /** Every result of a check that ran carries the routing notes and records; a failed provider call does not. */
  const finish = (result: AgentInputV0_3BuildResult, record: ContextCheckRecord): ContextCheckOutcome => {
    const conditional = settleConditional({ answered, groups: plan.groups, executionEvidence, inputWitnesses, finalSlices: result.input.initialCodeSlices });
    const witnessSliceErrors = record.status === 'UNAVAILABLE' ? [] : sliceErrors(result.input.initialCodeSlices);
    timing.jevRecheckMs = record.recheck?.latencyMs ?? 0;
    timing.totalMs = performance.now() - checkStarted;
    return {
      built: withMissingData(withMissingData(result, conditional), [...routingNotes(skippedGroups, plan.preservedReasons, plan.restorationStatus), ...triggerStartNotes(executionEvidence)]),
      record: {
        ...record, ...routing(), ...(witnessSliceErrors.length === 0 ? {} : { witnessSliceErrors }),
        ...(measureTiming ? { timing: { ...timing } } : {}),
      },
    };
  };

  // A question the code cannot answer is not asked. Whenever this cannot be established the question is asked.
  if (index) {
    for (const group of plan.groups) {
      if (!group.contexts.includes('INPUT')) continue;
      const traced = inputWitnesses.filter((item) => item.groupId === group.groupId);
      if (traced.length !== group.findingIds.length || traced.some((item) => item.status !== 'NONE')) continue;
      const code = indexedSource(index, { artifactId: group.artifactId, filePath: group.filePath });
      const literalsOnly = code !== undefined && group.findingIds.every((findingId) => {
        const binding = bindingOf(group, findingId);
        return typeof binding?.startLine === 'number'
          && statementUsesOnlyLiterals(code, { startLine: binding.startLine, endLine: binding.endLine ?? binding.startLine }, index.parseCache);
      });
      if (!literalsOnly) continue;
      const record = { groupId: group.groupId, filePath: group.filePath, behavior: group.behavior, scripts: [] };
      omittedQuestions.push({ ...record, context: 'INPUT', reason: 'NO_TRACEABLE_VALUE' });
      if (!group.contexts.includes('LINK')) continue;
      const isOperation = (findingId: string): boolean => {
        const binding = bindingOf(group, findingId);
        if (typeof binding?.startLine !== 'number') return false;
        try {
          return buildActionPaths(
            index, { artifactId: group.artifactId, filePath: group.filePath }, { startLine: binding.startLine, endLine: binding.endLine ?? binding.startLine },
            { groupId: group.groupId, findingId, behavior: group.behavior }, ['ACTION'],
          ).some((path) => path.complete && path.steps.length === 0);
        } catch (error) {
          if (signal?.aborted) throw error;
          return false;
        }
      };
      if (group.findingIds.every(isOperation)) omittedQuestions.push({ ...record, context: 'LINK', reason: 'NOTHING_TO_LINK' });
    }
  }
  const omittedKeys = new Set(omittedQuestions.map((item) => questionKey(item.groupId, item.context)));
  // When the request is too large, the lowest-priority groups are left out first.
  const groups = plan.groups.map((group) => ({ ...group, contexts: group.contexts.filter((context) => !omittedKeys.has(questionKey(group.groupId, context))) }));
  const dropped: FindingGroup[] = [];
  const evidenceFor = (pathStatements?: ReadonlyMap<string, readonly PathStatementCode[]>, valueFlowStatements: readonly PathStatementCode[] = []): RequestExecutionEvidence | undefined => (
    evidenceMode === 'NONE' ? undefined : {
      groups: executionEvidence, mode: evidenceMode === 'INSTRUCTION_WITH_PATH' ? 'INSTRUCTION' : evidenceMode, ...(pathStatements === undefined ? {} : { pathStatements }),
      ...(valueFlowStatements.length === 0 ? {} : { valueFlowStatements }),
    }
  );
  let contextRequest = buildContextCheckRequest(execution, slices, groups, evidenceFor());
  while (groups.length > 1 && estimateRequestChars(contextRequest) > CONTEXT_CHECK_LIMITS.maxStateChars) {
    dropped.unshift(groups.pop()!);
    contextRequest = buildContextCheckRequest(execution, slicesFor(slices, groups, dropped), groups, evidenceFor());
  }
  const tooLarge = groups.length > 0 && estimateRequestChars(contextRequest) > CONTEXT_CHECK_LIMITS.maxStateChars;
  skippedGroups.push(...(tooLarge ? [...groups, ...dropped] : dropped).map((group) => skippedFor(group, 'INPUT_LIMIT')));
  if (groups.length === 0) return finish(built, emptyRecord('NO_GROUPS'));
  if (tooLarge) return finish(built, emptyRecord('INPUT_TOO_LARGE', plan.groups.length));

  const usedLines = slices.reduce((sum, slice) => sum + slice.endLine - slice.startLine + 1, 0);
  const expansionLines = input.measurementLimits?.maxExpansionLines ?? expansionLineBudget(input.policy, usedLines);
  const expansionTargets = input.measurementLimits?.maxExpansionTargets ?? CONTEXT_CHECK_LIMITS.maxExpansionTargets;
  const linesPerCandidate = input.measurementLimits?.maxLinesPerCandidate ?? CONTEXT_CHECK_LIMITS.maxLinesPerCandidate;
  const sourceCache = new Map<string, { lines: string[]; filePath: string } | null>();
  const validate = async (candidates: readonly ExpansionCandidate[]) => {
    const started = performance.now();
    try {
      return await validateExpansionCandidates({
        sourceCache, candidates, groups, slices, resolver: execution.artifacts, analysisMode: execution.validatedPlan.analysisMode,
        // Expansion targets have a slice limit of their own; see `SliceSupplementBudget.maxSlices`.
        remainingSlices: expansionTargets, remainingLines: expansionLines, maxTargets: expansionTargets,
        maxLinesPerCandidate: linesPerCandidate, maxFileSizeBytes: input.policy.maxFileSizeBytes, signal,
      });
    } finally { timing.candidateValidationMs += performance.now() - started; }
  };
  const expansionBudget = { lines: Math.max(expansionLines, 0), targets: expansionTargets };
  const select = async (selection: Parameters<typeof selectWitnessPaths>[0]) => {
    const started = performance.now();
    try { return await selectWitnessPaths(selection); }
    finally { timing.witnessSelectionMs += performance.now() - started; }
  };

  // The call sites and Finding statements the slices lack are settled before the model is asked: they take the same
  // limits as every other expansion target, the TRIGGER question quotes exactly the ones that fit, and they are added
  // as slices whatever the answers are, so the Agent is given the code the model was shown.
  let pathCandidates: ExpansionCandidate[] = [];
  if (evidenceMode === 'INSTRUCTION_WITH_PATH' && expansionLines > 0) {
    try {
      // Paths the index completed are supplied whole: confirmed TRIGGER paths, then a value flow with one probable
      // step that the answer may settle. A group without such a path keeps the single-file statements.
      const asks = (groupId: string, context: ContextCode) => groups.some((group) => group.groupId === groupId && group.contexts.includes(context));
      const triggerPaths = [...primaryTrigger.keys()].filter((path) => path.complete && asks(path.groupId, 'TRIGGER'));
      const request = (pathPurpose: 'CALL_SITE' | 'VALUE_FLOW') => (path: ContextWitnessPath): PathRequest => (
        { path, state: 'PARTIAL', pathPurpose, ...(pathPurpose === 'CALL_SITE' ? { kind: 'EXECUTION_PATH' as const } : {}) }
      );
      const tiers = [
        triggerPaths.filter((path) => primaryTrigger.get(path)?.status === 'CONFIRMED').map(request('CALL_SITE')),
        [...conditionalInputPaths].filter((path) => path.complete && asks(path.groupId, 'INPUT')).map(request('VALUE_FLOW')),
      ];
      const witnessed = await select({ tiers, slices, accepted: [], validate, budget: expansionBudget, order: selectionOrder });
      const supplied = new Set(witnessed.filter((candidate) => candidate.context === 'TRIGGER').map((candidate) => candidate.groupId));
      const offered = [...witnessed, ...executionPathCandidates(groups.filter((group) => !supplied.has(group.groupId)), executionEvidence, slices)];
      const selected = offered.length === 0 ? undefined : await validate(offered);
      const acceptedOffered = selected ? acceptedCandidateRanges(offered, selected) : [];
      const shown = new Map<string, PathStatementCode[]>();
      const valueFlow: PathStatementCode[] = [];
      for (const { candidate, targetId } of acceptedOffered) {
        // A statement several groups need is one target; every group that needs it is shown it.
        const target = selected?.targets.find((item) => item.targetId === targetId);
        if (!target?.preferredRange) continue;
        const source = await readArtifactSource(execution.artifacts, target.artifactId, target.filePath, input.policy.maxFileSizeBytes, signal);
        const { startLine, endLine } = target.preferredRange;
        const statement = { artifactId: target.artifactId, filePath: target.filePath, startLine, endLine,
          purpose: candidate.pathPurpose ?? 'CALL_SITE', code: source.lines.slice(startLine - 1, endLine).join('\n') };
        // A value-flow statement is supplied as code only; the TRIGGER question quotes the execution path alone.
        if (candidate.pathPurpose === 'VALUE_FLOW') valueFlow.push(statement);
        else shown.set(candidate.groupId, [...(shown.get(candidate.groupId) ?? []), statement]);
      }
      const withPath = buildContextCheckRequest(execution, slicesFor(slices, groups, dropped), groups, evidenceFor(shown, valueFlow));
      if ((shown.size > 0 || valueFlow.length > 0) && estimateRequestChars(withPath) <= CONTEXT_CHECK_LIMITS.maxStateChars) {
        contextRequest = withPath;
        pathCandidates = acceptedOffered.map(({ candidate }) => candidate);
      } else {
        for (const { path } of tiers.flat()) {
          Object.assign(path, { outcome: 'NOT_NEEDED', newTargetCount: 0, newLineCount: 0 });
          delete path.selectionOrder;
          delete path.exclusionReason;
        }
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      // The path statements are an addition; without them the check runs as it would have.
    }
  }

  let response: ContextCheckResponse;
  const initialJevStarted = performance.now();
  try {
    response = await input.provider.check(contextRequest, signal);
  } catch (error) {
    if (signal?.aborted) throw error;
    timing.jevInitialMs = performance.now() - initialJevStarted;
    timing.totalMs = performance.now() - checkStarted;
    return {
      built,
      record: {
        ...emptyRecord('UNAVAILABLE', groups.length), ...routing(),
        failureReason: error instanceof ContextCheckProviderError ? error.reason : 'INTERNAL_ERROR', ...(measureTiming ? { timing: { ...timing } } : {}),
      },
    };
  }
  timing.jevInitialMs = performance.now() - initialJevStarted;

  answered = response;
  // Resolution policy needs an exact witness even when Jev already returned a VISIBLE-range score.
  // Build ACTION/TARGET/LINK paths for every asked context before classifying the answer.
  const actionWitnessStarted = performance.now();
  if (index) {
    for (const group of groups) {
      const wanted = group.contexts.filter((context): context is 'ACTION' | 'TARGET' | 'LINK' => (
        context === 'ACTION' || context === 'TARGET' || context === 'LINK'
      ));
      if (wanted.length === 0) continue;
      for (const findingId of group.findingIds) {
        const binding = bindingOf(group, findingId);
        if (typeof binding?.startLine !== 'number') continue;
        try {
          buildActionPaths(
            index, { artifactId: group.artifactId, filePath: group.filePath }, { startLine: binding.startLine, endLine: binding.endLine ?? binding.startLine },
            { groupId: group.groupId, findingId, behavior: group.behavior }, wanted,
          ).forEach(track);
        } catch (error) {
          if (signal?.aborted) throw error;
        }
      }
    }
  }
  timing.witnessSearchMs += performance.now() - actionWitnessStarted;
  const initiallyShown: Shown[] = [...slices, ...pathCandidates];
  const states = stateRecords(groups, response, (groupId, context) => supportFor(groupId, context, initiallyShown));
  const groupById = new Map(groups.map((group) => [group.groupId, group]));
  // A model answer cannot promote a registered-only callback, timer or outside event to an execution root.
  // Apply this only when the index followed every Finding, so incomplete indexing never becomes negative proof.
  const triggerRootDenied = new Set(executionEvidence.filter((group) => group.findings.length > 0
    && group.findings.every((finding) => finding.reach !== undefined)
    && !group.findings.every((finding) => [...(finding.reach ? [finding.reach] : []), ...(finding.reachAlternatives ?? [])]
      .some((reach) => reach.status === 'CONFIRMED' || reach.conditional.eligible))).map((group) => group.groupId));
  const unresolved: UnresolvedContext[] = states.flatMap((item) => {
    const rootDenied = item.context === 'TRIGGER' && triggerRootDenied.has(item.groupId);
    if (item.state === 'VISIBLE' && !rootDenied) return [];
    const answer = { score: item.score, confidence: item.confidence };
    const state: Exclude<ContextState, 'VISIBLE'> = rootDenied || item.state === 'VISIBLE' ? 'PARTIAL' : item.state;
    return [{ group: groupById.get(item.groupId)!, context: item.context, state, exploration: explorationClass(item.context, answer), answer }];
  });
  const base: ContextCheckRecord = { ...emptyRecord('SUFFICIENT', groups.length), states, model: response.model, usage: response.usage };
  if (unresolved.length === 0 && pathCandidates.length === 0) return finish(built, base);

  if (expansionLines <= 0) {
    return finish(withMissingData(built, unresolved.map(missingContext(execution, executionEvidence, 'NOT_SEARCHED'))), { ...base, status: 'NO_BUDGET', unresolvedContextCount: unresolved.length });
  }

  try {
    // A context with at least one complete path gets its paths, each whole or not at all; only a context without any is looked up directly.
    const pathsOf = (item: UnresolvedContext) => witnessPaths.filter((path) => path.groupId === item.group.groupId && path.context === item.context);
    const witnessedItem = (item: UnresolvedContext) => pathsOf(item).some((path) => path.complete);
    const requests = (items: readonly UnresolvedContext[]): PathRequest[] => items.filter(witnessedItem).flatMap((item) => pathsOf(item).map((path) => ({
      path, state: item.state, ...(item.exploration === undefined ? {} : { exploration: item.exploration }), ...(item.answer === undefined ? {} : { answer: item.answer }),
    })));
    for (const item of unresolved.filter((entry) => !witnessedItem(entry))) {
      for (const path of pathsOf(item)) Object.assign(path, { outcome: 'NOT_ADDED', exclusionReason: path.failureReason ?? 'NO_COMPLETE_PATH' });
    }
    const completed = await select({
      tiers: [requests(unresolved.filter(({ state }) => state === 'MISSING')), requests(unresolved.filter(({ state }) => state !== 'MISSING'))],
      slices, accepted: pathCandidates, validate, budget: expansionBudget, order: selectionOrder,
    });
    const keyOf = (item: UnresolvedContext) => questionKey(item.group.groupId, item.context);
    // The function around each Finding, whole, for every group with an unresolved context.
    const enclosing: ExpansionCandidate[] = [];
    // What was found of a path that is not complete, statement by statement.
    const partial: ExpansionCandidate[] = [];
    if (index) {
      const first = new Map<string, UnresolvedContext>();
      for (const item of [...unresolved].sort((left, right) => Number(right.state === 'MISSING') - Number(left.state === 'MISSING'))) {
        if (!first.has(item.group.groupId)) first.set(item.group.groupId, item);
      }
      const offered = new Set<string>();
      for (const item of first.values()) {
        const { group } = item;
        for (const findingId of group.findingIds) {
          const binding = bindingOf(group, findingId);
          if (typeof binding?.startLine !== 'number') continue;
          const symbol = symbolHolding(index, { artifactId: group.artifactId, filePath: group.filePath }, { startLine: binding.startLine, endLine: binding.endLine ?? binding.startLine });
          if (!symbol || symbol.kind === 'MODULE' || symbol.endLine - symbol.startLine + 1 > linesPerCandidate || offered.has(symbol.id)) continue;
          offered.add(symbol.id);
          enclosing.push({
            groupId: group.groupId, context: item.context, state: item.state, kind: 'ENCLOSING_FUNCTION', depth: 1, artifactId: symbol.artifactId, filePath: symbol.filePath,
            startLine: symbol.startLine, endLine: symbol.endLine, units: [{ startLine: symbol.startLine, endLine: symbol.endLine, executable: true }], statementAligned: true,
          });
        }
      }
      for (const item of unresolved) {
        for (const path of pathsOf(item).filter((candidate) => !candidate.complete && candidate.statements.length > 0)) {
          path.outcome = 'OFFERED_INCOMPLETE';
          for (const statement of path.statements.filter((entry) => !shownIn(slices, entry))) {
            partial.push({
              groupId: item.group.groupId, context: item.context, state: item.state, kind: 'WITNESS_PATH', depth: 1, artifactId: statement.artifactId, filePath: statement.filePath,
              startLine: statement.startLine, endLine: statement.endLine, units: [{ startLine: statement.startLine, endLine: statement.endLine, executable: true }], statementAligned: true,
            });
          }
        }
      }
    }
    // The direct lookup is for the contexts without a complete path; elsewhere it only repeats large parts of the entry files.
    const direct = unresolved.filter((item) => !witnessedItem(item));
    const generated = direct.length === 0 ? [] : await generateExpansionCandidates({
      unresolved: direct, slices, resolver: execution.artifacts, packageContext: execution.packageContext,
      maxFileSizeBytes: input.policy.maxFileSizeBytes, signal, ...(index ? { parseCache: index.parseCache } : {}),
    });
    // Path statements come first, so the same ones are selected as before the model was asked.
    // What follows the paths is cut down to the lines nothing before it holds, so no line is supplied twice.
    const rangesOf = (candidate: ExpansionCandidate) => candidate.units.map((unit) => ({
      artifactId: candidate.artifactId, filePath: candidate.filePath, startLine: unit.startLine, endLine: unit.endLine }));
    const held = [...slices, ...[...pathCandidates, ...completed].flatMap(rangesOf)];
    const fresh = (candidate: ExpansionCandidate): ExpansionCandidate => {
      const units = candidate.units.flatMap((unit) => uncovered(held, { artifactId: candidate.artifactId, filePath: candidate.filePath, startLine: unit.startLine, endLine: unit.endLine })
        .map((run) => ({ ...unit, startLine: run.startLine, endLine: run.endLine })));
      const kept = units.length === 0 ? candidate
        : { ...candidate, units, startLine: Math.min(...units.map((unit) => unit.startLine)), endLine: Math.max(...units.map((unit) => unit.endLine)) };
      held.push(...rangesOf(kept));
      return kept;
    };
    const candidates = [...pathCandidates, ...completed, ...[...enclosing, ...partial, ...generated].map(fresh)];
    const validated = await validate(candidates);
    reportTrace(input, validated.trace);
    // Confirmed static evidence settles without a confidence floor. A path with a PROBABLE edge
    // settles only when its VISIBLE-range answer passes the score-dependent confidence floor.
    const witnessedIn = (shown: readonly AgentCodeSlice[]) => new Set(unresolved.filter((item) => {
      const support = supportFor(item.group.groupId, item.context, shown);
      if (support === 'CONFIRMED') return true;
      if (item.answer === undefined) return false;
      if (support === 'DIRECT' || support === 'CONDITIONAL_START') return item.answer.score >= CONTEXT_CHECK_LIMITS.visibleMinScore;
      return support === 'PROBABLE' && probableAnswerSettles(item.context, item.answer);
    }).map(keyOf));
    const witnessRecord = (keys: ReadonlySet<string>) => ({
      witnessResolved: unresolved.filter((item) => keys.has(keyOf(item))).map((item) => ({ groupId: item.group.groupId, context: item.context })) });
    if (validated.targets.length === 0) {
      const settled = witnessedIn(slices);
      const open = unresolved.filter((item) => !settled.has(keyOf(item)));
      return finish(withMissingData(built, open.map(missingContext(execution, executionEvidence, 'NOT_ADDED'))),
        { ...base, ...witnessRecord(settled), status: 'NO_CANDIDATE', unresolvedContextCount: open.length });
    }

    const rebuildStarted = performance.now();
    const expanded = await input.rebuild(
      {
        ...execution,
        validatedPlan: { ...execution.validatedPlan, targets: [...execution.validatedPlan.targets, ...validated.targets] },
      },
      { fromTargetIndex: execution.validatedPlan.targets.length, maxCodeLines: expansionLines, maxSlices: expansionTargets },
    );
    timing.sliceRebuildMs += performance.now() - rebuildStarted;
    const addedSlices = expanded.input.initialCodeSlices.filter((slice) => slice.planningTargetId?.startsWith(CONTEXT_TARGET_ID_PREFIX) === true);
    // A path statement was supplied before the question was asked; it does not answer a TRIGGER the model still found unresolved.
    const pathTargets = new Map<string, ExpansionCandidate>();
    for (const [index, candidate] of pathCandidates.entries()) {
      const targetId = validated.outcomes[index]?.targetId;
      if (targetId) pathTargets.set(targetId, candidate);
    }
    for (const slice of addedSlices) {
      const candidate = pathTargets.get(slice.planningTargetId ?? '');
      if (candidate) executionPathStatements.push({
        groupId: candidate.groupId, filePath: slice.filePath, startLine: slice.startLine, endLine: slice.endLine, purpose: candidate.pathPurpose ?? 'CALL_SITE' });
    }
    const pathKeys = new Set(pathCandidates.map((candidate) => questionKey(candidate.groupId, candidate.context)));
    const served = new Set(addedSlices.flatMap((slice) => {
      const targetId = slice.planningTargetId ?? '';
      return (validated.contextsByTarget.get(targetId) ?? []).filter((key) => !pathTargets.has(targetId) || !pathKeys.has(key));
    }));
    // A context is taken as shown when the direct lookup shows it, or when a complete witness path of the index lies in the slices.
    const finalSlices = expanded.input.initialCodeSlices;
    const inputStillMissing = groupsWithUnresolvedInput(candidates, validated.outcomes, new Set(addedSlices.map((slice) => slice.planningTargetId ?? '')));
    for (const groupId of groupsWithWitnessedInput(inputWitnesses, finalSlices)) inputStillMissing.delete(groupId);
    const witnessResolved = witnessedIn(finalSlices);
    const notAdded = unresolved.filter((item) => !served.has(keyOf(item)) && !witnessResolved.has(keyOf(item)));
    const triggerStillMissing = groupsWithUnresolvedTrigger(candidates, finalSlices);
    const witnessedTrigger = groupsWithWitnessedTrigger(executionEvidence, finalSlices);
    for (const groupId of witnessedTrigger) triggerStillMissing.delete(groupId);
    // Where the index followed every Finding of a group, its verdict stands: a file that is merely loaded does not settle TRIGGER.
    const deniedByIndex = new Set<string>();
    for (const group of executionEvidence) {
      if (group.findings.length > 0 && group.findings.every((finding) => finding.reach !== undefined) && !witnessedTrigger.has(group.groupId)) deniedByIndex.add(group.groupId);
    }
    for (const groupId of deniedByIndex) triggerStillMissing.add(groupId);
    // An answer with too little confidence to trust is never taken as resolved, whatever was added.
    const addedButUnresolved = unresolved.filter((item) => served.has(keyOf(item)) && !witnessResolved.has(keyOf(item))
      && (index !== undefined
        || item.exploration === 'VERY_LOW_CONFIDENCE'
        || (item.context === 'INPUT' && inputStillMissing.has(item.group.groupId))
        || (item.context === 'TRIGGER' && triggerStillMissing.has(item.group.groupId))));
    // The second call asks the open questions of a group that was given code, where an answer can still settle them.
    let recheck: ContextRecheckRecord | undefined;
    let [reportedNotAdded, reportedUnresolved] = [notAdded, addedButUnresolved];
    if (input.recheck === true && addedSlices.length > 0) {
      const keysOf = (slice: AgentCodeSlice) => validated.contextsByTarget.get(slice.planningTargetId ?? '') ?? [];
      const supplied = (slice: AgentCodeSlice, key: string) => keysOf(slice).includes(key) && (!pathTargets.has(slice.planningTargetId ?? '') || !pathKeys.has(key));
      const inFile = (group: FindingGroup, slice: AgentCodeSlice) => slice.artifactId === group.artifactId && slice.filePath === group.filePath;
      const fileOrder = [...new Set(finalSlices.map((slice) => artifactFileKey(slice.artifactId, slice.filePath)))];
      const addedFor = (group: FindingGroup, slice: AgentCodeSlice) => addedSlices.includes(slice) && keysOf(slice).some((key) => key.startsWith(`${group.groupId}__`));
      const servedGroupIds = new Set([...served].map((key) => key.split('__')[0]));
      const servedGroups = new Set(states.filter((state) => servedGroupIds.has(state.groupId)).map((state) => questionKey(state.groupId, state.context)));
      // With the final slices, the best answer there is would still leave these open: asking again changes nothing.
      const unsettleable = new Set(states.filter((state) => state.state !== 'VISIBLE' && !witnessResolved.has(questionKey(state.groupId, state.context))
        && witnessAwareContextState({ score: 2, confidence: 1 }, supportFor(state.groupId, state.context, finalSlices), state.context) !== 'VISIBLE')
        .map((state) => questionKey(state.groupId, state.context)));
      const skippedUnsettleable = [...unsettleable].filter((key) => servedGroups.has(key)).length;
      try {
        recheck = await runRecheck({
          provider: input.provider, groups, states, signal,
          stateFor: (groupId, context, answer) => witnessAwareContextState(answer, supportFor(groupId, context, finalSlices), context),
          excluded: new Set([...witnessResolved, ...unsettleable]),
          ...(input.recheckVerifyScannerSettled === true
            ? { verify: new Set([...witnessResolved].filter((key) => servedGroupIds.has(key.split('__')[0]))) } : {}),
          served: servedGroups,
          inputTouchesTarget: (groupId) => addedSlices.filter((slice) => supplied(slice, questionKey(groupId, 'INPUT'))).some((slice) => (
            witnessPaths.some((path) => path.groupId === groupId && path.context === 'TARGET' && path.statements.some((statement) => (
              statement.artifactId === slice.artifactId && statement.filePath === slice.filePath && statement.startLine <= slice.endLine && statement.endLine >= slice.startLine
            )))
          )),
          // The group's own file and what was added for the group, most needed first: the slices that hold its Findings,
          // then what was added for it, then the rest of its file. A request that is too large loses slices from the end.
          slicesOf: (group) => {
            const findingLines = execution.bindings.findingBindings
              .filter((binding) => group.findingIds.includes(binding.findingId) && binding.artifactId === group.artifactId
                && binding.filePath === group.filePath && typeof binding.startLine === 'number')
              .map((binding) => binding.startLine as number);
            const rank = (slice: AgentCodeSlice) => (inFile(group, slice) && findingLines.some((line) => line >= slice.startLine && line <= slice.endLine) ? 0 : addedSlices.includes(slice) ? 1 : 2);
            return finalSlices
              .filter((slice) => inFile(group, slice) || addedFor(group, slice))
              .map((slice, position) => ({ slice, position })).sort((left, right) => rank(left.slice) - rank(right.slice) || left.position - right.position).map(({ slice }) => slice);
          },
          // Groups in the same artifact file share one request; each file's slices remain in line order.
          request: (askedGroups, groupSlices) => {
            const again = buildContextCheckRequest(execution, [...groupSlices].sort((left, right) => (
              fileOrder.indexOf(artifactFileKey(left.artifactId, left.filePath)) - fileOrder.indexOf(artifactFileKey(right.artifactId, right.filePath)) || left.startLine - right.startLine
            )), askedGroups, evidenceFor());
            for (const group of askedGroups) {
              // Where code was added for this group, by position only; whether it is enough stays the model's rating.
              const added = groupSlices.filter((slice) => addedFor(group, slice))
                .sort((left, right) => left.filePath.localeCompare(right.filePath) || left.startLine - right.startLine);
              if (added.length === 0) continue;
              const named = added.slice(0, CONTEXT_CHECK_LIMITS.maxRecheckHintRanges).map((slice) => `\`${slice.filePath}\` lines ${slice.startLine}-${slice.endLine}`);
              const note = ` Since the first rating, code was added for this Finding group at ${named.join(', ')}${added.length > named.length ? ' and other places' : ''}; rate what all the supplied slices show now.`;
              for (const [key, question] of Object.entries(again.questions)) if (key.startsWith(`${group.groupId}__`)) question.instructions += note;
            }
            return again;
          },
        });
      } catch (error) {
        if (signal?.aborted) throw error;
        recheck = { questions: [], callCount: 0, failedCallCount: 0, latencyMs: 0, usage: {}, failureReason: 'INTERNAL_ERROR' };
      }
      if (skippedUnsettleable > 0) recheck.skippedUnsettleable = skippedUnsettleable;
      const answers = new Map(recheck.questions.filter((question) => question.outcome !== 'RECHECK_UNAVAILABLE').map((question) => [questionKey(question.groupId, question.context), question]));
      const resolvedAgain = (item: UnresolvedContext) => answers.get(keyOf(item))?.outcome === 'RESOLVED';
      reportedNotAdded = notAdded.filter((item) => !resolvedAgain(item));
      reportedUnresolved = unresolved.filter((item) => served.has(keyOf(item)) && !witnessResolved.has(keyOf(item))
        && (answers.has(keyOf(item)) ? !resolvedAgain(item) : addedButUnresolved.includes(item)));
      const reported = new Set([...reportedNotAdded, ...reportedUnresolved].map(keyOf));
      for (const question of recheck.questions) question.unresolved = reported.has(questionKey(question.groupId, question.context));
    }
    const stillUnresolved = [...reportedNotAdded, ...reportedUnresolved];
    return finish(withMissingData(expanded, [
      ...reportedNotAdded.map(missingContext(execution, executionEvidence, 'NOT_ADDED')),
      ...reportedUnresolved.map(missingContext(execution, executionEvidence, input.recheck === true ? 'STILL_UNRESOLVED' : 'ADDED_UNCHECKED')),
    ]), {
      ...base,
      ...(recheck === undefined ? {} : { recheck }),
      ...witnessRecord(witnessResolved),
      status: addedSlices.length > 0 ? 'EXPANDED' : 'NO_CANDIDATE',
      addedTargetCount: validated.targets.length,
      addedSliceCount: addedSlices.length,
      addedLineCount: addedSlices.reduce((sum, slice) => sum + slice.endLine - slice.startLine + 1, 0),
      unresolvedContextCount: stillUnresolved.length,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    return finish(withMissingData(built, unresolved.map(missingContext(execution, executionEvidence, 'NOT_SEARCHED'))), {
      ...base, status: 'EXPANSION_FAILED', unresolvedContextCount: unresolved.length, failureReason: 'EXPANSION_FAILED',
    });
  }
}
