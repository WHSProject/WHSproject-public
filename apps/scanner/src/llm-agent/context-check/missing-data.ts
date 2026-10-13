import type { AgentInputV0_3BuildResult } from '../artifact/agent-input-v0_3.builder';
import type { MissingDataV0_3, Tier3ExecutionInput } from '../artifact/agent-analysis-input.contract';
import type { FindingPosition } from './code-units';
import {
  CONTEXT_CHECK_LIMITS, type GroupExecutionEvidence, type PreservedReasonRecord, type RestorationStatusRecord, type SkippedGroupRecord,
} from './context-check.contract';
import { entryPointsAt, lifecycleScriptsRunning, type UnresolvedContext } from './expansion-candidates';

/**
 * Why a context is still reported: nothing was looked up (no budget, a failed
 * expansion), nothing could be added, or code was added but the context is
 * still not fully shown. ADDED_UNCHECKED is the same case without a second
 * rating: only the first rating is known, so the note says no more than that.
 */
export type UnresolvedOutcome = 'NOT_SEARCHED' | 'NOT_ADDED' | 'STILL_UNRESOLVED' | 'ADDED_UNCHECKED';

/** What the package context already says about who runs a group's file: lifecycle scripts and entry points that name it. */
function runFacts(execution: Tier3ExecutionInput, filePath: string): string[] {
  const scripts = lifecycleScriptsRunning(execution.packageContext, filePath);
  const entries = entryPointsAt(execution.packageContext, filePath);
  return [
    ...(scripts.length === 0 ? [] : [`the ${scripts.join(', ')} script runs this file directly`]),
    ...(entries.length === 0 ? [] : [`this file is the package ${entries.join(', ')} entry point`]),
  ];
}

/** What Scanner established about where the group's Findings sit relative to the file load; nothing when it is unknown. */
const POSITION_FACTS: Record<FindingPosition, string | undefined> = {
  TOP_LEVEL: 'the flagged code runs when the file is loaded',
  CALLED_AT_LOAD: 'the flagged code is in a function that is called when the file is loaded',
  CALLBACK: 'the flagged code is in a callback that is registered when the file is loaded, and when that callback fires is not established',
  EXPORTED_NOT_CALLED: 'the flagged code is in a function that is exported and not called in this file',
  UNKNOWN: undefined,
};

export function missingContext(execution: Tier3ExecutionInput, evidence: readonly GroupExecutionEvidence[], outcome: UnresolvedOutcome) {
  return (item: UnresolvedContext): MissingDataV0_3 => {
    const prefix = outcome === 'ADDED_UNCHECKED'
      ? `${item.group.filePath} (${item.group.behavior}): ${item.context} context was ${item.state} at the first check`
      : `${item.group.filePath} (${item.group.behavior}): ${item.context} context is ${item.state} in the supplied slices`;
    const position = POSITION_FACTS[evidence.find((group) => group.groupId === item.group.groupId)?.position ?? 'UNKNOWN'];
    const facts = item.context === 'TRIGGER' ? [...runFacts(execution, item.group.filePath), ...(position === undefined ? [] : [position])] : [];
    const known = facts.map((fact) => `; ${fact}`).join('');
    let detail: string;
    if (outcome === 'ADDED_UNCHECKED') {
      detail = `${known}; code was added afterwards and not rated again, so whether it settles this is not established.`;
    } else if (item.context === 'TRIGGER' && outcome === 'STILL_UNRESOLVED') {
      detail = `${known}; lifecycle or entry code was added, but it does not show a path to this file.`;
    } else if (facts.length > 0) {
      detail = known + (outcome === 'NOT_SEARCHED' ? '; other callers or entry points were not looked up.' : '; no other caller or entry point was found.');
    } else if (outcome === 'STILL_UNRESOLVED') {
      detail = item.context === 'INPUT'
        ? '; code was added, but where the value comes from is still not fully shown.'
        : '; code was added, but the context is still not fully shown.';
    } else {
      detail = ' and no directly linked code could be added.';
    }
    return { field: 'contextCheck', reason: `${prefix}${detail}` };
  };
}

export function withMissingData(built: AgentInputV0_3BuildResult, items: readonly MissingDataV0_3[]): AgentInputV0_3BuildResult {
  if (items.length === 0) return built;
  return { ...built, input: { ...built.input, missingData: [...built.input.missingData, ...items] } };
}

const MAX_LISTED_FINDINGS = 5;
function listFindings(findingIds: readonly string[]): string {
  const listed = findingIds.slice(0, MAX_LISTED_FINDINGS).join(',');
  return findingIds.length > MAX_LISTED_FINDINGS ? `${listed} (+${findingIds.length - MAX_LISTED_FINDINGS} more)` : listed;
}

/** At most `maxNotesPerKind` entries of one kind; whatever is left over becomes one summary line. */
function capped(field: string, reasons: readonly string[], what: string): MissingDataV0_3[] {
  const listed = reasons.slice(0, CONTEXT_CHECK_LIMITS.maxNotesPerKind).map((reason) => ({ field, reason }));
  const rest = reasons.length - listed.length;
  return rest > 0 ? [...listed, { field, reason: `${rest} more ${what} are not listed.` }] : listed;
}

/**
 * What Tier 3 is told about Findings that were not asked about and about
 * reasons that added no context. A group that is simply never asked
 * (PACKAGE_RISK, a plain OBFUSCATION_SIGNAL, a restored file) produces nothing:
 * not asking is not missing data.
 */
export function routingNotes(
  skippedGroups: readonly SkippedGroupRecord[], preservedReasons: readonly PreservedReasonRecord[], restorationStatus: readonly RestorationStatusRecord[],
): MissingDataV0_3[] {
  const unchecked = skippedGroups.map((group) => (
    `${group.filePath} (${group.behavior}): not context-checked; reason=${group.reason}; findings=${listFindings(group.findingIds)}`
  ));
  const restoration = restorationStatus
    .filter((file) => file.status === 'UNRESOLVED' || file.status === 'NOT_SELECTED')
    .map((file) => `${file.filePath}: restoration status=${file.status}; techniques=${file.techniques.join(',') || 'none'}`
      + (file.signalFindingIds.length === 0 ? '' : `; obfuscation signal findings=${listFindings(file.signalFindingIds)}`));
  const reasons = preservedReasons.map((group) => (
    `${group.filePath} (${group.behavior}): static filter reason ${group.reasonCodes.join(', ')} applies; no additional context was requested; findings=${listFindings(group.findingIds)}`
  ));
  return [
    ...capped('contextCheck', unchecked, 'groups that were not context-checked'),
    ...capped('restorationStatus', restoration, 'files with an incomplete restoration'),
    ...capped('staticFilterReason', reasons, 'groups with a preserved static filter reason'),
  ];
}

/**
 * What Tier 3 is told about a path that does not start at install or at the
 * package load: it is a path that can run, and what has to happen for it to run.
 */
export function triggerStartNotes(evidence: readonly GroupExecutionEvidence[]): MissingDataV0_3[] {
  const reasons = evidence.flatMap((group) => {
    const starts = new Set<string>();
    for (const finding of group.findings) {
      const { reach } = finding;
      if (reach?.status !== 'CONFIRMED' || !reach.root) continue;
      if (reach.root.kind === 'SCRIPT') starts.add(`the ${reach.root.name} npm script`);
      else if (reach.root.kind === 'EXPORTED_API') starts.add(`the exported ${reach.root.name}, which a user of the package has to call`);
      else if (reach.root.kind === 'UNREFERENCED') starts.add('code that nothing in the package calls or loads');
      if (reach.steps.some((step) => step.basis?.startsWith('REGISTERED_CALLBACK') === true)) starts.add('a callback that runs when its timer, event or operation fires');
    }
    return starts.size === 0 ? [] : [`${group.filePath} (${group.behavior}): the path Scanner followed to this code starts at ${[...starts].join('; ')}. It is not shown to run at install by itself.`];
  });
  return capped('triggerStart', reasons, 'groups whose path does not start at install');
}
