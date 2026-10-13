import type { PolicyLlmAuditRecord } from './policy-llm.audit';

export class PolicyLlmAuditDbError extends Error {
  constructor(message: string, readonly statusCode?: number, readonly retryable = false) { super(message); }
}

export interface PersistedPolicyLlmAudit {
  auditDbId: string | null;
  status: 'SAVED' | 'ALREADY_EXISTS';
}

export class HttpPolicyLlmAuditClient {
  constructor(
    private readonly baseUrl = process.env.DECISION_DB_URL ?? 'http://localhost:9100',
    private readonly timeoutMs = Number(process.env.DECISION_DB_TIMEOUT_MS ?? (Number(process.env.DECISION_DB_TIMEOUT_SECONDS ?? 5) * 1_000)),
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async save(audit: PolicyLlmAuditRecord): Promise<PersistedPolicyLlmAudit> {
    const payload = {
      audit: {
        runMode: audit.runMode,
        requestId: audit.requestId,
        scanId: audit.scanId,
        policyKey: audit.policyKey,
        policyVersion: audit.policyVersion,
        policyHash: audit.policyHash ?? null,
        provider: audit.provider,
        promptVersion: audit.promptVersion,
        inputHash: audit.inputHash,
        judgmentId: audit.judgmentId,
        status: audit.status,
        prompt: audit.prompt,
        model: audit.model ?? null,
        providerRequestId: audit.providerRequestId ?? null,
        durationMs: audit.durationMs ?? null,
        judgmentJson: audit.judgmentJson ?? null,
        responseJson: audit.responseJson ?? null,
        failureCode: audit.failureCode ?? null,
        resolvedDecision: audit.resolvedDecision ?? null,
        resolvedReasonCode: audit.resolvedReasonCode ?? null,
        shadowOfJudgmentId: audit.shadowOfJudgmentId ?? null,
        comparison: audit.comparison ?? null,
        evaluatedAt: audit.evaluatedAt,
      },
    };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetcher(`${this.baseUrl.replace(/\/+$/u, '')}/internal/v1/llm-judgments`, {
        method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: controller.signal,
      });
      if (response.status === 409) return { auditDbId: null, status: 'ALREADY_EXISTS' };
      if (response.status >= 500) throw new PolicyLlmAuditDbError(`POLICY_LLM_AUDIT_DB_HTTP_${response.status}`, response.status, true);
      if (!response.ok) throw new PolicyLlmAuditDbError(`POLICY_LLM_AUDIT_DB_HTTP_${response.status}`, response.status, false);
      let body: Record<string, unknown>;
      try { body = await response.json() as Record<string, unknown>; } catch { throw new PolicyLlmAuditDbError('POLICY_LLM_AUDIT_DB_INVALID_RESPONSE', response.status, false); }
      if (typeof body.id !== 'string') throw new PolicyLlmAuditDbError('POLICY_LLM_AUDIT_DB_INVALID_RESPONSE');
      return { auditDbId: body.id, status: 'SAVED' };
    } catch (error) {
      if (error instanceof PolicyLlmAuditDbError) throw error;
      throw new PolicyLlmAuditDbError(controller.signal.aborted ? 'POLICY_LLM_AUDIT_DB_TIMEOUT' : 'POLICY_LLM_AUDIT_DB_UNAVAILABLE', undefined, true);
    } finally {
      clearTimeout(timeout);
    }
  }
}
