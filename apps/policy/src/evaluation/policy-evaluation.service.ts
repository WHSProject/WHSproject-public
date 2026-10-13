import { buildEvidenceCase, type EvidenceCase } from '../case/evidence-case.builder';
import type { EvaluationRequest } from '../contracts/evidence';
import type { PolicyJudgment } from '../contracts/judgment';
import type { PolicySnapshot } from '../contracts/policy';
import { resolveDecision, type ResolvedDecision } from '../decision/decision.resolver';
import { buildPolicyJudgmentRetryPrompt, buildPolicyPrompt } from '../llm/policy-llm.prompt';
import { PolicyLlmError, type PolicyLlmProvider, type PolicyLlmResponse } from '../llm/policy-llm.provider';
import { PolicyJudgmentValidationError, validatePolicyJudgmentWithComputedRuleStatus } from '../llm/policy-judgment.validator';
import { policyLlmInputHash } from '../llm/policy-llm.audit';
import type { PolicyLlmAuditRecord } from '../llm/policy-llm.audit';
import { POLICY_LLM_PROMPT_VERSION } from '../llm/policy-llm.prompt';

export interface PolicyEvaluationResult {
  case: EvidenceCase;
  judgment: PolicyJudgment;
  decision: ResolvedDecision;
  llm: { status: 'COMPLETED' | 'FAILED'; model?: string; providerRequestId?: string; durationMs?: number; failureCode?: string; attemptCount?: number };
  audit?: PolicyLlmAuditRecord;
  shadow?: {
    llm: PolicyEvaluationResult['llm'];
    audit: PolicyLlmAuditRecord;
    comparison: NonNullable<PolicyLlmAuditRecord['comparison']>;
  };
}

export class PolicyEvaluationService {
  constructor(
    private readonly provider: PolicyLlmProvider,
    private readonly timeoutMs = 20_000,
    private readonly shadowProvider?: PolicyLlmProvider,
    private readonly now = () => performance.now(),
    private readonly evaluatedAt = () => new Date().toISOString(),
  ) {}

  async evaluate(request: EvaluationRequest, policy: PolicySnapshot, signal?: AbortSignal): Promise<PolicyEvaluationResult> {
    const evidenceCase = buildEvidenceCase(request);
    const prompt = buildPolicyPrompt(evidenceCase, policy);
    const inputHash = policyLlmInputHash(prompt);
    const auditEvaluatedAt = this.evaluatedAt();
    const startedAt = this.now();
    let response: PolicyLlmResponse | undefined;
    let judgment: PolicyJudgment | undefined;
    let attemptCount = 0;
    const retryTrace: Array<Record<string, unknown>> = [];
    let result: PolicyEvaluationResult;
    try {
      let validationCode: string | undefined;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const attemptPrompt = attempt === 0 ? prompt : buildPolicyJudgmentRetryPrompt(prompt, validationCode!);
        attemptCount += 1;
        response = await this.withTimeout((providerSignal) => this.provider.analyze(attemptPrompt, providerSignal), this.timeoutMs, signal);
        try {
          judgment = validatePolicyJudgmentWithComputedRuleStatus(response.judgment, policy, evidenceCase);
          retryTrace.push({ attempt: attempt + 1, inputHash: policyLlmInputHash(attemptPrompt), providerRequestId: response.providerRequestId, responseJson: response.rawResponse ?? response.judgment });
          break;
        } catch (error) {
          if (!(error instanceof PolicyJudgmentValidationError)) throw error;
          validationCode = error.message.split(':', 1)[0] || 'INVALID_POLICY_JUDGMENT';
          retryTrace.push({ attempt: attempt + 1, inputHash: policyLlmInputHash(attemptPrompt), providerRequestId: response.providerRequestId, responseJson: response.rawResponse ?? response.judgment, failureCode: `POLICY_LLM_INVALID_JUDGMENT:${error.message}` });
          if (attempt === 1) throw error;
        }
      }
      if (!judgment || !response) throw new PolicyLlmError('POLICY_LLM_INVALID_JUDGMENT');
      const decision = resolveDecision(policy, judgment, evidenceCase);
      const durationMs = response.durationMs ?? this.durationSince(startedAt);
      result = {
        case: evidenceCase,
        judgment,
        decision,
        llm: { status: 'COMPLETED', model: response.model, providerRequestId: response.providerRequestId, durationMs, attemptCount },
        audit: {
          runMode: 'PRIMARY', requestId: request.requestId, scanId: request.scanId,
          policyKey: policy.policyKey, policyVersion: policy.policyVersion, policyHash: policy.policyHash,
          provider: response.provider ?? 'unknown', promptVersion: POLICY_LLM_PROMPT_VERSION, inputHash,
          judgmentId: judgment.judgmentId, status: 'COMPLETED', prompt, model: response.model,
          providerRequestId: response.providerRequestId, durationMs, evaluatedAt: auditEvaluatedAt,
          judgmentJson: judgment, responseJson: attemptCount > 1 ? { type: 'POLICY_LLM_RETRY_TRACE', attemptCount, attempts: retryTrace } : response.rawResponse,
          resolvedDecision: decision.decision, resolvedReasonCode: decision.reasonCode,
        },
      };
    } catch (error) {
      const failureCode = error instanceof PolicyJudgmentValidationError ? `POLICY_LLM_INVALID_JUDGMENT:${error.message}` : error instanceof PolicyLlmError ? error.message : error instanceof Error ? error.message : 'POLICY_LLM_UNKNOWN_FAILURE';
      const judgment = failureJudgment(policy, failureCode);
      const decision = resolveDecision(policy, judgment, evidenceCase);
      const invalidJudgment = error instanceof PolicyJudgmentValidationError;
      const failureDecision = { ...decision, decision: policy.judgmentFailureDecision, reasonCode: invalidJudgment ? 'POLICY_LLM_INVALID_JUDGMENT' : 'POLICY_LLM_UNAVAILABLE', reason: invalidJudgment ? `Policy GPT returned an invalid judgment: ${failureCode}` : `Policy GPT unavailable: ${failureCode}` };
      const durationMs = this.durationSince(startedAt);
      const failureAttempts = [...retryTrace];
      if (attemptCount > failureAttempts.length) failureAttempts.push({ attempt: attemptCount, providerRequestId: response?.providerRequestId, responseJson: response?.rawResponse ?? (error instanceof PolicyLlmError ? error.rawResponse : response?.judgment), failureCode });
      const responseJson = attemptCount > 1
        ? { type: 'POLICY_LLM_RETRY_TRACE', attemptCount, attempts: failureAttempts }
        : response?.rawResponse ?? (error instanceof PolicyLlmError ? error.rawResponse : undefined);
      result = {
        case: evidenceCase,
        judgment,
        decision: failureDecision,
        llm: { status: 'FAILED', model: response?.model, providerRequestId: response?.providerRequestId, durationMs, failureCode, attemptCount },
        audit: {
          runMode: 'PRIMARY', requestId: request.requestId, scanId: request.scanId,
          policyKey: policy.policyKey, policyVersion: policy.policyVersion, policyHash: policy.policyHash,
          provider: response?.provider ?? 'unknown', promptVersion: POLICY_LLM_PROMPT_VERSION, inputHash,
          judgmentId: judgment.judgmentId, status: 'FAILED', prompt, model: response?.model,
          providerRequestId: response?.providerRequestId, durationMs, evaluatedAt: auditEvaluatedAt,
          judgmentJson: response?.judgment, responseJson, failureCode,
          resolvedDecision: failureDecision.decision, resolvedReasonCode: failureDecision.reasonCode,
        },
      };
    }
    if (this.shadowProvider) result.shadow = await this.evaluateShadow(request, policy, evidenceCase, prompt, inputHash, auditEvaluatedAt, result, signal);
    return result;
  }

  private async evaluateShadow(request: EvaluationRequest, policy: PolicySnapshot, evidenceCase: EvidenceCase, prompt: string, inputHash: string, auditEvaluatedAt: string, primary: PolicyEvaluationResult, signal?: AbortSignal): Promise<NonNullable<PolicyEvaluationResult['shadow']>> {
    const startedAt = this.now();
    let response: PolicyLlmResponse | undefined;
    try {
      response = await this.withTimeout((providerSignal) => this.shadowProvider!.analyze(prompt, providerSignal), this.timeoutMs, signal);
      const judgment = validatePolicyJudgmentWithComputedRuleStatus(response.judgment, policy, evidenceCase);
      const decision = resolveDecision(policy, judgment, evidenceCase);
      const comparison = compare(primary.decision, decision);
      const durationMs = response.durationMs ?? this.durationSince(startedAt);
      return {
        llm: { status: 'COMPLETED', model: response.model, providerRequestId: response.providerRequestId, durationMs },
        comparison,
        audit: {
          runMode: 'SHADOW', requestId: request.requestId, scanId: request.scanId,
          policyKey: policy.policyKey, policyVersion: policy.policyVersion, policyHash: policy.policyHash,
          provider: response.provider ?? 'unknown', promptVersion: POLICY_LLM_PROMPT_VERSION, inputHash,
          judgmentId: judgment.judgmentId, status: 'COMPLETED', prompt, model: response.model,
          providerRequestId: response.providerRequestId, durationMs, evaluatedAt: auditEvaluatedAt,
          judgmentJson: judgment, responseJson: response.rawResponse,
          resolvedDecision: decision.decision, resolvedReasonCode: decision.reasonCode,
          shadowOfJudgmentId: primary.judgment.judgmentId, comparison,
        },
      };
    } catch (error) {
      const failureCode = error instanceof PolicyJudgmentValidationError ? `POLICY_LLM_INVALID_JUDGMENT:${error.message}` : error instanceof PolicyLlmError ? error.message : error instanceof Error ? error.message : 'POLICY_LLM_UNKNOWN_FAILURE';
      const comparison = compare(primary.decision, undefined);
      const durationMs = this.durationSince(startedAt);
      return {
        llm: { status: 'FAILED', model: response?.model, providerRequestId: response?.providerRequestId, durationMs, failureCode },
        comparison,
        audit: {
          runMode: 'SHADOW', requestId: request.requestId, scanId: request.scanId,
          policyKey: policy.policyKey, policyVersion: policy.policyVersion, policyHash: policy.policyHash,
          provider: response?.provider ?? 'unknown', promptVersion: POLICY_LLM_PROMPT_VERSION, inputHash,
          judgmentId: `shadow:failed:${policyLlmInputHash(`${request.requestId}:${failureCode}`).slice(0, 24)}`, status: 'FAILED', prompt, model: response?.model,
          providerRequestId: response?.providerRequestId, durationMs, evaluatedAt: auditEvaluatedAt,
          judgmentJson: response?.judgment, responseJson: response?.rawResponse ?? (error instanceof PolicyLlmError ? error.rawResponse : undefined), failureCode,
          shadowOfJudgmentId: primary.judgment.judgmentId, comparison,
        },
      };
    }
  }

  private durationSince(startedAt: number): number {
    return Math.max(0, this.now() - startedAt);
  }

  private async withTimeout<T>(operation: (signal: AbortSignal) => Promise<T>, timeoutMs: number, parentSignal?: AbortSignal): Promise<T> {
    if (parentSignal?.aborted) throw new PolicyLlmError('POLICY_LLM_ABORTED');
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      const operationPromise = operation(controller.signal);
      const timeoutPromise = new Promise<T>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new PolicyLlmError('POLICY_LLM_TIMEOUT', true)); }, timeoutMs); });
      const abortPromise = parentSignal ? new Promise<T>((_, reject) => {
        onAbort = () => { controller.abort(); reject(new PolicyLlmError('POLICY_LLM_ABORTED')); };
        parentSignal.addEventListener('abort', onAbort, { once: true });
      }) : undefined;
      return await Promise.race(abortPromise ? [operationPromise, timeoutPromise, abortPromise] : [operationPromise, timeoutPromise]);
    } finally {
      if (timer) clearTimeout(timer);
      if (parentSignal && onAbort) parentSignal.removeEventListener('abort', onAbort);
    }
  }
}

function compare(primary: ResolvedDecision, shadow: ResolvedDecision | undefined): NonNullable<PolicyLlmAuditRecord['comparison']> {
  return {
    primaryDecision: primary.decision,
    shadowDecision: shadow?.decision,
    decisionChanged: shadow !== undefined && primary.decision !== shadow.decision,
    primaryReasonCode: primary.reasonCode,
    shadowReasonCode: shadow?.reasonCode,
    reasonCodeChanged: shadow !== undefined && primary.reasonCode !== shadow.reasonCode,
  };
}

function failureJudgment(policy: PolicySnapshot, failureCode: string): PolicyJudgment {
  return { judgmentId: `judgment:failed:${policyLlmInputHash(failureCode).slice(0, 24)}`, policyVersion: policy.policyVersion, caseStatus: 'INCOMPLETE', ruleEvaluations: [], unresolved: ['ANALYSIS_COVERAGE_INCOMPLETE'], conflicts: [], limitations: [failureCode] };
}
