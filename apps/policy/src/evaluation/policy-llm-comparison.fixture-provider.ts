import type { PolicyJudgment } from '../contracts/judgment';
import type { PolicySnapshot } from '../contracts/policy';
import { calculateRuleStatus } from '../llm/policy-judgment.validator';
import { FixturePolicyLlmProvider, PolicyLlmError, type PolicyLlmProvider, type PolicyLlmResponse } from '../llm/policy-llm.provider';

/** Offline comparison mock; it delegates Predicate output and only makes the mechanical Rule summary schema-valid. */
export class PolicyLlmComparisonFixtureProvider implements PolicyLlmProvider {
  constructor(private readonly model: string, private readonly delegate = new FixturePolicyLlmProvider()) {}

  async analyze(input: string, signal: AbortSignal): Promise<PolicyLlmResponse> {
    const response = await this.delegate.analyze(input, signal);
    const payload = parsePrompt(input);
    const judgment = structuredClone(response.judgment) as PolicyJudgment;
    for (const evaluation of judgment.ruleEvaluations) {
      const rule = payload.rules.find((candidate) => candidate.ruleId === evaluation.ruleId);
      if (!rule) throw new PolicyLlmError(`POLICY_FIXTURE_UNKNOWN_RULE:${evaluation.ruleId}`);
      evaluation.status = calculateRuleStatus(rule, evaluation.predicateEvaluations);
    }
    const rawResponse = response.rawResponse !== null && typeof response.rawResponse === 'object'
      ? { ...(response.rawResponse as Record<string, unknown>), output_text: JSON.stringify(judgment), model: this.model }
      : response.rawResponse;
    return { ...response, judgment, rawResponse, model: this.model };
  }
}

function parsePrompt(input: string): PolicySnapshot {
  try {
    const payload = JSON.parse(input.trim().split('\n').at(-1) ?? '') as { policySnapshot?: PolicySnapshot };
    if (!payload.policySnapshot || !Array.isArray(payload.policySnapshot.rules)) throw new Error('invalid policy snapshot');
    return payload.policySnapshot;
  } catch (error) {
    if (error instanceof PolicyLlmError) throw error;
    throw new PolicyLlmError('POLICY_FIXTURE_INVALID_PROMPT');
  }
}
