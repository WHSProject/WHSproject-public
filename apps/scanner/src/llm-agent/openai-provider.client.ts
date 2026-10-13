import { Injectable } from '@nestjs/common';
import type { LlmAgentEnvironment } from '../config/scanner-environment';
import type { AgentFailureReason, AgentUsage } from './output.contract';
import { AGENT_OUTPUT_SCHEMA } from './output-schema';

export interface AgentProviderResponse { text: string; model: string; providerRequestId?: string; usage: AgentUsage; durationMs: number }
/** `outputSchema` defaults to the 0.1.0 output schema; the Tier 3 artifact path passes its versioned schema. */
export interface AgentProvider { generate(prompt: string, signal: AbortSignal, outputSchema?: object): Promise<AgentProviderResponse> }
export class AgentProviderError extends Error { constructor(message: string, readonly retryable: boolean, readonly reason: AgentFailureReason = 'PROVIDER_ERROR') { super(message); } }

export interface OpenAiProviderRequestOptions {
  /** Explicit experiment controls. Omitted by production callers to preserve the existing request. */
  readonly reasoningEffort?: 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  readonly maxOutputTokens?: number;
}

function record(value: unknown): Record<string, unknown> | null { return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function number(value: unknown): number | undefined { return typeof value === 'number' && Number.isFinite(value) ? value : undefined; }

@Injectable()
export class OpenAiProviderClient implements AgentProvider {
  constructor(private readonly config: LlmAgentEnvironment, private readonly fetcher: typeof fetch = fetch,
    private readonly requestOptions: OpenAiProviderRequestOptions = {}) {}
  async generate(prompt: string, signal: AbortSignal, outputSchema: object = AGENT_OUTPUT_SCHEMA): Promise<AgentProviderResponse> {
    const started = performance.now();
    if (!this.config.OPENAI_API_KEY || !this.config.LLM_AGENT_MODEL) throw new AgentProviderError('Agent provider is not configured', false);
    let response: Response;
    try {
      response = await this.fetcher(`${this.config.OPENAI_BASE_URL.replace(/\/+$/u, '')}/v1/responses`, {
        method: 'POST', signal, headers: { authorization: `Bearer ${this.config.OPENAI_API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.config.LLM_AGENT_MODEL, input: prompt, store: false,
          ...(this.requestOptions.reasoningEffort === undefined ? {} : { reasoning: { effort: this.requestOptions.reasoningEffort } }),
          ...(this.requestOptions.maxOutputTokens === undefined ? {} : { max_output_tokens: this.requestOptions.maxOutputTokens }),
          text: { format: { type: 'json_schema', name: 'scanner_agent_analysis', schema: outputSchema, strict: false } } }),
      });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new AgentProviderError('Agent provider transport failed', true);
    }
    if (!response.ok) throw new AgentProviderError(`Agent provider HTTP ${response.status}`, response.status === 429 || response.status >= 500, response.status === 429 ? 'RATE_LIMITED' : 'PROVIDER_ERROR');
    let payload: Record<string, unknown>;
    try { payload = record(await response.json()) ?? {}; } catch { throw new AgentProviderError('Agent provider returned invalid JSON', true); }
    if (payload.status === 'incomplete' && record(payload.incomplete_details)?.reason === 'max_output_tokens') {
      throw new AgentProviderError('Agent provider output was truncated by max_output_tokens', false, 'OUTPUT_TRUNCATED');
    }
    const usage = record(payload.usage);
    const inputDetails = record(usage?.input_tokens_details);
    const outputDetails = record(usage?.output_tokens_details);
    const content = Array.isArray(payload.output) ? payload.output.flatMap((item) => {
      const message = record(item);
      return Array.isArray(message?.content) ? message.content.map(record).filter((part): part is Record<string, unknown> => part !== null) : [];
    }) : [];
    const text = content.filter((part) => part.type === 'output_text' && typeof part.text === 'string').map((part) => part.text as string).join('');
    return { text, model: typeof payload.model === 'string' ? payload.model : this.config.LLM_AGENT_MODEL,
      providerRequestId: typeof payload.id === 'string' ? payload.id : undefined,
      usage: { inputTokens: number(usage?.input_tokens), cachedInputTokens: number(inputDetails?.cached_tokens), outputTokens: number(usage?.output_tokens), reasoningTokens: number(outputDetails?.reasoning_tokens), totalTokens: number(usage?.total_tokens) },
      durationMs: performance.now() - started };
  }
}
