import type { Tier3ExecutionInput } from '../artifact/agent-analysis-input.contract';
import { hasMeaningfulCode } from './code-units';
import {
  artifactFileKey, CONTEXT_CHECK_LIMITS,
  type ContextCode, type ContextWitnessPath, type FindingGroup, type GroupExecutionEvidence, type WitnessSliceError, type WitnessSupport,
} from './context-check.contract';
import { indexedSource, type PackageProgramIndex } from './program-index/program-index';

export type Shown = { artifactId: string; filePath: string; startLine: number; endLine: number };
const DIRECT_EVIDENCE_CONTEXTS: readonly ContextCode[] = ['INPUT', 'ACTION', 'TARGET'];
/** Starts that run when the package is installed or loaded; an npm script, an exported function and an unreferenced file need someone to run or call them. */
const SELF_STARTING_ROOTS: ReadonlyArray<NonNullable<ContextWitnessPath['rootKind']>> = ['LIFECYCLE', 'ENTRY_POINT'];
/** Whether every line of the statement lies in a slice of the same artifact and file. */
export function shownIn(slices: readonly Shown[], statement: Shown, emptyLine?: (artifactId: string, filePath: string, line: number) => boolean): boolean {
  const ranges = slices.filter((slice) => slice.artifactId === statement.artifactId && slice.filePath === statement.filePath);
  for (let line = statement.startLine; line <= statement.endLine; line += 1) {
    if (ranges.some((slice) => line >= slice.startLine && line <= slice.endLine)) continue;
    // A line that holds nothing but punctuation (a closing brace) has nothing to show.
    if (emptyLine?.(statement.artifactId, statement.filePath, line) !== true) return false;
  }
  return true;
}

export interface WitnessSupportInput {
  /** Undefined when the program index could not be built: every question then has probable support. */
  index: PackageProgramIndex | undefined;
  execution: Tier3ExecutionInput;
  groups: readonly FindingGroup[];
  /** Grows while the check runs; read when a question is judged. */
  witnessPaths: readonly ContextWitnessPath[];
  executionEvidence: readonly GroupExecutionEvidence[];
}

/** Judges, for the slices shown, how well the paths Scanner followed back each question. */
export function createWitnessSupport({ index, execution, groups, witnessPaths, executionEvidence }: WitnessSupportInput) {
  const requiredBy = (path: ContextWitnessPath): Shown[] => {
    const required: Shown[] = [...path.statements, ...(path.sink === undefined ? [] : [path.sink])];
    if (required.length === 0) {
      const binding = execution.bindings.findingBindings.find((item) => item.findingId === path.findingId
        && typeof item.startLine === 'number');
      if (binding?.startLine !== undefined) required.push({
        artifactId: binding.artifactId, filePath: binding.filePath,
        startLine: binding.startLine, endLine: binding.endLine ?? binding.startLine,
      });
    }
    const seen = new Set<string>();
    return required.filter((item) => {
      const key = `${item.artifactId}\u0000${item.filePath}\u0000${item.startLine}\u0000${item.endLine}`;
      return seen.has(key) ? false : (seen.add(key), true);
    });
  };
  // A listener on a local emitter that nothing emits to is registered, not run.
  const registeredOnly = (path: ContextWitnessPath): boolean => path.context === 'TRIGGER'
    && path.steps.some((step) => /^REGISTERED_CALLBACK:(?:NO_LOCAL_EMIT|EMITTER_IDENTITY_UNCLEAR|DYNAMIC_EVENT_NAME)$/u.test(step.basis ?? ''));
  const sourceLines = new Map<string, string[] | undefined>();
  const emptyLine = (artifactId: string, filePath: string, line: number): boolean => {
    if (!index) return false;
    const key = artifactFileKey(artifactId, filePath);
    if (!sourceLines.has(key)) sourceLines.set(key, indexedSource(index, { artifactId, filePath })?.split('\n'));
    const text = sourceLines.get(key)?.[line - 1];
    return text !== undefined && !hasMeaningfulCode([text]);
  };
  // A value flow that reaches the operation by confirmed steps, where only an origin further back could not be followed.
  const OPEN_ORIGIN_REASONS: ReadonlyArray<ContextWitnessPath['failureReason']> = ['NO_COMPLETE_PATH', 'DYNAMIC_DISPATCH', 'EXTERNAL_BOUNDARY'];
  const reachesWithOpenOrigin = (path: ContextWitnessPath): boolean => path.context === 'LINK' && !path.complete && OPEN_ORIGIN_REASONS.includes(path.failureReason)
    && path.sink !== undefined && path.steps.length > 0 && path.steps.every((step) => step.evidence === 'CONFIRMED' || step.evidence === 'CONFIRMED_ASYNC');
  const supportFor = (groupId: string, context: ContextCode, shown: readonly Shown[]): WitnessSupport => {
    // When the index itself is unavailable, retain the documented score/confidence fallback;
    // PROGRAM_INDEX_UNAVAILABLE is already recorded separately and is not evidence about this Finding.
    if (!index) return 'PROBABLE';
    const group = groups.find((item) => item.groupId === groupId);
    if (!group) return 'UNRESOLVED';
    // The weakest Finding decides. Per Finding: a confirmed path (from a start that runs on its own, else from one someone has to
    // run or call), else its whole statement in the slices, else a path with probable steps.
    const order: WitnessSupport[] = ['CONFIRMED', 'CONDITIONAL_START', 'DIRECT', 'PROBABLE', 'UNRESOLVED'];
    const recorded = executionEvidence.find((item) => item.groupId === groupId)?.findings ?? [];
    let support: WitnessSupport = 'CONFIRMED';
    for (const findingId of group.findingIds) {
      const complete = witnessPaths.filter((path) => path.groupId === groupId && path.context === context
        && path.findingId === findingId && path.complete && !registeredOnly(path) && requiredBy(path).every((statement) => shownIn(shown, statement, emptyLine)));
      const statement = recorded.find((item) => item.findingId === findingId)?.statement;
      const direct = DIRECT_EVIDENCE_CONTEXTS.includes(context) && statement != null
        && shownIn(shown, { artifactId: group.artifactId, filePath: group.filePath, startLine: statement.startLine, endLine: statement.endLine }, emptyLine);
      const probable = complete.some((path) => context !== 'TRIGGER' || path.probableEdgeCount <= CONTEXT_CHECK_LIMITS.triggerProbableMaxEdges)
        || witnessPaths.some((path) => path.groupId === groupId && path.findingId === findingId && reachesWithOpenOrigin(path)
          && requiredBy(path).every((statement) => shownIn(shown, statement, emptyLine)));
      const confirmed = complete.filter((path) => path.probableEdgeCount === 0);
      const runsOnItsOwn = context !== 'TRIGGER' || confirmed.some((path) => path.rootKind === undefined || SELF_STARTING_ROOTS.includes(path.rootKind));
      const own: WitnessSupport = confirmed.length > 0 ? (runsOnItsOwn ? 'CONFIRMED' : 'CONDITIONAL_START') : direct ? 'DIRECT' : probable ? 'PROBABLE' : 'UNRESOLVED';
      if (order.indexOf(own) > order.indexOf(support)) support = own;
    }
    return support;
  };
  const sliceErrors = (shown: readonly Shown[]): WitnessSliceError[] => witnessPaths.flatMap((path) => {
    if (!path.complete || (path.outcome !== 'ADDED' && path.outcome !== 'ALREADY_IN_SLICES')) return [];
    const missing = requiredBy(path).filter((statement) => !shownIn(shown, statement));
    return missing.length === 0 ? [] : [{
      groupId: path.groupId, context: path.context, pathId: path.pathId,
      reason: 'SELECTED_WITNESS_NOT_IN_SLICES' as const, missing,
    }];
  });
  return { supportFor, sliceErrors };
}
