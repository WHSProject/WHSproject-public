import { z } from 'zod';
import type { AgentAnalysisRequest } from './agent.contract';

const nonempty = z.string().min(1);
const identifiers = z.array(nonempty).min(1).refine((ids) => new Set(ids).size === ids.length);
const linePair = z.tuple([z.number().int().positive(), z.number().int().positive()]);
const codeRequest = z.strictObject({ id: nonempty, type: z.enum(['GET_FILE_RANGE', 'GET_PACKAGE_METADATA', 'GET_SYMBOL_DEFINITION', 'GET_SYMBOL_REFERENCES', 'GET_CALLERS', 'GET_IMPORT_RELATIONS']), target: z.strictObject({ file: nonempty.optional(), symbol: nonempty.optional(), lines: linePair.optional() }), reasonCode: nonempty, maxLines: z.number().int().positive() });
const codeReference = z.strictObject({ id: nonempty, sliceId: nonempty, lines: linePair, role: z.enum(['TRIGGER', 'SOURCE', 'TRANSFORM', 'SINK', 'CONDITION', 'CONTEXT']) });
export const assessmentSchema = z.strictObject({
  id: nonempty, type: z.literal('CORRELATED_BEHAVIOR'), signal: nonempty, category: nonempty,
  basis: z.enum(['PATTERN_MATCH', 'CO_OCCURRENCE', 'EXECUTION_LINK', 'DATA_FLOW', 'TOOL_CORRELATION']),
  findingIds: identifiers.optional(), atomicEvidenceIds: identifiers.optional(), refs: z.array(codeReference).min(1),
  flow: z.strictObject({ trigger: nonempty.optional(), source: nonempty.optional(), transforms: z.array(nonempty).optional(), sink: nonempty.optional(), conditions: z.array(nonempty).optional() }),
  reachability: z.strictObject({ status: z.enum(['CONFIRMED', 'LIKELY', 'POSSIBLE', 'UNREACHABLE', 'UNKNOWN']), entry: nonempty.optional(), path: z.array(nonempty).min(1).optional(), reasonCodes: identifiers.optional() }),
  verification: z.strictObject({ status: z.enum(['VERIFIED', 'PARTIALLY_VERIFIED', 'UNVERIFIED', 'REJECTED']), method: z.enum(['NONE', 'SELF_VERIFIED', 'DETERMINISTIC_VALIDATOR', 'INDEPENDENT_VERIFIER']) }),
  confidence: z.number().min(0).max(1), reasonCodes: identifiers,
  classification: z.enum(['BENIGN_LIKELY', 'DUAL_USE', 'SUSPICIOUS', 'LIKELY_MALICIOUS', 'UNKNOWN']).optional(),
  intentAssessment: z.enum(['BENIGN_LIKELY', 'DUAL_USE', 'SUSPICIOUS', 'LIKELY_MALICIOUS', 'UNKNOWN']).optional(),
  rationale: nonempty.optional(), alternatives: z.array(z.strictObject({ type: nonempty, plausibility: z.enum(['HIGH', 'MEDIUM', 'LOW', 'UNKNOWN']), reasonCodes: identifiers })).min(1).optional(), limitations: identifiers.optional(),
});
export const agentOutputSchema = z.discriminatedUnion('status', [
  z.strictObject({ requestId: nonempty, schemaVersion: z.literal('0.1.0'), status: z.literal('NEEDS_ADDITIONAL_CODE'), requests: z.array(codeRequest).min(1) }),
  z.strictObject({ requestId: nonempty, schemaVersion: z.literal('0.1.0'), status: z.literal('COMPLETED'), assessments: z.array(assessmentSchema), summary: z.strictObject({ verdict: z.enum(['NO_MALICIOUS_BEHAVIOR_FOUND', 'SUSPICIOUS', 'LIKELY_MALICIOUS', 'INCONCLUSIVE']), confidence: z.number().min(0).max(1), reasonCodes: identifiers }), limitations: z.array(z.string()), missingContext: z.array(z.string()) }),
]);
export type AgentAnalysisOutput = z.infer<typeof agentOutputSchema>;
export type AgentAssessment = z.infer<typeof assessmentSchema>;
export type AssessmentVerificationStatus = 'VERIFIED' | 'PARTIALLY_VERIFIED' | 'UNVERIFIED' | 'REJECTED';
export type EvidenceIntegrityStatus = 'PASSED' | 'INCOMPLETE' | 'REJECTED';
export interface AnalysisLimitationDiagnostic {
  source: 'ASSESSMENT' | 'GLOBAL_MISSING_CONTEXT';
  kind: string;
  detail: string;
  affectedAssessmentIds?: string[];
}
export interface EvidenceIntegrityValidation {
  criteriaVersion: 'EVIDENCE_INTEGRITY_V1';
  status: EvidenceIntegrityStatus;
  /** Deterministic integrity errors only. Agent-authored analytical limits are kept separately. */
  errors: string[];
  analysisLimitations: AnalysisLimitationDiagnostic[];
}
export interface ValidatedAssessment<TAssessment = AgentAssessment> {
  assessment: TAssessment;
  /** Legacy-compatible projection. For output 0.3.0, consult evidenceIntegrity for its explicit scope. */
  status: AssessmentVerificationStatus;
  issues: string[];
  evidenceIntegrity?: EvidenceIntegrityValidation;
}
export interface ValidatedAgentAnalysisResult { output: Extract<AgentAnalysisOutput, { status: 'COMPLETED' }>; assessments: ValidatedAssessment<AgentAssessment>[] }
export type AgentAnalysisStatus = 'NEEDS_ADDITIONAL_CODE' | 'COMPLETED' | 'PARTIAL' | 'FAILED' | 'TIMEOUT' | 'SKIPPED';
export type AgentFailureReason = 'INPUT_BUILD_FAILED' | 'PROVIDER_ERROR' | 'RATE_LIMITED' | 'TIMEOUT' | 'EMPTY_RESPONSE' | 'INVALID_RESPONSE' | 'OUTPUT_SCHEMA_VALIDATION_FAILED' | 'OUTPUT_TRUNCATED' | 'TOOL_REQUEST_REJECTED' | 'TOOL_EXECUTION_FAILED' | 'REQUEST_LIMIT_EXCEEDED' | 'INTERNAL_ERROR';
export interface AgentUsage { inputTokens?: number; cachedInputTokens?: number; outputTokens?: number; reasoningTokens?: number; totalTokens?: number }
export interface AgentAnalysisResult {
  status: Exclude<AgentAnalysisStatus, 'NEEDS_ADDITIONAL_CODE'>; analysisId: string; output?: Extract<AgentAnalysisOutput, { status: 'COMPLETED' }>;
  validated?: ValidatedAgentAnalysisResult; effectiveRequest?: AgentAnalysisRequest; model?: string; promptVersion: string; outputSchemaVersion: string;
  providerRequestIds: string[]; usage: AgentUsage; modelCalls: number; toolCalls: number; additionalCodeRequests: number; durationMs: number;
  limitations: string[]; failureReason?: AgentFailureReason;
}
export interface AgentAnalysisSummary {
  status: AgentAnalysisResult['status']; analysisId?: string; assessmentCount: number; verifiedAssessmentCount: number; generatedEvidenceCount: number; rejectedAssessmentCount: number; limitations: string[]; failureReason?: AgentFailureReason;
  model?: string; promptVersion?: string; toolCalls?: number; additionalCodeRequests?: number; modelCalls?: number; usage?: AgentUsage; durationMs?: number; triggerReason?: string;
}
