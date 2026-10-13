import assert from 'node:assert/strict';
import test from 'node:test';
import type { EvaluationRequest, OsvFeed } from '../contracts/evidence';
import { validateOsvFeed } from './osv-feed.validator';

const subject = { ecosystem: 'npm' as const, packageName: 'demo', packageVersion: '1.2.3', artifactHash: 'sha256:a', integrity: 'sha512-a' };
const baseRequest: EvaluationRequest = { requestId: 'req', scanId: 'scan', scanStatus: 'COMPLETED', subject, evidences: [], osvFeed: undefined as never };
const now = '2026-09-23T00:00:00.000Z';

function success(advisories: Array<Record<string, unknown>>): OsvFeed {
  return { source: 'OSV', feedStatus: 'SUCCESS', query: { ecosystem: 'npm', packageName: 'demo', packageVersion: '1.2.3' }, advisories, complete: true, pagesFetched: 1, collectedAt: now, completedAt: now, errorCode: null, skippedReason: null };
}

function advisory(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'GHSA-demo-1234', aliases: ['CVE-2026-0001'],
    affected: [{ package: { ecosystem: 'npm', name: 'demo' }, ranges: [{ type: 'SEMVER', events: [{ introduced: '1.0.0' }, { fixed: '2.0.0' }] }] }],
    database_specific: { severity: 'HIGH' }, references: [{ type: 'ADVISORY', url: 'https://example.invalid/advisory' }],
    ...overrides,
  };
}

test('valid advisory becomes separate Policy-local OSV evidence and empty success stays empty', () => {
  const validated = validateOsvFeed(success([advisory()]), baseRequest);
  assert.equal(validated.validationStatus, 'VALID');
  assert.equal(validated.advisories[0]?.feedEvidenceId, 'osv:GHSA-demo-1234');
  assert.equal(validated.advisories[0]?.severity, 'HIGH');
  assert.equal(validateOsvFeed(success([]), baseRequest).validationStatus, 'EMPTY');
});

test('package, ecosystem, version, withdrawn and affected mismatches are excluded per advisory', () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [advisory({ affected: [{ package: { ecosystem: 'PyPI', name: 'demo' }, versions: ['1.2.3'] }] }), 'ECOSYSTEM_MISMATCH'],
    [advisory({ affected: [{ package: { ecosystem: 'npm', name: 'other' }, versions: ['1.2.3'] }] }), 'PACKAGE_MISMATCH'],
    [advisory({ affected: [{ package: { ecosystem: 'npm', name: 'demo' }, versions: ['9.9.9'] }] }), 'VERSION_MISMATCH'],
    [advisory({ affected: [] }), 'INVALID_AFFECTED'],
    [advisory({ withdrawn: now }), 'WITHDRAWN'],
  ];
  for (const [value, code] of cases) {
    const result = validateOsvFeed(success([value]), baseRequest);
    assert.equal(result.validationStatus, 'ALL_EXCLUDED');
    assert.equal(result.exclusions[0]?.code, code);
  }
});

test('missing severity is preserved as applicable metadata and never converted to a score', () => {
  const value = advisory();
  delete value.database_specific;
  const result = validateOsvFeed(success([value]), baseRequest);
  assert.equal(result.advisories[0]?.validationStatus, 'APPLICABLE');
  assert.equal(result.advisories[0]?.severity, undefined);
  assert.deepEqual(result.advisories[0]?.validationCodes, ['MISSING_SEVERITY']);
  assert.equal('score' in result.advisories[0]!, false);
});

test('FAILED, TIMEOUT and SKIPPED never expose partial advisories', () => {
  const feeds: OsvFeed[] = [
    { ...success([]), feedStatus: 'FAILED', complete: false, pagesFetched: 1, collectedAt: now, completedAt: null, errorCode: 'HTTP_ERROR' },
    { ...success([]), feedStatus: 'TIMEOUT', complete: false, pagesFetched: 0, collectedAt: null, completedAt: null, errorCode: 'DEADLINE_EXCEEDED' },
    { ...success([]), feedStatus: 'SKIPPED', complete: false, pagesFetched: 0, collectedAt: null, completedAt: null, errorCode: null, skippedReason: 'DISABLED' },
  ];
  for (const feed of feeds) {
    const result = validateOsvFeed(feed, baseRequest);
    assert.equal(result.validationStatus, 'NOT_EVALUATED');
    assert.deepEqual(result.advisories, []);
  }
  assert.throws(() => validateOsvFeed({ ...feeds[0]!, advisories: [advisory()] }, baseRequest), /INVALID_OSV_FAILURE_STATE/u);
});

test('feed query identity mismatch is rejected before advisory use', () => {
  assert.throws(() => validateOsvFeed({ ...success([]), query: { ecosystem: 'npm', packageName: 'other', packageVersion: '1.2.3' } }, baseRequest), /OSV_QUERY_IDENTITY_MISMATCH/u);
});
