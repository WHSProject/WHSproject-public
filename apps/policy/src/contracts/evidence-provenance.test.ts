import assert from 'node:assert/strict';
import test from 'node:test';
import { parseEvaluationRequest } from './parse-evaluation-request';

const base = {
  schemaVersion: '0.1', evidenceId: 'atomic-1', kind: 'ATOMIC',
  signal: { id: 'child-process', type: 'CHILD_PROCESS', category: 'EXECUTION' },
  subject: { ecosystem: 'npm', packageName: 'fixture', packageVersion: '1.0.0', artifactHash: 'hash' },
  assertion: { summary: 'direct invocation', basis: 'PATTERN_MATCH' },
  sources: [{ analyzer: 'fixture', analyzerVersion: '1' }],
  locations: [{ type: 'SOURCE_FILE', path: 'package/index.js' }],
  provenance: { scanId: 'scan-1' },
};
const request = (evidence: object) => ({
  requestId: 'request-1', scanId: 'scan-1', scanStatus: 'COMPLETED',
  subject: { ...base.subject, integrity: 'integrity' }, evidences: [evidence],
  osvFeed: { source: 'OSV', feedStatus: 'SUCCESS', query: { ecosystem: 'npm', packageName: 'fixture', packageVersion: '1.0.0' }, advisories: [], complete: true, pagesFetched: 1, collectedAt: null, completedAt: null, errorCode: null, skippedReason: null },
});
const capability = {
  before: ['network'], after: null, status: 'NOT_APPLICABLE',
  preserved: [], lost: [], discovered: [], limitations: [],
  comparisons: [{
    capability: 'network', status: 'PRESERVED', original: [],
    deobfuscated: [{
      analyzer: 'fixture', analyzerVersion: '1', ruleId: 'r', findingId: 'f',
      path: 'package/decoded.js', representation: 'DEOBFUSCATED', lineageStatus: 'MAPPED',
      derivedFrom: { path: 'package/index.js', startLine: 8, endLine: 9 },
    }],
  }],
};

test('Tier1 remains optional and Tier2 provenance survives request JSON round trip', () => {
  assert.deepEqual(parseEvaluationRequest(request(base)).evidences[0], base);
  const tier1 = { ...base, analysisPass: 'TIER1', locations: [{ ...base.locations[0], representation: 'ORIGINAL', lineageStatus: 'DIRECT' }] };
  assert.deepEqual(parseEvaluationRequest(request(tier1)).evidences[0], tier1);
  const tier2 = { ...base, analysisPass: 'TIER2', locations: [{ type: 'SOURCE_FILE', path: 'package/decoded.js', representation: 'DEOBFUSCATED', lineageStatus: 'UNMAPPED', derivedFrom: { path: 'package/index.js' } }] };
  assert.deepEqual(parseEvaluationRequest(JSON.parse(JSON.stringify(request(tier2)))).evidences[0], tier2);
  const mapped = { ...tier2, locations: [{ ...tier2.locations[0], derivedFrom: { path: 'package/index.js', startLine: 8, endLine: 9 } }] };
  assert.deepEqual(parseEvaluationRequest(request(mapped)).evidences[0], mapped);
  const withCapability = { ...mapped, capabilityPreservation: { before: [], after: [], status: 'NOT_APPLICABLE', preserved: [], lost: [], discovered: [], comparisons: [], limitations: [] } };
  assert.deepEqual(parseEvaluationRequest(request(withCapability)).evidences[0], withCapability);
  const classified = { ...mapped, taxonomy: 'EVASION_AND_OBFUSCATION', action: 'DEOBFUSCATION', capabilityPreservation: capability };
  assert.deepEqual(parseEvaluationRequest(request(classified)).evidences[0], classified);
  const correlated = { ...tier2, evidenceId: 'correlated-1', kind: 'CORRELATED', derivedFrom: { evidenceIds: ['atomic-1'] } };
  assert.deepEqual(parseEvaluationRequest(request(correlated)).evidences[0], correlated);
});

test('request parser rejects invalid provenance enums, types, and unknown nested fields', () => {
  const comparison = capability.comparisons[0]!;
  const observation = comparison.deobfuscated[0]!;
  const invalid = [
    { ...base, unknown: true },
    { ...base, analysisPass: 'TIER3' }, { ...base, analysisPass: null },
    { ...base, taxonomy: 'UNKNOWN' }, { ...base, taxonomy: null }, { ...base, taxonomy: 1 },
    { ...base, action: '' }, { ...base, action: null }, { ...base, action: 1 },
    { ...base, capabilityPreservation: null }, { ...base, capabilityPreservation: [] },
    { ...base, capabilityPreservation: { ...capability, unknown: true } },
    { ...base, capabilityPreservation: { ...capability, before: 'network' } },
    { ...base, capabilityPreservation: { ...capability, status: 'UNKNOWN' } },
    { ...base, capabilityPreservation: { ...capability, comparisons: [{ ...comparison, unknown: true }] } },
    { ...base, capabilityPreservation: { ...capability, comparisons: [{ ...comparison, deobfuscated: [{ ...observation, unknown: true }] }] } },
    { ...base, capabilityPreservation: { ...capability, comparisons: [{ ...comparison, deobfuscated: [{ ...observation, startLine: '8' }] }] } },
    { ...base, locations: [{ type: 'SOURCE_FILE', representation: 'DERIVED' }] },
    { ...base, locations: [{ type: 'SOURCE_FILE', representation: 1 }] },
    { ...base, locations: [{ type: 'SOURCE_FILE', lineageStatus: 'LOST' }] },
    { ...base, locations: [{ type: 'SOURCE_FILE', lineageStatus: 1 }] },
    { ...base, locations: [{ type: 'SOURCE_FILE', derivedFrom: { path: 1 } }] },
    { ...base, locations: [{ type: 'SOURCE_FILE', derivedFrom: { path: 'x', startLine: 0 } }] },
    { ...base, locations: [{ type: 'SOURCE_FILE', derivedFrom: { path: 'x', startLine: -1 } }] },
    { ...base, locations: [{ type: 'SOURCE_FILE', derivedFrom: { path: 'x', startLine: 1.5 } }] },
    { ...base, locations: [{ type: 'SOURCE_FILE', derivedFrom: { path: 'x', startLine: '1' } }] },
    { ...base, locations: [{ type: 'SOURCE_FILE', derivedFrom: { path: 'x', startLine: null } }] },
    { ...base, locations: [{ type: 'SOURCE_FILE', derivedFrom: { path: 'x', endLine: 0 } }] },
    { ...base, locations: [{ type: 'SOURCE_FILE', derivedFrom: { path: 'x', endLine: -1 } }] },
    { ...base, locations: [{ type: 'SOURCE_FILE', derivedFrom: { path: 'x', endLine: 1.5 } }] },
    { ...base, locations: [{ type: 'SOURCE_FILE', derivedFrom: { path: 'x', endLine: '1' } }] },
    { ...base, locations: [{ type: 'SOURCE_FILE', derivedFrom: { path: 'x', endLine: null } }] },
    { ...base, locations: [{ type: 'SOURCE_FILE', derivedFrom: { path: 'x', unknown: true } }] },
    { ...base, locations: [{ type: 'SOURCE_FILE', unknown: true }] },
  ];
  for (const evidence of invalid) assert.throws(() => parseEvaluationRequest(request(evidence)), /INVALID_EVIDENCE/u);
});
