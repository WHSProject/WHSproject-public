import { createHash } from 'node:crypto';

export const DATASET_BATCH_CONTRACT_VERSION = '1.0.0';
export const DATASET_BATCH_ANALYZERS = ['guarddog', 'metadata', 'custom-rule'] as const;

export interface DatasetBatchSample {
  sampleId: string;
  sampleArtifactHash: string;
  qcStatus: 'ELIGIBLE';
  split: 'DEVELOPMENT' | 'VALIDATION' | 'FROZEN_TEST';
}

export interface DatasetBatchIdentity {
  sampleId: string;
  archiveSha256: string;
  scannerCommitSha: string;
  imageDigest: string;
  guardDogVersion: string;
  semgrepVersion: string;
  rulesetHash: string;
  metadataVersion: string;
  findingContractHash: string;
  evidenceContractHash: string;
  evidenceMappingHash: string;
  agentFindingContractHash: string;
  agentFindingProjectionHash: string;
  sandboxPolicyHash: string;
  batchPolicyHash: string;
}

export function sealPrimaryManifest(rows: readonly DatasetBatchSample[], quarantineIds: ReadonlySet<string>): {
  sampleIds: string[]; digest: string;
} {
  if (rows.length !== 179) throw new Error(`PRIMARY_COUNT_INVALID:${rows.length}`);
  const ids = rows.map(({ sampleId }) => sampleId);
  if (new Set(ids).size !== ids.length) throw new Error('PRIMARY_SAMPLE_DUPLICATE');
  if (rows.some(({ qcStatus }) => qcStatus !== 'ELIGIBLE')) throw new Error('PRIMARY_NOT_ELIGIBLE');
  if (rows.some(({ sampleArtifactHash }) => !/^[a-f0-9]{64}$/u.test(sampleArtifactHash))) throw new Error('PRIMARY_HASH_INVALID');
  if (ids.some((id) => quarantineIds.has(id))) throw new Error('QUARANTINE_INCLUDED');
  const sampleIds = [...ids].sort();
  return { sampleIds, digest: createHash('sha256').update(JSON.stringify(sampleIds)).digest('hex') };
}

export function batchIdentityHash(identity: DatasetBatchIdentity): string {
  return createHash('sha256').update(JSON.stringify(identity, Object.keys(identity).sort())).digest('hex');
}

export function isReusableSuccess(value: unknown, expectedIdentityHash: string): boolean {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return record.status === 'COMPLETED'
    && record.cacheIdentityHash === expectedIdentityHash
    && record.complete === true;
}
