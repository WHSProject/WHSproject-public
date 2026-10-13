import { Inject, Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';

import type { OsvFeedClient } from './osv-feed-client';
import type { OsvFeedInput, OsvFeedResult } from './osv-feed.types';

export interface FeedSnapshot {
  id: string;
  source: 'OSV';
  ecosystem: 'npm';
  packageName: string;
  packageVersion: string;
  rawAdvisories: Array<Record<string, unknown>>;
  validationResult: Record<string, unknown>;
  contentDigest: string;
  collectedAt: string;
  validatedAt: string;
  expiresAt: string;
}

export interface FeedRefreshCandidate {
  source: 'OSV';
  ecosystem: 'npm';
  packageName: string;
  packageVersion: string;
  lastRequestedAt: string;
}

export interface FeedLookupPersistence {
  requestId: string;
  scanId: string | null;
  feed: OsvFeedResult;
  contentDigest?: string;
  validationResult?: Record<string, unknown>;
}

export interface FeedLookupPersistenceResult {
  attemptId: string;
  snapshotId: string | null;
  snapshotReused: boolean;
  reevaluationJobIds?: string[];
}

export interface FeedSnapshotStore {
  lookup(query: Pick<OsvFeedInput, 'ecosystem' | 'packageName' | 'packageVersion'>, signal: AbortSignal): Promise<FeedSnapshot | null>;
  listRefreshCandidates(since: string, signal: AbortSignal): Promise<FeedRefreshCandidate[]>;
  persistLookup(input: FeedLookupPersistence, signal: AbortSignal): Promise<FeedLookupPersistenceResult>;
}

export const FEED_SNAPSHOT_STORE = Symbol('FEED_SNAPSHOT_STORE');

export interface OsvFeedResolution {
  feed: OsvFeedResult;
  snapshotId?: string;
}

/** Read-through adapter. Cache failures deliberately fall back to live OSV. */
@Injectable()
export class OsvFeedCacheAdapter {
  constructor(
    @Inject(FEED_SNAPSHOT_STORE)
    private readonly store: FeedSnapshotStore,
    private readonly liveClient: OsvFeedClient,
    private readonly now: () => number = Date.now,
  ) {}

  async query(input: OsvFeedInput): Promise<OsvFeedResolution> {
    if (input.permission?.allowed !== true || input.ecosystem !== 'npm') {
      return { feed: await this.liveClient.query(input) };
    }
    try {
      const snapshot = await this.store.lookup(input, input.signal);
      if (snapshot !== null && this.isUsable(snapshot, input)) {
        return { feed: fromSnapshot(snapshot, input), snapshotId: snapshot.id };
      }
    } catch {
      // A cache outage must never turn an otherwise valid Scanner evaluation into a failure.
    }
    return { feed: await this.liveClient.query(input) };
  }

  private isUsable(
    snapshot: FeedSnapshot,
    input: OsvFeedInput,
  ): boolean {
    return snapshot.source === 'OSV'
      && snapshot.ecosystem === input.ecosystem
      && snapshot.packageName === input.packageName
      && snapshot.packageVersion === input.packageVersion
      && Array.isArray(snapshot.rawAdvisories)
      && Number.isFinite(Date.parse(snapshot.expiresAt))
      && Date.parse(snapshot.expiresAt) > this.now();
  }
}

function fromSnapshot(snapshot: FeedSnapshot, input: OsvFeedInput): OsvFeedResult {
  const pagesFetched = typeof snapshot.validationResult.pagesFetched === 'number'
    && Number.isSafeInteger(snapshot.validationResult.pagesFetched)
    && snapshot.validationResult.pagesFetched >= 0
    ? snapshot.validationResult.pagesFetched : 0;
  const completedAt = typeof snapshot.validationResult.completedAt === 'string'
    ? snapshot.validationResult.completedAt : snapshot.validatedAt;
  return {
    source: 'OSV',
    feedStatus: 'SUCCESS',
    query: {
      ecosystem: input.ecosystem,
      packageName: input.packageName,
      packageVersion: input.packageVersion,
    },
    advisories: snapshot.rawAdvisories,
    complete: true,
    pagesFetched,
    collectedAt: snapshot.collectedAt,
    completedAt,
    errorCode: null,
    skippedReason: null,
  };
}

export class InMemoryFeedSnapshotStore implements FeedSnapshotStore {
  private readonly snapshots = new Map<string, FeedSnapshot>();
  private readonly attempts: FeedLookupPersistence[] = [];

  constructor(private readonly now: () => number = Date.now) {}

  put(snapshot: FeedSnapshot): void {
    this.snapshots.set(key(snapshot), snapshot);
  }

  async lookup(query: Pick<OsvFeedInput, 'ecosystem' | 'packageName' | 'packageVersion'>): Promise<FeedSnapshot | null> {
    return this.snapshots.get(key(query)) ?? null;
  }

  async listRefreshCandidates(since: string): Promise<FeedRefreshCandidate[]> {
    const sinceMs = Date.parse(since);
    const latest = new Map<string, FeedLookupPersistence>();
    for (const attempt of this.attempts) {
      const identity = key(attempt.feed.query);
      const previous = latest.get(identity);
      if (previous === undefined || Date.parse(attempt.feed.completedAt ?? '') > Date.parse(previous.feed.completedAt ?? '')) latest.set(identity, attempt);
    }
    return [...latest.values()].flatMap((attempt) => {
      const snapshot = this.snapshots.get(key(attempt.feed.query));
      const lastRequestedAt = attempt.feed.completedAt ?? attempt.feed.collectedAt;
      if (lastRequestedAt === null || Date.parse(lastRequestedAt) < sinceMs || (snapshot !== undefined && Date.parse(snapshot.expiresAt) > this.now())) return [];
      return [{ source: 'OSV' as const, ecosystem: attempt.feed.query.ecosystem as 'npm', packageName: attempt.feed.query.packageName, packageVersion: attempt.feed.query.packageVersion, lastRequestedAt }];
    });
  }

  async persistLookup(input: FeedLookupPersistence): Promise<FeedLookupPersistenceResult> {
    this.attempts.push(input);
    if (input.feed.feedStatus === 'SUCCESS' && input.feed.complete && input.feed.collectedAt !== null) {
      const snapshot: FeedSnapshot = {
        id: randomUUID(), source: 'OSV', ecosystem: input.feed.query.ecosystem as 'npm', packageName: input.feed.query.packageName, packageVersion: input.feed.query.packageVersion,
        rawAdvisories: input.feed.advisories, validationResult: { pagesFetched: input.feed.pagesFetched, completedAt: input.feed.completedAt }, contentDigest: '', collectedAt: input.feed.collectedAt, validatedAt: input.feed.completedAt ?? input.feed.collectedAt, expiresAt: new Date(Date.parse(input.feed.completedAt ?? input.feed.collectedAt) + 3_600_000).toISOString(),
      };
      this.put(snapshot);
      return { attemptId: input.requestId, snapshotId: snapshot.id, snapshotReused: false };
    }
    return { attemptId: input.requestId, snapshotId: null, snapshotReused: false };
  }
}

@Injectable()
export class HttpFeedSnapshotStore implements FeedSnapshotStore {
  constructor(
    private readonly baseUrl = process.env.DECISION_DB_URL ?? 'http://decision-db-api:9100',
    private readonly timeoutMs = Number(process.env.FEED_CACHE_TIMEOUT_MS ?? 750),
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async lookup(query: Pick<OsvFeedInput, 'ecosystem' | 'packageName' | 'packageVersion'>, signal: AbortSignal): Promise<FeedSnapshot | null> {
    const url = new URL(`${this.baseUrl.replace(/\/+$/u, '')}/internal/v1/feed-snapshots/lookup`);
    url.searchParams.set('source', 'OSV');
    url.searchParams.set('ecosystem', query.ecosystem);
    url.searchParams.set('packageName', query.packageName);
    url.searchParams.set('packageVersion', query.packageVersion);
    const body = await this.request(url, { method: 'GET', headers: { accept: 'application/json' }, signal });
    if (body === null) return null;
    return parseSnapshot(body);
  }

  async listRefreshCandidates(since: string, signal: AbortSignal): Promise<FeedRefreshCandidate[]> {
    const url = new URL(`${this.baseUrl.replace(/\/+$/u, '')}/internal/v1/feed-snapshots/refresh-candidates`);
    url.searchParams.set('source', 'OSV');
    url.searchParams.set('since', since);
    const body = await this.request(url, { method: 'GET', headers: { accept: 'application/json' }, signal });
    if (!Array.isArray(body)) throw new Error('FEED_CACHE_INVALID_CANDIDATES');
    return body.map(parseCandidate);
  }

  async persistLookup(input: FeedLookupPersistence, signal: AbortSignal): Promise<FeedLookupPersistenceResult> {
    const response = await this.fetcher(`${this.baseUrl.replace(/\/+$/u, '')}/internal/v1/feed-lookups`, {
      method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' }, signal,
      body: JSON.stringify(buildRefreshPersistencePayload(input)),
    });
    if (!response.ok) throw new Error(`FEED_CACHE_PERSISTENCE_HTTP_${response.status}`);
    const body = await response.json() as Record<string, unknown>;
    if (typeof body.attemptId !== 'string' || (body.snapshotId !== null && typeof body.snapshotId !== 'string') || typeof body.snapshotReused !== 'boolean') throw new Error('FEED_CACHE_INVALID_PERSISTENCE_RESPONSE');
    const jobIds = body.reevaluationJobIds;
    if (jobIds !== undefined && (!Array.isArray(jobIds) || jobIds.some((id) => typeof id !== 'string'))) throw new Error('FEED_CACHE_INVALID_PERSISTENCE_RESPONSE');
    return { attemptId: body.attemptId, snapshotId: body.snapshotId as string | null, snapshotReused: body.snapshotReused, reevaluationJobIds: (jobIds as string[] | undefined) ?? [] };
  }

  private async request(url: URL, init: RequestInit): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const onAbort = (): void => controller.abort();
    init.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const response = await this.fetcher(url, { ...init, signal: controller.signal });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`FEED_CACHE_HTTP_${response.status}`);
      return await response.json();
    } finally {
      clearTimeout(timer);
      init.signal?.removeEventListener('abort', onAbort);
    }
  }
}

function parseSnapshot(value: unknown): FeedSnapshot {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('FEED_CACHE_INVALID_SNAPSHOT');
  const record = value as Record<string, unknown>;
  if (typeof record.id !== 'string' || record.source !== 'OSV' || record.ecosystem !== 'npm' || typeof record.packageName !== 'string' || typeof record.packageVersion !== 'string' || !Array.isArray(record.rawAdvisories) || typeof record.validationResult !== 'object' || record.validationResult === null || typeof record.contentDigest !== 'string' || typeof record.collectedAt !== 'string' || typeof record.validatedAt !== 'string' || typeof record.expiresAt !== 'string') throw new Error('FEED_CACHE_INVALID_SNAPSHOT');
  return record as unknown as FeedSnapshot;
}

function parseCandidate(value: unknown): FeedRefreshCandidate {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('FEED_CACHE_INVALID_CANDIDATE');
  const record = value as Record<string, unknown>;
  if (record.source !== 'OSV' || record.ecosystem !== 'npm' || typeof record.packageName !== 'string' || typeof record.packageVersion !== 'string' || typeof record.lastRequestedAt !== 'string') throw new Error('FEED_CACHE_INVALID_CANDIDATE');
  return record as unknown as FeedRefreshCandidate;
}

function buildRefreshPersistencePayload(input: FeedLookupPersistence): Record<string, unknown> {
  const feed = input.feed;
  const completedAt = feed.completedAt ?? feed.collectedAt ?? new Date().toISOString();
  const collectedAt = feed.collectedAt ?? completedAt;
  const success = feed.feedStatus === 'SUCCESS' && feed.complete && feed.collectedAt !== null;
  return {
    attempt: {
      requestId: input.requestId,
      scanId: input.scanId,
      ecosystem: feed.query.ecosystem,
      packageName: feed.query.packageName,
      packageVersion: feed.query.packageVersion,
      source: 'OSV',
      feedStatus: feed.feedStatus,
      complete: success,
      errorCode: feed.errorCode,
      skippedReason: feed.skippedReason,
      pagesFetched: feed.pagesFetched,
      startedAt: collectedAt,
      completedAt,
      failureDetail: feed.errorCode ?? feed.skippedReason,
    },
    snapshot: success ? {
      ecosystem: feed.query.ecosystem,
      packageName: feed.query.packageName,
      packageVersion: feed.query.packageVersion,
      source: 'OSV',
      rawAdvisories: feed.advisories,
      validationResult: input.validationResult ?? { validationStatus: 'BACKGROUND_REFRESH', pagesFetched: feed.pagesFetched, completedAt: feed.completedAt },
      contentDigest: input.contentDigest ?? createHash('sha256').update(JSON.stringify({ ecosystem: feed.query.ecosystem, packageName: feed.query.packageName, packageVersion: feed.query.packageVersion, advisories: feed.advisories })).digest('hex'),
      collectedAt,
      validatedAt: completedAt,
    } : null,
  };
}

function key(value: Pick<OsvFeedInput, 'ecosystem' | 'packageName' | 'packageVersion'>): string {
  return `${value.ecosystem}\u0000${value.packageName}\u0000${value.packageVersion}`;
}
