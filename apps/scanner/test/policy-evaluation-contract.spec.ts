import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020';
import addFormats from 'ajv-formats';

import type { OsvFeedResult } from '../src/osv/osv-feed.types';

function loadSchema(fileName: string): object {
  return JSON.parse(readFileSync(join(
    __dirname,
    '../../../packages/contracts',
    fileName,
  ), 'utf8')) as object;
}

function osvFeed(feedStatus: OsvFeedResult['feedStatus']): OsvFeedResult {
  return {
    source: 'OSV',
    feedStatus,
    query: { ecosystem: 'npm', packageName: 'example', packageVersion: '1.0.0' },
    advisories: feedStatus === 'SUCCESS' ? [{ id: 'OSV-2026-1', unknown: { kept: true } }] : [],
    complete: feedStatus === 'SUCCESS',
    pagesFetched: feedStatus === 'SUCCESS' ? 1 : 0,
    collectedAt: feedStatus === 'SKIPPED' ? null : '2026-09-17T00:00:00.000Z',
    completedAt: feedStatus === 'SUCCESS' ? '2026-09-17T00:00:01.000Z' : null,
    errorCode: feedStatus === 'FAILED'
      ? 'NETWORK_ERROR'
      : feedStatus === 'TIMEOUT' ? 'DEADLINE_EXCEEDED' : null,
    skippedReason: feedStatus === 'SKIPPED' ? 'PROVENANCE_UNCONFIRMED' : null,
  };
}

function atomicEvidence(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: '0.1',
    evidenceId: 'evidence-1',
    kind: 'ATOMIC',
    signal: { id: 'signal-1', type: 'CHILD_PROCESS', category: 'EXECUTION' },
    subject: {
      ecosystem: 'npm',
      packageName: 'example',
      packageVersion: '1.0.0',
      artifactHash: 'a'.repeat(64),
    },
    assertion: { summary: 'child process', basis: 'PATTERN_MATCH' },
    sources: [{ analyzer: 'custom-rule', analyzerVersion: '1.0.0' }],
    locations: [{ type: 'SOURCE_FILE', path: 'package/index.js', startLine: 1, endLine: 1 }],
    provenance: { scanId: 'scan-1', generatedBy: 'EVIDENCE_NORMALIZER' },
    ...overrides,
  };
}

function request(feedStatus: OsvFeedResult['feedStatus']): Record<string, unknown> {
  return {
    requestId: 'request-1',
    scanStatus: 'COMPLETED',
    scanId: 'scan-1',
    subject: {
      ecosystem: 'npm',
      packageName: 'example',
      packageVersion: '1.0.0',
      artifactHash: 'a'.repeat(64),
      integrity: `sha512-${'A'.repeat(88)}`,
    },
    evidences: [],
    osvFeed: osvFeed(feedStatus),
  };
}

describe('Policy evaluation shared contract', () => {
  let validate: ValidateFunction;

  beforeAll(() => {
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    addFormats(ajv);
    ajv.addSchema(loadSchema('evidence-v0.1.schema.json'));
    validate = ajv.compile(loadSchema('policy-evaluation-v0.1.schema.json'));
  });

  it('rejects an evaluation request without osvFeed', () => {
    const payload = request('SUCCESS');
    delete payload.osvFeed;

    expect(validate(payload)).toBe(false);
    expect(validate.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ keyword: 'required', params: { missingProperty: 'osvFeed' } }),
    ]));
  });

  it.each(['SUCCESS', 'FAILED', 'TIMEOUT', 'SKIPPED'] as const)(
    'accepts the %s OSV result and its nullable fields',
    (feedStatus) => {
      expect(validate(request(feedStatus))).toBe(true);
      expect(validate.errors).toBeNull();
    },
  );

  it('accepts empty SUCCESS advisories and preserves unconstrained advisory fields', () => {
    const empty = request('SUCCESS');
    (empty.osvFeed as OsvFeedResult).advisories = [];

    expect(validate(empty)).toBe(true);
    expect(validate(request('SUCCESS'))).toBe(true);
  });

  it.each([
    ['SUCCESS', { complete: false }],
    ['SUCCESS', { collectedAt: null }],
    ['SUCCESS', { completedAt: null }],
    ['SUCCESS', { errorCode: 'NETWORK_ERROR' }],
    ['SUCCESS', { skippedReason: 'DISABLED' }],
    ['FAILED', { complete: true }],
    ['FAILED', { advisories: [{ id: 'GHSA-partial' }] }],
    ['FAILED', { completedAt: '2026-09-17T00:00:00Z' }],
    ['FAILED', { errorCode: null }],
    ['FAILED', { errorCode: 'PARENT_ABORTED' }],
    ['FAILED', { skippedReason: 'DISABLED' }],
    ['TIMEOUT', { complete: true }],
    ['TIMEOUT', { advisories: [{ id: 'GHSA-partial' }] }],
    ['TIMEOUT', { completedAt: '2026-09-17T00:00:00Z' }],
    ['TIMEOUT', { errorCode: null }],
    ['TIMEOUT', { errorCode: 'NETWORK_ERROR' }],
    ['TIMEOUT', { skippedReason: 'DISABLED' }],
    ['SKIPPED', { complete: true }],
    ['SKIPPED', { advisories: [{ id: 'GHSA-partial' }] }],
    ['SKIPPED', { pagesFetched: 1 }],
    ['SKIPPED', { collectedAt: '2026-09-17T00:00:00Z' }],
    ['SKIPPED', { completedAt: '2026-09-17T00:00:00Z' }],
    ['SKIPPED', { errorCode: 'NETWORK_ERROR' }],
    ['SKIPPED', { skippedReason: null }],
  ] as const)('rejects inconsistent %s fields: %j', (status, changes) => {
    const payload = request(status);
    Object.assign(payload.osvFeed as object, changes);
    expect(validate(payload)).toBe(false);
  });

  it.each(['SUCCESS', 'FAILED', 'TIMEOUT', 'SKIPPED'] as const)(
    'requires every transport field for %s', (status) => {
      for (const field of Object.keys(osvFeed(status))) {
        const payload = request(status);
        delete (payload.osvFeed as Record<string, unknown>)[field];
        expect(validate(payload)).toBe(false);
        expect(validate.errors).toEqual(expect.arrayContaining([
          expect.objectContaining({ keyword: 'required', params: { missingProperty: field } }),
        ]));
      }
    },
  );

  it('accepts TIMEOUT before an HTTP attempt starts', () => {
    const payload = request('TIMEOUT');
    (payload.osvFeed as OsvFeedResult).collectedAt = null;
    expect(validate(payload)).toBe(true);
  });

  it('rejects null Feed and forged internal results', () => {
    expect(validate({ ...request('SUCCESS'), osvFeed: null })).toBe(false);
    for (const field of ['threatFeed', 'feedStatus', 'decision', 'validatedFeed']) {
      expect(validate({ ...request('SUCCESS'), [field]: 'REJECT' })).toBe(false);
    }
  });

  it('accepts existing Atomic Evidence without provenance extensions', () => {
    const payload = request('SUCCESS');
    payload.evidences = [atomicEvidence()];

    expect(validate(payload)).toBe(true);
    expect(validate.errors).toBeNull();
  });

  it.each(['TIER1', 'TIER2'] as const)('accepts %s analysisPass and Tier2 provenance extensions without changing the v0.1 payload shape', (analysisPass) => {
    const payload = request('SUCCESS');
    payload.evidences = [atomicEvidence({
      analysisPass,
      locations: [{
        type: 'SOURCE_FILE',
        path: 'package/derived/index.js',
        startLine: 1,
        endLine: 2,
        representation: 'DEOBFUSCATED',
        lineageStatus: 'UNMAPPED',
        derivedFrom: { path: 'package/index.js' },
      }],
    })];

    expect(validate(payload)).toBe(true);
    expect(validate.errors).toBeNull();
  });

  it.each([
    ['analysisPass', 'INVALID'],
    ['representation', 'INVALID'],
    ['lineageStatus', 'INVALID'],
  ] as const)('rejects an invalid %s enum', (field, value) => {
    const payload = request('SUCCESS');
    payload.evidences = [atomicEvidence({
      ...(field === 'analysisPass' ? { analysisPass: value } : {}),
      locations: [{
        type: 'SOURCE_FILE',
        path: 'package/derived/index.js',
        ...(field === 'representation' ? { representation: value } : {}),
        ...(field === 'lineageStatus' ? { lineageStatus: value } : {}),
      }],
    })];

    expect(validate(payload)).toBe(false);
  });

  it('requires a path when location derivedFrom is present', () => {
    const payload = request('SUCCESS');
    payload.evidences = [atomicEvidence({
      locations: [{
        type: 'SOURCE_FILE',
        path: 'package/derived/index.js',
        derivedFrom: {},
      }],
    })];

    expect(validate(payload)).toBe(false);
  });

  it('rejects unknown location properties while keeping location strictness', () => {
    const payload = request('SUCCESS');
    payload.evidences = [atomicEvidence({
      locations: [{
        type: 'SOURCE_FILE',
        path: 'package/derived/index.js',
        unknownLocationField: 'must-reject',
      }],
    })];

    expect(validate(payload)).toBe(false);
  });

  it('accepts Evidence-level and location-level derivedFrom together', () => {
    const payload = request('SUCCESS');
    payload.evidences = [atomicEvidence({
      analysisPass: 'TIER2',
      derivedFrom: { evidenceIds: ['tier1-evidence-1'] },
      locations: [{
        type: 'SOURCE_FILE',
        path: 'package/derived/index.js',
        representation: 'DEOBFUSCATED',
        lineageStatus: 'UNMAPPED',
        derivedFrom: { path: 'package/index.js' },
      }],
    })];

    expect(validate(payload)).toBe(true);
    expect(validate.errors).toBeNull();
  });

  it('keeps taxonomy, action, capability preservation, and mapped lines aligned with the shared schema', () => {
    const capability = {
      before: [], after: null, status: 'NOT_APPLICABLE', preserved: [], lost: [],
      discovered: [], limitations: [], comparisons: [{
        capability: 'network', status: 'PRESERVED', original: [], deobfuscated: [{
          analyzer: 'fixture', analyzerVersion: '1', ruleId: 'r', findingId: 'f',
          path: 'package/decoded.js', representation: 'DEOBFUSCATED', lineageStatus: 'MAPPED',
          derivedFrom: { path: 'package/index.js', startLine: 8, endLine: 9 },
        }],
      }],
    };
    const location = { type: 'SOURCE_FILE', derivedFrom: { path: 'package/index.js', startLine: 8, endLine: 9 } };
    const comparison = capability.comparisons[0]!;
    const observation = comparison.deobfuscated[0]!;
    const accepts = (overrides: Record<string, unknown>) => {
      const payload = request('SUCCESS');
      payload.evidences = [atomicEvidence(overrides)];
      return validate(payload);
    };
    expect(accepts({ taxonomy: 'EVASION_AND_OBFUSCATION', action: 'DEOBFUSCATION', capabilityPreservation: capability, locations: [location] })).toBe(true);
    for (const overrides of [
      { taxonomy: 'UNKNOWN' }, { taxonomy: null }, { action: '' }, { action: null }, { action: 1 },
      { capabilityPreservation: null }, { capabilityPreservation: { ...capability, unknown: true } },
      { capabilityPreservation: { ...capability, before: 'invalid' } },
      { capabilityPreservation: { ...capability, comparisons: [{ ...comparison, unknown: true }] } },
      { capabilityPreservation: { ...capability, comparisons: [{ ...comparison, deobfuscated: [{ ...observation, startLine: 0 }] }] } },
      ...[0, -1, 1.5, '1', null].flatMap((line) => [
        { locations: [{ type: 'SOURCE_FILE', derivedFrom: { path: 'x', startLine: line } }] },
        { locations: [{ type: 'SOURCE_FILE', derivedFrom: { path: 'x', endLine: line } }] },
      ]),
    ]) expect(accepts(overrides)).toBe(false);
  });

});
