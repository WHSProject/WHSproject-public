import { batchIdentityHash, isReusableSuccess, sealPrimaryManifest } from '../src/application/dataset-batch/dataset-batch.contract';

const rows = Array.from({ length: 179 }, (_, index) => ({
  sampleId: `sample-${index}`, sampleArtifactHash: 'a'.repeat(64), qcStatus: 'ELIGIBLE' as const,
  split: 'DEVELOPMENT' as const,
}));

describe('dataset batch contract', () => {
  it('seals exactly 179 eligible non-quarantine samples deterministically', () => {
    const first = sealPrimaryManifest(rows, new Set());
    const second = sealPrimaryManifest([...rows].reverse(), new Set());
    expect(first).toEqual(second);
  });
  it('rejects quarantine, count, and duplicate violations', () => {
    expect(() => sealPrimaryManifest(rows, new Set(['sample-1']))).toThrow('QUARANTINE_INCLUDED');
    expect(() => sealPrimaryManifest(rows.slice(1), new Set())).toThrow('PRIMARY_COUNT_INVALID');
    expect(() => sealPrimaryManifest([...rows.slice(0, 178), rows[0]!], new Set())).toThrow('PRIMARY_SAMPLE_DUPLICATE');
  });
  it('reuses only a complete successful exact-identity cache', () => {
    const identity = { sampleId: 'sample', archiveSha256: 'a', scannerCommitSha: 'b', imageDigest: 'c',
      guardDogVersion: 'd', semgrepVersion: 'e', rulesetHash: 'f', metadataVersion: 'g', findingContractHash: 'h',
      evidenceContractHash: 'i', evidenceMappingHash: 'j', agentFindingContractHash: 'k',
      agentFindingProjectionHash: 'l', sandboxPolicyHash: 'm', batchPolicyHash: 'n' };
    const hash = batchIdentityHash(identity);
    expect(isReusableSuccess({ status: 'COMPLETED', cacheIdentityHash: hash, complete: true }, hash)).toBe(true);
    expect(isReusableSuccess({ status: 'FAILED', cacheIdentityHash: hash, complete: true }, hash)).toBe(false);
    expect(isReusableSuccess({ status: 'COMPLETED', cacheIdentityHash: 'other', complete: true }, hash)).toBe(false);
    expect(isReusableSuccess({ status: 'COMPLETED', cacheIdentityHash: hash, complete: false }, hash)).toBe(false);
  });
});
