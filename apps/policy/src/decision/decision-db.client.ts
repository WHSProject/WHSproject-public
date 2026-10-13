import type { EvaluationRequest } from '../contracts/evidence';
import type { PolicySnapshot } from '../contracts/policy';
import type { ResolvedDecision } from './decision.resolver';

export class DecisionDbError extends Error {
  constructor(message: string, readonly statusCode?: number, readonly retryable = false) { super(message); }
}

export interface PersistedDecision {
  decisionDbId: string | null;
  status: 'SAVED' | 'ALREADY_EXISTS';
}

export interface DecisionFeedReferences {
  snapshotId: string | null;
}

export interface DecisionLineage {
  decisionId?: string;
  previousDecisionId?: string;
  triggerSnapshotId?: string | null;
  reevaluationJobId?: string;
}

export class HttpDecisionDbClient {
  constructor(private readonly baseUrl = process.env.DECISION_DB_URL ?? 'http://localhost:9100', private readonly timeoutMs = Number(process.env.DECISION_DB_TIMEOUT_MS ?? (Number(process.env.DECISION_DB_TIMEOUT_SECONDS ?? 5) * 1_000)), private readonly fetcher: typeof fetch = fetch) {}

  async save(request: EvaluationRequest, policy: PolicySnapshot, decision: ResolvedDecision, evaluatedAt: string, feed: DecisionFeedReferences = { snapshotId: null }, lineage: DecisionLineage = {}): Promise<PersistedDecision> {
    const payload = {
      policyKey: policy.policyKey,
      decision: {
        decisionId: lineage.decisionId ?? `dec_${request.scanId}`,
        requestId: request.requestId,
        score: null,
        decision: decision.decision,
        reasonCode: decision.reasonCode,
        reason: decision.reason,
        matchedRuleIds: decision.matchedRuleIds,
        evidenceIds: decision.evidenceIds,
        scanId: request.scanId,
        policyVersion: policy.policyVersion,
        judgmentId: decision.judgmentId,
        policyHash: policy.policyHash ?? null,
        assessmentIds: decision.assessmentIds,
        feedSnapshotId: feed.snapshotId,
        feedEvidenceIds: decision.feedEvidenceIds.length > 0 ? decision.feedEvidenceIds : null,
        previousDecisionId: lineage.previousDecisionId ?? null,
        triggerSnapshotId: lineage.triggerSnapshotId ?? null,
        subject: { ecosystem: request.subject.ecosystem, packageName: request.subject.packageName, packageVersion: request.subject.packageVersion, artifactHash256: request.subject.artifactHash, artifactHash512: request.subject.integrity },
        evaluatedAt,
      },
      ...(lineage.reevaluationJobId ? { reevaluationJobId: lineage.reevaluationJobId } : {}),
    };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetcher(`${this.baseUrl.replace(/\/+$/u, '')}/internal/v1/decisions`, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: controller.signal });
      if (response.status === 409) {
        const conflict = await response.json().catch(() => null) as { detail?: { code?: unknown } } | null;
        if (conflict?.detail?.code === 'DECISION_ALREADY_EXISTS') return { decisionDbId: null, status: 'ALREADY_EXISTS' };
        throw new DecisionDbError(typeof conflict?.detail?.code === 'string' ? conflict.detail.code : `DECISION_DB_HTTP_${response.status}`, response.status, false);
      }
      if (response.status >= 500) throw new DecisionDbError(`DECISION_DB_HTTP_${response.status}`, response.status, true);
      if (!response.ok) throw new DecisionDbError(`DECISION_DB_HTTP_${response.status}`, response.status, false);
      let body: Record<string, unknown>;
      try { body = await response.json() as Record<string, unknown>; } catch { throw new DecisionDbError('DECISION_DB_INVALID_RESPONSE', response.status, false); }
      if (typeof body.id !== 'string' && typeof body.decisionId !== 'string') throw new DecisionDbError('DECISION_DB_INVALID_RESPONSE');
      return { decisionDbId: typeof body.id === 'string' ? body.id : null, status: 'SAVED' };
    } catch (error) {
      if (error instanceof DecisionDbError) throw error;
      throw new DecisionDbError(controller.signal.aborted ? 'DECISION_DB_TIMEOUT' : 'DECISION_DB_UNAVAILABLE', undefined, true);
    } finally {
      clearTimeout(timeout);
    }
  }
}
