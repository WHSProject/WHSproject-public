import assert from 'node:assert/strict';
import test from 'node:test';
import type { EvaluationRequest } from '../contracts/evidence';
import type { ResolvedDecision } from './decision.resolver';
import { HttpDecisionDbClient } from './decision-db.client';
import { defaultPolicy } from '../policy/default-policy';

test('decision DB client preserves the existing save endpoint and sends score as null', async () => {
  let body = '';
  const client = new HttpDecisionDbClient('http://decision-db', 100, async (_url, init) => {
    body = String(init?.body);
    return new Response(JSON.stringify({ id: 'db-id', decisionId: 'dec_req-1' }), { status: 201, headers: { 'content-type': 'application/json' } });
  });
  const request: EvaluationRequest = {
    requestId: 'req-1', scanId: 'scan-1', scanStatus: 'COMPLETED',
    subject: { ecosystem: 'npm', packageName: 'demo', packageVersion: '1.0.0', artifactHash: 'sha256:a', integrity: 'sha512-a' },
    evidences: [],
    osvFeed: { source: 'OSV', feedStatus: 'SKIPPED', query: { ecosystem: 'npm', packageName: 'demo', packageVersion: '1.0.0' }, advisories: [], complete: false, pagesFetched: 0, collectedAt: null, completedAt: null, errorCode: null, skippedReason: 'DISABLED' },
  };
  const decision: ResolvedDecision = { decision: 'HOLD', reasonCode: 'WAIT', reason: 'wait', matchedRuleIds: [], evidenceIds: [], assessmentIds: [], feedEvidenceIds: [], judgmentId: 'j-1', policyVersion: defaultPolicy.policyVersion };
  const persisted = await client.save(request, defaultPolicy, decision, '2026-09-20T00:00:00.000Z');
  assert.deepEqual(persisted, { decisionDbId: 'db-id', status: 'SAVED' });
  assert.equal(JSON.parse(body).decision.score, null);
  assert.equal(JSON.parse(body).decision.feedSnapshotId, null);
  assert.equal(JSON.parse(body).decision.feedEvidenceIds, null);
  assert.deepEqual(JSON.parse(body).decision.assessmentIds, []);
});

test('decision DB client links a successful snapshot and cited feed evidence without changing score', async () => {
  let body = '';
  const client = new HttpDecisionDbClient('http://decision-db', 100, async (_url, init) => {
    body = String(init?.body);
    return new Response(JSON.stringify({ id: 'db-id' }), { status: 201, headers: { 'content-type': 'application/json' } });
  });
  const request: EvaluationRequest = {
    requestId: '10000000-0000-4000-8000-000000000001', scanId: '20000000-0000-4000-8000-000000000001', scanStatus: 'COMPLETED',
    subject: { ecosystem: 'npm', packageName: 'demo', packageVersion: '1.0.0', artifactHash: 'sha256:a', integrity: 'sha512-a' }, evidences: [],
    osvFeed: { source: 'OSV', feedStatus: 'SUCCESS', query: { ecosystem: 'npm', packageName: 'demo', packageVersion: '1.0.0' }, advisories: [], complete: true, pagesFetched: 1, collectedAt: '2026-09-20T00:00:00Z', completedAt: '2026-09-20T00:00:01Z', errorCode: null, skippedReason: null },
  };
  const decision: ResolvedDecision = { decision: 'ACCEPT', reasonCode: 'OK', reason: 'ok', matchedRuleIds: [], evidenceIds: ['atomic-used'], assessmentIds: ['assessment-used'], feedEvidenceIds: ['osv:GHSA-demo'], judgmentId: 'j', policyVersion: defaultPolicy.policyVersion };
  await client.save(request, defaultPolicy, decision, '2026-09-20T00:00:02Z', { snapshotId: '30000000-0000-4000-8000-000000000001' });
  const saved = JSON.parse(body).decision;
  assert.equal(saved.score, null);
  assert.equal(saved.feedSnapshotId, '30000000-0000-4000-8000-000000000001');
  assert.deepEqual(saved.feedEvidenceIds, ['osv:GHSA-demo']);
  assert.deepEqual(saved.evidenceIds, ['atomic-used']);
  assert.deepEqual(saved.assessmentIds, ['assessment-used']);
});
