import type { PersistedDecision } from '../decision/decision-db.client';
import type { PolicyEvaluationResult } from './policy-evaluation.service';

export function buildPolicyEvaluationResponse(
  evaluation: PolicyEvaluationResult,
  persistence: PersistedDecision,
  evaluatedAt: string,
): Record<string, unknown> {
  return {
    decisionId: `dec_${evaluation.case.request.scanId}`,
    requestId: evaluation.case.request.requestId,
    score: null,
    decision: evaluation.decision.decision,
    reasonCode: evaluation.decision.reasonCode,
    reason: evaluation.decision.reason,
    matchedRuleIds: evaluation.decision.matchedRuleIds,
    evidenceIds: evaluation.decision.evidenceIds,
    assessmentIds: evaluation.decision.assessmentIds,
    scanId: evaluation.case.request.scanId,
    policyVersion: evaluation.decision.policyVersion,
    subject: evaluation.case.request.subject,
    evaluatedAt,
    judgmentId: evaluation.decision.judgmentId,
    llm: {
      ...evaluation.llm,
      ...(evaluation.shadow ? {
        shadow: {
          ...evaluation.shadow.llm,
          comparison: evaluation.shadow.comparison,
        },
      } : {}),
    },
    feed: {
      source: evaluation.case.osvFeed.source,
      feedStatus: evaluation.case.osvFeed.feedStatus,
      validationStatus: evaluation.case.osvFeed.validationStatus,
      errorCodes: evaluation.case.osvFeed.errorCodes,
      exclusions: evaluation.case.osvFeed.exclusions,
      feedEvidenceIds: [...evaluation.case.feedEvidenceIds].sort(),
      citedFeedEvidenceIds: evaluation.decision.feedEvidenceIds,
    },
    persistence: { saved: true, status: persistence.status, decisionDbId: persistence.decisionDbId },
  };
}
