import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';

import type { LlmAgentEnvironment } from '../../config/scanner-environment';
import { AGENT_OUTPUT_SCHEMA } from '../../llm-agent/output-schema';
import { AgentProviderError, type AgentProvider, type AgentProviderResponse } from '../../llm-agent/openai-provider.client';

type ReasoningEffort = 'medium';
const MAX_ERROR_BODY_BYTES = 16 * 1024;

export interface AgentExperimentProviderErrorDetails {
  httpStatus: number;
  requestId: string | null;
  error: { type: string | null; code: string | null; param: string | null; message: string };
  errorFingerprint: string;
  bodyTruncated: boolean;
}

export class AgentExperimentProviderHttpError extends AgentProviderError {
  constructor(readonly details: AgentExperimentProviderErrorDetails, retryable: boolean) {
    super(`Agent experiment provider HTTP ${details.httpStatus}`, retryable,
      details.httpStatus === 429 ? 'RATE_LIMITED' : 'PROVIDER_ERROR');
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function number(value: unknown): number | undefined { return typeof value === 'number' && Number.isFinite(value) ? value : undefined; }

/** Offline experiment-only one-shot adapter. It is deliberately not a Nest provider. */
export class AgentExperimentOpenAiProvider implements AgentProvider {
  constructor(
    private readonly config: LlmAgentEnvironment,
    private readonly reasoningEffort: ReasoningEffort,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    if (reasoningEffort !== 'medium') throw new Error('AGENT_EXPERIMENT_REASONING_EFFORT_UNSUPPORTED');
  }

  async generate(prompt: string, signal: AbortSignal, outputSchema: object = AGENT_OUTPUT_SCHEMA): Promise<AgentProviderResponse> {
    const started = performance.now();
    if (!this.config.OPENAI_API_KEY || !this.config.LLM_AGENT_MODEL) throw new AgentProviderError('Agent experiment provider is not configured', false);
    let response: Response;
    try {
      response = await this.fetcher(`${this.config.OPENAI_BASE_URL.replace(/\/+$/u, '')}/v1/responses`, {
        method: 'POST', signal,
        headers: { authorization: `Bearer ${this.config.OPENAI_API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: this.config.LLM_AGENT_MODEL,
          input: prompt,
          store: false,
          reasoning: { effort: this.reasoningEffort },
          text: { format: { type: 'json_schema', name: 'scanner_agent_analysis', schema: outputSchema, strict: true } },
        }),
      });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new AgentProviderError('Agent experiment provider transport failed', true);
    }
    if (!response.ok) throw new AgentExperimentProviderHttpError(
      await extractProviderError(response, this.config.OPENAI_API_KEY), response.status === 429 || response.status >= 500);
    let payload: Record<string, unknown>;
    try { payload = record(await response.json()) ?? {}; } catch { throw new AgentProviderError('Agent experiment provider returned invalid JSON', true); }
    const usage = record(payload.usage), inputDetails = record(usage?.input_tokens_details), outputDetails = record(usage?.output_tokens_details);
    const content = Array.isArray(payload.output) ? payload.output.flatMap((item) => {
      const message = record(item);
      return Array.isArray(message?.content) ? message.content.map(record).filter((part): part is Record<string, unknown> => part !== null) : [];
    }) : [];
    const text = content.filter((part) => part.type === 'output_text' && typeof part.text === 'string').map((part) => part.text as string).join('');
    return {
      text,
      model: typeof payload.model === 'string' ? payload.model : this.config.LLM_AGENT_MODEL,
      providerRequestId: typeof payload.id === 'string' ? payload.id : undefined,
      usage: { inputTokens: number(usage?.input_tokens), cachedInputTokens: number(inputDetails?.cached_tokens), outputTokens: number(usage?.output_tokens),
        reasoningTokens: number(outputDetails?.reasoning_tokens), totalTokens: number(usage?.total_tokens) },
      durationMs: performance.now() - started,
    };
  }
}

export async function extractProviderError(response: Response, credential?: string): Promise<AgentExperimentProviderErrorDetails> {
  const { text, truncated } = await readBoundedText(response, MAX_ERROR_BODY_BYTES);
  let envelope: Record<string, unknown> | null = null;
  try { envelope = record(JSON.parse(text)); } catch { /* non-JSON response */ }
  const error = record(envelope?.error);
  const string = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value : null;
  const message = sanitizeProviderErrorMessage(string(error?.message) ?? (text ? 'Provider returned a non-JSON error response' : 'Provider returned an empty error response'), credential);
  const details = {
    httpStatus: response.status,
    requestId: response.headers.get('x-request-id'),
    error: { type: string(error?.type), code: string(error?.code), param: string(error?.param), message },
    bodyTruncated: truncated,
  };
  return { ...details, errorFingerprint: createHash('sha256').update([
    details.httpStatus, details.error.type ?? '', details.error.code ?? '', details.error.param ?? '', details.error.message,
  ].join('\n')).digest('hex') };
}

export function sanitizeProviderErrorMessage(value: string, credential?: string): string {
  let output = value.replace(/Bearer\s+[^\s"']+/giu, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gu, '[REDACTED]')
    .replace(/\/(?:Users|private\/tmp)\/[^\s"']+/gu, (match) => match.startsWith('/Users/') ? '/Users/[REDACTED]' : '/private/tmp/[REDACTED]')
    .replace(/\b(?:api[_-]?key|token|secret|password)\s*[=:]\s*[^\s,;"']+/giu, '$1=[REDACTED]');
  if (credential) output = output.split(credential).join('[REDACTED]');
  return output.slice(0, MAX_ERROR_BODY_BYTES);
}

async function readBoundedText(response: Response, limit: number): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) return { text: '', truncated: false };
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0, truncated = false;
  try {
    while (size <= limit) {
      const item = await reader.read();
      if (item.done) break;
      const remaining = limit - size;
      if (item.value.byteLength > remaining) { chunks.push(item.value.subarray(0, Math.max(0, remaining))); size = limit; truncated = true; break; }
      chunks.push(item.value); size += item.value.byteLength;
    }
  } finally { if (truncated) await reader.cancel().catch(() => undefined); }
  const merged = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength; }
  return { text: new TextDecoder('utf-8', { fatal: false }).decode(merged), truncated };
}
