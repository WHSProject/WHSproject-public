import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { LlmAgentEnvironment } from '../config/scanner-environment';
import type { AgentAnalysisRequest, AgentCodeSlice } from './agent.contract';
import { buildAgentPrompt } from './agent-prompt';
import { AgentOutputValidatorService } from './agent-output-validator.service';
import type { AgentAnalysisInputV0_3 } from './artifact/agent-analysis-input.contract';
import { AGENT_OUTPUT_API_SCHEMA_V0_3, normalizeAgentOutputV0_3ApiResponse, validateAgentOutputV0_3ApiBranch } from './artifact/agent-output-v0_3.api-schema';
import { AGENT_OUTPUT_SCHEMA_VERSION_V0_3, parseAgentOutputV0_3, type AgentAnalysisOutputV0_3, type CompletedAgentOutputV0_3 } from './artifact/agent-output-v0_3.contract';
import { AGENT_PROMPT_VERSION_V0_3, buildAgentPromptV0_3 } from './artifact/agent-prompt-v0_3';
import type { AgentPromptV0_2Options } from './artifact/agent-prompt-v0_2';
import type { AgentCodeSlice as ArtifactCodeSlice, ArtifactResolver } from './artifact/artifact.contract';
import { ArtifactOutputValidator, type ValidatedAgentAnalysisResultV0_3 } from './artifact/artifact-output.validator';
import type { CodeSliceRegistry } from './artifact/code-slice.registry';
import { RuntimeCodeTool, type UnavailableReason } from './artifact/runtime-code-tool';
import { AgentToolError, LlmAgentToolsService, type AgentToolRequest, type AgentToolUsage } from './llm-agent-tools.service';
import { AgentProviderError, type AgentProvider } from './openai-provider.client';
import type { AgentAnalysisOutput, AgentAnalysisResult, AgentFailureReason, AgentUsage } from './output.contract';

export interface AgentExecutionContext { scanId: string; extractedPackageRoot: string; signal?: AbortSignal }
class AgentRunError extends Error { constructor(message: string, readonly reason: AgentFailureReason) { super(message); } }
function addUsage(total: AgentUsage, next: AgentUsage): void {
  for (const key of ['inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningTokens', 'totalTokens'] as const) {
    if (next[key] !== undefined) total[key] = (total[key] ?? 0) + next[key];
  }
}
async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new AgentRunError('Agent timeout', 'TIMEOUT');
  let onAbort: (() => void) | undefined;
  const cancelled = new Promise<never>((_, reject) => {
    onAbort = () => reject(new AgentRunError('Agent timeout', 'TIMEOUT'));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try { return await Promise.race([operation, cancelled]); }
  finally { if (onAbort) signal.removeEventListener('abort', onAbort); }
}

/** Execution context for the Tier 3 input 0.3.0 path; the registry already holds the INITIAL slices. */
export interface AgentExecutionContextV0_3 { resolver: ArtifactResolver; registry: CodeSliceRegistry; signal?: AbortSignal }
export interface AgentExecutionOptionsV0_3 { prompt?: AgentPromptV0_2Options }
export interface AgentCodeRequestRecordV0_3 {
  requestId: string;
  artifactId: string;
  filePath: string;
  requestedRange: { startLine: number; endLine: number };
  servedRange: { startLine: number; endLine: number } | null;
  truncated: boolean;
  unavailableReason?: UnavailableReason;
}

/**
 * Result of the input 0.3.0 path. COMPLETED output is re-verified against the
 * registry and artifacts; like the 0.2.0 path, any assessment that is not
 * VERIFIED leaves the run PARTIAL. `slices` lists the INITIAL and RUNTIME slices
 * the assessments were checked against.
 */
export interface AgentAnalysisResultV0_3 extends Omit<AgentAnalysisResult, 'output' | 'validated' | 'effectiveRequest'> {
  output?: CompletedAgentOutputV0_3;
  validated?: ValidatedAgentAnalysisResultV0_3;
  slices: readonly ArtifactCodeSlice[];
  codeRequests: readonly AgentCodeRequestRecordV0_3[];
}

type AgentRunResult = Omit<AgentAnalysisResult, 'output' | 'validated' | 'effectiveRequest'>;
type LoopDiagnostic = string | { kind: string; detail: string };
type LoopOutput = { status: 'COMPLETED'; limitations: LoopDiagnostic[]; missingContext: LoopDiagnostic[] } | { status: 'NEEDS_ADDITIONAL_CODE'; requests: unknown[] };

const MAX_MODEL_CALLS = 3;
const MAX_SCHEMA_FEEDBACK_ISSUES = 3;
const MAX_SCHEMA_FEEDBACK_MESSAGE_LENGTH = 240;
const MAX_SCHEMA_FEEDBACK_LENGTH = 900;

type SchemaValidationIssue = { path?: unknown; code?: unknown; message?: unknown };

function schemaPath(path: unknown): string {
  if (!Array.isArray(path)) return '$';
  return path.reduce<string>((result, segment) => {
    if (typeof segment === 'number') return `${result}[${segment}]`;
    if (typeof segment !== 'string') return result;
    return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(segment) ? `${result}.${segment}` : `${result}[${JSON.stringify(segment)}]`;
  }, '$');
}

function schemaValidationFeedback(error: unknown): string[] {
  if (!error || typeof error !== 'object' || !('issues' in error) || !Array.isArray(error.issues)) return ['Invalid response'];
  const feedback = (error.issues as SchemaValidationIssue[]).slice(0, MAX_SCHEMA_FEEDBACK_ISSUES).map((issue) => {
    const kind = typeof issue.code === 'string' ? issue.code : 'validation_error';
    const message = typeof issue.message === 'string'
      ? issue.message.replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, MAX_SCHEMA_FEEDBACK_MESSAGE_LENGTH)
      : 'Value does not satisfy the output schema';
    return `Schema validation failed at ${schemaPath(issue.path)} (${kind}): ${message}`;
  });
  if (error.issues.length > MAX_SCHEMA_FEEDBACK_ISSUES) feedback.push(`${error.issues.length - MAX_SCHEMA_FEEDBACK_ISSUES} additional schema error(s) omitted`);
  const bounded: string[] = [];
  let length = 0;
  for (const item of feedback) {
    const separatorLength = bounded.length === 0 ? 0 : 2;
    const available = MAX_SCHEMA_FEEDBACK_LENGTH - length - separatorLength;
    if (available <= 0) break;
    bounded.push(item.slice(0, available));
    length += separatorLength + Math.min(item.length, available);
  }
  return bounded.length ? bounded : ['Invalid response'];
}

/** What differs between the 0.2.0 and 0.3.0 inputs; the call, retry and re-call loop is shared. */
interface AgentLoop<TOutput extends LoopOutput, TResult> {
  promptVersion: string;
  outputSchemaVersion: string;
  outputSchema?: object;
  toolUsage: AgentToolUsage;
  prompt(responses: readonly unknown[], feedback: readonly string[], finalCall: boolean): string;
  /** True once no further code request can be served; the next call is then asked for its final answer. */
  budgetExhausted?(): boolean;
  parse(value: unknown): TOutput;
  complete(output: Extract<TOutput, { status: 'COMPLETED' }>, result: (status: AgentRunResult['status']) => AgentRunResult, signal: AbortSignal): Promise<TResult>;
  requestCode(output: Extract<TOutput, { status: 'NEEDS_ADDITIONAL_CODE' }>, responses: unknown[], signal: AbortSignal): Promise<void>;
  failed(result: AgentRunResult): TResult;
}

@Injectable()
export class LlmAgentRunnerService {
  private readonly runtimeTool = new RuntimeCodeTool();
  private readonly artifactValidator = new ArtifactOutputValidator();

  constructor(private readonly provider: AgentProvider, private readonly tools: LlmAgentToolsService,
    private readonly validator: AgentOutputValidatorService, private readonly settings: LlmAgentEnvironment) {}

  async execute(request: AgentAnalysisRequest, executionContext: AgentExecutionContext): Promise<AgentAnalysisResult> {
    const toolUsage: AgentToolUsage = { calls: 0, additionalCodeRequests: 0,
      codeLines: request.initialCodeSlices.reduce((sum, slice) => sum + slice.endLine - slice.startLine + 1, 0), requestKeys: new Set() };
    const workingRequest = structuredClone(request);
    return this.run<AgentAnalysisOutput, AgentAnalysisResult>({
      promptVersion: this.settings.LLM_AGENT_PROMPT_VERSION,
      outputSchemaVersion: this.settings.LLM_AGENT_OUTPUT_SCHEMA_VERSION,
      toolUsage,
      prompt: (responses, feedback) => buildAgentPrompt(workingRequest, responses, feedback),
      parse: (value) => this.validator.parse(value, workingRequest),
      complete: async (output, result) => {
        const validated = await this.validator.validate(workingRequest, output, executionContext.extractedPackageRoot, this.settings.LLM_AGENT_MAX_FILE_SIZE_BYTES);
        const hasUnverifiedAssessment = validated.assessments.some((item) => item.status !== 'VERIFIED');
        return { ...result(hasUnverifiedAssessment ? 'PARTIAL' : 'COMPLETED'), output, validated, effectiveRequest: workingRequest };
      },
      requestCode: async (output, responses, signal) => {
        for (const requested of output.requests) {
          if (signal.aborted) throw new AgentRunError('Agent timeout', 'TIMEOUT');
          if (requested.maxLines > this.settings.LLM_AGENT_MAX_LINES_PER_SLICE) throw new AgentRunError('Tool line limit exceeded', 'REQUEST_LIMIT_EXCEEDED');
          if (requested.target.lines && requested.target.lines[1] - requested.target.lines[0] + 1 > requested.maxLines) throw new AgentRunError('Requested range exceeds maxLines', 'TOOL_REQUEST_REJECTED');
          let toolRequest: AgentToolRequest;
          if (requested.type === 'GET_FILE_RANGE' && requested.target.lines && requested.target.file) {
            toolRequest = { tool: 'GET_FILE_RANGE', input: { file: requested.target.file, startLine: requested.target.lines[0], endLine: requested.target.lines[1] } };
          } else if (requested.type === 'GET_PACKAGE_METADATA') toolRequest = { tool: 'GET_PACKAGE_METADATA', input: {} };
          else throw new AgentRunError('Tool unavailable or malformed', 'TOOL_REQUEST_REJECTED');
          const response = await abortable(this.tools.execute(toolRequest, executionContext.extractedPackageRoot, workingRequest.packageContext, request.analysisPolicy,
            this.settings.LLM_AGENT_MAX_LINES_PER_SLICE, this.settings.LLM_AGENT_MAX_FILE_SIZE_BYTES, toolUsage, signal), signal);
          responses.push({ requestId: requested.id, tool: requested.type, response });
          if (toolRequest.tool === 'GET_FILE_RANGE' && 'content' in response) {
            const slice: AgentCodeSlice = { sliceId: randomUUID(), file: response.file, startLine: response.startLine, endLine: response.endLine,
              content: response.content, contentRedacted: false, selectionReason: 'GET_FILE_RANGE', relatedFindingIds: [] };
            workingRequest.initialCodeSlices.push(slice);
            responses.push({ requestId: requested.id, sliceId: slice.sliceId });
          }
        }
      },
      failed: (result) => result,
    }, executionContext.signal);
  }

  /**
   * Input 0.3.0 / output 0.3.0 path. Output 0.2.0 remains parseable for stored
   * legacy responses but new production calls use structured limitations.
   * GET_FILE_RANGE requests become RUNTIME slices in the same registry as the
   * INITIAL slices; the model sees them only through tool responses, so
   * `initialCodeSlices` in the input stays INITIAL-only.
   */
  async executeV0_3(input: AgentAnalysisInputV0_3, executionContext: AgentExecutionContextV0_3,
    options: AgentExecutionOptionsV0_3 = {}): Promise<AgentAnalysisResultV0_3> {
    const { registry, resolver } = executionContext;
    const toolUsage: AgentToolUsage = { calls: 0, additionalCodeRequests: 0,
      codeLines: registry.list().reduce((sum, slice) => sum + slice.endLine - slice.startLine + 1, 0), requestKeys: new Set() };
    const slices = () => registry.list();
    const codeRequests: AgentCodeRequestRecordV0_3[] = [];
    let budgetHit = false;
    return this.run<AgentAnalysisOutputV0_3, AgentAnalysisResultV0_3>({
      promptVersion: AGENT_PROMPT_VERSION_V0_3,
      outputSchemaVersion: AGENT_OUTPUT_SCHEMA_VERSION_V0_3,
      outputSchema: AGENT_OUTPUT_API_SCHEMA_V0_3,
      toolUsage,
      prompt: (responses, feedback, finalCall) => buildAgentPromptV0_3(input, responses, feedback, finalCall ? { ...options.prompt, additionalCodeRequests: 'EXHAUSTED' } : options.prompt),
      budgetExhausted: () => budgetHit || toolUsage.calls >= input.analysisPolicy.maxToolCalls
        || toolUsage.additionalCodeRequests >= input.analysisPolicy.maxAdditionalCodeRequests
        || toolUsage.codeLines >= input.analysisPolicy.maxTotalCodeLines,
      parse: (value) => {
        validateAgentOutputV0_3ApiBranch(value);
        return parseAgentOutputV0_3(normalizeAgentOutputV0_3ApiResponse(value), input.request.analysisRequestId);
      },
      complete: async (output, result, signal) => {
        const validated = await this.artifactValidator.validate(input, output, { registry, resolver, maxFileSizeBytes: this.settings.LLM_AGENT_MAX_FILE_SIZE_BYTES, signal });
        const hasUnverifiedAssessment = validated.assessments.some((item) => item.status !== 'VERIFIED');
        const base = result(hasUnverifiedAssessment ? 'PARTIAL' : 'COMPLETED');
        const assessmentLimitations = validated.assessments.flatMap(({ evidenceIntegrity }) =>
          (evidenceIntegrity?.analysisLimitations ?? [])
            .filter(({ source }) => source === 'ASSESSMENT')
            .map(({ kind, detail }) => `[ASSESSMENT][${kind}] ${detail}`));
        return { ...base, limitations: [...new Set([...base.limitations, ...assessmentLimitations])], output, validated,
          slices: slices(), codeRequests: [...codeRequests] };
      },
      requestCode: async (output, responses, signal) => {
        for (const requested of output.requests) {
          if (signal.aborted) throw new AgentRunError('Agent timeout', 'TIMEOUT');
          const outcome = await abortable(this.runtimeTool.getFileRange(requested, {
            resolver, registry, analysisMode: input.analysisPlan.analysisMode, policy: input.analysisPolicy,
            maxLinesPerRequest: this.settings.LLM_AGENT_MAX_LINES_PER_SLICE, maxFileSizeBytes: this.settings.LLM_AGENT_MAX_FILE_SIZE_BYTES, usage: toolUsage, signal,
          }), signal);
          if ('unavailable' in outcome) {
            if (outcome.unavailable.reason === 'BUDGET_EXHAUSTED') budgetHit = true;
            codeRequests.push({ requestId: requested.id, artifactId: requested.target.artifactId, filePath: requested.target.filePath,
              requestedRange: outcome.requestedRange, servedRange: null, truncated: false, unavailableReason: outcome.unavailable.reason });
            responses.push({ requestId: requested.id, tool: requested.type, unavailable: outcome.unavailable });
            continue;
          }
          const { slice, requestedRange, servedRange, truncated } = outcome;
          codeRequests.push({ requestId: requested.id, artifactId: requested.target.artifactId, filePath: requested.target.filePath,
            requestedRange, servedRange, truncated });
          responses.push({ requestId: requested.id, tool: requested.type, truncated, slice: {
            sliceId: slice.sliceId, artifactId: slice.artifactId, filePath: slice.filePath, startLine: slice.startLine, endLine: slice.endLine,
            // Same lineage an INITIAL slice carries in the input, so the Agent sees where RUNTIME code came from.
            ...(slice.lineageStatus === undefined ? {} : { lineageStatus: slice.lineageStatus }),
            ...(slice.derivedFrom === undefined ? {} : { derivedFrom: slice.derivedFrom }),
            content: slice.content,
          } });
        }
      },
      failed: (result) => ({ ...result, slices: slices(), codeRequests: [...codeRequests] }),
    }, executionContext.signal);
  }

  private async run<TOutput extends LoopOutput, TResult>(loop: AgentLoop<TOutput, TResult>, externalSignal?: AbortSignal): Promise<TResult> {
    const analysisId = randomUUID();
    const start = performance.now();
    const usage: AgentUsage = {};
    const providerRequestIds: string[] = [];
    const limitations: string[] = [];
    const { toolUsage } = loop;
    const responses: unknown[] = [];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.settings.LLM_AGENT_TIMEOUT_MS);
    timer.unref?.();
    const signal = externalSignal ? AbortSignal.any([controller.signal, externalSignal]) : controller.signal;
    let modelCalls = 0;
    let model: string | undefined;
    const result = (status: AgentRunResult['status'], failureReason?: AgentFailureReason): AgentRunResult => ({
      status, analysisId, model, promptVersion: loop.promptVersion,
      outputSchemaVersion: loop.outputSchemaVersion, providerRequestIds, usage,
      modelCalls, toolCalls: toolUsage.calls, additionalCodeRequests: toolUsage.additionalCodeRequests,
      durationMs: performance.now() - start, limitations, ...(failureReason ? { failureReason } : {}),
    });
    try {
      for (;;) {
        let output: TOutput | undefined;
        let lastError: unknown;
        let retryFeedback: string[] = [];
        for (let attempt = 0; attempt <= this.settings.LLM_AGENT_MAX_RETRIES && modelCalls < MAX_MODEL_CALLS; attempt += 1) {
          if (signal.aborted) throw new AgentRunError('Agent timeout', 'TIMEOUT');
          modelCalls += 1;
          try {
            const prompt = loop.prompt(responses, retryFeedback, modelCalls >= MAX_MODEL_CALLS || loop.budgetExhausted?.() === true);
            const response = await abortable(loop.outputSchema ? this.provider.generate(prompt, signal, loop.outputSchema) : this.provider.generate(prompt, signal), signal);
            model = response.model;
            if (response.providerRequestId) providerRequestIds.push(response.providerRequestId);
            addUsage(usage, response.usage);
            if (!response.text) throw new AgentProviderError('Empty Agent output', true, 'EMPTY_RESPONSE');
            let parsed: unknown;
            try { parsed = JSON.parse(response.text) as unknown; } catch { throw new AgentProviderError('Invalid Agent JSON', true, 'INVALID_RESPONSE'); }
            try { output = loop.parse(parsed); } catch (error) {
              retryFeedback = schemaValidationFeedback(error);
              throw new AgentProviderError('Agent output schema invalid', true, 'OUTPUT_SCHEMA_VALIDATION_FAILED');
            }
            break;
          } catch (error) {
            lastError = error;
            if (retryFeedback.length === 0) retryFeedback = ['Invalid response'];
            if (signal.aborted) throw new AgentRunError('Agent timeout', 'TIMEOUT');
            if (!(error instanceof AgentProviderError) || !error.retryable) throw error;
          }
        }
        if (!output) throw lastError ?? new AgentRunError('Agent call limit reached', 'REQUEST_LIMIT_EXCEEDED');
        if (output.status === 'COMPLETED') {
          limitations.push(
            ...output.limitations.map((item) => typeof item === 'string' ? item : `[OUTPUT_LIMITATION][${item.kind}] ${item.detail}`),
            ...output.missingContext.map((item) => typeof item === 'string' ? item : `[GLOBAL_MISSING_CONTEXT][${item.kind}] ${item.detail}`),
          );
          return await loop.complete(output as Extract<TOutput, { status: 'COMPLETED' }>, (status) => result(status), signal);
        }
        if (modelCalls >= MAX_MODEL_CALLS) throw new AgentRunError('Agent call limit reached', 'REQUEST_LIMIT_EXCEEDED');
        if (output.requests.length === 0) throw new AgentRunError('Empty additional code request', 'TOOL_REQUEST_REJECTED');
        await loop.requestCode(output as Extract<TOutput, { status: 'NEEDS_ADDITIONAL_CODE' }>, responses, signal);
      }
    } catch (error) {
      const timeout = signal.aborted || (error instanceof AgentRunError && error.reason === 'TIMEOUT');
      const reason: AgentFailureReason = timeout ? 'TIMEOUT' : error instanceof AgentRunError || error instanceof AgentToolError || error instanceof AgentProviderError ? error.reason : 'INTERNAL_ERROR';
      limitations.push(reason);
      return loop.failed(result(timeout ? 'TIMEOUT' : 'FAILED', reason));
    } finally { clearTimeout(timer); controller.abort(); }
  }
}
