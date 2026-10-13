import { AgentToolError, type AgentToolUsage } from '../llm-agent-tools.service';
import type { GetFileRangeRequest } from './agent-output-v0_2.contract';
import { representationsForMode, type AgentAnalysisMode, type AgentCodeSlice, type ArtifactResolver } from './artifact.contract';
import { ArtifactReadError, readArtifactSource, registerCodeSlice, type ArtifactSource } from './code-slice.factory';
import type { CodeSliceRegistry } from './code-slice.registry';

/**
 * Artifact-based GET_FILE_RANGE for the Tier 3 input 0.3.0 path (issue #346).
 * Budgets, repeat detection and failure reasons follow the legacy
 * LlmAgentToolsService; reading and registration go through the shared slice
 * factory, so RUNTIME slices land in the same registry as INITIAL slices.
 */

export interface RuntimeToolPolicy { maxToolCalls: number; maxAdditionalCodeRequests: number; maxTotalCodeLines: number }

export interface RuntimeToolContext {
  resolver: ArtifactResolver;
  registry: CodeSliceRegistry;
  analysisMode: AgentAnalysisMode;
  policy: RuntimeToolPolicy;
  maxLinesPerRequest: number;
  maxFileSizeBytes: number;
  usage: AgentToolUsage;
  signal?: AbortSignal;
}

export interface RuntimeToolResult {
  slice: AgentCodeSlice;
  requestedRange: { startLine: number; endLine: number };
  servedRange: { startLine: number; endLine: number };
  truncated: boolean;
}

export type UnavailableReason = 'FILE_TOO_LARGE' | 'FILE_BINARY' | 'FILE_NOT_FOUND' | 'RANGE_OUTSIDE_FILE' | 'BUDGET_EXHAUSTED';

/** The file cannot be served; the Agent is told why and keeps going. Unsafe requests still throw. */
export interface RuntimeToolUnavailable {
  requestedRange: { startLine: number; endLine: number };
  unavailable: { reason: UnavailableReason; sizeBytes?: number; lineCount?: number };
}

const sequence = (value: number): string => String(value).padStart(3, '0');
export const runtimeSliceId = (requestNumber: number): string => `SLICE-R${sequence(requestNumber)}`;
export const additionalCodeRequestId = (requestNumber: number): string => `ACR-${sequence(requestNumber)}`;

function isValidRange(startLine: number, endLine: number): boolean {
  return Number.isSafeInteger(startLine) && Number.isSafeInteger(endLine) && startLine >= 1 && endLine >= startLine;
}

export class RuntimeCodeTool {
  async getFileRange(request: GetFileRangeRequest, context: RuntimeToolContext): Promise<RuntimeToolResult | RuntimeToolUnavailable> {
    const { policy, usage, signal } = context;
    const { artifactId, filePath, startLine, endLine } = request.target;
    signal?.throwIfAborted();
    // A used-up budget is answered, not thrown: the Agent still gets to finish with what it has.
    const exhausted = (): RuntimeToolUnavailable => ({ requestedRange: { startLine, endLine }, unavailable: { reason: 'BUDGET_EXHAUSTED' } });
    if (usage.calls >= policy.maxToolCalls) return exhausted();
    // The model-assigned id and reasonCode do not change what is read, so they are not part of the repeat key.
    const key = JSON.stringify({ tool: request.type, artifactId, filePath, startLine, endLine });
    if (usage.requestKeys.has(key)) throw new AgentToolError('Repeated tool request', 'TOOL_REQUEST_REJECTED');
    if (usage.additionalCodeRequests >= policy.maxAdditionalCodeRequests) return exhausted();
    if (!isValidRange(startLine, endLine)) throw new AgentToolError('Invalid file range', 'TOOL_REQUEST_REJECTED');
    const cappedEnd = Math.min(endLine, startLine + context.maxLinesPerRequest - 1);
    if (usage.codeLines + (cappedEnd - startLine + 1) > policy.maxTotalCodeLines) return exhausted();

    const artifact = context.resolver.describe(artifactId);
    if (!artifact) throw new AgentToolError('Unknown artifact', 'TOOL_REQUEST_REJECTED');
    if (!representationsForMode(context.analysisMode).includes(artifact.representation)) throw new AgentToolError('Artifact representation outside analysisMode', 'TOOL_REQUEST_REJECTED');

    const unavailable = (reason: UnavailableReason, extra: { sizeBytes?: number; lineCount?: number } = {}): RuntimeToolUnavailable => {
      usage.calls += 1;
      usage.additionalCodeRequests += 1;
      usage.requestKeys.add(key);
      return { requestedRange: { startLine, endLine }, unavailable: { reason, ...extra } };
    };

    let source: ArtifactSource;
    try {
      source = await readArtifactSource(context.resolver, artifactId, filePath, context.maxFileSizeBytes, signal);
    } catch (error) {
      if (!(error instanceof ArtifactReadError)) throw error;
      if (error.reason === 'FILE_UNAVAILABLE') return unavailable('FILE_NOT_FOUND');
      if (error.detail?.kind === 'TOO_LARGE') return unavailable('FILE_TOO_LARGE', { sizeBytes: error.detail.sizeBytes });
      if (error.detail?.kind === 'BINARY') return unavailable('FILE_BINARY');
      throw new AgentToolError(error.reason === 'ARTIFACT_NOT_FOUND' ? 'Unknown artifact' : 'Code file rejected by access policy', 'TOOL_REQUEST_REJECTED');
    }
    if (startLine > source.lineCount) return unavailable('RANGE_OUTSIDE_FILE', { lineCount: source.lineCount });

    const servedEnd = Math.min(cappedEnd, source.lineCount);
    const truncated = servedEnd < endLine;
    const requestNumber = usage.additionalCodeRequests + 1;
    const slice = registerCodeSlice(context.registry, source, { startLine, endLine: servedEnd }, {
      sliceId: runtimeSliceId(requestNumber),
      origin: 'RUNTIME',
      boundaryConfidence: startLine === 1 && servedEnd === source.lineCount ? 'HIGH' : truncated ? 'LOW' : 'MEDIUM',
      planningTargetId: null,
      additionalCodeRequestId: additionalCodeRequestId(requestNumber),
      agentRequestId: request.id,
      selectionReason: `Agent request ${request.id}: ${request.reasonCode}`,
      relatedFindingIds: [],
      relatedEvidenceIds: [],
    });
    usage.calls += 1;
    usage.additionalCodeRequests += 1;
    usage.codeLines += slice.endLine - slice.startLine + 1;
    usage.requestKeys.add(key);
    return {
      slice,
      requestedRange: { startLine, endLine },
      servedRange: { startLine, endLine: servedEnd },
      truncated,
    };
  }
}
