import {
  representationsForMode,
  type AgentAnalysisMode,
  type AgentCodeSlice,
  type ArtifactResolver,
  type ValidatedPlanningTarget,
} from '../artifact/artifact.contract';
import { ArtifactReadError, readArtifactSource } from '../artifact/code-slice.factory';
import { hasMeaningfulCode } from './code-units';
import {
  artifactFileKey,
  CONTEXT_CHECK_LIMITS,
  CONTEXT_TARGET_ID_PREFIX,
  questionKey,
  type CandidateExclusionReason,
  type CandidateTraceEntry,
  type ExpansionCandidate,
  type FindingGroup,
} from './context-check.contract';

export interface CandidateValidationInput {
  candidates: readonly ExpansionCandidate[];
  groups: readonly FindingGroup[];
  slices: readonly AgentCodeSlice[];
  resolver: ArtifactResolver;
  analysisMode: AgentAnalysisMode;
  /** Slices the INITIAL slice limit still allows after the slices already built. */
  remainingSlices: number;
  /** Lines the expansion may add in total, first and second hop together. */
  remainingLines: number;
  maxFileSizeBytes: number;
  /** Measurement-only overrides. Omitted values preserve product limits. */
  maxTargets?: number;
  maxLinesPerCandidate?: number;
  /** Files read by earlier validations of the same check; a path is tried many times and its files stay the same. */
  sourceCache?: Map<string, { lines: string[]; filePath: string } | null>;
  signal?: AbortSignal;
}

/** What became of one candidate's statements, in candidate order. */
export interface CandidateOutcome {
  /** Target created for the candidate. */
  targetId: string | null;
  /** Targets of other contexts that already hold all of the candidate's new statements. */
  creditedTargetIds: string[];
  /** All of the candidate's statements are in the supplied slices. */
  alreadySupplied: boolean;
}

export interface CandidateValidationResult {
  targets: ValidatedPlanningTarget[];
  /** Question keys of the contexts each target was added for (a target can serve several). */
  contextsByTarget: Map<string, string[]>;
  /** One entry per candidate, in candidate order: selected, or why not. */
  trace: CandidateTraceEntry[];
  /** One entry per candidate, in candidate order. */
  outcomes: CandidateOutcome[];
}

interface Range { startLine: number; endLine: number }
type Unit = ExpansionCandidate['units'][number];
const lineCount = (range: Range): number => range.endLine - range.startLine + 1;
const overlaps = (left: Range, right: Range): boolean => left.startLine <= right.endLine && left.endLine >= right.startLine;

/**
 * New statements that sit next to each other with no already-supplied line
 * between them. Each run can become one target without repeating code that is
 * already there; a single statement may still overlap supplied lines, because
 * a statement is only ever offered whole.
 */
function runsOf(units: readonly Unit[], covered: readonly Range[]): Unit[][] {
  const runs: Unit[][] = [];
  for (const unit of units) {
    const run = runs.at(-1);
    const previous = run?.at(-1);
    const gap = previous && unit.startLine > previous.endLine + 1 ? { startLine: previous.endLine + 1, endLine: unit.startLine - 1 } : undefined;
    const blocked = gap !== undefined && covered.some((item) => overlaps(item, gap));
    if (run && previous && !blocked) run.push(unit);
    else runs.push([unit]);
  }
  return runs;
}

/** Longest prefix of `run` whose span fits `limit` lines. */
function prefixWithin(run: readonly Unit[], limit: number): Unit[] {
  const taken: Unit[] = [];
  for (const unit of run) {
    if (unit.endLine - (taken[0] ?? unit).startLine + 1 > limit) break;
    taken.push(unit);
  }
  return taken;
}

/**
 * Turns candidates into Plan targets for the Slice Builder. Candidates arrive in
 * priority order, so limits simply stop accepting. Only complete statements that
 * hold code and are not yet supplied are selected; a candidate that offers none,
 * or whose statements do not fit, uses neither a target nor any lines. A
 * candidate whose statements were just accepted for another context still
 * counts as serving its own context.
 */
export async function validateExpansionCandidates(input: CandidateValidationInput): Promise<CandidateValidationResult> {
  const allowed = representationsForMode(input.analysisMode);
  const groups = new Map(input.groups.map((group) => [group.groupId, group]));
  const initial = new Map<string, Range[]>();
  for (const slice of input.slices) {
    const key = artifactFileKey(slice.artifactId, slice.filePath);
    initial.set(key, [...(initial.get(key) ?? []), { startLine: slice.startLine, endLine: slice.endLine }]);
  }
  const accepted = new Map<string, Array<Range & { targetId: string }>>();
  const result: CandidateValidationResult = { targets: [], contextsByTarget: new Map(), trace: [], outcomes: [] };
  const maxTargets = Math.min(input.maxTargets ?? CONTEXT_CHECK_LIMITS.maxExpansionTargets, input.remainingSlices);
  const maxLinesPerCandidate = input.maxLinesPerCandidate ?? CONTEXT_CHECK_LIMITS.maxLinesPerCandidate;
  let { remainingLines } = input;

  const record = (
    candidate: ExpansionCandidate, exclusionReason: CandidateExclusionReason | null, selected?: Range, filePath = candidate.filePath,
    outcome: Partial<CandidateOutcome> = {},
  ) => {
    result.outcomes.push({ targetId: null, creditedTargetIds: [], alreadySupplied: false, ...outcome });
    const offered = { startLine: candidate.startLine, endLine: candidate.endLine };
    result.trace.push({
      groupId: candidate.groupId, context: candidate.context, depth: candidate.depth, kind: candidate.kind,
      artifactId: candidate.artifactId, filePath,
      candidateStartLine: offered.startLine, candidateEndLine: offered.endLine,
      selectedStartLine: selected?.startLine ?? null, selectedEndLine: selected?.endLine ?? null,
      lineCount: Math.max(0, lineCount(selected ?? offered)),
      ...(candidate.symbol === undefined ? {} : { symbol: candidate.symbol }),
      selected: exclusionReason === null, exclusionReason,
      lowConfidenceMissing: candidate.exploration === 'LOW_CONFIDENCE_MISSING',
      score: candidate.answer?.score ?? null, confidence: candidate.answer?.confidence ?? null,
    });
  };
  const credit = (targetId: string, contextKey: string) => {
    const contexts = result.contextsByTarget.get(targetId) ?? [];
    if (!contexts.includes(contextKey)) result.contextsByTarget.set(targetId, [...contexts, contextKey]);
  };

  for (const candidate of input.candidates) {
    input.signal?.throwIfAborted();
    if (candidate.exclusion) { record(candidate, candidate.exclusion); continue; }
    const group = groups.get(candidate.groupId);
    const artifact = input.resolver.describe(candidate.artifactId);
    if (!group || !artifact || !allowed.includes(artifact.representation)) { record(candidate, 'UNSUPPORTED_ARTIFACT'); continue; }
    const contextKey = questionKey(candidate.groupId, candidate.context);

    const sourceKey = artifactFileKey(candidate.artifactId, candidate.filePath);
    let source = input.sourceCache?.get(sourceKey);
    if (source === undefined) {
      try {
        const read = await readArtifactSource(input.resolver, candidate.artifactId, candidate.filePath, input.maxFileSizeBytes, input.signal);
        source = { lines: read.lines, filePath: read.filePath };
      } catch (error) {
        if (!(error instanceof ArtifactReadError)) throw error;
        source = null;
      }
      input.sourceCache?.set(sourceKey, source);
    }
    if (source === null) { record(candidate, 'FILE_READ_FAILED'); continue; }
    const { lines, filePath } = source;
    const validUnit = (unit: Range) => Number.isSafeInteger(unit.startLine) && Number.isSafeInteger(unit.endLine)
      && unit.startLine >= 1 && unit.endLine >= unit.startLine && unit.endLine <= lines.length;
    if (!candidate.units.every(validUnit)) { record(candidate, 'INVALID_RANGE', undefined, filePath); continue; }

    const meaningful = candidate.units.filter((unit) => hasMeaningfulCode(lines.slice(unit.startLine - 1, unit.endLine)));
    if (meaningful.length === 0) { record(candidate, 'NO_MEANINGFUL_CODE', undefined, filePath); continue; }

    const key = artifactFileKey(candidate.artifactId, filePath);
    const supplied = initial.get(key) ?? [];
    const alreadyAccepted = accepted.get(key) ?? [];
    const covered = [...supplied, ...alreadyAccepted];
    // A statement counts as held once every line of it that holds code is: a closing brace left over is not new code.
    const inside = (range: Range, ranges: readonly Range[]): boolean => {
      for (let line = range.startLine; line <= range.endLine; line += 1) {
        if (!ranges.some((item) => line >= item.startLine && line <= item.endLine) && hasMeaningfulCode([lines[line - 1] ?? ''])) return false;
      }
      return true;
    };
    // Statements that another context's target already holds serve this context too.
    const credited = new Set<string>();
    for (const unit of meaningful.filter((item) => inside(item, covered) && !inside(item, supplied))) {
      for (const target of alreadyAccepted.filter((item) => overlaps(item, unit))) { credit(target.targetId, contextKey); credited.add(target.targetId); }
    }
    const fresh = meaningful.filter((unit) => !inside(unit, covered));
    if (fresh.length === 0) {
      const alreadySupplied = meaningful.every((unit) => inside(unit, supplied));
      record(candidate, alreadySupplied ? 'ALREADY_COVERED' : 'DUPLICATE', undefined, filePath, { alreadySupplied, creditedTargetIds: [...credited] });
      continue;
    }
    if (result.targets.length >= maxTargets) { record(candidate, 'TARGET_LIMIT', undefined, filePath); continue; }

    // Lifecycle and entry candidates prefer statements that run at load time.
    const runs = runsOf(fresh, covered);
    const ordered = candidate.kind === 'LIFECYCLE_ENTRY'
      ? [...runs.filter((run) => run.some((unit) => unit.executable)), ...runs.filter((run) => !run.some((unit) => unit.executable))]
      : runs;
    const limit = candidate.kind === 'LIFECYCLE_ENTRY' ? Math.min(maxLinesPerCandidate, CONTEXT_CHECK_LIMITS.maxFallbackLines) : maxLinesPerCandidate;
    const fitting = ordered.map((run) => prefixWithin(run, limit)).find((run) => run.length > 0);
    if (!fitting) { record(candidate, 'PARTIAL_STATEMENT', undefined, filePath); continue; }
    const taken = prefixWithin(fitting, remainingLines);
    if (taken.length === 0) { record(candidate, 'LINE_BUDGET_EXCEEDED', undefined, filePath); continue; }
    const range = { startLine: taken[0]!.startLine, endLine: taken.at(-1)!.endLine };

    const targetId = `${CONTEXT_TARGET_ID_PREFIX}${String(result.targets.length + 1).padStart(3, '0')}`;
    result.targets.push({
      targetId, artifactId: candidate.artifactId, filePath, preferredRange: range, priority: 'MEDIUM',
      findingRefs: [...group.findingIds], evidenceRefs: [],
      reasonCodes: ['CONTEXT_EXPANSION', `CONTEXT_${candidate.context}`, candidate.kind],
    });
    result.contextsByTarget.set(targetId, [contextKey]);
    accepted.set(key, [...alreadyAccepted, { ...range, targetId }]);
    remainingLines -= lineCount(range);
    record(candidate, null, range, filePath, { targetId });
  }
  return result;
}
