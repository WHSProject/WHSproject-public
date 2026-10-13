import type { AgentCodeSlice } from '../artifact/artifact.contract';
import {
  CONTEXT_CHECK_LIMITS, CONTEXT_CODES, ContextCheckProviderError, questionKey,
  type ContextCheckProvider, type ContextCheckRequest, type ContextCode, type ContextRecheckRecord, type ContextStateRecord, type FindingGroup,
  type RecheckOutcome, type RecheckQuestionRecord, type ScannerSettledCheckRecord, type ScoreAnswer,
} from './context-check.contract';
import { contextState, estimateRequestChars } from './context-questions';

/** The contexts whose answer code added for a context can change. */
const AFFECTS: Record<ContextCode, readonly ContextCode[]> = {
  TRIGGER: ['TRIGGER'], INPUT: ['INPUT', 'LINK'], ACTION: ['ACTION', 'LINK'], TARGET: ['TARGET', 'LINK'], LINK: ['LINK'],
};

export interface RecheckInput {
  provider: ContextCheckProvider;
  groups: readonly FindingGroup[];
  /** The first answers. */
  states: readonly ContextStateRecord[];
  /** Questions whose context was given code after the first answer. */
  served: ReadonlySet<string>;
  /** Questions the second answer cannot settle; they are not asked again. */
  excluded?: ReadonlySet<string>;
  /** Questions Scanner settled, asked along in a group's second request for the record. */
  verify?: ReadonlySet<string>;
  /** Whether the code added for a group's INPUT lies on one of its TARGET paths. */
  inputTouchesTarget(groupId: string): boolean;
  /** The final slices a group is asked about again, most needed first. */
  slicesOf(group: FindingGroup): AgentCodeSlice[];
  /** Builds one request for groups whose Findings are in the same artifact file. */
  request(groups: readonly FindingGroup[], slices: readonly AgentCodeSlice[]): ContextCheckRequest;
  /** Final witness-aware policy. Omitted by isolated callers that only test score mapping. */
  stateFor?: (groupId: string, context: ContextCode, answer: ScoreAnswer) => ContextStateRecord['state'];
  signal?: AbortSignal;
}

type Target = Pick<RecheckQuestionRecord, 'context' | 'reason'>;
type RecheckPlan = {
  group: FindingGroup;
  targets: Target[];
  base: Array<Omit<RecheckQuestionRecord, 'outcome' | 'unresolved'>>;
  verified: ContextCode[];
  asked: FindingGroup;
  slices: AgentCodeSlice[];
};

function batchKey(plan: RecheckPlan): string {
  return `${plan.group.artifactId}\u0000${plan.group.filePath}`;
}

function uniqueSlices(plans: readonly RecheckPlan[]): AgentCodeSlice[] {
  const seen = new Set<string>();
  return plans.flatMap((plan) => plan.slices).filter((slice) => {
    const key = `${slice.artifactId}\u0000${slice.sliceId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * The questions asked again, by group: the ones the first answer left PARTIAL
 * or MISSING whose own context, or a context that bears on it, was given code.
 * A VISIBLE answer and a question nothing was added for are never asked again.
 */
export function recheckTargets(input: Pick<RecheckInput, 'states' | 'served' | 'inputTouchesTarget' | 'excluded'>): Map<string, Target[]> {
  const targets = new Map<string, Target[]>();
  for (const state of input.states) {
    if (state.state === 'VISIBLE' || input.excluded?.has(questionKey(state.groupId, state.context)) === true) continue;
    const own = input.served.has(questionKey(state.groupId, state.context));
    const related = !own && CONTEXT_CODES.some((other) => other !== state.context && input.served.has(questionKey(state.groupId, other))
      && (AFFECTS[other].includes(state.context) || (other === 'INPUT' && state.context === 'TARGET' && input.inputTouchesTarget(state.groupId))));
    if (!own && !related) continue;
    targets.set(state.groupId, [...(targets.get(state.groupId) ?? []), { context: state.context, reason: own ? 'CODE_ADDED' : 'RELATED_CONTEXT_ADDED' }]);
  }
  return targets;
}

function outcomeOf(first: ScoreAnswer, second: ScoreAnswer, state: ContextStateRecord['state']): RecheckOutcome {
  if (state === 'VISIBLE') return 'RESOLVED';
  if (second.score < first.score) return 'REGRESSED';
  return second.score > first.score ? 'IMPROVED_UNRESOLVED' : 'UNRESOLVED';
}

/**
 * Asks the provider once more, batching groups in the same artifact file, with
 * the slices the Agent will receive. The questions and criteria are the first
 * call's; the first scores are not sent. A call that fails leaves its questions
 * `RECHECK_UNAVAILABLE`; only an aborted scan throws.
 */
export async function runRecheck(input: RecheckInput): Promise<ContextRecheckRecord> {
  const started = Date.now();
  const usage = { inputTokens: 0, outputTokens: 0 };
  let callCount = 0;
  let failedCallCount = 0;
  let timeoutCallCount = 0;
  let trimmedSliceCount = 0;
  let model: string | undefined;
  const scannerSettled: ScannerSettledCheckRecord[] = [];
  const targetsByGroup = recheckTargets(input);
  const plans: RecheckPlan[] = [...targetsByGroup].map(([groupId, targets]) => {
    const group = input.groups.find((item) => item.groupId === groupId)!;
    const base = targets.map((target) => {
      const state = input.states.find((item) => item.groupId === groupId && item.context === target.context)!;
      return { groupId, context: target.context, reason: target.reason, first: { score: state.score, confidence: state.confidence, state: state.state } };
    });
    const verified = group.contexts.filter((context) => input.verify?.has(questionKey(groupId, context)) === true && !targets.some((target) => target.context === context));
    const asked = { ...group, contexts: group.contexts.filter((context) => targets.some((target) => target.context === context) || verified.includes(context)) };
    return { group, targets, base, verified, asked, slices: input.slicesOf(group) };
  });
  const batches = new Map<string, RecheckPlan[]>();
  for (const plan of plans) {
    const key = batchKey(plan);
    batches.set(key, [...(batches.get(key) ?? []), plan]);
  }
  const unavailable = (plansInCall: readonly RecheckPlan[], failureReason: string): RecheckQuestionRecord[] => plansInCall.flatMap((plan) => (
    plan.base.map((item) => ({ ...item, outcome: 'RECHECK_UNAVAILABLE', failureReason, unresolved: true }))
  ));
  const ask = async (plansInCall: readonly RecheckPlan[]): Promise<RecheckQuestionRecord[]> => {
    let slices = uniqueSlices(plansInCall);
    let request = input.request(plansInCall.map((plan) => plan.asked), slices);
    // Preserve the old per-group behavior if combining otherwise valid requests would cross the input limit.
    if (plansInCall.length > 1 && estimateRequestChars(request) > CONTEXT_CHECK_LIMITS.maxStateChars) {
      return (await Promise.all(plansInCall.map(async (plan) => ask([plan])))).flat();
    }
    // Too large: the least needed slices are left out, about a tenth at a time, until the request fits.
    while (slices.length > 1 && estimateRequestChars(request) > CONTEXT_CHECK_LIMITS.maxStateChars) {
      const kept = slices.length - Math.max(1, Math.floor(slices.length / 10));
      trimmedSliceCount += slices.length - kept;
      slices = slices.slice(0, kept);
      request = input.request(plansInCall.map((plan) => plan.asked), slices);
    }
    if (estimateRequestChars(request) > CONTEXT_CHECK_LIMITS.maxStateChars) return unavailable(plansInCall, 'INPUT_TOO_LARGE');
    callCount += 1;
    try {
      const response = await input.provider.check(request, input.signal);
      model = response.model;
      usage.inputTokens += response.usage.inputTokens ?? 0;
      usage.outputTokens += response.usage.outputTokens ?? 0;
      for (const plan of plansInCall) {
        for (const context of plan.verified) {
          const state = input.states.find((item) => item.groupId === plan.group.groupId && item.context === context)!;
          const answer = response.answers[questionKey(plan.group.groupId, context)];
          scannerSettled.push({
            groupId: plan.group.groupId, context, first: { score: state.score, confidence: state.confidence },
            ...(answer ? { second: { score: answer.score, confidence: answer.confidence } } : {}), agreed: answer !== undefined && answer.score >= CONTEXT_CHECK_LIMITS.visibleMinScore,
          });
        }
      }
      return plansInCall.flatMap((plan) => plan.base.map((item) => {
        const answer = response.answers[questionKey(plan.group.groupId, item.context)];
        if (!answer) return { ...item, outcome: 'RECHECK_UNAVAILABLE', failureReason: 'NO_ANSWER', unresolved: true };
        const state = input.stateFor?.(plan.group.groupId, item.context, answer) ?? contextState(answer);
        const outcome = outcomeOf(item.first, answer, state);
        return { ...item, second: { score: answer.score, confidence: answer.confidence, state }, outcome, unresolved: outcome !== 'RESOLVED' };
      }));
    } catch (error) {
      if (input.signal?.aborted) throw error;
      failedCallCount += 1;
      if (error instanceof ContextCheckProviderError && error.reason === 'TIMEOUT') timeoutCallCount += 1;
      return unavailable(plansInCall, error instanceof ContextCheckProviderError ? error.reason : 'INTERNAL_ERROR');
    }
  };
  const answered = (await Promise.all([...batches.values()].map(ask))).flat();
  const records = new Map(answered.map((item) => [questionKey(item.groupId, item.context), item]));
  const questions = plans.flatMap((plan) => plan.targets.map((target) => records.get(questionKey(plan.group.groupId, target.context))!));
  return { questions, ...(scannerSettled.length === 0 ? {} : { scannerSettled }),
    callCount, failedCallCount, timeoutCallCount, ...(trimmedSliceCount === 0 ? {} : { trimmedSliceCount }),
      latencyMs: Date.now() - started, usage, ...(model === undefined ? {} : { model }) };
}
