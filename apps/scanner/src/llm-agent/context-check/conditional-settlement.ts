import type { MissingDataV0_3 } from '../artifact/agent-analysis-input.contract';
import {
  CONTEXT_CHECK_LIMITS, questionKey,
  type ContextCheckResponse, type FindingGroup, type GroupExecutionEvidence, type InputWitnessRecord,
} from './context-check.contract';
import { contextState } from './context-questions';
import { shownIn, type Shown } from './witness-support';

export interface ConditionalSettlementInput {
  /** The first answers; undefined until the model has answered. */
  answered: ContextCheckResponse | undefined;
  groups: readonly FindingGroup[];
  executionEvidence: readonly GroupExecutionEvidence[];
  inputWitnesses: readonly InputWitnessRecord[];
  finalSlices: readonly Shown[];
}

/**
 * Decides, once the model has answered, whether a path with one probable step is settled: the answer for its
 * context has to be VISIBLE, every statement of the path has to be in the slices, and every other Finding of the group
 * has to be settled on its own. Otherwise the path stays unsettled; a context the model rated VISIBLE keeps that state and is reported as not confirmed.
 */
export function settleConditional({ answered, groups, executionEvidence, inputWitnesses, finalSlices }: ConditionalSettlementInput): MissingDataV0_3[] {
  if (!answered) return [];
  const notes: MissingDataV0_3[] = [];
  for (const group of groups) {
    for (const context of ['TRIGGER', 'INPUT'] as const) {
      const records = context === 'TRIGGER'
        ? (executionEvidence.find((item) => item.groupId === group.groupId)?.findings ?? []).map((finding) => (
          finding.reach ? { conditional: finding.reach.conditional, statements: finding.reach.statements, settled: finding.reach.status === 'CONFIRMED', holder: finding.reach } : undefined
        ))
        : inputWitnesses.filter((item) => item.groupId === group.groupId).map((item) => (
          { conditional: item.conditional, statements: item.statements, settled: item.status !== 'INCOMPLETE', holder: item }
        ));
      const eligible = records.filter((item) => item?.conditional.eligible === true);
      if (eligible.length === 0) continue;
      const answer = answered.answers[questionKey(group.groupId, context)];
      const othersSettled = records.every((item) => item !== undefined && (item.conditional.eligible || item.settled));
      const shown = eligible.every((item) => item!.statements.every((statement) => shownIn(finalSlices, statement)));
      const reason = answer === undefined ? 'NOT_ASKED'
        : !othersSettled ? 'OTHER_FINDING_NOT_SETTLED'
          : !shown ? 'STATEMENTS_NOT_IN_SLICES'
            : answer.score < CONTEXT_CHECK_LIMITS.visibleMinScore ? 'SCORE_BELOW_VISIBLE'
              : contextState(answer) !== 'VISIBLE' ? 'CONFIDENCE_BELOW_CONDITIONAL_MINIMUM' : 'RESOLVED';
      for (const item of eligible) item!.holder.conditional = { eligible: true, resolved: reason === 'RESOLVED', reason };
      if (reason !== 'RESOLVED' && answer !== undefined && contextState(answer) === 'VISIBLE') {
        notes.push({
          field: 'contextCheck',
          reason: `${group.filePath} (${group.behavior}): ${context} context was rated VISIBLE, but the path Scanner followed holds one step that is not established and the answer does not settle it (${reason}); it is not taken as confirmed.`,
        });
      }
    }
  }
  return notes;
}
