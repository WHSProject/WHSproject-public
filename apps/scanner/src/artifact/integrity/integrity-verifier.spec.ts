import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { IntegrityVerificationError } from './integrity-verification.error';
import {
  prepareIntegrityVerification,
  verifyArtifactFile,
  verifyArtifactStream,
} from './integrity-verifier';

const payload = Buffer.from('verified artifact payload');
const otherPayload = Buffer.from('different artifact payload');

describe('Integrity verification preparation', () => {
  it('accepts Expected Integrity only', () => {
    const expectedIntegrity = sri(payload, 'sha512');

    expect(prepareIntegrityVerification({ expectedIntegrity })).toMatchObject({
      expectedIntegrity,
      requiredAlgorithms: ['sha512', 'sha256'],
    });
  });

  it('accepts Registry Integrity only', () => {
    const registryIntegrity = sri(payload, 'sha512');

    expect(prepareIntegrityVerification({ registryIntegrity })).toMatchObject({
      registryIntegrity,
      requiredAlgorithms: ['sha512', 'sha256'],
    });
  });

  it('accepts matching Expected and Registry Integrity', () => {
    const integrity = sri(payload, 'sha512');

    expect(
      prepareIntegrityVerification({
        expectedIntegrity: `  ${integrity}  `,
        registryIntegrity: integrity,
      }),
    ).toMatchObject({
      expectedIntegrity: integrity,
      registryIntegrity: integrity,
    });
  });

  it('rejects missing Integrity before download', () => {
    expectIntegrityFailure(
      () => prepareIntegrityVerification({}),
      'INVALID_INPUT',
    );
  });

  it('rejects a shared algorithm digest mismatch', () => {
    expectIntegrityFailure(
      () =>
        prepareIntegrityVerification({
          expectedIntegrity: sri(payload, 'sha512'),
          registryIntegrity: sri(otherPayload, 'sha512'),
        }),
      'INTEGRITY_MISMATCH',
    );
  });

  it('allows valid SRI values with no common algorithm', () => {
    expect(
      prepareIntegrityVerification({
        expectedIntegrity: sri(payload, 'sha256'),
        registryIntegrity: sri(payload, 'sha512'),
      }).requiredAlgorithms,
    ).toEqual(['sha512', 'sha256']);
  });

  it.each([
    ['invalid SRI', 'not-sri'],
    ['unsupported algorithm', `md5-${digest(payload, 'md5')}`],
    ['empty SRI', '   '],
  ])('rejects %s', (_caseName, expectedIntegrity) => {
    expectIntegrityFailure(
      () => prepareIntegrityVerification({ expectedIntegrity }),
      'INTEGRITY_MISMATCH',
    );
  });

  it('uses the strongest supported token in multi-token SRI', () => {
    const expectedIntegrity = [
      sri(otherPayload, 'sha256'),
      sri(payload, 'sha512'),
    ].join(' ');

    expect(
      prepareIntegrityVerification({ expectedIntegrity }),
    ).toMatchObject({
      requiredAlgorithms: ['sha512', 'sha256'],
    });
  });

  it('accepts overlapping digests among same-algorithm multi-token SRI', () => {
    const matching = sri(payload, 'sha512');

    expect(() =>
      prepareIntegrityVerification({
        expectedIntegrity: `${sri(otherPayload, 'sha512')} ${matching}`,
        registryIntegrity: matching,
      }),
    ).not.toThrow();
  });
});

describe('Artifact byte verification', () => {
  it('verifies chunked stream data without buffering the whole stream', async () => {
    const prepared = prepareIntegrityVerification({
      expectedIntegrity: sri(payload, 'sha256'),
      registryIntegrity: sri(payload, 'sha512'),
    });
    const chunks = [payload.subarray(0, 4), payload.subarray(4, 12), payload.subarray(12)];

    const result = await verifyArtifactStream(Readable.from(chunks), prepared);

    expect(result).toEqual({
      verified: true,
      expectedIntegrity: sri(payload, 'sha256'),
      registryIntegrity: sri(payload, 'sha512'),
      calculatedIntegrity: sri(payload, 'sha512'),
      sha256: digest(payload, 'sha256', 'hex'),
    });
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('calculates SHA-384 in the same stream pass when required', async () => {
    const prepared = prepareIntegrityVerification({
      expectedIntegrity: sri(payload, 'sha384'),
    });

    expect(prepared.requiredAlgorithms).toEqual(['sha512', 'sha384', 'sha256']);
    await expect(
      verifyArtifactStream(Readable.from([payload]), prepared),
    ).resolves.toMatchObject({ verified: true });
  });

  it('uses the strongest valid digest from multi-token SRI', async () => {
    const prepared = prepareIntegrityVerification({
      expectedIntegrity: `${sri(otherPayload, 'sha256')} ${sri(payload, 'sha512')}`,
    });

    await expect(
      verifyArtifactStream(Readable.from([payload]), prepared),
    ).resolves.toMatchObject({
      verified: true,
      calculatedIntegrity: sri(payload, 'sha512'),
    });
  });

  it('requires Expected and Registry Integrity to each match the Artifact', async () => {
    const prepared = prepareIntegrityVerification({
      expectedIntegrity: sri(payload, 'sha256'),
      registryIntegrity: sri(otherPayload, 'sha512'),
    });

    await expect(
      verifyArtifactStream(Readable.from([payload]), prepared),
    ).rejects.toMatchObject({
      code: 'INTEGRITY_MISMATCH',
      stage: 'INTEGRITY_VERIFICATION',
      retryable: false,
    });
  });

  it('verifies an Artifact file through a read stream', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'scanner-integrity-'));
    const artifactPath = join(directory, 'artifact.tgz.part');

    try {
      await writeFile(artifactPath, payload);
      const result = await verifyArtifactFile(
        artifactPath,
        prepareIntegrityVerification({
          registryIntegrity: sri(payload, 'sha512'),
        }),
      );

      expect(result.calculatedIntegrity).toBe(sri(payload, 'sha512'));
      expect(result.sha256).toBe(digest(payload, 'sha256', 'hex'));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

type HashAlgorithm = 'md5' | 'sha256' | 'sha384' | 'sha512';

function sri(value: Buffer, algorithm: Exclude<HashAlgorithm, 'md5'>): string {
  return `${algorithm}-${digest(value, algorithm)}`;
}

function digest(
  value: Buffer,
  algorithm: HashAlgorithm,
  encoding: 'base64' | 'hex' = 'base64',
): string {
  return createHash(algorithm).update(value).digest(encoding);
}

function expectIntegrityFailure(
  action: () => unknown,
  code: 'INVALID_INPUT' | 'INTEGRITY_MISMATCH',
): void {
  try {
    action();
    throw new Error('Expected Integrity validation to fail');
  } catch (error) {
    expect(error).toBeInstanceOf(IntegrityVerificationError);
    expect(error).toMatchObject({
      code,
      stage: 'INTEGRITY_VERIFICATION',
      retryable: false,
    });
  }
}
