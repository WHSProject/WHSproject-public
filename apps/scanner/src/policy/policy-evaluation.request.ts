import type { ScanExecutionResult } from '../application/orchestrator/orchestrator';
import type { ScanResult } from '../domain/analysis.types';
import { ScannerErrorCode } from '../domain/scanner-error-code';
import type { AgentAnalysisSummary, AgentFailureReason } from '../llm-agent/output.contract';
import { PolicyEvaluationError, type PolicyEvaluationRequest } from './policy-evaluation.client';

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function strings(value: unknown): value is string[] { return Array.isArray(value) && value.every((item) => typeof item === 'string'); }
function contractError(message: string): PolicyEvaluationError {
  return new PolicyEvaluationError(message, null, false, ScannerErrorCode.POLICY_EVALUATION_FAILED);
}
const failureReasons = new Set<AgentFailureReason>(['INPUT_BUILD_FAILED', 'PROVIDER_ERROR', 'RATE_LIMITED', 'TIMEOUT', 'EMPTY_RESPONSE', 'INVALID_RESPONSE', 'OUTPUT_SCHEMA_VALIDATION_FAILED', 'TOOL_REQUEST_REJECTED', 'TOOL_EXECUTION_FAILED', 'REQUEST_LIMIT_EXCEEDED', 'INTERNAL_ERROR']);

function validSummary(summary: AgentAnalysisSummary, llmCount: number): boolean {
  const counts = [summary.assessmentCount, summary.verifiedAssessmentCount, summary.generatedEvidenceCount, summary.rejectedAssessmentCount];
  if (!counts.every((count) => Number.isSafeInteger(count) && count >= 0)) return false;
  if (summary.verifiedAssessmentCount > summary.assessmentCount || summary.rejectedAssessmentCount > summary.assessmentCount || summary.generatedEvidenceCount > summary.verifiedAssessmentCount) return false;
  if (summary.generatedEvidenceCount !== llmCount) return false;
  if (summary.status === 'FAILED') return summary.failureReason !== undefined && failureReasons.has(summary.failureReason);
  if (summary.status === 'TIMEOUT') return summary.failureReason === 'TIMEOUT';
  if (summary.status === 'COMPLETED' || summary.status === 'SKIPPED') return summary.failureReason === undefined;
  return summary.status === 'PARTIAL' && (summary.failureReason === undefined || failureReasons.has(summary.failureReason));
}

function validLlmEvidence(value: unknown, atomicIds: ReadonlySet<string>, findingIds: ReadonlySet<string>): boolean {
  const evidence = record(value);
  if (!evidence || evidence.kind !== 'LLM_ASSESSMENT' || 'evidenceType' in evidence || evidence.verificationStatus !== 'VERIFIED') return false;
  const provenance = record(evidence.provenance);
  if (!provenance || provenance.producerType !== 'LLM_AGENT' || typeof provenance.analysisId !== 'string' || typeof provenance.assessmentId !== 'string') return false;
  if (evidence.evidenceId !== `llm:${provenance.analysisId}:${provenance.assessmentId}`) return false;
  if (!strings(evidence.relatedFindingIds) || !strings(evidence.relatedAtomicEvidenceIds)) return false;
  return evidence.relatedFindingIds.every((id) => findingIds.has(id)) && evidence.relatedAtomicEvidenceIds.every((id) => atomicIds.has(id));
}

function failedSummary(): AgentAnalysisSummary {
  return { status: 'FAILED', assessmentCount: 0, verifiedAssessmentCount: 0, generatedEvidenceCount: 0, rejectedAssessmentCount: 0,
    limitations: ['LLM Evidence failed Scanner contract validation'], failureReason: 'INTERNAL_ERROR' };
}

/** Final Scanner boundary: isolate invalid LLM data without changing existing Evidence or OSV. */
export function buildPolicyEvaluationRequest(saved: ScanResult, execution: ScanExecutionResult, integrity: string): PolicyEvaluationRequest {
  if (!record(execution.osvFeed)) throw contractError('OSV Feed is required for Policy Evaluation');
  const base: unknown[] = [];
  const llm: unknown[] = [];
  for (const evidence of saved.evidences) {
    const item = record(evidence);
    if (item?.kind === 'LLM_ASSESSMENT' || item?.evidenceType === 'LLM_ASSESSMENT' || (typeof item?.evidenceId === 'string' && item.evidenceId.startsWith('llm:')) || record(item?.provenance)?.producerType === 'LLM_AGENT') llm.push(evidence);
    else base.push(evidence);
  }
  const baseIds = new Set<string>();
  const atomicIds = new Set<string>();
  for (const value of base) {
    const evidence = record(value);
    if (!evidence || typeof evidence.evidenceId !== 'string' || baseIds.has(evidence.evidenceId)) throw contractError('Existing Evidence ID is invalid or duplicated');
    baseIds.add(evidence.evidenceId);
    if (evidence.kind === 'ATOMIC') atomicIds.add(evidence.evidenceId);
  }
  const llmIds = new Set<string>();
  const findingIds = new Set(execution.agentFindingIds ?? []);
  let summary = execution.agentAnalysisSummary?.status === 'SKIPPED' ? undefined : execution.agentAnalysisSummary;
  // A broken summary describes the whole Agent result; an invalid Evidence only affects itself.
  if (llm.length > 0 && (!summary || !validSummary(summary, llm.length)
    || llm.some((value) => {
      const analysisId = record(record(value)?.provenance)?.analysisId;
      return typeof analysisId === 'string' && analysisId !== summary?.analysisId;
    }))) {
    summary = failedSummary();
    llm.length = 0;
  }
  const accepted: unknown[] = [];
  for (const value of llm) {
    const evidence = record(value);
    if (!evidence || !validLlmEvidence(value, atomicIds, findingIds) || typeof evidence.evidenceId !== 'string' || baseIds.has(evidence.evidenceId) || llmIds.has(evidence.evidenceId)) continue;
    if (summary?.analysisId !== record(evidence.provenance)?.analysisId) continue;
    llmIds.add(evidence.evidenceId);
    accepted.push(value);
  }
  const removed = llm.length - accepted.length;
  if (removed > 0 && summary) {
    summary = { ...summary, status: 'PARTIAL', generatedEvidenceCount: accepted.length,
      rejectedAssessmentCount: Math.min(summary.assessmentCount, summary.rejectedAssessmentCount + removed),
      limitations: [...summary.limitations, 'LLM Evidence failed Scanner contract validation'] };
  }
  if (summary && !validSummary(summary, accepted.length)) {
    summary = failedSummary();
    accepted.length = 0;
  }
  return {
    requestId: saved.requestId, scanStatus: saved.status, scanId: saved.scanId,
    subject: { ecosystem: saved.subject.ecosystem, packageName: saved.subject.name, packageVersion: saved.subject.version, artifactHash: saved.artifactHash, integrity },
    evidences: [...base, ...accepted],
    osvFeed: execution.osvFeed,
    ...(summary ? { agentAnalysisSummary: summary } : {}),
  };
}
