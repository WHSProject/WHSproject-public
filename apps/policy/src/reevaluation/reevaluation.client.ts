import type { Evidence, EvaluationRequest } from '../contracts/evidence';

export interface ReevaluationJob {
  id: string;
  ecosystem: 'npm';
  packageName: string;
  packageVersion: string;
  artifactHash256: string | null;
  artifactHash512: string | null;
  scanId: string | null;
  previousSnapshotId: string;
  triggerSnapshotId: string;
  previousDecisionId: string;
  changeReason: 'CONTENT_DIGEST_CHANGED';
  status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED';
  errorCode: string | null;
  errorDetail: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface PreviousDecision {
  id: string;
  decisionId: string;
  requestId: string;
  evidenceIds: string[];
  assessmentIds: string[];
  scanId: string;
  policyKey: string;
  policyVersion: string;
  feedSnapshotId: string | null;
  subject: {
    ecosystem: 'npm';
    packageName: string;
    packageVersion: string;
    artifactHash256?: string;
    artifactHash512?: string;
  };
}

export interface FeedSnapshotRecord {
  id: string;
  ecosystem: 'npm';
  packageName: string;
  packageVersion: string;
  source: 'OSV';
  rawAdvisories: Array<Record<string, unknown>>;
  validationResult: Record<string, unknown>;
  contentDigest: string;
  collectedAt: string;
  validatedAt: string;
  expiresAt: string;
}

export interface EvidenceLookup {
  ecosystem: 'npm';
  packageName: string;
  packageVersion: string;
  artifactHash: string;
  scanId?: string;
}

export interface ReevaluationJobClient {
  claim(jobId: string): Promise<{ claimed: boolean; job: ReevaluationJob }>;
  fail(jobId: string, errorCode: string, errorDetail: string): Promise<ReevaluationJob>;
  getDecision(decisionId: string): Promise<PreviousDecision>;
  getSnapshot(snapshotId: string): Promise<FeedSnapshotRecord>;
  getEvidence(input: EvidenceLookup): Promise<Evidence[]>;
}

export class ReevaluationClientError extends Error {
  constructor(message: string, readonly statusCode?: number, readonly retryable = false) { super(message); }
}

export class HttpReevaluationJobClient implements ReevaluationJobClient {
  constructor(
    private readonly decisionDbUrl = process.env.DECISION_DB_URL ?? 'http://localhost:9100',
    private readonly evidenceDbUrl = process.env.EVIDENCE_DB_URL ?? 'http://localhost:8100',
    private readonly timeoutMs = Number(process.env.DECISION_DB_TIMEOUT_MS ?? 5_000),
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async claim(jobId: string): Promise<{ claimed: boolean; job: ReevaluationJob }> {
    return this.request<{ claimed: boolean; job: ReevaluationJob }>(
      `${this.decisionDbUrl}/internal/v1/reevaluation-jobs/${encodeURIComponent(jobId)}/claim`,
      { method: 'POST' },
    );
  }

  async fail(jobId: string, errorCode: string, errorDetail: string): Promise<ReevaluationJob> {
    return this.request<ReevaluationJob>(
      `${this.decisionDbUrl}/internal/v1/reevaluation-jobs/${encodeURIComponent(jobId)}/fail`,
      { method: 'POST', body: JSON.stringify({ errorCode, errorDetail }) },
    );
  }

  async getDecision(decisionId: string): Promise<PreviousDecision> {
    return this.request<PreviousDecision>(
      `${this.decisionDbUrl}/internal/v1/decisions/by-decision-id/${encodeURIComponent(decisionId)}`,
      { method: 'GET' },
    );
  }

  async getSnapshot(snapshotId: string): Promise<FeedSnapshotRecord> {
    return this.request<FeedSnapshotRecord>(
      `${this.decisionDbUrl}/internal/v1/feed-snapshots/${encodeURIComponent(snapshotId)}`,
      { method: 'GET' },
    );
  }

  async getEvidence(input: EvidenceLookup): Promise<Evidence[]> {
    const url = new URL(`${this.evidenceDbUrl}/internal/v1/evidences/by-artifact`);
    url.searchParams.set('ecosystem', input.ecosystem);
    url.searchParams.set('packageName', input.packageName);
    url.searchParams.set('packageVersion', input.packageVersion);
    url.searchParams.set('artifactHash', input.artifactHash);
    if (input.scanId !== undefined) url.searchParams.set('scanId', input.scanId);
    return this.request<Evidence[]>(url.toString(), { method: 'GET' });
  }

  private async request<T>(url: string, init: { method: 'GET' | 'POST'; body?: string }): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetcher(url, {
        ...init,
        headers: { accept: 'application/json', ...(init.body ? { 'content-type': 'application/json' } : {}) },
        signal: controller.signal,
      });
      if (!response.ok) throw new ReevaluationClientError(`REEVALUATION_DB_HTTP_${response.status}`, response.status, response.status >= 500);
      try { return await response.json() as T; } catch { throw new ReevaluationClientError('REEVALUATION_DB_INVALID_RESPONSE', response.status); }
    } catch (error) {
      if (error instanceof ReevaluationClientError) throw error;
      throw new ReevaluationClientError(controller.signal.aborted ? 'REEVALUATION_DB_TIMEOUT' : 'REEVALUATION_DB_UNAVAILABLE', undefined, true);
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function feedRequestFromSnapshot(previous: PreviousDecision, snapshot: FeedSnapshotRecord, evidences: Evidence[]): EvaluationRequest {
  const artifactHash = previous.subject.artifactHash256 ?? previous.subject.artifactHash512;
  if (!artifactHash) throw new ReevaluationClientError('REEVALUATION_ARTIFACT_IDENTITY_MISSING');
  const integrity = previous.subject.artifactHash512 ?? artifactHash;
  const completedAt = typeof snapshot.validationResult.completedAt === 'string'
    ? snapshot.validationResult.completedAt : snapshot.validatedAt;
  return {
    requestId: previous.requestId,
    scanStatus: 'COMPLETED',
    scanId: previous.scanId,
    subject: {
      ecosystem: previous.subject.ecosystem,
      packageName: previous.subject.packageName,
      packageVersion: previous.subject.packageVersion,
      artifactHash,
      integrity,
    },
    evidences,
    osvFeed: {
      source: 'OSV',
      feedStatus: 'SUCCESS',
      query: { ecosystem: snapshot.ecosystem, packageName: snapshot.packageName, packageVersion: snapshot.packageVersion },
      advisories: snapshot.rawAdvisories,
      complete: true,
      pagesFetched: typeof snapshot.validationResult.pagesFetched === 'number' ? snapshot.validationResult.pagesFetched : 0,
      collectedAt: snapshot.collectedAt,
      completedAt,
      errorCode: null,
      skippedReason: null,
    },
  };
}
