import assert from 'node:assert/strict';
import test from 'node:test';
import { buildEvidenceCase } from '../case/evidence-case.builder';
import type { EvaluationRequest } from '../contracts/evidence';
import type { PolicyJudgment } from '../contracts/judgment';
import type { PolicyPredicate, PolicySnapshot } from '../contracts/policy';
import { calculateRuleStatus, validatePolicyJudgment, validatePolicyJudgmentWithComputedRuleStatus } from './policy-judgment.validator';

const request: EvaluationRequest = {
  requestId: '10000000-0000-4000-8000-000000000201',
  scanId: '20000000-0000-4000-8000-000000000201',
  scanStatus: 'COMPLETED',
  subject: { ecosystem: 'npm', packageName: 'validator-fixture', packageVersion: '1.0.0', artifactHash: 'sha256:validator', integrity: 'sha512-validator' },
  evidences: [
    {
      schemaVersion: '0.1', evidenceId: 'atomic-1', kind: 'ATOMIC', signal: { type: 'PROCESS_EXECUTION' },
      subject: { ecosystem: 'npm', packageName: 'validator-fixture', packageVersion: '1.0.0', artifactHash: 'sha256:validator' },
      assertion: { summary: 'A process execution sink is reached.' }, provenance: { scanId: '20000000-0000-4000-8000-000000000201' },
    },
    {
      schemaVersion: '0.1', evidenceId: 'llm:analysis-1:assessment-1', kind: 'LLM_ASSESSMENT', signal: { id: 'assessment', type: 'MALICIOUSNESS', category: 'intent' },
      subject: { ecosystem: 'npm', packageName: 'validator-fixture', packageVersion: '1.0.0', artifactHash: 'sha256:validator' },
      assertion: { summary: 'The package appears malicious.', basis: 'fixture' }, verificationStatus: 'VERIFIED', intentAssessment: 'LIKELY_MALICIOUS', confidence: 0.9,
      reasonCodes: ['FIXTURE'], alternatives: [], locations: [], relatedFindingIds: [], relatedAtomicEvidenceIds: ['atomic-1'], sources: [], limitations: [],
      provenance: { scanId: '20000000-0000-4000-8000-000000000201', producerType: 'LLM_AGENT', analysisId: 'analysis-1', assessmentId: 'assessment-1' },
    },
  ],
  osvFeed: { source: 'OSV', feedStatus: 'SKIPPED', query: { ecosystem: 'npm', packageName: 'validator-fixture', packageVersion: '1.0.0' }, advisories: [], complete: false, pagesFetched: 0, collectedAt: null, completedAt: null, errorCode: null, skippedReason: 'DISABLED' },
};

function policy(effect: 'REJECT' | 'REVIEW' = 'REVIEW'): PolicySnapshot {
  return {
    policyKey: 'validator-fixture', policyVersion: '1', ecosystem: 'npm', defaultDecision: 'ACCEPT', judgmentFailureDecision: 'HOLD',
    rules: [{ ruleId: 'R', priority: 100, effect, when: { allOf: [{ predicate: 'DATA_REACHES_PROCESS_EXECUTION' }] }, minimumSupport: 'SUPPORTED', onUnknown: 'HOLD', reasonCode: 'MATCH' }],
  };
}

function judgment(predicate: PolicyPredicate, overrides: Partial<PolicyJudgment['ruleEvaluations'][number]['predicateEvaluations'][number]> = {}, ruleStatus: 'SATISFIED' | 'NOT_SATISFIED' | 'UNKNOWN' | 'CONFLICT' = 'SATISFIED'): PolicyJudgment {
  return {
    judgmentId: 'judgment-validator', policyVersion: '1', caseStatus: 'COMPLETE', unresolved: [], conflicts: [], limitations: [],
    ruleEvaluations: [{ ruleId: 'R', status: ruleStatus, rationale: 'fixture', counterEvidenceIds: [], predicateEvaluations: [{ predicate, status: 'SUPPORTED', evidenceIds: ['atomic-1'], assessmentIds: [], feedEvidenceIds: [], codeRefs: [], ...overrides }] }],
  };
}

test('validator rejects a supported predicate without a citation', () => {
  const evidenceCase = buildEvidenceCase(request);
  assert.throws(() => validatePolicyJudgment(judgment('DATA_REACHES_PROCESS_EXECUTION', { evidenceIds: [] }), policy(), evidenceCase), /SUPPORTED_REQUIRES_CITATION/u);
});

test('validator keeps LLM assessment IDs separate from Scanner evidence IDs', () => {
  const evidenceCase = buildEvidenceCase(request);
  assert.throws(() => validatePolicyJudgment(judgment('DATA_REACHES_PROCESS_EXECUTION', { evidenceIds: ['llm:analysis-1:assessment-1'], assessmentIds: [] }), policy(), evidenceCase), /LLM_ASSESSMENT_MUST_USE_ASSESSMENT_ID/u);
});

test('validator rejects an automatic REJECT supported only by an LLM assessment', () => {
  const evidenceCase = buildEvidenceCase(request);
  assert.throws(() => validatePolicyJudgment(judgment('DATA_REACHES_PROCESS_EXECUTION', { evidenceIds: [], assessmentIds: ['assessment-1'] }), policy('REJECT'), evidenceCase), /REJECT_REQUIRES_ATOMIC_OR_CORRELATED_EVIDENCE/u);
});

test('validator rejects positive citations on a NOT_SUPPORTED predicate', () => {
  const evidenceCase = buildEvidenceCase(request);
  assert.throws(() => validatePolicyJudgment(judgment('DATA_REACHES_PROCESS_EXECUTION', { status: 'NOT_SUPPORTED' }), policy(), evidenceCase), /NOT_SUPPORTED_CANNOT_CITE_POSITIVE_EVIDENCE/u);
});

test('validator checks code reference line ranges when provided', () => {
  const evidenceCase = buildEvidenceCase(request);
  assert.throws(() => validatePolicyJudgment(judgment('DATA_REACHES_PROCESS_EXECUTION', { codeRefs: [{ file: 'index.js', lines: [0, 3] }] }), policy(), evidenceCase), /INVALID_CODE_REF/u);
});

test('validator rejects unregistered predicates and unknown evidence or assessment IDs', () => {
  const evidenceCase = buildEvidenceCase(request);
  assert.throws(() => validatePolicyJudgment(judgment('UNREGISTERED_PREDICATE' as PolicyPredicate), policy(), evidenceCase), /INVALID_POLICY_PREDICATE_EVALUATION/u);
  assert.throws(() => validatePolicyJudgment(judgment('DATA_REACHES_PROCESS_EXECUTION', { evidenceIds: ['missing-evidence'] }), policy(), evidenceCase), /UNKNOWN_EVIDENCE_REF/u);
  assert.throws(() => validatePolicyJudgment(judgment('DATA_REACHES_PROCESS_EXECUTION', { evidenceIds: [], assessmentIds: ['missing-assessment'] }), policy(), evidenceCase), /UNKNOWN_ASSESSMENT_REF/u);
});

test('validator rejects unverified Assessment references and OSV namespace misuse', () => {
  const unverifiedCase = buildEvidenceCase(request);
  unverifiedCase.assessments = unverifiedCase.assessments.map((assessment) => ({ ...assessment, verificationStatus: 'UNVERIFIED' as const }));
  assert.throws(() => validatePolicyJudgment(judgment('DATA_REACHES_PROCESS_EXECUTION', { evidenceIds: [], assessmentIds: ['assessment-1'] }), policy(), unverifiedCase), /UNVERIFIED_ASSESSMENT_REF/u);

  const feedRequest: EvaluationRequest = {
    ...request,
    osvFeed: { ...request.osvFeed, feedStatus: 'SUCCESS', complete: true, collectedAt: '2026-09-25T00:00:00Z', completedAt: '2026-09-25T00:00:01Z', errorCode: null, skippedReason: null, advisories: [{ id: 'GHSA-validator-1', affected: [{ package: { ecosystem: 'npm', name: 'validator-fixture' }, versions: ['1.0.0'] }] }] },
  };
  const feedCase = buildEvidenceCase(feedRequest);
  const feedId = [...feedCase.feedEvidenceIds][0]!;
  assert.throws(() => validatePolicyJudgment(judgment('DATA_REACHES_PROCESS_EXECUTION', { evidenceIds: [], feedEvidenceIds: [feedId] }), policy(), feedCase), /FEED_EVIDENCE_NOT_RELEVANT/u);
  assert.throws(() => validatePolicyJudgment(judgment('OSV_ADVISORY_APPLIES' as PolicyPredicate, { evidenceIds: ['atomic-1'], feedEvidenceIds: [] }), { ...policy(), rules: [{ ...policy().rules[0]!, when: { allOf: [{ predicate: 'OSV_ADVISORY_APPLIES' }] } }] }, feedCase), /OSV_SUPPORT_REQUIRES_FEED_EVIDENCE/u);
});

test('validator enforces allOf/anyOf rule status semantics', () => {
  const evidenceCase = buildEvidenceCase(request);
  assert.throws(() => validatePolicyJudgment(judgment('DATA_REACHES_PROCESS_EXECUTION', {}, 'NOT_SATISFIED'), policy(), evidenceCase), /INVALID_POLICY_RULE_STATUS/u);
});

type PredicateStatus = PolicyJudgment['ruleEvaluations'][number]['predicateEvaluations'][number]['status'];
type RuleStatus = PolicyJudgment['ruleEvaluations'][number]['status'];

function statusJudgment(allOf: PredicateStatus[], anyOf: PredicateStatus[], status: RuleStatus): { snapshot: PolicySnapshot; value: PolicyJudgment } {
  const predicates: PolicyPredicate[] = ['DATA_REACHES_PROCESS_EXECUTION', 'SENSITIVE_DATA_ACCESSED', 'DATA_REACHES_EXTERNAL_SINK'];
  const all = allOf.map((_, index) => ({ predicate: predicates[index]! }));
  const any = anyOf.map((_, index) => ({ predicate: predicates[allOf.length + index]! }));
  const snapshot: PolicySnapshot = { ...policy(), rules: [{ ...policy().rules[0]!, when: { ...(all.length ? { allOf: all } : {}), ...(any.length ? { anyOf: any } : {}) } }] };
  const evaluations = [...allOf, ...anyOf].map((predicateStatus, index) => ({
    predicate: predicates[index]!, status: predicateStatus,
    evidenceIds: predicateStatus === 'SUPPORTED' ? ['atomic-1'] : [],
    assessmentIds: [], feedEvidenceIds: [], codeRefs: [], missing: [],
  }));
  const value: PolicyJudgment = { ...judgment(predicates[0]!), ruleEvaluations: [{ ruleId: 'R', status, rationale: 'fixture', counterEvidenceIds: [], predicateEvaluations: evaluations }] };
  return { snapshot, value };
}

test('validator accepts the four single-predicate rule statuses and existing valid judgment', () => {
  const evidenceCase = buildEvidenceCase(request);
  for (const [predicateStatus, ruleStatus] of [
    ['SUPPORTED', 'SATISFIED'], ['NOT_SUPPORTED', 'NOT_SATISFIED'], ['UNKNOWN', 'UNKNOWN'], ['CONFLICT', 'CONFLICT'],
  ] as const) {
    const { snapshot, value } = statusJudgment([predicateStatus], [], ruleStatus);
    assert.doesNotThrow(() => validatePolicyJudgment(value, snapshot, evidenceCase), predicateStatus);
  }
  assert.doesNotThrow(() => validatePolicyJudgment(judgment('DATA_REACHES_PROCESS_EXECUTION'), policy(), evidenceCase));
});

test('validator rejects UNKNOWN process-flow predicate summarized as NOT_SATISFIED, including RULE-REJECT-SHELL-EXEC', () => {
  const evidenceCase = buildEvidenceCase(request);
  const { snapshot, value } = statusJudgment(['UNKNOWN'], [], 'NOT_SATISFIED');
  assert.throws(() => validatePolicyJudgment(value, snapshot, evidenceCase), /INVALID_POLICY_RULE_STATUS:R/u);
  snapshot.rules[0]!.ruleId = 'RULE-REJECT-SHELL-EXEC';
  value.ruleEvaluations[0]!.ruleId = 'RULE-REJECT-SHELL-EXEC';
  snapshot.rules[0]!.effect = 'REJECT';
  assert.throws(() => validatePolicyJudgment(value, snapshot, evidenceCase), /INVALID_POLICY_RULE_STATUS:RULE-REJECT-SHELL-EXEC/u);
});

test('validator enforces allOf status precedence', () => {
  const evidenceCase = buildEvidenceCase(request);
  const cases: Array<[PredicateStatus[], RuleStatus]> = [
    [['SUPPORTED', 'SUPPORTED'], 'SATISFIED'],
    [['SUPPORTED', 'UNKNOWN'], 'UNKNOWN'],
    [['SUPPORTED', 'NOT_SUPPORTED'], 'NOT_SATISFIED'],
    [['UNKNOWN', 'NOT_SUPPORTED'], 'UNKNOWN'],
    [['CONFLICT', 'SUPPORTED'], 'CONFLICT'],
  ];
  for (const [allOf, expected] of cases) {
    const { snapshot, value } = statusJudgment(allOf, [], expected);
    assert.doesNotThrow(() => validatePolicyJudgment(value, snapshot, evidenceCase), allOf.join(','));
    value.ruleEvaluations[0]!.status = expected === 'NOT_SATISFIED' ? 'UNKNOWN' : 'NOT_SATISFIED';
    assert.throws(() => validatePolicyJudgment(value, snapshot, evidenceCase), /INVALID_POLICY_RULE_STATUS/u);
  }
});

test('validator enforces anyOf status precedence', () => {
  const evidenceCase = buildEvidenceCase(request);
  const cases: Array<[PredicateStatus[], RuleStatus]> = [
    [['SUPPORTED', 'UNKNOWN'], 'SATISFIED'],
    [['NOT_SUPPORTED', 'NOT_SUPPORTED'], 'NOT_SATISFIED'],
    [['NOT_SUPPORTED', 'UNKNOWN'], 'UNKNOWN'],
    [['UNKNOWN', 'UNKNOWN'], 'UNKNOWN'],
    [['SUPPORTED', 'CONFLICT'], 'CONFLICT'],
  ];
  for (const [anyOf, expected] of cases) {
    const { snapshot, value } = statusJudgment([], anyOf, expected);
    assert.doesNotThrow(() => validatePolicyJudgment(value, snapshot, evidenceCase), anyOf.join(','));
    value.ruleEvaluations[0]!.status = expected === 'NOT_SATISFIED' ? 'UNKNOWN' : 'NOT_SATISFIED';
    assert.throws(() => validatePolicyJudgment(value, snapshot, evidenceCase), /INVALID_POLICY_RULE_STATUS/u);
  }
});

test('computed rule statuses match strict validation without mutating the provider judgment', () => {
  const evidenceCase = buildEvidenceCase(request);
  const cases: Array<[PredicateStatus[], PredicateStatus[], RuleStatus]> = [
    [['SUPPORTED'], [], 'SATISFIED'], [['NOT_SUPPORTED'], [], 'NOT_SATISFIED'],
    [['UNKNOWN'], [], 'UNKNOWN'], [['CONFLICT'], [], 'CONFLICT'],
    [['SUPPORTED', 'UNKNOWN', 'NOT_SUPPORTED'], [], 'UNKNOWN'],
    [[], ['SUPPORTED', 'UNKNOWN', 'NOT_SUPPORTED'], 'SATISFIED'],
    [[], ['NOT_SUPPORTED', 'UNKNOWN'], 'UNKNOWN'],
    [['NOT_SUPPORTED'], ['SUPPORTED'], 'NOT_SATISFIED'],
    [['SUPPORTED'], ['SUPPORTED', 'CONFLICT'], 'CONFLICT'],
  ];
  for (const [allOf, anyOf, expected] of cases) {
    const { snapshot, value } = statusJudgment(allOf, anyOf, expected);
    assert.equal(calculateRuleStatus(snapshot.rules[0]!, value.ruleEvaluations[0]!.predicateEvaluations), expected);
    value.ruleEvaluations[0]!.status = expected === 'NOT_SATISFIED' ? 'UNKNOWN' : 'NOT_SATISFIED';
    const originalStatus = value.ruleEvaluations[0]!.status;
    const computed = validatePolicyJudgmentWithComputedRuleStatus(value, snapshot, evidenceCase);
    assert.equal(computed.ruleEvaluations[0]!.status, expected);
    assert.equal(value.ruleEvaluations[0]!.status, originalStatus);
    assert.doesNotThrow(() => validatePolicyJudgment(computed, snapshot, evidenceCase));
  }
});

test('computed status corrects multiple rules, including the reproduced SHELL-EXEC rule', () => {
  const evidenceCase = buildEvidenceCase(request);
  const { snapshot, value } = statusJudgment(['UNKNOWN'], [], 'NOT_SATISFIED');
  snapshot.rules[0]!.ruleId = 'RULE-REJECT-SHELL-EXEC';
  snapshot.rules[0]!.effect = 'REJECT';
  value.ruleEvaluations[0]!.ruleId = 'RULE-REJECT-SHELL-EXEC';
  snapshot.rules.push({ ...policy().rules[0]!, ruleId: 'RULE-SECOND', when: { allOf: [{ predicate: 'SENSITIVE_DATA_ACCESSED' }] } });
  value.ruleEvaluations.push({ ...value.ruleEvaluations[0]!, ruleId: 'RULE-SECOND', predicateEvaluations: [{ predicate: 'SENSITIVE_DATA_ACCESSED', status: 'UNKNOWN', evidenceIds: [], assessmentIds: [], feedEvidenceIds: [], codeRefs: [], missing: [] }] });
  const computed = validatePolicyJudgmentWithComputedRuleStatus(value, snapshot, evidenceCase);
  assert.deepEqual(computed.ruleEvaluations.map((rule) => rule.status), ['UNKNOWN', 'UNKNOWN']);
  assert.deepEqual(value.ruleEvaluations.map((rule) => rule.status), ['NOT_SATISFIED', 'NOT_SATISFIED']);
  assert.doesNotThrow(() => validatePolicyJudgment(computed, snapshot, evidenceCase));
});

test('computed status retains rule, predicate, and citation validation boundaries', () => {
  const evidenceCase = buildEvidenceCase(request);
  const base = statusJudgment(['SUPPORTED'], [], 'NOT_SATISFIED');
  const check = (change: (value: PolicyJudgment, snapshot: PolicySnapshot) => void, code: RegExp): void => {
    const value = structuredClone(base.value);
    const snapshot = structuredClone(base.snapshot);
    change(value, snapshot);
    assert.throws(() => validatePolicyJudgmentWithComputedRuleStatus(value, snapshot, evidenceCase), code);
  };
  check((value) => { value.ruleEvaluations = []; }, /INVALID_POLICY_RULE_COVERAGE/u);
  check((value) => { value.ruleEvaluations.push(structuredClone(value.ruleEvaluations[0]!)); }, /INVALID_POLICY_RULE_COVERAGE/u);
  check((value) => { value.ruleEvaluations[0]!.ruleId = 'NOT_IN_POLICY'; }, /INVALID_POLICY_RULE_EVALUATION/u);
  check((value, snapshot) => { snapshot.rules[0]!.when.allOf!.push({ predicate: 'SENSITIVE_DATA_ACCESSED' }); }, /INVALID_POLICY_PREDICATE_COVERAGE/u);
  check((value) => { value.ruleEvaluations[0]!.predicateEvaluations.push(structuredClone(value.ruleEvaluations[0]!.predicateEvaluations[0]!)); }, /INVALID_POLICY_PREDICATE_COVERAGE/u);
  check((value) => { value.ruleEvaluations[0]!.predicateEvaluations[0]!.predicate = 'UNREGISTERED' as PolicyPredicate; }, /INVALID_POLICY_PREDICATE_EVALUATION/u);
  check((value) => { value.ruleEvaluations[0]!.status = 'INVALID' as RuleStatus; }, /INVALID_POLICY_RULE_EVALUATION/u);
  check((value) => { value.ruleEvaluations[0]!.predicateEvaluations[0]!.status = 'INVALID' as PredicateStatus; }, /INVALID_POLICY_PREDICATE_EVALUATION/u);
  check((value) => { value.ruleEvaluations[0]!.predicateEvaluations[0]!.evidenceIds = ['missing']; }, /UNKNOWN_EVIDENCE_REF/u);
  check((value) => { value.ruleEvaluations[0]!.predicateEvaluations[0]!.evidenceIds = ['llm:analysis-1:assessment-1']; }, /LLM_ASSESSMENT_MUST_USE_ASSESSMENT_ID/u);
  check((value) => { value.ruleEvaluations[0]!.predicateEvaluations[0]!.assessmentIds = ['missing-assessment']; }, /UNKNOWN_ASSESSMENT_REF/u);
  check((value) => { value.ruleEvaluations[0]!.predicateEvaluations[0]!.evidenceIds = []; }, /SUPPORTED_REQUIRES_CITATION/u);
  check((value, snapshot) => { value.ruleEvaluations[0]!.predicateEvaluations[0]!.predicate = 'OSV_ADVISORY_APPLIES'; snapshot.rules[0]!.when = { allOf: [{ predicate: 'OSV_ADVISORY_APPLIES' }] }; }, /OSV_SUPPORT_REQUIRES_FEED_EVIDENCE/u);
});
