import type { AgentCodeSlice } from '../artifact/artifact.contract';
import type { CandidateValidationResult } from './candidate-validation';
import type {
  ContextState, ContextWitnessPath, ExpansionCandidate, ExplorationClass, TriggerReachRecord, WitnessFailureReason,
} from './context-check.contract';
import { contiguousBlocks } from './expansion-candidates';
import { isConfirmed, statementKey } from './program-index/program-index.contract';

type Statement = ContextWitnessPath['statements'][number];
const DYNAMIC_REASONS = new Set(['PARAMETER', 'COMPUTED_PROPERTY', 'CALLBACK_PASSED_ON', 'UNKNOWN_CALLEE', 'THIS', 'INHERITED_METHOD', 'CONSTRUCTOR_ARGUMENT']);

/** A TRIGGER witness as a path: complete when a root is reached. */
export function triggerPath(groupId: string, findingId: string, reach: TriggerReachRecord): ContextWitnessPath {
  const steps = reach.steps.map((step) => ({ kind: step.kind as string, evidence: step.evidence, ...(step.basis === undefined ? {} : { basis: step.basis }),
    statement: { artifactId: step.artifactId, filePath: step.filePath, startLine: step.startLine, endLine: step.endLine } }));
  const last = reach.steps.at(-1);
  const failureReason: WitnessFailureReason | undefined = reach.status === 'CONFIRMED' ? undefined
    : reach.limits.includes('DEPTH_LIMIT') ? 'DEPTH_LIMIT'
      : reach.incompleteReason !== 'UNRESOLVED_EDGE' ? 'NO_COMPLETE_PATH'
        : last?.callbackKind === 'TIMER_CALLBACK' || last?.callbackKind === 'EXTERNAL_EVENT_CALLBACK' ? 'EXTERNAL_BOUNDARY'
          : last?.callbackKind === 'UNKNOWN_CALLBACK' || DYNAMIC_REASONS.has(last?.unresolvedReason ?? '') ? 'DYNAMIC_DISPATCH' : 'NO_COMPLETE_PATH';
  return {
    pathId: '', context: 'TRIGGER', groupId, findingId, complete: failureReason === undefined, steps,
    confirmedEdgeCount: steps.filter((step) => isConfirmed(step.evidence)).length,
    confirmedAsyncEdgeCount: steps.filter((step) => step.evidence === 'CONFIRMED_ASYNC').length, probableEdgeCount: reach.probableEdgeCount, depth: steps.length,
    statements: reach.statements.map((item) => ({ ...item })), ...(failureReason === undefined ? {} : { failureReason }),
    ...(reach.root === undefined ? {} : { rootKind: reach.root.kind }),
    newTargetCount: 0, newLineCount: 0, outcome: 'NOT_NEEDED',
  };
}

export interface PathRequest {
  path: ContextWitnessPath;
  state: Exclude<ContextState, 'VISIBLE'>;
  pathPurpose?: ExpansionCandidate['pathPurpose'];
  kind?: ExpansionCandidate['kind'];
  exploration?: ExplorationClass;
  answer?: { score: number; confidence: number };
}

export interface WitnessSelectionInput {
  /** Tiers in priority order. The paths of one group and context form a unit; a unit takes the place of its first tier. */
  tiers: readonly (readonly PathRequest[])[];
  slices: readonly AgentCodeSlice[];
  /** Candidates accepted before this selection; they keep their place in front and their lines count as supplied. */
  accepted: readonly ExpansionCandidate[];
  validate(candidates: readonly ExpansionCandidate[]): Promise<CandidateValidationResult>;
  /** What the expansion may add in all. */
  budget: { lines: number; targets: number };
  /** Counter for `selectionOrder`, shared by the selections of one check. */
  order?: { next: number };
}

/** The lines of a statement that nothing supplied holds yet, as ranges; the rest of it is already there. */
export function uncovered(ranges: readonly Statement[], statement: Statement): Statement[] {
  const same = ranges.filter((item) => item.artifactId === statement.artifactId && item.filePath === statement.filePath);
  const runs: Statement[] = [];
  for (let line = statement.startLine; line <= statement.endLine; line += 1) {
    if (same.some((item) => line >= item.startLine && line <= item.endLine)) continue;
    const last = runs.at(-1);
    if (last && last.endLine === line - 1) last.endLine = line;
    else runs.push({ artifactId: statement.artifactId, filePath: statement.filePath, startLine: line, endLine: line });
  }
  return runs;
}
const ratio = (path: ContextWitnessPath): number => (path.depth === 0 ? 1 : path.confirmedEdgeCount / path.depth);
const lineCount = (statements: readonly Statement[]): number => statements.reduce((sum, item) => sum + item.endLine - item.startLine + 1, 0);
/** A partially supplied statement is still requested whole so syntax and budget selection stay atomic. */
const missingStatements = (ranges: readonly Statement[], statements: readonly Statement[]): Statement[] => (
  statements.filter((statement) => uncovered(ranges, statement).length > 0)
);
const unitsOf = (candidates: readonly ExpansionCandidate[]): Statement[] => (
  candidates.flatMap((candidate) => candidate.units.map((unit) => ({ artifactId: candidate.artifactId, filePath: candidate.filePath, startLine: unit.startLine, endLine: unit.endLine })))
);

interface Queued { request: PathRequest; alternative: boolean }
interface Unit { queue: Queued[]; requests: PathRequest[] }

/**
 * Ranks the complete paths of one group and context: confirmed steps only,
 * fewer probable steps, larger confirmed share, fewer new lines, shorter. The
 * best path of every Finding comes before any Finding's alternatives. A path
 * with the statements or the sink of a better one is dropped.
 */
function rankUnit(unit: Unit, slices: readonly AgentCodeSlice[]): void {
  const pending = (path: ContextWitnessPath) => lineCount(missingStatements(slices, path.statements));
  const complete: PathRequest[] = [];
  const perFinding = new Map<string, number>();
  for (const request of unit.requests) {
    const { path } = request;
    // A path added by an earlier selection is its Finding's first one; what follows is an alternative.
    if (path.outcome === 'ADDED') { perFinding.set(path.findingId, (perFinding.get(path.findingId) ?? 0) + 1); continue; }
    if (path.complete) { complete.push(request); continue; }
    path.outcome = 'NOT_ADDED';
    path.exclusionReason = path.failureReason ?? 'NO_COMPLETE_PATH';
  }
  complete.sort((left, right) => (
    Math.min(left.path.probableEdgeCount, 1) - Math.min(right.path.probableEdgeCount, 1) || left.path.probableEdgeCount - right.path.probableEdgeCount
    || ratio(right.path) - ratio(left.path) || pending(left.path) - pending(right.path) || left.path.depth - right.path.depth
  ));
  const ordinal = new Map<PathRequest, number>();
  for (const request of complete) {
    const position = perFinding.get(request.path.findingId) ?? 0;
    ordinal.set(request, position);
    perFinding.set(request.path.findingId, position + 1);
  }
  const ordered = complete.map((request, position) => ({ request, position }))
    .sort((left, right) => ordinal.get(left.request)! - ordinal.get(right.request)! || left.position - right.position).map(({ request }) => request);
  const seen = new Set<string>();
  for (const [position, request] of ordered.entries()) {
    const { path } = request;
    path.rank = position + 1;
    delete path.exclusionReason;
    // Paths are the same only when their statements are; several may end at one sink.
    const keys = path.statements.length > 0 ? [`S:${path.statements.map(statementKey).sort().join('|')}`] : [];
    if (keys.some((key) => seen.has(key))) {
      path.outcome = 'NOT_ADDED';
      path.exclusionReason = 'DUPLICATE_PATH';
      continue;
    }
    for (const key of keys) seen.add(key);
    unit.queue.push({ request, alternative: ordinal.get(request)! > 0 });
  }
}

/**
 * Adds complete paths whole or not at all. Each path's missing statements are
 * tried through the candidate validator together with what was accepted so
 * far; the path is taken only when every one of them is selected in full.
 *
 * The units (group and context) take turns, one path each: first every unit's
 * best path, the ones that need the fewest lines first so that as many units
 * as possible get one, then the next paths in order. An alternative path is
 * added only for lines the slices do not hold yet.
 */
export async function selectWitnessPaths(input: WitnessSelectionInput): Promise<ExpansionCandidate[]> {
  const accepted: ExpansionCandidate[] = [...input.accepted];
  const added: ExpansionCandidate[] = [];
  const order = input.order ?? { next: 1 };
  const units = new Map<string, Unit>();
  for (const tier of input.tiers) {
    for (const request of tier) {
      const key = `${request.path.groupId}\u0000${request.path.context}`;
      const unit = units.get(key) ?? { queue: [], requests: [] };
      units.set(key, unit);
      if (!unit.requests.some((item) => item.path === request.path)) unit.requests.push(request);
    }
  }
  const turns = [...units.values()];
  for (const unit of turns) rankUnit(unit, input.slices);
  // The operation a path ends at belongs to the path even when no step leads there: a Finding line outside the slices has to be added.
  const neededBy = (path: ContextWitnessPath) => (path.sink === undefined || path.statements.some((item) => statementKey(item) === statementKey(path.sink!))
    ? path.statements
    : [...path.statements, { artifactId: path.sink.artifactId, filePath: path.sink.filePath, startLine: path.sink.startLine, endLine: path.sink.endLine }]);
  const need = (queued: Queued | undefined): number => (queued === undefined ? 0
    : lineCount(missingStatements(input.slices, neededBy(queued.request.path))));

  const attempt = async ({ request, alternative }: Queued): Promise<void> => {
    const { path } = request;
    const missing = missingStatements([...input.slices, ...unitsOf(accepted)], neededBy(path));
    const covered = () => {
      path.outcome = alternative ? 'NOT_ADDED' : 'ALREADY_IN_SLICES';
      path.exclusionReason = alternative ? 'DUPLICATE_EVIDENCE' : 'ALREADY_IN_SLICES';
    };
    if (missing.length === 0) { covered(); return; }
    const candidates: ExpansionCandidate[] = contiguousBlocks(missing).map((block) => ({
      groupId: path.groupId, context: path.context, state: request.state, kind: request.kind ?? 'WITNESS_PATH', depth: 1,
      artifactId: block[0]!.artifactId, filePath: block[0]!.filePath, startLine: block[0]!.startLine, endLine: Math.max(...block.map((item) => item.endLine)),
      units: block.map((item) => ({ startLine: item.startLine, endLine: item.endLine, executable: true })), statementAligned: true,
      ...(request.pathPurpose === undefined ? {} : { pathPurpose: request.pathPurpose }),
      ...(request.exploration === undefined ? {} : { exploration: request.exploration }),
      ...(request.answer === undefined ? {} : { answer: request.answer }),
    }));
    const trial = await input.validate([...accepted, ...candidates]);
    const entries = trial.trace.slice(accepted.length);
    // What is left of a statement may be a closing brace alone; there is nothing in it to show.
    const empty = (position: number) => entries[position]!.exclusionReason === 'NO_MEANINGFUL_CODE';
    const failed = entries.find((entry, position) => !empty(position) && (!entry.selected
      || entry.selectedStartLine !== candidates[position]!.startLine || entry.selectedEndLine !== candidates[position]!.endLine));
    if (failed) {
      path.outcome = 'NOT_ADDED';
      path.failureReason = failed.exclusionReason === 'TARGET_LIMIT' ? 'TARGET_BUDGET'
        : failed.selected || failed.exclusionReason === 'LINE_BUDGET_EXCEEDED' || failed.exclusionReason === 'PARTIAL_STATEMENT' ? 'LINE_BUDGET' : 'NO_COMPLETE_PATH';
      path.exclusionReason = path.failureReason;
      return;
    }
    const taken = candidates.filter((_, position) => !empty(position));
    if (taken.length === 0) { covered(); return; }
    path.outcome = 'ADDED';
    path.newTargetCount = taken.length;
    path.newLineCount = lineCount(taken);
    path.selectionOrder = order.next;
    order.next += 1;
    accepted.push(...taken);
    added.push(...taken);
  };

  const rounds = Math.max(0, ...turns.map((unit) => unit.queue.length));
  for (let round = 0; round < rounds; round += 1) {
    const order = round === 0 ? turns.map((unit, position) => ({ unit, position }))
      .sort((left, right) => need(left.unit.queue[0]) - need(right.unit.queue[0]) || left.position - right.position).map(({ unit }) => unit) : turns;
    for (const unit of order) {
      const queued = unit.queue[round];
      if (queued) await attempt(queued);
    }
  }
  return added;
}
