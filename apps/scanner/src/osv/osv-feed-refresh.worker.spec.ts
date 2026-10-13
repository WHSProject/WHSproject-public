import { InMemoryFeedSnapshotStore, type FeedRefreshCandidate, type FeedSnapshotStore } from './osv-feed-cache';
import { OsvFeedRefreshWorker } from './osv-feed-refresh.worker';
import type { OsvFeedClient, OsvDetailedResult } from './osv-feed-client';
import type { OsvFeedResult } from './osv-feed.types';

const candidate: FeedRefreshCandidate = { source: 'OSV', ecosystem: 'npm', packageName: 'demo', packageVersion: '1.0.0', lastRequestedAt: '2026-09-22T00:00:00.000Z' };
const success: OsvFeedResult = { source: 'OSV', feedStatus: 'SUCCESS', query: { ecosystem: 'npm', packageName: 'demo', packageVersion: '1.0.0' }, advisories: [], complete: true, pagesFetched: 1, collectedAt: '2026-09-23T00:00:00.000Z', completedAt: '2026-09-23T00:00:01.000Z', errorCode: null, skippedReason: null };
const failure: OsvFeedResult = { ...success, feedStatus: 'FAILED', complete: false, advisories: [], completedAt: null, errorCode: 'HTTP_ERROR' };
const timeout: OsvFeedResult = { ...failure, feedStatus: 'TIMEOUT', errorCode: 'DEADLINE_EXCEEDED' };

function store(overrides: Partial<FeedSnapshotStore> = {}): FeedSnapshotStore {
  return { lookup: jest.fn().mockResolvedValue(null), listRefreshCandidates: jest.fn().mockResolvedValue([candidate]), persistLookup: jest.fn().mockResolvedValue({ attemptId: 'attempt', snapshotId: 'snapshot', snapshotReused: false }), ...overrides };
}

function worker(client: Partial<OsvFeedClient>, feedStore = store(), options = {}) {
  return { worker: new OsvFeedRefreshWorker(client as OsvFeedClient, feedStore, { maxAttempts: 1, retryDelayMs: 1, requestTimeoutMs: 100, sleep: async () => undefined, ...options }), feedStore };
}

it('refreshes only candidates returned as recent and expired/missing, then persists success', async () => {
  const fixedNow = Date.parse('2026-09-23T10:32:37.754Z');
  const { worker: refresh, feedStore } = worker(
    { query: jest.fn().mockResolvedValue(success) },
    undefined,
    { now: () => fixedNow },
  );
  const jobs = await refresh.runOnce();
  expect(jobs[0]).toMatchObject({ status: 'SUCCEEDED', snapshotId: 'snapshot', attemptCount: 1 });
  expect(feedStore.listRefreshCandidates).toHaveBeenCalledWith(
    new Date(fixedNow - 7 * 24 * 3_600_000).toISOString(),
    expect.any(AbortSignal),
  );
  expect(feedStore.persistLookup).toHaveBeenCalledTimes(1);
});

it('records worker failures and timeout attempts without deleting a prior Snapshot', async () => {
  const memory = new InMemoryFeedSnapshotStore();
  memory.put({ id: 'old', source: 'OSV', ecosystem: 'npm', packageName: 'demo', packageVersion: '1.0.0', rawAdvisories: [{ id: 'old' }], validationResult: {}, contentDigest: 'a'.repeat(64), collectedAt: '2026-09-22T00:00:00.000Z', validatedAt: '2026-09-22T00:00:00.000Z', expiresAt: '2026-09-24T00:00:00.000Z' });
  const { worker: refresh } = worker({ query: jest.fn().mockResolvedValue(timeout) }, memory, { maxAttempts: 1 });
  const job = refresh.forceRefresh('demo', '1.0.0');
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  expect(refresh.getJob(job.jobId)).toMatchObject({ status: 'TIMEOUT', errorCode: 'DEADLINE_EXCEEDED' });
  await expect(memory.lookup(candidate)).resolves.toMatchObject({ id: 'old', rawAdvisories: [{ id: 'old' }] });
});

it('honors Retry-After and limits retry count', async () => {
  const detailed: jest.MockedFunction<() => Promise<OsvDetailedResult>> = jest.fn()
    .mockResolvedValueOnce({ result: failure, retryAfterMs: 42_000 })
    .mockResolvedValueOnce({ result: success });
  const sleep = jest.fn().mockResolvedValue(undefined);
  const { worker: refresh, feedStore } = worker({ queryDetailed: detailed }, store(), { maxAttempts: 2, maxRetryAfterMs: 100, sleep });
  const jobs = await refresh.runOnce();
  expect(jobs[0]).toMatchObject({ status: 'SUCCEEDED', attemptCount: 2 });
  expect(sleep).toHaveBeenCalledWith(100, expect.any(AbortSignal));
  expect(feedStore.persistLookup).toHaveBeenCalledTimes(2);
});

it('opens, half-opens, and closes a per-package circuit breaker', async () => {
  let current: OsvFeedResult = failure;
  const feedStore = store();
  let now = Date.parse('2026-09-23T00:00:00.000Z');
  const { worker: refresh } = worker({ query: jest.fn().mockImplementation(() => current) }, feedStore, { maxAttempts: 1, circuitFailureThreshold: 2, circuitOpenMs: 1, now: () => now });
  await refresh.runOnce();
  await refresh.runOnce();
  expect(refresh.circuitStatus('demo', '1.0.0')).toBe('OPEN');
  current = success;
  now += 2;
  await refresh.runOnce();
  expect(refresh.circuitStatus('demo', '1.0.0')).toBe('CLOSED');
});

it('deduplicates concurrent force refresh jobs for one package key', async () => {
  let resolve!: (value: OsvFeedResult) => void;
  const query = jest.fn(() => new Promise<OsvFeedResult>((next) => { resolve = next; }));
  const { worker: refresh } = worker({ query });
  const first = refresh.forceRefresh('demo', '1.0.0');
  const second = refresh.forceRefresh('demo', '1.0.0');
  expect(second.jobId).toBe(first.jobId);
  resolve(success);
  await new Promise<void>((done) => setTimeout(done, 0));
  expect(query).toHaveBeenCalledTimes(1);
});

it('does not start polling when disabled and allows a later worker instance to process an expired candidate', async () => {
  const previous = process.env.OSV_REFRESH_WORKER_ENABLED;
  process.env.OSV_REFRESH_WORKER_ENABLED = 'false';
  try {
    const feedStore = store();
    const query = jest.fn().mockResolvedValue(success);
    const first = worker({ query }, feedStore).worker;
    first.onModuleInit();
    expect(query).not.toHaveBeenCalled();
    first.onModuleDestroy();
    const restarted = worker({ query }, feedStore).worker;
    expect(await restarted.runOnce()).toMatchObject([{ status: 'SUCCEEDED' }]);
    expect(query).toHaveBeenCalledTimes(1);
  } finally {
    if (previous === undefined) delete process.env.OSV_REFRESH_WORKER_ENABLED;
    else process.env.OSV_REFRESH_WORKER_ENABLED = previous;
  }
});

it('records incomplete collection as failure and recovers on a new forced job', async () => {
  const query = jest.fn().mockResolvedValueOnce({ ...success, complete: false, advisories: [{ id: 'partial' }], errorCode: 'PARTIAL_COLLECTION' }).mockResolvedValue(success);
  const feedStore = store();
  const refresh = worker({ query }, feedStore).worker;
  const first = refresh.forceRefresh('demo', '1.0.0');
  await new Promise<void>((done) => setTimeout(done, 0));
  expect(refresh.getJob(first.jobId)).toMatchObject({ status: 'FAILED', errorCode: 'PARTIAL_COLLECTION', snapshotId: null });
  const second = refresh.forceRefresh('demo', '1.0.0');
  await new Promise<void>((done) => setTimeout(done, 0));
  expect(second.jobId).not.toBe(first.jobId);
  expect(refresh.getJob(second.jobId)).toMatchObject({ status: 'SUCCEEDED', snapshotId: 'snapshot' });
  expect(feedStore.persistLookup).toHaveBeenCalledTimes(2);
});

it('aborts an in-flight force refresh when the worker stops', async () => {
  const query = jest.fn().mockImplementation((input: { signal: AbortSignal }) => new Promise<OsvFeedResult>((resolve) => {
    input.signal.addEventListener('abort', () => resolve(timeout), { once: true });
  }));
  const refresh = worker({ query }).worker;
  const job = refresh.forceRefresh('demo', '1.0.0');
  refresh.onModuleDestroy();
  await new Promise<void>((done) => setTimeout(done, 0));
  expect(refresh.getJob(job.jobId)).toMatchObject({ status: 'TIMEOUT', errorCode: 'DEADLINE_EXCEEDED' });
  expect(query).toHaveBeenCalledTimes(1);
});
