import assert from 'node:assert/strict';
import test from 'node:test';
import type { ValidatedOsvFeed } from '../case/osv-feed.validator';
import { validateOsvFeed } from '../case/osv-feed.validator';
import type { EvaluationRequest, OsvFeed } from '../contracts/evidence';
import type { PolicyJudgment } from '../contracts/judgment';
import { buildFeedPersistencePayload, feedContentDigest, FeedPersistenceError, HttpFeedPersistenceClient, usedFeedEvidenceIds } from './feed-persistence.client';

const validatedAt = '2026-09-23T01:00:00.000Z';

function advisory(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'GHSA-demo-1234', aliases: ['CVE-2026-0001'],
    affected: [{ package: { ecosystem: 'npm', name: 'demo' }, ranges: [{ type: 'SEMVER', events: [{ introduced: '1.0.0' }, { fixed: '2.0.0' }] }] }],
    database_specific: { severity: 'HIGH' },
    references: [{ type: 'ADVISORY', url: 'https://example.invalid/advisory' }],
    ...overrides,
  };
}

function feed(status: OsvFeed['feedStatus'] = 'SUCCESS', advisories = [advisory()]): OsvFeed {
  const success = status === 'SUCCESS';
  const skipped = status === 'SKIPPED';
  return {
    source: 'OSV', feedStatus: status,
    query: { ecosystem: 'npm', packageName: 'demo', packageVersion: '1.2.3' },
    advisories: success ? advisories : [], complete: success, pagesFetched: skipped ? 0 : 2,
    collectedAt: skipped ? null : '2026-09-23T00:00:00.000Z',
    completedAt: success ? '2026-09-23T00:00:05.000Z' : null,
    errorCode: status === 'FAILED' ? 'HTTP_ERROR' : status === 'TIMEOUT' ? 'DEADLINE_EXCEEDED' : null,
    skippedReason: skipped ? 'DISABLED' : null,
  };
}

function request(osvFeed = feed()): EvaluationRequest {
  return {
    requestId: '10000000-0000-4000-8000-000000000001', scanId: '20000000-0000-4000-8000-000000000001', scanStatus: 'COMPLETED',
    subject: { ecosystem: 'npm', packageName: 'demo', packageVersion: '1.2.3', artifactHash: 'sha256:a', integrity: 'sha512-a' },
    evidences: [], osvFeed,
  };
}

function validated(input: EvaluationRequest): ValidatedOsvFeed {
  return validateOsvFeed(input.osvFeed, input);
}

test('SUCCESS and empty SUCCESS create snapshots while all other statuses create attempts only', () => {
  for (const advisories of [[advisory()], []]) {
    const input = request(feed('SUCCESS', advisories));
    const payload = buildFeedPersistencePayload(input, validated(input), validatedAt);
    assert.ok(payload.snapshot);
    assert.deepEqual(payload.snapshot.rawAdvisories, advisories);
    assert.equal(payload.attempt.feedStatus, 'SUCCESS');
    assert.equal(payload.attempt.complete, true);
  }
  for (const status of ['FAILED', 'TIMEOUT', 'SKIPPED'] as const) {
    const input = request(feed(status));
    const payload = buildFeedPersistencePayload(input, validated(input), validatedAt);
    assert.equal(payload.snapshot, null);
    assert.equal(payload.attempt.feedStatus, status);
    assert.equal(payload.attempt.complete, false);
    assert.equal(payload.attempt.pagesFetched, status === 'SKIPPED' ? 0 : 2);
    assert.equal(payload.attempt.errorCode, status === 'FAILED' ? 'HTTP_ERROR' : status === 'TIMEOUT' ? 'DEADLINE_EXCEEDED' : null);
    assert.equal(payload.attempt.skippedReason, status === 'SKIPPED' ? 'DISABLED' : null);
  }
});

test('incomplete validated result is attempt-only even when marked SUCCESS', () => {
  const input = request(feed());
  const incomplete = { ...validated(input), complete: false };
  const payload = buildFeedPersistencePayload(input, incomplete, validatedAt);
  assert.equal(payload.snapshot, null);
  assert.equal(payload.attempt.complete, false);
});

test('digest ignores collection timestamps and canonical array order', () => {
  const first = request(feed('SUCCESS', [advisory({ aliases: ['CVE-B', 'CVE-A'] })]));
  const secondFeed = { ...feed('SUCCESS', [advisory({ aliases: ['CVE-A', 'CVE-B'] })]), collectedAt: '2026-09-24T00:00:00.000Z', completedAt: '2026-09-24T00:00:01.000Z' };
  const second = request(secondFeed);
  assert.equal(feedContentDigest(first, validated(first)), feedContentDigest(second, validated(second)));
  const referenceOnly = request(feed('SUCCESS', [advisory({ aliases: ['CVE-A', 'CVE-B'], references: [{ url: 'https://changed.invalid' }] })]));
  assert.equal(feedContentDigest(second, validated(second)), feedContentDigest(referenceOnly, validated(referenceOnly)));
});

test('digest ignores raw advisory order when one advisory is excluded', () => {
  const invalid = advisory({ id: 'x' });
  const first = request(feed('SUCCESS', [advisory(), invalid]));
  const second = request(feed('SUCCESS', [invalid, advisory()]));
  assert.equal(feedContentDigest(first, validated(first)), feedContentDigest(second, validated(second)));
});

test('digest changes for advisory identity, alias, affected range, severity, withdrawn, package, and validation result', () => {
  const base = request();
  const baseDigest = feedContentDigest(base, validated(base));
  const variants = [
    advisory({ id: 'GHSA-other-1234' }),
    advisory({ aliases: ['CVE-2026-9999'] }),
    advisory({ affected: [{ package: { ecosystem: 'npm', name: 'demo' }, ranges: [{ type: 'SEMVER', events: [{ introduced: '1.0.0' }, { fixed: '1.5.0' }] }] }] }),
    advisory({ database_specific: { severity: 'CRITICAL' } }),
    advisory({ withdrawn: '2026-09-20T00:00:00Z' }),
  ];
  for (const changed of variants) {
    const input = request(feed('SUCCESS', [changed]));
    assert.notEqual(feedContentDigest(input, validated(input)), baseDigest);
  }
  const changedPackage = request();
  changedPackage.subject = { ...changedPackage.subject, packageName: 'other' };
  changedPackage.osvFeed = { ...changedPackage.osvFeed, query: { ...changedPackage.osvFeed.query, packageName: 'other' }, advisories: [advisory({ affected: [{ package: { ecosystem: 'npm', name: 'other' }, versions: ['1.2.3'] }] })] };
  assert.notEqual(feedContentDigest(changedPackage, validated(changedPackage)), baseDigest);
});

test('only feed evidence actually cited by the judgment is linked to Decision', () => {
  const judgment = {
    judgmentId: 'j', policyVersion: '1', caseStatus: 'COMPLETE', unresolved: [], conflicts: [], limitations: [],
    ruleEvaluations: [{ ruleId: 'R', status: 'SATISFIED', counterEvidenceIds: [], rationale: 'r', predicateEvaluations: [
      { predicate: 'OSV_ADVISORY_APPLIES', status: 'SUPPORTED', evidenceIds: [], assessmentIds: [], feedEvidenceIds: ['osv:B', 'osv:A', 'osv:A'], codeRefs: [] },
    ] }],
  } as PolicyJudgment;
  assert.deepEqual(usedFeedEvidenceIds(judgment), ['osv:A', 'osv:B']);
  assert.deepEqual(usedFeedEvidenceIds({ ...judgment, ruleEvaluations: [] }), []);
});

test('persistence client preserves snapshot/attempt failure identity', async () => {
  const client = new HttpFeedPersistenceClient('http://decision-db', 100, async () => new Response(JSON.stringify({ detail: { code: 'FEED_SNAPSHOT_PERSISTENCE_FAILED' } }), { status: 503, headers: { 'content-type': 'application/json' } }));
  const input = request();
  await assert.rejects(client.save(buildFeedPersistencePayload(input, validated(input), validatedAt)), (error: unknown) => {
    assert.ok(error instanceof FeedPersistenceError);
    assert.equal(error.message, 'FEED_SNAPSHOT_PERSISTENCE_FAILED');
    assert.equal(error.retryable, true);
    return true;
  });
});
