import type { Evidence, EvaluationRequest, LlmAssessmentEvidence, Subject } from '../contracts/evidence';
import { validateOsvFeed, type ValidatedOsvFeed } from './osv-feed.validator';

export interface EvidenceCase {
  caseId: string;
  request: EvaluationRequest;
  observations: Evidence[];
  assessments: LlmAssessmentEvidence[];
  evidenceIds: Set<string>;
  feedEvidenceIds: Set<string>;
  coverage: { status: 'COMPLETE' | 'PARTIAL' | 'UNKNOWN'; limitations: string[] };
  osvFeed: ValidatedOsvFeed;
}

function subjectKey(subject: Subject): string {
  return [subject.ecosystem, subject.packageName, subject.packageVersion, subject.artifactHash].join(':');
}

export function buildEvidenceCase(request: EvaluationRequest): EvidenceCase {
  const expectedSubject = subjectKey(request.subject);
  const ids = new Set<string>();
  const limitations = new Set<string>();
  for (const evidence of request.evidences) {
    if (typeof evidence.evidenceId !== 'string' || evidence.evidenceId.trim().length === 0) throw new Error('INVALID_EVIDENCE_ID');
    if (ids.has(evidence.evidenceId)) throw new Error(`DUPLICATE_EVIDENCE_ID:${evidence.evidenceId}`);
    ids.add(evidence.evidenceId);
    if (subjectKey(evidence.subject) !== expectedSubject) throw new Error(`MULTIPLE_SUBJECTS:${evidence.evidenceId}`);
    if (evidence.provenance.scanId !== request.scanId) throw new Error(`SCAN_ID_MISMATCH:${evidence.evidenceId}`);
    for (const limitation of evidence.limitations ?? []) limitations.add(limitation);
    if (evidence.kind === 'LLM_ASSESSMENT') {
      if (!Array.isArray(evidence.relatedAtomicEvidenceIds)) throw new Error(`INVALID_LLM_ASSESSMENT:${evidence.evidenceId}`);
      if (evidence.verificationStatus !== 'VERIFIED' || evidence.provenance.producerType !== 'LLM_AGENT' || evidence.provenance.analysisId === undefined || evidence.provenance.assessmentId === undefined || evidence.evidenceId !== `llm:${evidence.provenance.analysisId}:${evidence.provenance.assessmentId}`) throw new Error(`INVALID_LLM_ASSESSMENT:${evidence.evidenceId}`);
    }
  }
  for (const evidence of request.evidences) {
    if (evidence.kind !== 'LLM_ASSESSMENT') continue;
    for (const id of evidence.relatedAtomicEvidenceIds) {
      if (!ids.has(id)) throw new Error(`UNKNOWN_RELATED_EVIDENCE:${evidence.evidenceId}:${id}`);
      if (request.evidences.find((candidate) => candidate.evidenceId === id)?.kind === 'LLM_ASSESSMENT') throw new Error(`INVALID_RELATED_EVIDENCE_KIND:${evidence.evidenceId}:${id}`);
    }
  }
  const assessments = request.evidences.filter((evidence): evidence is LlmAssessmentEvidence => evidence.kind === 'LLM_ASSESSMENT');
  if (request.scanStatus !== 'COMPLETED') limitations.add(`SCAN_STATUS_${request.scanStatus}`);
  const coverage = request.scanStatus === 'COMPLETED' ? 'COMPLETE' : request.scanStatus === 'PARTIAL' ? 'PARTIAL' : 'UNKNOWN';
  const caseId = `case:${request.scanId}:${request.requestId}`;
  const osvFeed = validateOsvFeed(request.osvFeed, request);
  return { caseId, request, observations: request.evidences.filter((evidence) => evidence.kind !== 'LLM_ASSESSMENT'), assessments, evidenceIds: ids, feedEvidenceIds: new Set(osvFeed.advisories.filter((advisory) => advisory.validationStatus !== 'UNSUPPORTED_RISK').map((advisory) => advisory.feedEvidenceId)), coverage: { status: coverage, limitations: [...limitations] }, osvFeed };
}
