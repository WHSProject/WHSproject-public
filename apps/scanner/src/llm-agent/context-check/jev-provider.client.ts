import { Injectable } from '@nestjs/common';
import type { LlmAgentEnvironment } from '../../config/scanner-environment';
import {
  ContextCheckProviderError,
  type ContextCheckProvider,
  type ContextCheckRequest,
  type ContextCheckResponse,
  type ScoreAnswer,
} from './context-check.contract';

function record(value: unknown): Record<string, unknown> | null { return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function number(value: unknown): number | undefined { return typeof value === 'number' && Number.isFinite(value) ? value : undefined; }

/** TypeSafe System One (Jev) client. One request, no retry: a failed check only skips the expansion. */
@Injectable()
export class JevProviderClient implements ContextCheckProvider {
  constructor(private readonly config: LlmAgentEnvironment, private readonly fetcher: typeof fetch = fetch) {}

  async check(request: ContextCheckRequest, signal?: AbortSignal): Promise<ContextCheckResponse> {
    const apiKey = this.config.TYPESAFE_API_KEY?.trim();
    if (!apiKey) throw new ContextCheckProviderError('Context check provider is not configured', 'NOT_CONFIGURED');
    const timeout = AbortSignal.timeout(this.config.LLM_AGENT_CONTEXT_CHECK_TIMEOUT_MS);
    let response: Response;
    try {
      response = await this.fetcher(`${this.config.TYPESAFE_BASE_URL.replace(/\/+$/u, '')}/v1/systemone`, {
        method: 'POST', signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.config.LLM_AGENT_CONTEXT_CHECK_MODEL, state: request.state, questions: request.questions }),
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      if (timeout.aborted) throw new ContextCheckProviderError('Context check provider timed out', 'TIMEOUT');
      throw new ContextCheckProviderError('Context check provider transport failed', 'TRANSPORT');
    }
    if (!response.ok) throw new ContextCheckProviderError(`Context check provider HTTP ${response.status}`, 'HTTP');
    let payload: Record<string, unknown>;
    try { payload = record(await response.json()) ?? {}; } catch { throw new ContextCheckProviderError('Context check provider returned invalid JSON', 'INVALID_RESPONSE'); }

    const rawAnswers = record(payload.answers);
    const answers: Record<string, ScoreAnswer> = {};
    for (const key of Object.keys(request.questions)) {
      const answer = record(rawAnswers?.[key]);
      const score = number(answer?.score);
      const confidence = number(answer?.confidence);
      if (score === undefined || confidence === undefined || score < 0 || confidence < 0 || confidence > 1) {
        throw new ContextCheckProviderError('Context check provider answer is missing or malformed', 'INVALID_RESPONSE');
      }
      answers[key] = { score, confidence };
    }
    const usage = record(payload.usage);
    return {
      model: typeof payload.model === 'string' ? payload.model : this.config.LLM_AGENT_CONTEXT_CHECK_MODEL,
      answers,
      usage: { inputTokens: number(usage?.input_tokens), outputTokens: number(usage?.output_tokens) },
    };
  }
}
