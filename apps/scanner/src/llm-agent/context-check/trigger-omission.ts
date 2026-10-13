import type { Tier3ExecutionInput } from '../artifact/agent-analysis-input.contract';
import { ArtifactReadError, readArtifactSource } from '../artifact/code-slice.factory';
import { createParseCache, runsAtLoad, type ParseCache } from './code-units';
import type { FindingGroup, LifecycleTriggerQuestion, OmittedQuestionRecord } from './context-check.contract';
import { lifecycleScriptsRunning } from './expansion-candidates';

export interface TriggerOmissionInput {
  groups: readonly FindingGroup[];
  execution: Tier3ExecutionInput;
  mode: LifecycleTriggerQuestion;
  maxFileSizeBytes: number;
  /** Parsed files of the whole-package index, when it was built. */
  parseCache?: ParseCache;
  signal?: AbortSignal;
}

/**
 * The TRIGGER questions that would only ask the model to confirm what Scanner
 * already knows: a lifecycle script runs the group's file itself. By default
 * the question is left out only when every Finding of the group also lies in
 * code that runs when the file is loaded, because TRIGGER asks what makes the
 * flagged operation run, and a Finding inside a function still needs its caller.
 * Whenever that cannot be established (no line numbers, an unreadable or
 * unparsable file) the question is asked. A lifecycle script that merely exists
 * in the package, or an entry point, never leaves a question out.
 */
export async function resolveTriggerOmissions(input: TriggerOmissionInput): Promise<OmittedQuestionRecord[]> {
  if (input.mode === 'ASK') return [];
  const { execution } = input;
  const parsed = input.parseCache ?? createParseCache();
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

  const omitted: OmittedQuestionRecord[] = [];
  for (const group of input.groups) {
    if (!group.contexts.includes('TRIGGER')) continue;
    const scripts = lifecycleScriptsRunning(execution.packageContext, group.filePath);
    if (scripts.length === 0) continue;
    const record = { groupId: group.groupId, filePath: group.filePath, behavior: group.behavior, context: 'TRIGGER' as const, scripts };
    if (input.mode === 'OMIT_WHEN_RUN_BY_LIFECYCLE') { omitted.push({ ...record, reason: 'LIFECYCLE_RUNS_FILE' }); continue; }

    const ranges = group.findingIds.map((findingId) => execution.bindings.findingBindings
      .find((binding) => binding.findingId === findingId && binding.artifactId === group.artifactId && binding.filePath === group.filePath));
    // Scanner Findings often carry a start line only; such a Finding is that one line.
    if (ranges.length === 0 || ranges.some((binding) => typeof binding?.startLine !== 'number')) continue;
    const code = await sourceOf(group);
    if (code === undefined) continue;
    if (ranges.every((binding) => runsAtLoad(code, { startLine: binding!.startLine!, endLine: binding!.endLine ?? binding!.startLine! }, parsed))) {
      omitted.push({ ...record, reason: 'LIFECYCLE_RUNS_FILE_AT_LOAD' });
    }
  }
  return omitted;
}
