import { Injectable } from '@nestjs/common';
import type { AgentAnalysisRequest } from './agent.contract';
import { agentOutputSchema, type AgentAnalysisOutput, type ValidatedAgentAnalysisResult, type ValidatedAssessment } from './output.contract';
import { readSafeCodeFile } from './safe-code-reader';

@Injectable()
export class AgentOutputValidatorService {
  parse(value: unknown, request: AgentAnalysisRequest): AgentAnalysisOutput {
    return this.parseForRequestId(value, request.request.analysisRequestId);
  }
  parseForRequestId(value: unknown, analysisRequestId: string): AgentAnalysisOutput {
    const output = agentOutputSchema.parse(value);
    if (output.requestId !== analysisRequestId) throw new Error('Agent output requestId mismatch');
    return output;
  }
  validateSuppliedSlices(request: { request: { analysisRequestId: string }; findings: ReadonlyArray<{ findingId: string }>;
    atomicEvidences: ReadonlyArray<{ evidenceId: string }>; initialCodeSlices: ReadonlyArray<{ sliceId: string; startLine: number; endLine: number }> },
  output: AgentAnalysisOutput): ValidatedAgentAnalysisResult {
    if (output.status !== 'COMPLETED') throw new Error('Completed Agent output required');
    if (output.requestId !== request.request.analysisRequestId) throw new Error('Agent output requestId mismatch');
    const findingIds = new Set(request.findings.map((item) => item.findingId)), evidenceIds = new Set(request.atomicEvidences.map((item) => item.evidenceId));
    const slices = new Map(request.initialCodeSlices.map((item) => [item.sliceId, item])), ids = new Set<string>();
    const assessments: ValidatedAssessment[] = [];
    for (const assessment of output.assessments) {
      const issues: string[] = [];
      if (ids.has(assessment.id)) issues.push('Duplicate assessment ID'); ids.add(assessment.id);
      const refIds = new Set<string>();
      for (const ref of assessment.refs) {
        if (refIds.has(ref.id)) issues.push('Duplicate reference ID'); refIds.add(ref.id);
        const slice = slices.get(ref.sliceId);
        if (!slice) { issues.push('Unknown slice'); continue; }
        if (ref.lines[0] < slice.startLine || ref.lines[1] > slice.endLine || ref.lines[0] > ref.lines[1]) issues.push('Reference outside slice');
      }
      for (const id of [assessment.flow.trigger, assessment.flow.source, ...(assessment.flow.transforms ?? []), assessment.flow.sink, ...(assessment.flow.conditions ?? [])]) if (id && !refIds.has(id)) issues.push('Unknown flow reference');
      for (const id of assessment.findingIds ?? []) if (!findingIds.has(id)) issues.push('Unknown Finding ID');
      for (const id of assessment.atomicEvidenceIds ?? []) if (!evidenceIds.has(id)) issues.push('Unknown Atomic Evidence ID');
      const status: ValidatedAssessment['status'] = issues.length ? 'REJECTED'
        : !assessment.findingIds?.length && !assessment.atomicEvidenceIds?.length ? 'PARTIALLY_VERIFIED'
        : output.missingContext.length || assessment.limitations?.length ? 'PARTIALLY_VERIFIED' : 'VERIFIED';
      assessments.push({ assessment, status, issues });
    }
    return { output, assessments };
  }
  async validate(request: AgentAnalysisRequest, output: AgentAnalysisOutput, root: string, maxBytes: number): Promise<ValidatedAgentAnalysisResult> {
    if (output.status !== 'COMPLETED') throw new Error('Completed Agent output required');
    if (output.requestId !== request.request.analysisRequestId) throw new Error('Agent output requestId mismatch');
    const ids = new Set<string>();
    const assessments: ValidatedAssessment[] = [];
    const findingIds = new Set(request.findings.map((item) => item.findingId));
    const evidenceIds = new Set(request.atomicEvidences.map((item) => item.evidenceId));
    const slices = new Map(request.initialCodeSlices.map((item) => [item.sliceId, item]));
    for (const assessment of output.assessments) {
      const issues: string[] = [];
      if (ids.has(assessment.id)) issues.push('Duplicate assessment ID');
      ids.add(assessment.id);
      const refIds = new Set<string>();
      for (const ref of assessment.refs) {
        if (refIds.has(ref.id)) issues.push('Duplicate reference ID');
        refIds.add(ref.id);
        const slice = slices.get(ref.sliceId);
        if (!slice) { issues.push('Unknown slice'); continue; }
        if (ref.lines[0] < slice.startLine || ref.lines[1] > slice.endLine || ref.lines[0] > ref.lines[1]) issues.push('Reference outside slice');
        try {
          const source = await readSafeCodeFile(root, slice.file, maxBytes);
          if (ref.lines[1] > source.lines.length || slice.endLine > source.lines.length) issues.push('Reference outside source file');
          if (source.lines.slice(slice.startLine - 1, slice.endLine).join('\n') !== slice.content) issues.push('Source and slice mismatch');
        } catch { issues.push('Source file unavailable or unsafe'); }
      }
      const flow = assessment.flow;
      for (const id of [flow.trigger, flow.source, ...(flow.transforms ?? []), flow.sink, ...(flow.conditions ?? [])]) if (id && !refIds.has(id)) issues.push('Unknown flow reference');
      for (const id of assessment.findingIds ?? []) if (!findingIds.has(id)) issues.push('Unknown Finding ID');
      for (const id of assessment.atomicEvidenceIds ?? []) if (!evidenceIds.has(id)) issues.push('Unknown Atomic Evidence ID');
      let status: ValidatedAssessment['status'];
      if (issues.length > 0) status = 'REJECTED';
      else if (!assessment.findingIds?.length && !assessment.atomicEvidenceIds?.length) status = 'PARTIALLY_VERIFIED';
      else if (output.missingContext.length > 0 || (assessment.limitations?.length ?? 0) > 0) status = 'PARTIALLY_VERIFIED';
      else status = 'VERIFIED';
      assessments.push({ assessment, status, issues });
    }
    return { output, assessments };
  }
}
