import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import { AgentOutputValidatorService } from '../../llm-agent/agent-output-validator.service';
import { AgentProviderError, type AgentProvider } from '../../llm-agent/openai-provider.client';
import { renderAgentExperimentPrompt } from './agent-experiment-prompt.renderer';
import { canonicalJson, AgentExperimentRequestValidationError, AgentExperimentRequestValidator } from './agent-experiment-request.validator';
import { validateAgentExperimentOutput } from './agent-experiment-result';
import {
  AGENT_EXPERIMENT_MAX_OUTPUT_BYTES, AGENT_EXPERIMENT_RESULT_VERSION, type AgentExperimentExecutionOptions,
  type AgentExperimentProviderResult, type AgentExperimentResultEnvelope,
} from './agent-experiment.types';
import { AgentExperimentProviderHttpError } from './agent-experiment-openai.provider';
import { AGENT_EXPERIMENT_OUTPUT_SCHEMA, normalizeAgentExperimentApiOutput, validateAgentExperimentApiOutput,
  validateAgentExperimentOutputBranch } from './agent-experiment-output.schema';

export class AgentExperimentService {
  constructor(private readonly validator = new AgentExperimentRequestValidator(), private readonly provider?: AgentProvider,
    private readonly outputValidator = new AgentOutputValidatorService()) {}

  async execute(value: unknown, options: AgentExperimentExecutionOptions, credentialForRedaction?: string): Promise<AgentExperimentResultEnvelope> {
    if (options.maxRetries !== 0) throw new Error('EXPERIMENT_RETRY_MUST_BE_ZERO');
    if (options.reasoningEffort !== 'medium') throw new Error('AGENT_EXPERIMENT_REASONING_EFFORT_UNSUPPORTED');
    if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) throw new Error('EXPERIMENT_TIMEOUT_INVALID');
    const input = this.validator.validate(value);
    const payloadSha256 = hash(canonicalJson(input));
    const rendered = renderAgentExperimentPrompt(input);
    const base = {
      contractVersion: AGENT_EXPERIMENT_RESULT_VERSION,
      executionMode: options.live ? 'LIVE' as const : 'DRY_RUN' as const,
      request: { schemaVersion: '0.3.0' as const, sampleId: input.request.sampleId, inputProfile: input.request.inputProfile,
        payloadSha256, promptSha256: rendered.promptSha256 },
      reasoning: { requestedEffort: options.reasoningEffort, configurationSource: 'AGENT_EXPERIMENT_EXPLICIT' as const },
      additionalModelRounds: 0 as const,
    };
    if (!options.live) return { ...base, provider: providerResult(options.model), status: 'VALIDATED', rawModelOutput: null,
      responseValidation: 'PASS', analysisOutcome: 'UNAVAILABLE', toolDisposition: 'NOT_APPLICABLE', outcomeDetailCode: null,
      validatedResult: null, validationFailures: [], error: null };
    if (!this.provider) return { ...base, provider: providerResult(options.model), status: 'FAILED', rawModelOutput: null,
      ...responseFailure(), validatedResult: null, validationFailures: [], error: { code: 'CREDENTIAL_OR_PROVIDER_UNAVAILABLE', message: 'Live provider is not configured' } };

    const totalStarted = performance.now(), controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs); timer.unref?.();
    try {
      const response = await abortable(this.provider.generate(rendered.prompt, controller.signal, AGENT_EXPERIMENT_OUTPUT_SCHEMA), controller.signal);
      const provider = providerResult(response.model, response.providerRequestId, response.durationMs, performance.now() - totalStarted, response.usage);
      if (Buffer.byteLength(response.text) > AGENT_EXPERIMENT_MAX_OUTPUT_BYTES) return { ...base, provider, status: 'FAILED', rawModelOutput: null,
        ...responseFailure(), validatedResult: null, validationFailures: ['MODEL_OUTPUT_TOO_LARGE'], error: { code: 'MODEL_OUTPUT_TOO_LARGE', message: 'Model output exceeded the configured limit' } };
      const raw = redact(response.text, credentialForRedaction);
      let decoded: unknown;
      try { decoded = JSON.parse(response.text) as unknown; }
      catch { return { ...base, provider, status: 'FAILED', rawModelOutput: raw, validatedResult: null,
        ...responseFailure(),
        validationFailures: ['INVALID_RESPONSE_JSON'], error: { code: 'INVALID_RESPONSE_JSON', message: 'Provider response is not valid JSON' } }; }
      const rawSchemaFailures = validateAgentExperimentApiOutput(decoded);
      if (rawSchemaFailures.length) return { ...base, provider, status: 'FAILED', rawModelOutput: raw, validatedResult: null,
        ...responseFailure(),
        validationFailures: rawSchemaFailures,
        error: { code: 'OUTPUT_SCHEMA_VALIDATION_FAILED', message: 'Provider response failed experiment API-facing schema validation' } };
      try { validateAgentExperimentOutputBranch(decoded); }
      catch (error) { return { ...base, provider, status: 'FAILED', rawModelOutput: raw, validatedResult: null,
        ...responseFailure(),
        validationFailures: [error instanceof Error ? error.message : 'BRANCH_SEMANTIC_VALIDATION_FAILED'],
        error: { code: 'BRANCH_SEMANTIC_VALIDATION_FAILED', message: 'Provider response violates status branch semantics' } }; }
      try { decoded = normalizeAgentExperimentApiOutput(decoded); }
      catch (error) { return { ...base, provider, status: 'FAILED', rawModelOutput: raw, validatedResult: null,
        ...responseFailure(),
        validationFailures: [error instanceof Error ? error.message : 'OUTPUT_NORMALIZATION_FAILED'],
        error: { code: 'OUTPUT_NORMALIZATION_FAILED', message: 'Provider response normalization failed' } }; }
      let parsed;
      try { parsed = this.outputValidator.parseForRequestId(decoded, input.request.analysisRequestId); }
      catch (error) { return { ...base, provider, status: 'FAILED', rawModelOutput: raw, validatedResult: null,
        ...responseFailure(),
        validationFailures: [error instanceof Error ? error.message : 'OUTPUT_PARSER_FAILED'],
        error: { code: 'OUTPUT_PARSER_FAILED', message: 'Provider response failed the existing output parser or request binding validation' } }; }
      if (parsed.status === 'NEEDS_ADDITIONAL_CODE') return { ...base, provider, status: 'COMPLETED', rawModelOutput: raw,
        responseValidation: 'PASS', analysisOutcome: 'NEEDS_ADDITIONAL_CODE', toolDisposition: 'NOT_EXECUTED_BY_EXPERIMENT_POLICY',
        outcomeDetailCode: 'ADDITIONAL_CODE_REQUESTED_TOOL_DISABLED', validatedResult: redactJson(parsed, credentialForRedaction),
        validationFailures: [], error: null };
      const validatedResult = validateAgentExperimentOutput(input, parsed, this.outputValidator);
      const rejected = validatedResult.assessments.flatMap(({ issues }) => issues);
      return { ...base, provider, status: rejected.length ? 'FAILED' : 'COMPLETED', rawModelOutput: raw,
        ...(rejected.length ? responseFailure() : responseCompleted()),
        validatedResult: redactJson(validatedResult, credentialForRedaction),
        validationFailures: rejected, error: rejected.length ? { code: 'OUTPUT_REFERENCE_VALIDATION_FAILED', message: 'Output references failed validation' } : null };
    } catch (error) {
      const timeout = controller.signal.aborted;
      const code = timeout ? 'TIMEOUT' : error instanceof AgentProviderError ? error.reason : error instanceof AgentExperimentRequestValidationError ? 'REQUEST_INVALID' : 'INTERNAL_ERROR';
      return { ...base, provider: providerResult(options.model, undefined, undefined, performance.now() - totalStarted), status: timeout ? 'TIMEOUT' : 'FAILED',
        rawModelOutput: null, ...responseFailure(), validatedResult: null, validationFailures: [], error: { code, message: redact(error instanceof Error ? error.message : String(error), credentialForRedaction),
          ...(error instanceof AgentExperimentProviderHttpError ? { provider: error.details } : {}) } };
    } finally { clearTimeout(timer); controller.abort(); }
  }
}

function responseFailure() { return { responseValidation: 'FAIL' as const, analysisOutcome: 'UNAVAILABLE' as const,
  toolDisposition: 'UNAVAILABLE' as const, outcomeDetailCode: null }; }
function responseCompleted() { return { responseValidation: 'PASS' as const, analysisOutcome: 'COMPLETED' as const,
  toolDisposition: 'NOT_APPLICABLE' as const, outcomeDetailCode: null }; }

function providerResult(model: string, responseId?: string, durationMs?: number, totalDurationMs?: number, usage?: AgentExperimentProviderResult['usage']): AgentExperimentProviderResult {
  return { provider: 'openai', model: model || null, responseId: responseId ?? null, durationMs: durationMs ?? null,
    totalDurationMs: totalDurationMs ?? null, usage: usage ?? null };
}
function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new Error('TIMEOUT');
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => { onAbort=()=>reject(new Error('TIMEOUT')); signal.addEventListener('abort',onAbort,{once:true}); });
  try { return await Promise.race([operation, aborted]); }
  finally { if (onAbort) signal.removeEventListener('abort',onAbort); }
}
export function redact(value: string, credential?: string): string {
  let output = value.replace(/\/Users\/[^/\s"']+/gu, '/Users/[REDACTED]').replace(/\/private\/tmp\/[^/\s"']+/gu, '/private/tmp/[REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/giu, 'Bearer [REDACTED]').replace(/\b(?:sk|ghp|gho)-?[A-Za-z0-9_-]{16,}\b/gu, '[REDACTED]');
  if (credential) output = output.split(credential).join('[REDACTED]');
  return output;
}
function redactJson<T>(value: T, credential?: string): T { return JSON.parse(redact(JSON.stringify(value), credential)) as T; }
