import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ScanExecutionResult } from '../application/orchestrator/orchestrator';
import type { ScanResult } from '../domain/analysis.types';
import type { AgentAnalysisRequest } from '../llm-agent/agent.contract';
import type { Tier3OperationalResult } from '../llm-agent/artifact/tier3-runtime';
import { agentSummary, LlmEvidenceAdapter } from '../llm-agent/llm-evidence.adapter';
import type { AgentAnalysisResult, AgentAssessment, AgentAnalysisSummary } from '../llm-agent/output.contract';
import type { OsvFeedResult } from '../osv/osv-feed.types';
import { buildPolicyEvaluationRequest } from './policy-evaluation.request';

const fixtureDir = join(__dirname, '..', '..', 'test', 'fixtures', 'policy-llm');
const osvFeed: OsvFeedResult = { source: 'OSV', feedStatus: 'SUCCESS', query: { ecosystem: 'npm', packageName: 'example', packageVersion: '1.0.0' }, advisories: [], complete: true, pagesFetched: 1, collectedAt: '2026-09-20T00:00:00.000Z', completedAt: '2026-09-20T00:00:01.000Z', errorCode: null, skippedReason: null };
const atomic = { schemaVersion: '0.1', evidenceId: 'atomic-1', kind: 'ATOMIC', signal: { id: 'child-process', type: 'CHILD_PROCESS', category: 'EXECUTION' }, subject: { ecosystem: 'npm', packageName: 'example', packageVersion: '1.0.0', artifactHash: 'sha256-value' }, assertion: { summary: 'Process execution', basis: 'PATTERN_MATCH' as const }, sources: [{ analyzer: 'custom-rule', analyzerVersion: '1', ruleId: 'custom.process-execution', rawFindingId: 'finding-1' }], locations: [], provenance: { scanId: 'scan-1', generatedBy: 'EVIDENCE_NORMALIZER', observedAt: '2026-09-20T00:00:00.000Z' }, limitations: [] };
const correlated = { ...atomic, evidenceId: 'correlated-1', kind: 'CORRELATED', derivedFrom: { evidenceIds: ['atomic-1'] } };
const request: AgentAnalysisRequest = {
  request: { analysisRequestId: 'agent-request-1', requestType: 'MALICIOUS_CODE_ANALYSIS', schemaVersion: '0.2.0', createdAt: '2026-09-20T00:00:00.000Z', requestId: 'request-1', scanId: 'scan-1', inputProfile: 'CODE_FINDING_EVIDENCE' },
  subject: { ecosystem: 'npm', packageName: 'example', packageVersion: '1.0.0', artifactHash: 'sha256-value', integrity: 'sha512-value' },
  packageContext: { source: 'TARBALL_PACKAGE_MANIFEST_PROJECTION', packageMetadata: { name: 'example', version: '1.0.0', description: null }, main: 'index.js', exports: null, bin: {}, scripts: {}, dependencies: {}, entryPoints: [], lifecycleScripts: [] },
  findings: [{ findingId: 'finding-1', analyzer: 'custom-rule', analyzerVersion: '1', ruleId: 'custom.process-execution', kind: 'CAPABILITY', description: 'Process execution', location: { file: 'index.js', startLine: 1, endLine: 1 }, rawMatch: null }],
  atomicEvidences: [{ evidenceId: 'atomic-1', signal: atomic.signal, assertion: atomic.assertion, sources: atomic.sources, locations: [], limitations: [] }],
  analysisPolicy: { maxToolCalls: 4, maxAdditionalCodeRequests: 2, maxTotalCodeLines: 1040 },
  initialCodeSlices: [{ sliceId: 'slice-1', file: 'index.js', startLine: 1, endLine: 1, content: 'exec(x);', contentRedacted: false, selectionReason: 'finding', relatedFindingIds: ['finding-1'] }],
  analysisTargets: [], toolResponseCatalog: [], missingData: [],
};
const assessment: AgentAssessment = { id: 'assessment-1', type: 'CORRELATED_BEHAVIOR', signal: 'CHILD_PROCESS', category: 'EXECUTION', basis: 'PATTERN_MATCH', findingIds: ['finding-1'], atomicEvidenceIds: ['atomic-1'], refs: [{ id: 'ref-1', sliceId: 'slice-1', lines: [1, 1], role: 'SINK' }], flow: { sink: 'ref-1' }, reachability: { status: 'POSSIBLE' }, verification: { status: 'UNVERIFIED', method: 'NONE' }, confidence: 0.7, reasonCodes: ['CODE'] };
const output = { requestId: 'agent-request-1', schemaVersion: '0.1.0' as const, status: 'COMPLETED' as const, assessments: [assessment], summary: { verdict: 'SUSPICIOUS' as const, confidence: 0.7, reasonCodes: ['CODE'] }, limitations: [], missingContext: [] };
function run(status: AgentAnalysisResult['status'], verified = true): AgentAnalysisResult {
  const result: AgentAnalysisResult = { status, analysisId: 'analysis-1', model: 'mock-model', promptVersion: 'scanner-single-agent-0.1.0', outputSchemaVersion: '0.1.0', providerRequestIds: ['provider-request-1'], usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, modelCalls: 1, toolCalls: 0, additionalCodeRequests: 0, durationMs: 5, limitations: [],
    ...(status === 'FAILED' ? { failureReason: 'PROVIDER_ERROR' as const } : status === 'TIMEOUT' ? { failureReason: 'TIMEOUT' as const } : {}),
  };
  if (status === 'COMPLETED' || status === 'PARTIAL') result.validated = { output, assessments: verified ? [{ assessment, status: 'VERIFIED', issues: [] }] : [] };
  return result;
}
function scanResult(evidences: unknown[]): ScanResult { return { schemaVersion: '0.1', requestId: 'request-1', scanId: 'scan-1', subject: { ecosystem: 'npm', name: 'example', version: '1.0.0' }, artifactHash: 'sha256-value', status: 'COMPLETED', evidences, analyzerSummaries: [], errors: [] }; }
function payloadFor(status: 'COMPLETED_WITH_EVIDENCE' | 'COMPLETED_WITHOUT_EVIDENCE' | 'PARTIAL' | 'FAILED' | 'TIMEOUT' | 'SKIPPED') {
  const actualStatus = status === 'COMPLETED_WITH_EVIDENCE' || status === 'COMPLETED_WITHOUT_EVIDENCE' ? 'COMPLETED' : status;
  const result = run(actualStatus, status !== 'COMPLETED_WITHOUT_EVIDENCE');
  const conversion = new LlmEvidenceAdapter().toEvidences(request, result);
  const saved = scanResult([atomic, correlated, ...conversion.evidences]);
  const summary = actualStatus === 'SKIPPED' ? undefined : agentSummary(result, conversion, 'ALWAYS_MODE');
  const execution: ScanExecutionResult = { scanResult: saved, osvFeed, calculatedIntegrity: 'sha512-value', agentFindingIds: ['finding-1'], ...(summary ? { agentAnalysisSummary: summary } : {}) };
  return JSON.parse(JSON.stringify(buildPolicyEvaluationRequest(saved, execution, 'sha512-value'))) as unknown;
}

describe('Scanner Policy LLM payload boundary', () => {
  const cases = [
    ['llm-completed-with-evidence.json', 'COMPLETED_WITH_EVIDENCE'],
    ['llm-completed-without-evidence.json', 'COMPLETED_WITHOUT_EVIDENCE'],
    ['llm-partial.json', 'PARTIAL'], ['llm-failed.json', 'FAILED'], ['llm-timeout.json', 'TIMEOUT'], ['llm-skipped-or-disabled.json', 'SKIPPED'],
  ] as const;
  it.each(cases)('serializes %s from the Adapter and Policy request builder', (name, status) => {
    const actual = payloadFor(status);
    if (process.env.UPDATE_LLM_GOLDEN === '1') { mkdirSync(fixtureDir, { recursive: true }); writeFileSync(join(fixtureDir, name), `${JSON.stringify(actual, null, 2)}\n`); }
    expect(existsSync(join(fixtureDir, name))).toBe(true);
    expect(actual).toEqual(JSON.parse(readFileSync(join(fixtureDir, name), 'utf8')) as unknown);
    expect(actual).toMatchObject({ osvFeed });
  });
  it('accepts the V0.3 operational result Evidence and summary without weakening Policy validation', () => {
    const runResult = run('COMPLETED');
    const conversion = new LlmEvidenceAdapter().toEvidences(request, runResult);
    const operational: Tier3OperationalResult = {
      evidences: conversion.evidences,
      summary: agentSummary(runResult, conversion, 'STATIC_FILTER'),
      inputFindingIds: ['finding-1'], assessedFindingIds: ['finding-1'], citedFindingIds: ['finding-1'],
      conversionFailures: [], initialSliceCount: 1, runtimeSliceCount: 0, codeRequests: [], limitations: [],
    };
    const saved = scanResult([atomic, correlated, ...operational.evidences]);

    const actual = buildPolicyEvaluationRequest(saved, {
      scanResult: saved, osvFeed, agentFindingIds: operational.inputFindingIds,
      agentAnalysisSummary: operational.summary,
    }, 'sha512-value');

    expect(actual.evidences).toEqual([atomic, correlated, ...operational.evidences]);
    expect(actual.agentAnalysisSummary).toEqual(operational.summary);
  });
  it.each([
    ['llm-partially-valid-evidences.json', false],
    ['llm-all-assessments-rejected.json', true],
  ] as const)('serializes %s after Assessment-level rejection', (name, allRejected) => {
    const invalid = { ...structuredClone(assessment), id: 'assessment-2', findingIds: ['missing-finding'], signal: 'OTHER_SIGNAL' };
    const first = { assessment: structuredClone(assessment), status: allRejected ? 'REJECTED' as const : 'VERIFIED' as const, issues: allRejected ? ['Unknown Finding ID'] : [] };
    if (allRejected) first.assessment.findingIds = ['missing-finding'];
    const result = run('PARTIAL');
    result.validated = { output: { ...output, assessments: [first.assessment, invalid] }, assessments: [first, { assessment: invalid, status: 'REJECTED', issues: ['Unknown Finding ID'] }] };
    const conversion = new LlmEvidenceAdapter().toEvidences(request, result);
    const saved = scanResult([atomic, correlated, ...conversion.evidences]);
    const summary = agentSummary(result, conversion, 'ALWAYS_MODE');
    const actual = JSON.parse(JSON.stringify(buildPolicyEvaluationRequest(saved, { scanResult: saved, osvFeed, agentFindingIds: ['finding-1'], agentAnalysisSummary: summary }, 'sha512-value'))) as unknown;
    if (process.env.UPDATE_LLM_GOLDEN === '1') writeFileSync(join(fixtureDir, name), `${JSON.stringify(actual, null, 2)}\n`);
    expect(actual).toEqual(JSON.parse(readFileSync(join(fixtureDir, name), 'utf8')) as unknown);
    expect(actual).toMatchObject({ osvFeed, agentAnalysisSummary: { status: 'PARTIAL', assessmentCount: 2, generatedEvidenceCount: allRejected ? 0 : 1, rejectedAssessmentCount: allRejected ? 2 : 1 } });
  });
  it('removes invalid LLM data but retains existing Evidence and OSV', () => {
    const good = payloadFor('COMPLETED_WITH_EVIDENCE') as { evidences: Array<Record<string, unknown>>; agentAnalysisSummary: AgentAnalysisSummary };
    for (const corrupt of [
      (item: Record<string, unknown>) => { item.evidenceType = 'LLM_ASSESSMENT'; },
      (item: Record<string, unknown>) => { item.kind = 'CORRELATED'; },
      (item: Record<string, unknown>) => { item.verificationStatus = 'REJECTED'; },
      (item: Record<string, unknown>) => { item.relatedAtomicEvidenceIds = ['missing']; },
      (item: Record<string, unknown>) => { item.evidenceId = 'llm:wrong:assessment-1'; },
      (item: Record<string, unknown>) => { item.relatedFindingIds = ['unknown']; },
    ]) {
      const evidences = structuredClone(good.evidences);
      corrupt(evidences[2]!);
      const saved = scanResult(evidences);
      const execution: ScanExecutionResult = { scanResult: saved, osvFeed, agentFindingIds: ['finding-1'], agentAnalysisSummary: good.agentAnalysisSummary };
      const actual = buildPolicyEvaluationRequest(saved, execution, 'sha512-value');
      expect(actual.evidences).toEqual([atomic, correlated]);
      expect(actual.agentAnalysisSummary).toMatchObject({ status: 'PARTIAL', generatedEvidenceCount: 0, rejectedAssessmentCount: 1 });
      expect(actual.osvFeed).toEqual(osvFeed);
    }
  });
  it('keeps valid LLM Evidence when a sibling has an invalid Atomic reference', () => {
    const good = payloadFor('COMPLETED_WITH_EVIDENCE') as { evidences: Array<Record<string, unknown>>; agentAnalysisSummary: AgentAnalysisSummary };
    const second = structuredClone(good.evidences[2]!);
    second.evidenceId = 'llm:analysis-1:assessment-2';
    second.provenance = { ...(second.provenance as Record<string, unknown>), assessmentId: 'assessment-2' };
    second.relatedAtomicEvidenceIds = ['missing'];
    const saved = scanResult([...good.evidences, second]);
    const summary = { ...good.agentAnalysisSummary, assessmentCount: 2, verifiedAssessmentCount: 2, generatedEvidenceCount: 2 };
    const actual = buildPolicyEvaluationRequest(saved, { scanResult: saved, osvFeed, agentFindingIds: ['finding-1'], agentAnalysisSummary: summary }, 'sha512-value');
    expect(actual.evidences).toEqual(good.evidences);
    expect(actual.agentAnalysisSummary).toMatchObject({ status: 'PARTIAL', generatedEvidenceCount: 1, rejectedAssessmentCount: 1 });
    expect(actual.osvFeed).toEqual(osvFeed);
  });
  it('combines Adapter and Policy rejection counts without losing valid Evidence or OSV', () => {
    const a = structuredClone(assessment);
    const b = { ...structuredClone(assessment), id: 'assessment-2', signal: 'SECOND_SIGNAL' };
    const c = { ...structuredClone(assessment), id: 'assessment-3', signal: 'THIRD_SIGNAL' };
    Object.defineProperty(b, 'reasonCodes', { get: () => { throw new Error('conversion failed'); } });
    const result = run('COMPLETED');
    result.validated = { output: { ...output, assessments: [a, b, c] }, assessments: [a, b, c].map((item) => ({ assessment: item, status: 'VERIFIED', issues: [] })) };
    const conversion = new LlmEvidenceAdapter().toEvidences(request, result);
    expect(conversion.failures).toEqual([{ assessmentId: 'assessment-2', reason: 'EVIDENCE_CONVERSION_FAILED' }]);
    const malformed = { ...conversion.evidences[1]!, relatedAtomicEvidenceIds: ['missing'] };
    const saved = scanResult([atomic, correlated, conversion.evidences[0], malformed]);
    const summary = agentSummary(result, conversion, 'ALWAYS_MODE');
    const actual = buildPolicyEvaluationRequest(saved, { scanResult: saved, osvFeed, agentFindingIds: ['finding-1'], agentAnalysisSummary: summary }, 'sha512-value');
    expect(actual.evidences).toEqual([atomic, correlated, conversion.evidences[0]]);
    expect(actual.agentAnalysisSummary).toMatchObject({ status: 'PARTIAL', assessmentCount: 3, verifiedAssessmentCount: 3, generatedEvidenceCount: 1, rejectedAssessmentCount: 2 });
    expect(actual.osvFeed).toEqual(osvFeed);
  });
  it('sends baseline Evidence and OSV when every Assessment conversion fails', () => {
    const broken = structuredClone(assessment);
    Object.defineProperty(broken, 'reasonCodes', { get: () => { throw new Error('conversion failed'); } });
    const result = run('COMPLETED');
    result.validated = { output: { ...output, assessments: [broken] }, assessments: [{ assessment: broken, status: 'VERIFIED', issues: [] }] };
    const conversion = new LlmEvidenceAdapter().toEvidences(request, result);
    const saved = scanResult([atomic, correlated, ...conversion.evidences]);
    const actual = buildPolicyEvaluationRequest(saved, { scanResult: saved, osvFeed, agentFindingIds: ['finding-1'], agentAnalysisSummary: agentSummary(result, conversion, 'ALWAYS_MODE') }, 'sha512-value');
    expect(actual.evidences).toEqual([atomic, correlated]);
    expect(actual.agentAnalysisSummary).toMatchObject({ status: 'PARTIAL', generatedEvidenceCount: 0, rejectedAssessmentCount: 1 });
    expect(actual.osvFeed).toEqual(osvFeed);
  });
  it('requires a matching Summary and nonnegative consistent counts for LLM Evidence', () => {
    const good = payloadFor('COMPLETED_WITH_EVIDENCE') as { evidences: Array<Record<string, unknown>>; agentAnalysisSummary: AgentAnalysisSummary };
    for (const summary of [undefined,
      { ...good.agentAnalysisSummary, generatedEvidenceCount: 0 },
      { ...good.agentAnalysisSummary, verifiedAssessmentCount: -1 },
      { ...good.agentAnalysisSummary, analysisId: 'other-analysis' },
      { ...good.agentAnalysisSummary, status: 'FAILED' as const },
    ]) {
      const saved = scanResult(good.evidences);
      const execution: ScanExecutionResult = { scanResult: saved, osvFeed, agentFindingIds: ['finding-1'], ...(summary ? { agentAnalysisSummary: summary } : {}) };
      const actual = buildPolicyEvaluationRequest(saved, execution, 'sha512-value');
      expect(actual.evidences).toEqual([atomic, correlated]);
      expect(actual.agentAnalysisSummary).toMatchObject({ status: 'FAILED', failureReason: 'INTERNAL_ERROR', generatedEvidenceCount: 0 });
    }
  });
  it('rejects invalid existing Evidence or missing OSV', () => {
    const saved = scanResult([atomic, { ...atomic }]);
    expect(() => buildPolicyEvaluationRequest(saved, { scanResult: saved, osvFeed }, 'sha512-value')).toThrow('duplicated');
    expect(() => buildPolicyEvaluationRequest(scanResult([atomic]), { scanResult: scanResult([atomic]), osvFeed: undefined as unknown as OsvFeedResult }, 'sha512-value')).toThrow('OSV Feed');
  });
});
