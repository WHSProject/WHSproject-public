import assert from 'node:assert/strict';
import test from 'node:test';
import { buildEvidenceCase } from '../case/evidence-case.builder';
import type { EvaluationRequest, EvidenceBase } from '../contracts/evidence';
import type { PolicyJudgment } from '../contracts/judgment';
import { defaultPolicy } from './default-policy';
import { resolveRules } from './policy-rule.resolver';

const request: EvaluationRequest = {
  requestId: 'req-1', scanId: 'scan-1', scanStatus: 'COMPLETED',
  subject: { ecosystem: 'npm', packageName: 'demo', packageVersion: '1.0.0', artifactHash: 'sha256:abc', integrity: 'sha512:def' },
  osvFeed: { source: 'OSV', feedStatus: 'SKIPPED', query: { ecosystem: 'npm', packageName: 'demo', packageVersion: '1.0.0' }, advisories: [], complete: false, pagesFetched: 0, collectedAt: null, completedAt: null, errorCode: null, skippedReason: 'DISABLED' },
  evidences: [{
    schemaVersion: '0.1', evidenceId: 'atomic-1', kind: 'ATOMIC', signal: { type: 'SENSITIVE_DATA_ACCESS' },
    subject: { ecosystem: 'npm', packageName: 'demo', packageVersion: '1.0.0', artifactHash: 'sha256:abc' },
    assertion: { summary: 'process environment accessed', basis: 'DATA_FLOW' }, provenance: { scanId: 'scan-1' },
  }],
};

test('resolver matches a policy rule without calculating a risk score', () => {
  const evidenceCase = buildEvidenceCase(request);
  const judgment: PolicyJudgment = {
    judgmentId: 'judgment-1', policyVersion: defaultPolicy.policyVersion, caseStatus: 'COMPLETE', unresolved: [], conflicts: [], limitations: [],
    ruleEvaluations: [{
      ruleId: 'MALWARE-EXFIL-001', status: 'SATISFIED', counterEvidenceIds: [], rationale: 'policy predicates supported',
      predicateEvaluations: [
        { predicate: 'SENSITIVE_DATA_ACCESSED', status: 'SUPPORTED', evidenceIds: ['atomic-1'], assessmentIds: [], feedEvidenceIds: [], codeRefs: [] },
        { predicate: 'DATA_REACHES_EXTERNAL_SINK', status: 'SUPPORTED', evidenceIds: ['atomic-1'], assessmentIds: [], feedEvidenceIds: [], codeRefs: [] },
        { predicate: 'EXECUTION_PATH_REACHABLE', status: 'SUPPORTED', evidenceIds: ['atomic-1'], assessmentIds: [], feedEvidenceIds: [], codeRefs: [] },
        { predicate: 'BENIGN_ALTERNATIVE_NOT_SUPPORTED', status: 'SUPPORTED', evidenceIds: ['atomic-1'], assessmentIds: [], feedEvidenceIds: [], codeRefs: [] },
      ],
    }],
  };
  const matches = resolveRules(defaultPolicy, judgment, evidenceCase);
  assert.equal(matches.find((match) => match.ruleId === 'MALWARE-EXFIL-001')?.matched, true);
});

test('resolver keeps an unknown decisive predicate uncertain', () => {
  const evidenceCase = buildEvidenceCase(request);
  const judgment: PolicyJudgment = {
    judgmentId: 'judgment-2', policyVersion: defaultPolicy.policyVersion, caseStatus: 'INCOMPLETE', unresolved: ['DATA_REACHES_EXTERNAL_SINK'], conflicts: [], limitations: [], ruleEvaluations: [],
  };
  const matches = resolveRules(defaultPolicy, judgment, evidenceCase);
  assert.equal(matches.find((match) => match.ruleId === 'MALWARE-EXFIL-001')?.uncertain, true);
});

test('resolver keeps citations for the matched rule and does not include unrelated evidence', () => {
  const evidenceCase = buildEvidenceCase(request);
  const judgment: PolicyJudgment = {
    judgmentId: 'judgment-provenance', policyVersion: defaultPolicy.policyVersion, caseStatus: 'COMPLETE', unresolved: [], conflicts: [], limitations: [],
    ruleEvaluations: [{
      ruleId: 'MALWARE-EXFIL-001', status: 'SATISFIED', counterEvidenceIds: [], rationale: 'cited evidence',
      predicateEvaluations: [
        { predicate: 'SENSITIVE_DATA_ACCESSED', status: 'SUPPORTED', evidenceIds: ['atomic-1'], assessmentIds: ['assessment-1'], feedEvidenceIds: [], codeRefs: [] },
        { predicate: 'DATA_REACHES_EXTERNAL_SINK', status: 'SUPPORTED', evidenceIds: ['atomic-1'], assessmentIds: [], feedEvidenceIds: [], codeRefs: [] },
        { predicate: 'EXECUTION_PATH_REACHABLE', status: 'SUPPORTED', evidenceIds: ['atomic-1'], assessmentIds: [], feedEvidenceIds: [], codeRefs: [] },
        { predicate: 'BENIGN_ALTERNATIVE_NOT_SUPPORTED', status: 'SUPPORTED', evidenceIds: [], assessmentIds: [], feedEvidenceIds: [], codeRefs: [] },
      ],
    }],
  };
  const matches = resolveRules(defaultPolicy, judgment, evidenceCase);
  const match = matches.find((item) => item.ruleId === 'MALWARE-EXFIL-001');
  assert.deepEqual(match?.evidenceIds, ['atomic-1']);
  assert.deepEqual(match?.assessmentIds, ['assessment-1']);
});

test('resolver treats anyOf as satisfied when one branch is supported and another is unknown', () => {
  const evidenceCase = buildEvidenceCase(request);
  const policy = { ...defaultPolicy, rules: [{ ruleId: 'ANY-OF', priority: 100, effect: 'REVIEW' as const, when: { anyOf: [{ predicate: 'SENSITIVE_DATA_ACCESSED' as const }, { predicate: 'DATA_REACHES_EXTERNAL_SINK' as const }] }, minimumSupport: 'SUPPORTED' as const, onUnknown: 'HOLD' as const, reasonCode: 'ANY_OF' }] };
  const judgment: PolicyJudgment = {
    judgmentId: 'judgment-any-of', policyVersion: policy.policyVersion, caseStatus: 'COMPLETE', unresolved: ['DATA_REACHES_EXTERNAL_SINK'], conflicts: [], limitations: [],
    ruleEvaluations: [{
      ruleId: 'ANY-OF', status: 'UNKNOWN', counterEvidenceIds: [], rationale: 'one branch supported',
      predicateEvaluations: [
        { predicate: 'SENSITIVE_DATA_ACCESSED', status: 'SUPPORTED', evidenceIds: ['atomic-1'], assessmentIds: [], feedEvidenceIds: [], codeRefs: [] },
        { predicate: 'DATA_REACHES_EXTERNAL_SINK', status: 'UNKNOWN', evidenceIds: [], assessmentIds: [], feedEvidenceIds: [], codeRefs: [] },
      ],
    }],
  };
  const match = resolveRules(policy, judgment, evidenceCase)[0];
  assert.ok(match);
  assert.equal(match.matched, true);
  assert.equal(match.uncertain, false);
});

test('resolver uses Policy DB predicate metadata for feed-only reject protection', () => {
  const evidenceCase = buildEvidenceCase(request);
  const policy = {
    ...defaultPolicy,
    predicateCatalog: [{ code: 'TENANT_FEED_MATCH', description: 'Tenant feed match', requiresFeedEvidence: true, rejectAllowed: false }],
    rules: [{ ruleId: 'TENANT-FEED-REJECT', priority: 100, effect: 'REJECT' as const, when: { allOf: [{ predicate: 'TENANT_FEED_MATCH' }] }, minimumSupport: 'SUPPORTED' as const, onUnknown: 'HOLD' as const, reasonCode: 'TENANT_FEED' }],
  };
  const judgment: PolicyJudgment = {
    judgmentId: 'tenant-feed', policyVersion: policy.policyVersion, caseStatus: 'COMPLETE', unresolved: [], conflicts: [], limitations: [],
    ruleEvaluations: [{ ruleId: 'TENANT-FEED-REJECT', status: 'SATISFIED', counterEvidenceIds: [], rationale: 'feed', predicateEvaluations: [{ predicate: 'TENANT_FEED_MATCH', status: 'SUPPORTED', evidenceIds: [], assessmentIds: [], feedEvidenceIds: ['feed:demo'], codeRefs: [] }] }],
  };
  const match = resolveRules(policy, judgment, evidenceCase)[0];
  assert.equal(match?.matched, false);
});

test('resolver does not reject from a single generic capability citation', () => {
  const evidenceCase = buildEvidenceCase({
    ...request,
    evidences: request.evidences.map((evidence) => ({ ...evidence, assertion: { summary: evidence.assertion.summary, basis: 'PATTERN_MATCH' } })),
  });
  const policy = {
    ...defaultPolicy,
    rules: [{ ruleId: 'GENERIC-CAPABILITY-REJECT', priority: 100, effect: 'REJECT' as const, when: { allOf: [{ predicate: 'CHILD_PROCESS_SPAWNED' }] }, minimumSupport: 'SUPPORTED' as const, onUnknown: 'HOLD' as const, reasonCode: 'GENERIC_CAPABILITY' }],
  };
  const judgment: PolicyJudgment = {
    judgmentId: 'generic-capability', policyVersion: policy.policyVersion, caseStatus: 'COMPLETE', unresolved: [], conflicts: [], limitations: [],
    ruleEvaluations: [{ ruleId: 'GENERIC-CAPABILITY-REJECT', status: 'SATISFIED', counterEvidenceIds: [], rationale: 'generic capability', predicateEvaluations: [{ predicate: 'CHILD_PROCESS_SPAWNED', status: 'SUPPORTED', evidenceIds: ['atomic-1'], assessmentIds: [], feedEvidenceIds: [], codeRefs: [] }] }],
  };
  const match = resolveRules(policy, judgment, evidenceCase)[0];
  assert.equal(match?.matched, false);
});

test('resolver does not use uncited relation evidence to satisfy a generic reject rule', () => {
  const baseEvidence = request.evidences[0] as EvidenceBase;
  const evidenceCase = buildEvidenceCase({
    ...request,
    evidences: [
      ...request.evidences.map((evidence) => ({ ...evidence, assertion: { summary: evidence.assertion.summary, basis: 'PATTERN_MATCH' } })),
      { ...baseEvidence, evidenceId: 'atomic-2', assertion: { summary: 'unrelated data flow', basis: 'DATA_FLOW' } },
    ],
  });
  const policy = {
    ...defaultPolicy,
    rules: [{ ruleId: 'GENERIC-CAPABILITY-REJECT', priority: 100, effect: 'REJECT' as const, when: { allOf: [{ predicate: 'CHILD_PROCESS_SPAWNED' }] }, minimumSupport: 'SUPPORTED' as const, onUnknown: 'HOLD' as const, reasonCode: 'GENERIC_CAPABILITY' }],
  };
  const judgment: PolicyJudgment = {
    judgmentId: 'generic-capability-with-unrelated-flow', policyVersion: policy.policyVersion, caseStatus: 'COMPLETE', unresolved: [], conflicts: [], limitations: [],
    ruleEvaluations: [{ ruleId: 'GENERIC-CAPABILITY-REJECT', status: 'SATISFIED', counterEvidenceIds: [], rationale: 'generic capability', predicateEvaluations: [{ predicate: 'CHILD_PROCESS_SPAWNED', status: 'SUPPORTED', evidenceIds: ['atomic-1'], assessmentIds: [], feedEvidenceIds: [], codeRefs: [] }] }],
  };
  const match = resolveRules(policy, judgment, evidenceCase)[0];
  assert.equal(match?.matched, false);
});
