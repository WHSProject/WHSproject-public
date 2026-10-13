import { createHash } from 'node:crypto';
import type { ValidatedOsvFeed } from '../case/osv-feed.validator';
import type { EvaluationRequest } from '../contracts/evidence';
import type { PolicyJudgment } from '../contracts/judgment';

export class FeedPersistenceError extends Error {
  constructor(message: string, readonly statusCode?: number, readonly retryable = false) { super(message); }
}

export interface PersistedFeedLookup {
  attemptId: string;
  snapshotId: string | null;
  snapshotReused: boolean;
  contentChanged?: boolean;
  previousSnapshotId?: string | null;
  reevaluationJobIds?: string[];
}

export interface FeedPersistencePayload {
  attempt: {
    requestId: string;
    scanId: string | null;
    ecosystem: 'npm';
    packageName: string;
    packageVersion: string;
    source: 'OSV';
    feedStatus: ValidatedOsvFeed['feedStatus'];
    complete: boolean;
    errorCode: string | null;
    skippedReason: string | null;
    pagesFetched: number;
    startedAt: string;
    completedAt: string;
    failureDetail: string | null;
  };
  snapshot: null | {
    ecosystem: 'npm';
    packageName: string;
    packageVersion: string;
    source: 'OSV';
    rawAdvisories: Array<Record<string, unknown>>;
    validationResult: Record<string, unknown>;
    contentDigest: string;
    collectedAt: string;
    validatedAt: string;
  };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item)]));
  }
  return value;
}

function digestAdvisory(advisory: Record<string, unknown>): Record<string, unknown> {
  const databaseSpecific = advisory.database_specific;
  const affected = Array.isArray(advisory.affected) ? advisory.affected.map((item) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return item;
    const record = item as Record<string, unknown>;
    const affectedDatabaseSpecific = record.database_specific;
    return {
      package: record.package ?? null,
      versions: record.versions ?? [],
      ranges: record.ranges ?? [],
      severity: record.severity ?? [],
      databaseSpecificSeverity: typeof affectedDatabaseSpecific === 'object' && affectedDatabaseSpecific !== null && !Array.isArray(affectedDatabaseSpecific)
        ? (affectedDatabaseSpecific as Record<string, unknown>).severity ?? null : null,
    };
  }) : advisory.affected;
  return {
    id: advisory.id ?? null,
    aliases: advisory.aliases ?? [],
    affected: affected ?? [],
    severity: advisory.severity ?? [],
    databaseSpecificSeverity: typeof databaseSpecific === 'object' && databaseSpecific !== null && !Array.isArray(databaseSpecific)
      ? (databaseSpecific as Record<string, unknown>).severity ?? null : null,
    withdrawn: advisory.withdrawn ?? null,
  };
}

function digestValidatedAdvisory(advisory: ValidatedOsvFeed['advisories'][number]): Record<string, unknown> {
  return {
    advisoryId: advisory.advisoryId,
    aliases: advisory.aliases,
    affected: advisory.affected,
    rawSeverity: advisory.rawSeverity,
    severity: advisory.severity ?? null,
    riskType: advisory.riskType,
    validationStatus: advisory.validationStatus,
    validationCodes: advisory.validationCodes,
  };
}

function digestExclusion(request: EvaluationRequest, exclusion: { index: number; code: string }): Record<string, unknown> {
  return {
    code: exclusion.code,
    advisory: exclusion.index >= 0 && exclusion.index < request.osvFeed.advisories.length
      ? digestAdvisory(request.osvFeed.advisories[exclusion.index]!)
      : null,
  };
}

export function feedContentDigest(request: EvaluationRequest, feed: ValidatedOsvFeed): string {
  const judgmentContent = canonicalize({
    packageName: request.subject.packageName,
    packageVersion: request.subject.packageVersion,
    ecosystem: request.subject.ecosystem,
    advisories: request.osvFeed.advisories.map(digestAdvisory),
    validation: {
      status: feed.validationStatus,
      advisories: feed.advisories.map(digestValidatedAdvisory),
      // Bind each validation error to its advisory content, not its array
      // position, so reordering the raw feed cannot change the digest.
      exclusions: feed.exclusions.map((exclusion) => digestExclusion(request, exclusion)),
      errorCodes: feed.errorCodes,
    },
  });
  return createHash('sha256').update(JSON.stringify(judgmentContent)).digest('hex');
}

export function buildFeedPersistencePayload(
  request: EvaluationRequest,
  feed: ValidatedOsvFeed,
  validatedAt: string,
): FeedPersistencePayload {
  const completedAt = feed.completedAt ?? validatedAt;
  const startedAtCandidate = feed.collectedAt ?? completedAt;
  const startedAt = Date.parse(startedAtCandidate) <= Date.parse(completedAt) ? startedAtCandidate : completedAt;
  const errorCode = feed.errorCodes[0] ?? null;
  const attempt: FeedPersistencePayload['attempt'] = {
    requestId: request.requestId,
    scanId: request.scanId || null,
    ecosystem: request.subject.ecosystem,
    packageName: request.subject.packageName,
    packageVersion: request.subject.packageVersion,
    source: feed.source,
    feedStatus: feed.feedStatus,
    complete: feed.complete,
    errorCode,
    skippedReason: feed.skippedReason,
    pagesFetched: feed.pagesFetched,
    startedAt,
    completedAt,
    failureDetail: errorCode ?? feed.skippedReason,
  };
  if (feed.feedStatus !== 'SUCCESS' || !feed.complete || feed.collectedAt === null) {
    return { attempt, snapshot: null };
  }
  return {
    attempt,
    snapshot: {
      ecosystem: request.subject.ecosystem,
      packageName: request.subject.packageName,
      packageVersion: request.subject.packageVersion,
      source: feed.source,
      rawAdvisories: request.osvFeed.advisories,
      validationResult: {
        validationStatus: feed.validationStatus,
        advisories: feed.advisories,
        exclusions: feed.exclusions,
        errorCodes: feed.errorCodes,
        pagesFetched: feed.pagesFetched,
        completedAt: feed.completedAt,
      },
      contentDigest: feedContentDigest(request, feed),
      collectedAt: feed.collectedAt,
      validatedAt,
    },
  };
}

/** Returns all OSV references cited anywhere in a validated LLM judgment. */
export function usedFeedEvidenceIds(judgment: PolicyJudgment): string[] {
  return [...new Set(judgment.ruleEvaluations.flatMap((rule) =>
    rule.predicateEvaluations.flatMap((predicate) => predicate.feedEvidenceIds)))].sort();
}

export class HttpFeedPersistenceClient {
  constructor(private readonly baseUrl = process.env.DECISION_DB_URL ?? 'http://localhost:9100', private readonly timeoutMs = Number(process.env.DECISION_DB_TIMEOUT_MS ?? (Number(process.env.DECISION_DB_TIMEOUT_SECONDS ?? 5) * 1_000)), private readonly fetcher: typeof fetch = fetch) {}

  async save(payload: FeedPersistencePayload): Promise<PersistedFeedLookup> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetcher(`${this.baseUrl.replace(/\/+$/u, '')}/internal/v1/feed-lookups`, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: controller.signal });
      if (!response.ok) {
        let code = `FEED_PERSISTENCE_HTTP_${response.status}`;
        try {
          const body = await response.json() as { detail?: { code?: unknown } };
          if (typeof body.detail?.code === 'string') code = body.detail.code;
        } catch { /* preserve HTTP status code */ }
        throw new FeedPersistenceError(code, response.status, response.status >= 500);
      }
      let body: Record<string, unknown>;
      try { body = await response.json() as Record<string, unknown>; } catch { throw new FeedPersistenceError('FEED_PERSISTENCE_INVALID_RESPONSE', response.status); }
      if (typeof body.attemptId !== 'string' || (body.snapshotId !== null && typeof body.snapshotId !== 'string') || typeof body.snapshotReused !== 'boolean') throw new FeedPersistenceError('FEED_PERSISTENCE_INVALID_RESPONSE', response.status);
      const jobIds = body.reevaluationJobIds;
      if (jobIds !== undefined && (!Array.isArray(jobIds) || jobIds.some((id) => typeof id !== 'string'))) throw new FeedPersistenceError('FEED_PERSISTENCE_INVALID_RESPONSE', response.status);
      return {
        attemptId: body.attemptId,
        snapshotId: body.snapshotId as string | null,
        snapshotReused: body.snapshotReused,
        contentChanged: body.contentChanged === true,
        previousSnapshotId: typeof body.previousSnapshotId === 'string' ? body.previousSnapshotId : null,
        reevaluationJobIds: (jobIds as string[] | undefined) ?? [],
      };
    } catch (error) {
      if (error instanceof FeedPersistenceError) throw error;
      throw new FeedPersistenceError(controller.signal.aborted ? 'FEED_PERSISTENCE_TIMEOUT' : 'FEED_PERSISTENCE_UNAVAILABLE', undefined, true);
    } finally {
      clearTimeout(timeout);
    }
  }
}
