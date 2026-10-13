import { InMemoryFeedSnapshotStore, OsvFeedCacheAdapter, type FeedSnapshot, type FeedSnapshotStore } from './osv-feed-cache';
import type { OsvFeedClient } from './osv-feed-client';
import type { OsvFeedInput, OsvFeedResult } from './osv-feed.types';

const input = (): OsvFeedInput => ({
  ecosystem: 'npm', packageName: 'demo', packageVersion: '1.0.0',
  permission: { allowed: true, basis: 'VERIFIED_PUBLIC_NPM' },
  remainingMs: 1_000, signal: new AbortController().signal,
});

const feed = (): OsvFeedResult => ({
  source: 'OSV', feedStatus: 'SUCCESS', query: { ecosystem: 'npm', packageName: 'demo', packageVersion: '1.0.0' },
  advisories: [{ id: 'OSV-1' }], complete: true, pagesFetched: 2,
  collectedAt: '2026-09-23T00:00:00.000Z', completedAt: '2026-09-23T00:00:01.000Z', errorCode: null, skippedReason: null,
});

function snapshot(expiresAt: string, rawAdvisories: Array<Record<string, unknown>> = [{ id: 'cached' }]): FeedSnapshot {
  return { id: 'snapshot-1', source: 'OSV', ecosystem: 'npm', packageName: 'demo', packageVersion: '1.0.0', rawAdvisories, validationResult: { pagesFetched: 3, completedAt: '2026-09-22T00:00:01.000Z' }, contentDigest: 'a'.repeat(64), collectedAt: '2026-09-22T00:00:00.000Z', validatedAt: '2026-09-22T00:00:01.000Z', expiresAt };
}

function adapter(store: Partial<FeedSnapshotStore>, now = Date.parse('2026-09-23T00:00:00.000Z')) {
  const live = { query: jest.fn().mockResolvedValue(feed()) } as unknown as OsvFeedClient;
  return { adapter: new OsvFeedCacheAdapter(store as FeedSnapshotStore, live, () => now), live };
}

it('reuses a future Snapshot, including a normal empty result, and preserves its identity', async () => {
  const cached = snapshot('2026-09-23T01:00:00.000Z', []);
  const { adapter: cache, live } = adapter({ lookup: jest.fn().mockResolvedValue(cached) });
  const result = await cache.query(input());
  expect(result.snapshotId).toBe('snapshot-1');
  expect(result.feed).toMatchObject({ feedStatus: 'SUCCESS', advisories: [], pagesFetched: 3, collectedAt: cached.collectedAt });
  expect(live.query).not.toHaveBeenCalled();
});

it.each([
  ['miss', null],
  ['expired', snapshot('2026-09-22T23:59:59.000Z')],
])('falls back to real-time OSV on cache %s', async (_case, value) => {
  const { adapter: cache, live } = adapter({ lookup: jest.fn().mockResolvedValue(value) });
  await expect(cache.query(input())).resolves.toMatchObject({ feed: { advisories: [{ id: 'OSV-1' }] } });
  expect(live.query).toHaveBeenCalledTimes(1);
});

it('falls back to OSV when cache lookup fails without extending TTL', async () => {
  const lookup = jest.fn().mockRejectedValue(new Error('db unavailable'));
  const { adapter: cache, live } = adapter({ lookup });
  await cache.query(input());
  expect(lookup).toHaveBeenCalledTimes(1);
  expect(live.query).toHaveBeenCalledTimes(1);
});

it('runs miss, persisted hit and TTL expiration with a fixed clock without extending the snapshot', async () => {
  let now = Date.parse('2026-09-23T00:00:01.000Z');
  const store = new InMemoryFeedSnapshotStore(() => now);
  const live = { query: jest.fn().mockResolvedValue(feed()) } as unknown as OsvFeedClient;
  const cache = new OsvFeedCacheAdapter(store, live, () => now);
  const first = await cache.query(input());
  expect(first.snapshotId).toBeUndefined();
  expect(live.query).toHaveBeenCalledTimes(1);
  const persisted = await store.persistLookup({ requestId: 'first', scanId: null, feed: first.feed });
  expect(persisted.snapshotId).toBeTruthy();
  const original = await store.lookup(input());
  now += 1_000;
  const hit = await cache.query(input());
  expect(hit.snapshotId).toBe(persisted.snapshotId);
  expect(live.query).toHaveBeenCalledTimes(1);
  expect(await store.lookup(input())).toEqual(original);
  now = Date.parse(original!.expiresAt);
  const stale = await cache.query(input());
  expect(stale.snapshotId).toBeUndefined();
  expect(live.query).toHaveBeenCalledTimes(2);
  expect(await store.lookup(input())).toEqual(original);
});

it('keeps a successful empty snapshot when a later lookup fails', async () => {
  const store = new InMemoryFeedSnapshotStore();
  const empty = { ...feed(), advisories: [] };
  const saved = await store.persistLookup({ requestId: 'success', scanId: null, feed: empty });
  const original = await store.lookup(input());
  for (const status of ['FAILED', 'TIMEOUT', 'SKIPPED'] as const) {
    const failed: OsvFeedResult = { ...empty, feedStatus: status, complete: false,
      errorCode: status === 'SKIPPED' ? null : 'HTTP_ERROR',
      skippedReason: status === 'SKIPPED' ? 'DISABLED' : null };
    expect((await store.persistLookup({ requestId: status, scanId: null, feed: failed })).snapshotId).toBeNull();
  }
  expect(await store.lookup(input())).toEqual(original);
  expect(saved.snapshotId).toBe(original?.id);
});
