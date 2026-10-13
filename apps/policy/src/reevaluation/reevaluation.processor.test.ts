import assert from 'node:assert/strict';
import test from 'node:test';
import type { Evidence } from '../contracts/evidence';
import type { PolicySnapshot } from '../contracts/policy';
import type { ResolvedDecision } from '../decision/decision.resolver';
import { PolicyReevaluationProcessor } from './reevaluation.processor';
import type { FeedSnapshotRecord, PreviousDecision, ReevaluationJob, ReevaluationJobClient } from './reevaluation.client';

const job: ReevaluationJob = {
  id: '30000000-0000-4000-8000-000000000001', ecosystem: 'npm', packageName: 'demo', packageVersion: '1.0.0',
  artifactHash256: 'sha256:a', artifactHash512: 'sha512-a', scanId: '20000000-0000-4000-8000-000000000001',
  previousSnapshotId: '40000000-0000-4000-8000-000000000001', triggerSnapshotId: '50000000-0000-4000-8000-000000000001',
  previousDecisionId: 'dec-old', changeReason: 'CONTENT_DIGEST_CHANGED', status: 'QUEUED', errorCode: null, errorDetail: null,
  createdAt: '2026-09-24T00:00:00Z', startedAt: null, completedAt: null,
};

const previous: PreviousDecision = {
  id: '60000000-0000-4000-8000-000000000001', decisionId: 'dec-old', requestId: '10000000-0000-4000-8000-000000000001',
  evidenceIds: ['atomic-1'], assessmentIds: [], scanId: job.scanId!, policyKey: 'policy', policyVersion: '1',
  feedSnapshotId: job.previousSnapshotId,
  subject: { ecosystem: 'npm', packageName: 'demo', packageVersion: '1.0.0', artifactHash256: 'sha256:a', artifactHash512: 'sha512-a' },
};

const evidence: Evidence = {
  schemaVersion: '0.1', evidenceId: 'atomic-1', kind: 'ATOMIC', signal: { type: 'SENSITIVE_DATA_ACCESS' },
  subject: { ecosystem: 'npm', packageName: 'demo', packageVersion: '1.0.0', artifactHash: 'sha256:a' },
  assertion: { summary: 'existing scanner evidence', basis: 'PATTERN_MATCH' }, provenance: { scanId: job.scanId! }, limitations: [],
};

const snapshot: FeedSnapshotRecord = {
  id: job.triggerSnapshotId, ecosystem: 'npm', packageName: 'demo', packageVersion: '1.0.0', source: 'OSV',
  rawAdvisories: [], validationResult: { validationStatus: 'EMPTY', pagesFetched: 1, completedAt: '2026-09-24T00:00:01Z' },
  contentDigest: 'a'.repeat(64), collectedAt: '2026-09-24T00:00:00Z', validatedAt: '2026-09-24T00:00:01Z', expiresAt: '2026-09-24T01:00:01Z',
};

const policy: PolicySnapshot = { policyKey: 'policy', policyVersion: '2', ecosystem: 'npm', defaultDecision: 'ACCEPT', judgmentFailureDecision: 'HOLD', rules: [] };
const decision: ResolvedDecision = { decision: 'ACCEPT', reasonCode: 'OK', reason: 'ok', matchedRuleIds: [], evidenceIds: ['atomic-1'], assessmentIds: [], feedEvidenceIds: [], judgmentId: 'judgment-new', policyVersion: '2' };

function client(overrides: Partial<ReevaluationJobClient> = {}): ReevaluationJobClient {
  return {
    claim: async () => ({ claimed: true, job }),
    fail: async () => ({ ...job, status: 'FAILED', errorCode: 'FAILED' }),
    getDecision: async () => previous,
    getSnapshot: async () => snapshot,
    getEvidence: async () => [evidence],
    ...overrides,
  };
}

test('re-evaluation reuses stored Scanner Evidence and writes immutable lineage', async () => {
  let saved: unknown[] = [];
  const evaluator = { evaluate: async () => ({
    case: {}, judgment: { judgmentId: 'judgment-new' }, decision,
    llm: { status: 'COMPLETED' as const }, audit: { runMode: 'PRIMARY' as const, requestId: previous.requestId, scanId: previous.scanId, policyKey: 'policy', policyVersion: '2', judgmentId: 'judgment-new', status: 'COMPLETED' as const, prompt: 'fixture' },
  }) };
  const processor = new PolicyReevaluationProcessor(
    client(),
    { fetchActive: async () => policy },
    evaluator as never,
    { save: async (audit) => { saved.push(audit); } },
    { save: async (...args) => { saved.push(args); return { decisionDbId: 'db-new', status: 'SAVED' as const }; } },
  );
  const result = await processor.process(job.id);
  assert.equal(result.status, 'COMPLETED');
  const call = saved.find((value): value is unknown[] => Array.isArray(value));
  assert.equal(call?.[0] && (call[5] as { decisionId: string }).decisionId, `dec_${previous.requestId}_reeval_${job.id}`);
  assert.deepEqual(call?.[5] as { decisionId: string; previousDecisionId: string; triggerSnapshotId: string; reevaluationJobId: string }, {
    decisionId: `dec_${previous.requestId}_reeval_${job.id}`,
    previousDecisionId: 'dec-old', triggerSnapshotId: job.triggerSnapshotId, reevaluationJobId: job.id,
  });
});

test('missing stored Evidence fails the Job without saving a new Decision', async () => {
  let saveCount = 0;
  let failure: string | undefined;
  const processor = new PolicyReevaluationProcessor(
    client({ getEvidence: async () => [], fail: async (_id, code) => { failure = code; return { ...job, status: 'FAILED', errorCode: code }; } }),
    { fetchActive: async () => policy },
    { evaluate: async () => { throw new Error('must not evaluate'); } } as never,
    { save: async () => undefined },
    { save: async () => { saveCount++; return { decisionDbId: null, status: 'SAVED' as const }; } },
  );
  const result = await processor.process(job.id);
  assert.equal(result.status, 'FAILED');
  assert.equal(failure, 'REEVALUATION_EVIDENCE_NOT_FOUND');
  assert.equal(saveCount, 0);
});

test('already claimed or completed Job is not executed twice', async () => {
  let evaluateCount = 0;
  const processor = new PolicyReevaluationProcessor(
    client({ claim: async () => ({ claimed: false, job: { ...job, status: 'COMPLETED' } }) }),
    { fetchActive: async () => policy },
    { evaluate: async () => { evaluateCount++; throw new Error('must not evaluate'); } } as never,
    { save: async () => undefined },
    { save: async () => ({ decisionDbId: null, status: 'SAVED' as const }) },
  );
  assert.deepEqual(await processor.process(job.id), { jobId: job.id, status: 'COMPLETED' });
  assert.equal(evaluateCount, 0);
});
