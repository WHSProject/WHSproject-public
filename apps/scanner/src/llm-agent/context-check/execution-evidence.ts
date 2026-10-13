import type { Tier3ExecutionInput } from '../artifact/agent-analysis-input.contract';
import { ArtifactReadError, readArtifactSource } from '../artifact/code-slice.factory';
import type { AgentCodeSlice } from '../artifact/artifact.contract';
import { createParseCache, executionPathTo, findingStatement, weakestPosition, type CodeRange } from './code-units';
import { isLifecycleManifest, type ExpansionCandidate, type FindingGroup, type GroupExecutionEvidence, type TriggerReachRecord } from './context-check.contract';
import { entryPointsAt, lifecycleScriptsRunning } from './expansion-candidates';
import type { PackageProgramIndex } from './program-index/program-index';
import type { TriggerWitness } from './program-index/program-index.contract';
import { findTriggerWitnesses } from './program-index/trigger-witness';

/** A statement around a call site is quoted with it up to this many lines; beyond that only the call statement is. */
const MAX_CALL_WRAPPER_LINES = 20;

export interface ExecutionEvidenceInput {
  groups: readonly FindingGroup[];
  execution: Tier3ExecutionInput;
  maxFileSizeBytes: number;
  /** Whole-package index, when it was built: adds the path across files to every Finding and shares its parsed files. */
  index?: PackageProgramIndex;
  signal?: AbortSignal;
}

/** The record of a witness: positions and names only. */
export function reachRecord(witness: TriggerWitness): TriggerReachRecord {
  return {
    status: witness.status, evidence: witness.evidence, asyncBoundary: witness.asyncBoundary,
    ...(witness.root === undefined ? {} : { root: { kind: witness.root.kind, name: witness.root.name, filePath: witness.root.filePath } }),
    steps: witness.steps.map((step) => ({
      kind: step.kind, artifactId: step.site.artifactId, filePath: step.site.filePath, startLine: step.site.startLine, endLine: step.site.endLine,
      ...(step.calleeSymbol === undefined ? {} : { calleeSymbol: step.calleeSymbol }), evidence: step.evidence,
      ...(step.callbackKind === undefined ? {} : { callbackKind: step.callbackKind }),
      ...(step.within === undefined ? {} : { within: { kind: step.within.kind, startLine: step.within.startLine, endLine: step.within.endLine } }),
      ...(step.unresolvedReason === undefined ? {} : { unresolvedReason: step.unresolvedReason }),
      ...(step.basis === undefined ? {} : { basis: step.basis }),
      ...(step.registeredAt === undefined ? {} : { registeredAt: { filePath: step.registeredAt.filePath, startLine: step.registeredAt.startLine, endLine: step.registeredAt.endLine } }),
      ...(step.executedAt === undefined ? {} : { executedAt: { filePath: step.executedAt.filePath, startLine: step.executedAt.startLine, endLine: step.executedAt.endLine } }),
    })),
    statements: witness.statements.map(({ artifactId, filePath, startLine, endLine }) => ({ artifactId, filePath, startLine, endLine })),
    ...(witness.incomplete === undefined ? {} : { incompleteReason: witness.incomplete.reason }),
    exploredDepth: witness.exploredDepth, probableEdgeCount: witness.probableEdgeCount, limits: [...witness.limitations],
    // Whether the answer settles an eligible path is decided once the model has answered.
    conditional: { eligible: witness.conditional.eligible, resolved: false, reason: witness.conditional.reason },
  };
}

/**
 * What Scanner can establish statically about how each Finding of a group is
 * reached: which lifecycle scripts and entry points load its file, and the
 * path inside the file from the load to the Finding's line. Nothing is assumed:
 * a Finding without a line, in a file that cannot be read or parsed, or behind
 * a call the file does not show stays UNKNOWN. The group's position is the
 * least certain one among its Findings.
 */
export async function resolveExecutionEvidence(input: ExecutionEvidenceInput): Promise<GroupExecutionEvidence[]> {
  const { execution } = input;
  const parsed = input.index?.parseCache ?? createParseCache();
  const sources = new Map<string, string | undefined>();
  const sourceOf = async (group: FindingGroup): Promise<string | undefined> => {
    const key = `${group.artifactId}:${group.filePath}`;
    if (sources.has(key)) return sources.get(key);
    let code: string | undefined;
    try {
      const source = await readArtifactSource(execution.artifacts, group.artifactId, group.filePath, input.maxFileSizeBytes, input.signal);
      code = source.lines.slice(0, source.lineCount).join('\n');
    } catch (error) {
      if (!(error instanceof ArtifactReadError)) throw error;
    }
    sources.set(key, code);
    return code;
  };
  const rules = new Map(execution.findings.map((finding) => [finding.findingId, finding.ruleId]));

  const evidence: GroupExecutionEvidence[] = [];
  for (const group of input.groups) {
    if (isLifecycleManifest(group.filePath)) continue;
    const code = await sourceOf(group);
    const findings = group.findingIds.map((findingId) => {
      const binding = execution.bindings.findingBindings
        .find((item) => item.findingId === findingId && item.artifactId === group.artifactId && item.filePath === group.filePath);
      const startLine = typeof binding?.startLine === 'number' ? binding.startLine : null;
      const endLine = typeof binding?.endLine === 'number' ? binding.endLine : startLine;
      const path = code === undefined || startLine === null || endLine === null
        ? { position: 'UNKNOWN' as const, steps: [{ kind: 'UNKNOWN' as const }], callbackStartsOnLine: undefined }
        : executionPathTo(code, { startLine, endLine }, parsed);
      const statement = code === undefined || startLine === null || endLine === null ? undefined : findingStatement(code, { startLine, endLine }, parsed);
      // The path across files is an addition: a failure there leaves the single-file result as it is.
      let reach: TriggerReachRecord | undefined;
      let alternatives: TriggerReachRecord[] = [];
      if (input.index && startLine !== null && endLine !== null) {
        try {
          [reach, ...alternatives] = findTriggerWitnesses(input.index, { artifactId: group.artifactId, filePath: group.filePath }, { startLine, endLine }).map(reachRecord);
        } catch (error) {
          if (input.signal?.aborted) throw error;
        }
      }
      return { findingId, ruleId: rules.get(findingId) ?? '', startLine, statement: statement ?? null, position: path.position, steps: path.steps,
        ...(path.callbackStartsOnLine === true ? { callbackStartsOnLine: true as const } : {}), ...(reach === undefined ? {} : { reach }),
        ...(alternatives.length === 0 ? {} : { reachAlternatives: alternatives }) };
    });
    evidence.push({
      groupId: group.groupId, filePath: group.filePath, behavior: group.behavior,
      runByLifecycle: lifecycleScriptsRunning(execution.packageContext, group.filePath),
      runAsEntryPoint: entryPointsAt(execution.packageContext, group.filePath),
      position: weakestPosition(findings.map((finding) => finding.position)),
      findings,
    });
  }
  return evidence;
}

/**
 * The statements on the way from the file load to each Finding that the
 * supplied slices do not hold: the call statement of every confirmed `CALL`
 * step, and the Finding's own statement. Only groups that ask TRIGGER get them.
 * Each is one complete statement and one candidate, so validation applies the
 * usual limits (lines, targets, statement length) and never repeats code. An
 * immediately invoked function and a callback registration are not offered:
 * they hold the Finding's body rather than lead to it.
 */
export function executionPathCandidates(
  groups: readonly FindingGroup[], evidence: readonly GroupExecutionEvidence[], slices: readonly AgentCodeSlice[],
): ExpansionCandidate[] {
  const candidates: ExpansionCandidate[] = [];
  for (const group of groups) {
    if (!group.contexts.includes('TRIGGER')) continue;
    const found = evidence.find((item) => item.groupId === group.groupId);
    if (!found) continue;
    const shown = (range: CodeRange, artifactId: string, filePath: string) => {
      const covered = slices.filter((slice) => slice.artifactId === artifactId && slice.filePath === filePath);
      for (let line = range.startLine; line <= range.endLine; line += 1) {
        if (!covered.some((slice) => line >= slice.startLine && line <= slice.endLine)) return false;
      }
      return true;
    };
    const seen = new Set<string>();
    const offer = (
      range: CodeRange | null | undefined, pathPurpose: 'CALL_SITE' | 'FINDING_STATEMENT', symbol?: string,
      artifactId = group.artifactId, filePath = group.filePath,
    ) => {
      if (!range || shown(range, artifactId, filePath)) return;
      const key = `${artifactId}\u0000${filePath}\u0000${range.startLine}:${range.endLine}`;
      if (seen.has(key)) return;
      seen.add(key);
      candidates.push({
        groupId: group.groupId, context: 'TRIGGER', state: 'PARTIAL', kind: 'EXECUTION_PATH', depth: 1, artifactId, filePath,
        startLine: range.startLine, endLine: range.endLine, units: [{ startLine: range.startLine, endLine: range.endLine, executable: true }], statementAligned: true,
        pathPurpose, ...(symbol === undefined ? {} : { symbol }),
      });
    };
    // Call sites first: they are what connects the file load to the code already in the slices.
    for (const finding of found.findings) {
      // A call made under a condition, in a loop or in a try block is offered with that statement, unless it is long.
      for (const step of finding.steps) {
        if (step.kind !== 'CALL') continue;
        const wrapper = step.within && step.within.endLine - step.within.startLine + 1 <= MAX_CALL_WRAPPER_LINES ? step.within : undefined;
        offer(wrapper ? { startLine: wrapper.startLine, endLine: wrapper.endLine } : step.statement, 'CALL_SITE', step.symbol);
      }
    }
    for (const finding of found.findings) offer(finding.statement, 'FINDING_STATEMENT');
    // A path across files that is confirmed end to end: its statements in the other files, root first.
  }
  return candidates;
}
