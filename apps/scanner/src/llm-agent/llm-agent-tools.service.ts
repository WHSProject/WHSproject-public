import { Injectable } from '@nestjs/common';
import type { AgentAnalysisPolicy, AgentPackageContext, AgentToolDescriptor } from './agent.contract';
import type { AgentFailureReason } from './output.contract';
import { readSafeCodeFile } from './safe-code-reader';

export interface GetFileRangeRequest { file: string; startLine: number; endLine: number }
export interface GetFileRangeResponse extends GetFileRangeRequest { content: string; truncated: boolean }
export interface AgentToolUsage { calls: number; additionalCodeRequests: number; codeLines: number; requestKeys: Set<string> }
export type AgentToolRequest = { tool: 'GET_FILE_RANGE'; input: GetFileRangeRequest } | { tool: 'GET_PACKAGE_METADATA'; input: Record<string, never> };
export class AgentToolError extends Error { constructor(message: string, readonly reason: Extract<AgentFailureReason, 'TOOL_REQUEST_REJECTED' | 'TOOL_EXECUTION_FAILED' | 'REQUEST_LIMIT_EXCEEDED'>) { super(message); } }

export const AGENT_TOOL_CATALOG: AgentToolDescriptor[] = [
  { tool: 'GET_FILE_RANGE', status: 'AVAILABLE' }, { tool: 'GET_PACKAGE_METADATA', status: 'AVAILABLE' },
  { tool: 'GET_SYMBOL_REFERENCES', status: 'UNAVAILABLE' }, { tool: 'GET_CALLERS', status: 'UNAVAILABLE' },
];

@Injectable()
export class LlmAgentToolsService {
  async getFileRange(root: string, request: GetFileRangeRequest, maxLines: number, maxBytes: number, signal?: AbortSignal): Promise<GetFileRangeResponse> {
    if (!Number.isSafeInteger(request.startLine) || !Number.isSafeInteger(request.endLine) || request.startLine < 1 || request.endLine < request.startLine || request.endLine - request.startLine + 1 > maxLines) throw new AgentToolError('Invalid file range', 'TOOL_REQUEST_REJECTED');
    let file;
    try { file = await readSafeCodeFile(root, request.file, maxBytes, signal); }
    catch (error) {
      if (signal?.aborted) throw error;
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') throw new AgentToolError('Code file unavailable', 'TOOL_EXECUTION_FAILED');
      throw new AgentToolError('Code file rejected by access policy', 'TOOL_REQUEST_REJECTED');
    }
    if (request.startLine > file.lines.length) throw new AgentToolError('File range outside file', 'TOOL_REQUEST_REJECTED');
    const endLine = Math.min(request.endLine, file.lines.length);
    return { file: file.file, startLine: request.startLine, endLine, content: file.lines.slice(request.startLine - 1, endLine).join('\n'), truncated: endLine < request.endLine };
  }
  getPackageMetadata(context: AgentPackageContext): AgentPackageContext {
    return structuredClone(context);
  }
  async execute(request: AgentToolRequest, root: string, context: AgentPackageContext, policy: AgentAnalysisPolicy, maxLines: number, maxBytes: number, usage: AgentToolUsage, signal?: AbortSignal): Promise<GetFileRangeResponse | AgentPackageContext> {
    signal?.throwIfAborted();
    if (!request || typeof request !== 'object' || !('tool' in request) || !('input' in request) || typeof request.input !== 'object' || request.input === null) throw new AgentToolError('Invalid tool request', 'TOOL_REQUEST_REJECTED');
    if (!AGENT_TOOL_CATALOG.some((descriptor) => descriptor.tool === request.tool && descriptor.status === 'AVAILABLE')) throw new AgentToolError('Tool unavailable', 'TOOL_REQUEST_REJECTED');
    if (usage.calls >= policy.maxToolCalls) throw new AgentToolError('Tool call limit exceeded', 'REQUEST_LIMIT_EXCEEDED');
    const key = JSON.stringify(request);
    if (usage.requestKeys.has(key)) throw new AgentToolError('Repeated tool request', 'TOOL_REQUEST_REJECTED');
    let response: GetFileRangeResponse | AgentPackageContext;
    if (request.tool === 'GET_FILE_RANGE') {
      if (Object.keys(request.input).sort().join(',') !== 'endLine,file,startLine' || typeof request.input.file !== 'string') throw new AgentToolError('Invalid file request', 'TOOL_REQUEST_REJECTED');
      if (usage.additionalCodeRequests >= policy.maxAdditionalCodeRequests) throw new AgentToolError('Additional code request limit exceeded', 'REQUEST_LIMIT_EXCEEDED');
      const requestedLines = request.input.endLine - request.input.startLine + 1;
      if (usage.codeLines + requestedLines > policy.maxTotalCodeLines) throw new AgentToolError('Total code line limit exceeded', 'REQUEST_LIMIT_EXCEEDED');
      response = await this.getFileRange(root, request.input, maxLines, maxBytes, signal);
      usage.additionalCodeRequests += 1;
      usage.codeLines += response.endLine - response.startLine + 1;
    } else {
      if (Object.keys(request.input).length !== 0) throw new AgentToolError('Invalid metadata request', 'TOOL_REQUEST_REJECTED');
      response = this.getPackageMetadata(context);
    }
    usage.calls += 1; usage.requestKeys.add(key);
    return response;
  }
}
