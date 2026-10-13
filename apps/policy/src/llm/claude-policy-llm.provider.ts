import type { PolicyLlmProvider, PolicyLlmResponse } from './policy-llm.provider';
import { normalizePolicyLlmUsage, PolicyLlmError, policyJudgmentSchema } from './policy-llm.provider';

export const ANTHROPIC_API_VERSION = '2023-06-01';

export interface ClaudePolicyLlmConfig {
  apiKey?: string;
  model: string;
  baseUrl: string;
  apiVersion?: string;
  maxOutputTokens?: number;
  /** Optional provider-side limit. The caller's AbortSignal remains authoritative. */
  timeoutMs?: number;
}

/**
 * Anthropic Messages adapter for the shared Policy LLM contract.
 * It deliberately does not participate in the operational primary/shadow wiring.
 */
export class ClaudePolicyLlmProvider implements PolicyLlmProvider {
  constructor(private readonly config: ClaudePolicyLlmConfig, private readonly fetcher: typeof fetch = fetch) {}

  async analyze(input: string, signal: AbortSignal): Promise<PolicyLlmResponse> {
    if (!this.config.apiKey?.trim()) throw new PolicyLlmError('POLICY_LLM_API_KEY_MISSING');
    if (signal.aborted) throw new PolicyLlmError('POLICY_LLM_ABORTED');

    const started = performance.now();
    const controller = new AbortController();
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    if (this.config.timeoutMs !== undefined) {
      if (!Number.isSafeInteger(this.config.timeoutMs) || this.config.timeoutMs <= 0) {
        signal.removeEventListener('abort', abort);
        throw new PolicyLlmError('POLICY_LLM_INVALID_TIMEOUT');
      }
      timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.config.timeoutMs);
    }

    let response: Response;
    try {
      response = await this.fetcher(`${this.config.baseUrl.replace(/\/+$/u, '')}/v1/messages`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'x-api-key': this.config.apiKey,
          'anthropic-version': this.config.apiVersion ?? ANTHROPIC_API_VERSION,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: this.config.model,
          max_tokens: this.config.maxOutputTokens ?? 4096,
          messages: [{ role: 'user', content: input }],
          output_config: { format: { type: 'json_schema', schema: policyJudgmentSchema } },
        }),
      });
    } catch (error) {
      if (signal.aborted) throw new PolicyLlmError('POLICY_LLM_ABORTED');
      if (timedOut) throw new PolicyLlmError('POLICY_LLM_TIMEOUT', true);
      if (error instanceof PolicyLlmError) throw error;
      throw new PolicyLlmError('POLICY_LLM_TRANSPORT_FAILED', true);
    } finally {
      if (timer) clearTimeout(timer);
      signal.removeEventListener('abort', abort);
    }

    if (!response.ok) {
      let rawResponse: unknown;
      try { rawResponse = await response.json(); } catch { /* non-JSON provider errors have no raw payload */ }
      throw new PolicyLlmError(`POLICY_LLM_HTTP_${response.status}`, response.status === 429 || response.status >= 500, rawResponse);
    }

    let decoded: unknown;
    try { decoded = await response.json(); } catch { throw new PolicyLlmError('POLICY_LLM_INVALID_RESPONSE', true); }
    const payload = asRecord(decoded);
    if (!payload) throw new PolicyLlmError('POLICY_LLM_INVALID_RESPONSE', true);
    if (payload.stop_reason === 'refusal') throw new PolicyLlmError('POLICY_LLM_SCHEMA_OUTPUT_FAILED', false, payload);

    const textPart = Array.isArray(payload.content)
      ? payload.content.map(asRecord).find((part) => part?.type === 'text' && typeof part.text === 'string')
      : undefined;
    const text = typeof textPart?.text === 'string' ? textPart.text : undefined;
    if (typeof text !== 'string' || text.trim() === '') throw new PolicyLlmError('POLICY_LLM_EMPTY_OUTPUT', true, payload);
    try {
      return {
        judgment: JSON.parse(text),
        provider: 'anthropic',
        model: typeof payload.model === 'string' ? payload.model : this.config.model,
        providerRequestId: typeof payload.id === 'string' ? payload.id : undefined,
        durationMs: performance.now() - started,
        usage: normalizePolicyLlmUsage(payload.usage),
        rawResponse: payload,
      };
    } catch {
      throw new PolicyLlmError('POLICY_LLM_INVALID_JSON', true, payload);
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
