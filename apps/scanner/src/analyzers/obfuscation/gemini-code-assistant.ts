import type {
  AgentAnalysisRequestV0_1,
  CodeUnderstandingAssistant,
  GptShadowOutcome,
} from './agent-analysis.types';
import { setTimeout as delay } from 'node:timers/promises';
import {
  CODE_ASSISTANT_PROMPT_VERSION,
  GPT_RESPONSE_SCHEMA,
  SYSTEM_PROMPT,
  validateGptResponse,
} from './gpt-code-assistant';

/**
 * Tier 2 코드 이해 보조 — Gemini 구현 (OpenAiGptCodeAssistant 와 별도).
 *
 * Gemini 는 OpenAI 의 Responses API(`/responses`)를 지원하지 않는다. 대신 Google AI Studio 가
 * 제공하는 **OpenAI 호환 Chat Completions**(`/chat/completions`)를 쓴다.
 * baseUrl 예: https://generativelanguage.googleapis.com/v1beta/openai
 *
 * 판정 계약은 GPT 구현과 동일하다 — 같은 SYSTEM_PROMPT / 응답 스키마 / 검증기를 재사용해
 * 두 provider 의 출력이 같은 규칙(Evidence ID 인용 강제, 코드 재작성 금지)을 따르게 한다.
 * 반환 타입도 GptShadowOutcome 로 통일해 Shadow 파이프라인이 provider 를 구분하지 않게 한다.
 */
export interface GeminiCodeAssistantOptions {
  apiKey: string;
  model: string;
  baseUrl: string;
  timeoutMs: number;
  maxOutputTokens: number;
}

type GeminiTransport = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class GeminiCodeAssistant implements CodeUnderstandingAssistant {
  constructor(
    private readonly options: GeminiCodeAssistantOptions,
    private readonly transport: GeminiTransport = fetch,
  ) {}

  async analyze(
    request: AgentAnalysisRequestV0_1,
    signal?: AbortSignal,
  ): Promise<GptShadowOutcome> {
    const startedAt = Date.now();
    const timeoutSignal = AbortSignal.timeout(this.options.timeoutMs);
    const requestSignal = signal === undefined
      ? timeoutSignal
      : AbortSignal.any([signal, timeoutSignal]);

    try {
      const url = `${this.options.baseUrl.replace(/\/$/u, '')}/chat/completions`;
      const init: RequestInit = {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.options.apiKey}`,
        },
        body: JSON.stringify({
          model: this.options.model,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: JSON.stringify(request) },
          ],
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: 'obfuscation_code_understanding',
              strict: true,
              schema: GPT_RESPONSE_SCHEMA,
            },
          },
          max_tokens: this.options.maxOutputTokens,
        }),
        signal: requestSignal,
      };
      let response: Response;
      for (let attempt = 0; ; attempt += 1) {
        response = await this.transport(url, init);
        if ((response.status !== 429 && response.status !== 503) || attempt >= 2) break;
        const retryAfter = response.headers.get('retry-after');
        const retryAfterSeconds = retryAfter === null ? Number.NaN : Number(retryAfter);
        const waitMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0
          ? Math.min(retryAfterSeconds * 1_000, 1_000)
          : Math.min(250 * 2 ** attempt, 1_000);
        await delay(waitMs, undefined, { signal: requestSignal });
      }

      if (!response.ok) {
        return {
          status: 'FAILED',
          provider: 'gemini',
          model: this.options.model,
          durationMs: Date.now() - startedAt,
          reason: `Gemini HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`,
        };
      }

      const payload = await response.json() as Record<string, unknown>;
      const outputText = extractChatContent(payload);
      if (outputText === undefined) {
        return {
          status: 'FAILED',
          provider: 'gemini',
          model: this.options.model,
          durationMs: Date.now() - startedAt,
          reason: 'Gemini 응답에 message content 가 없습니다.',
        };
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(stripCodeFence(outputText));
      } catch {
        return {
          status: 'REJECTED',
          provider: 'gemini',
          model: this.options.model,
          durationMs: Date.now() - startedAt,
          reason: 'Gemini 응답이 JSON 이 아닙니다.',
        };
      }

      const validated = validateGptResponse(parsed, request);
      if (!validated.ok || validated.analysis === undefined) {
        return {
          status: 'REJECTED',
          provider: 'gemini',
          model: this.options.model,
          durationMs: Date.now() - startedAt,
          reason: validated.errors.join('; ').slice(0, 300),
        };
      }

      return {
        status: 'COMPLETED',
        provider: 'gemini',
        model: this.options.model,
        durationMs: Date.now() - startedAt,
        usage: readChatUsage(payload),
        analysis: validated.analysis,
        promptVersion: CODE_ASSISTANT_PROMPT_VERSION,
      };
    } catch (error) {
      return {
        status: 'FAILED',
        provider: 'gemini',
        model: this.options.model,
        durationMs: Date.now() - startedAt,
        reason: String((error as Error).message).slice(0, 200),
      };
    }
  }
}

/** Chat Completions 응답에서 assistant message 텍스트를 뽑는다(string / content-part 배열 모두 처리). */
function extractChatContent(payload: Record<string, unknown>): string | undefined {
  if (!Array.isArray(payload.choices) || payload.choices.length === 0) return undefined;
  const first = payload.choices[0];
  if (!isRecord(first) || !isRecord(first.message)) return undefined;
  const content = first.message.content;
  if (typeof content === 'string') return content;
  // 일부 호환 구현은 content 를 [{type:'text', text:'...'}] 배열로 준다.
  if (Array.isArray(content)) {
    const text = content
      .filter((part): part is Record<string, unknown> => isRecord(part) && typeof part.text === 'string')
      .map((part) => part.text as string)
      .join('');
    return text.length > 0 ? text : undefined;
  }
  return undefined;
}

/** ```json … ``` 펜스를 벗겨 순수 JSON 만 남긴다. json_schema 를 무시하고 펜스를 붙이는 경우 방어. */
function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith('```')) return trimmed;
  return trimmed
    .replace(/^```(?:json)?\s*/iu, '')
    .replace(/\s*```$/u, '')
    .trim();
}

function readChatUsage(payload: Record<string, unknown>): GptShadowOutcome['usage'] {
  const usage = isRecord(payload.usage) ? payload.usage : {};
  const inputTokens = typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : 0;
  const outputTokens = typeof usage.completion_tokens === 'number' ? usage.completion_tokens : 0;
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
