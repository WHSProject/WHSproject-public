import { createHash, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import type { Readable } from 'node:stream';

import { parse as parseSri, type IntegrityMap } from 'ssri';

import { ScannerErrorCode } from '../../domain/scanner-error-code';
import type { IntegrityResult, TarballSource } from '../artifact.types';
import { ArtifactStorageError } from '../storage/artifact-storage.error';
import { IntegrityVerificationError } from './integrity-verification.error';

const SUPPORTED_ALGORITHMS = ['sha512', 'sha384', 'sha256'] as const;
type SriAlgorithm = (typeof SUPPORTED_ALGORITHMS)[number];

interface ParsedIntegrity {
  canonical: string;
  strongestAlgorithm: SriAlgorithm;
  tokens: Readonly<Record<SriAlgorithm, readonly Buffer[]>>;
}

export interface IntegrityVerificationInput {
  expectedIntegrity?: string | null;
  registryIntegrity?: string | null;
}

export interface PreparedIntegrityVerification {
  expectedIntegrity?: string;
  registryIntegrity?: string;
  requiredAlgorithms: readonly SriAlgorithm[];
  parsedExpected?: ParsedIntegrity;
  parsedRegistry?: ParsedIntegrity;
}

export interface StreamingIntegrityVerification {
  update(chunk: Uint8Array): void;
  finish(): IntegrityResult;
}

export function prepareIntegrityVerification(
  input: IntegrityVerificationInput,
): PreparedIntegrityVerification {
  const expectedIntegrity = normalizeOptionalIntegrity(
    input.expectedIntegrity,
    'Expected integrity',
  );
  const registryIntegrity = normalizeOptionalIntegrity(
    input.registryIntegrity,
    'Registry integrity',
  );

  if (expectedIntegrity === undefined && registryIntegrity === undefined) {
    throw new IntegrityVerificationError(
      ScannerErrorCode.INVALID_INPUT,
      'Expected or Registry integrity is required',
    );
  }

  const parsedExpected =
    expectedIntegrity === undefined
      ? undefined
      : parseSupportedIntegrity(expectedIntegrity, 'Expected integrity');
  const parsedRegistry =
    registryIntegrity === undefined
      ? undefined
      : parseSupportedIntegrity(registryIntegrity, 'Registry integrity');

  if (parsedExpected !== undefined && parsedRegistry !== undefined) {
    assertSharedDigestsMatch(parsedExpected, parsedRegistry);
  }

  const requiredAlgorithms = new Set<SriAlgorithm>(['sha256', 'sha512']);
  if (parsedExpected !== undefined) {
    requiredAlgorithms.add(parsedExpected.strongestAlgorithm);
  }
  if (parsedRegistry !== undefined) {
    requiredAlgorithms.add(parsedRegistry.strongestAlgorithm);
  }

  return {
    ...(parsedExpected === undefined
      ? {}
      : {
          expectedIntegrity: parsedExpected.canonical,
          parsedExpected,
        }),
    ...(parsedRegistry === undefined
      ? {}
      : {
          registryIntegrity: parsedRegistry.canonical,
          parsedRegistry,
        }),
    requiredAlgorithms: SUPPORTED_ALGORITHMS.filter((algorithm) =>
      requiredAlgorithms.has(algorithm),
    ),
  };
}

export async function verifyArtifactStream(
  stream: Readable,
  prepared: PreparedIntegrityVerification,
  signal?: AbortSignal,
): Promise<IntegrityResult> {
  const verification = createStreamingIntegrityVerification(prepared);

  try {
    for await (const chunk of stream) {
      if (signal?.aborted === true) {
        stream.destroy();
        throw signal.reason;
      }
      verification.update(chunk);
    }
  } catch (error) {
    if (signal?.aborted === true) {
      throw error;
    }
    throw new ArtifactStorageError('Unable to read downloaded artifact');
  }

  return verification.finish();
}

export function createStreamingIntegrityVerification(
  prepared: PreparedIntegrityVerification,
): StreamingIntegrityVerification {
  const hashes = new Map(
    prepared.requiredAlgorithms.map(
      (algorithm) => [algorithm, createHash(algorithm)] as const,
    ),
  );
  let finished = false;

  return {
    update(chunk: Uint8Array): void {
      if (finished) {
        throw new ArtifactStorageError(
          'Artifact digest calculation is already finalized',
        );
      }

      for (const hash of hashes.values()) {
        hash.update(chunk);
      }
    },
    finish(): IntegrityResult {
      if (finished) {
        throw new ArtifactStorageError(
          'Artifact digest calculation is already finalized',
        );
      }
      finished = true;

      const digests = new Map<SriAlgorithm, Buffer>();
      for (const [algorithm, hash] of hashes) {
        digests.set(algorithm, hash.digest());
      }

      return verifyCalculatedDigests(prepared, digests);
    },
  };
}

function verifyCalculatedDigests(
  prepared: PreparedIntegrityVerification,
  digests: ReadonlyMap<SriAlgorithm, Buffer>,
): IntegrityResult {
  assertArtifactMatches(prepared.parsedExpected, digests, 'Expected integrity');
  assertArtifactMatches(prepared.parsedRegistry, digests, 'Registry integrity');

  const sha256 = requireDigest(digests, 'sha256');
  const sha512 = requireDigest(digests, 'sha512');

  return {
    verified: true,
    calculatedIntegrity: `sha512-${sha512.toString('base64')}`,
    sha256: sha256.toString('hex'),
    ...(prepared.expectedIntegrity === undefined
      ? {}
      : { expectedIntegrity: prepared.expectedIntegrity }),
    ...(prepared.registryIntegrity === undefined
      ? {}
      : { registryIntegrity: prepared.registryIntegrity }),
  };
}

export function verifyArtifactFile(
  artifactPath: string,
  prepared: PreparedIntegrityVerification,
  signal?: AbortSignal,
): Promise<IntegrityResult> {
  return verifyArtifactStream(createReadStream(artifactPath), prepared, signal);
}

export class IntegrityVerifier {
  prepare(input: IntegrityVerificationInput): PreparedIntegrityVerification {
    return prepareIntegrityVerification(input);
  }

  createStreamingVerification(
    prepared: PreparedIntegrityVerification,
  ): StreamingIntegrityVerification {
    return createStreamingIntegrityVerification(prepared);
  }

  async verify(
    artifactPath: string,
    source: Pick<TarballSource, 'registryIntegrity' | 'expectedIntegrity'>,
  ): Promise<IntegrityResult> {
    return verifyArtifactFile(
      artifactPath,
      prepareIntegrityVerification(source),
    );
  }

  verifyPrepared(
    artifactPath: string,
    prepared: PreparedIntegrityVerification,
    signal?: AbortSignal,
  ): Promise<IntegrityResult> {
    return verifyArtifactFile(artifactPath, prepared, signal);
  }
}

function normalizeOptionalIntegrity(
  value: string | null | undefined,
  label: string,
): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  const normalized = value.trim();
  if (normalized.length === 0) {
    throw integrityMismatch(`${label} is not valid SRI`);
  }

  return normalized;
}

function parseSupportedIntegrity(value: string, label: string): ParsedIntegrity {
  let parsed: IntegrityMap | undefined;
  try {
    parsed = parseSri(value, { strict: true }) ?? undefined;
  } catch {
    throw integrityMismatch(`${label} is not valid SRI`);
  }

  if (parsed === undefined || typeof parsed.pickAlgorithm !== 'function') {
    throw integrityMismatch(`${label} has no supported SRI token`);
  }

  const strongestAlgorithm = parsed.pickAlgorithm();
  if (!isSupportedAlgorithm(strongestAlgorithm)) {
    throw integrityMismatch(`${label} has no supported SRI token`);
  }

  const tokens = {
    sha256: parseAlgorithmDigests(parsed, 'sha256', label),
    sha384: parseAlgorithmDigests(parsed, 'sha384', label),
    sha512: parseAlgorithmDigests(parsed, 'sha512', label),
  };

  if (tokens[strongestAlgorithm].length === 0) {
    throw integrityMismatch(`${label} has no supported SRI token`);
  }

  return {
    canonical: parsed.toString({ strict: true }),
    strongestAlgorithm,
    tokens,
  };
}

function parseAlgorithmDigests(
  parsed: IntegrityMap,
  algorithm: SriAlgorithm,
  label: string,
): readonly Buffer[] {
  const expectedLength = { sha256: 32, sha384: 48, sha512: 64 }[algorithm];
  const hashes = parsed[algorithm] ?? [];

  return Object.freeze(
    hashes.map((hash) => {
      const digest = Buffer.from(hash.digest, 'base64');
      const normalizedDigest = hash.digest.replace(/=+$/u, '');
      const encodedDigest = digest.toString('base64').replace(/=+$/u, '');

      if (
        digest.length !== expectedLength ||
        normalizedDigest !== encodedDigest
      ) {
        throw integrityMismatch(`${label} contains an invalid digest`);
      }

      return digest;
    }),
  );
}

function assertSharedDigestsMatch(
  expected: ParsedIntegrity,
  registry: ParsedIntegrity,
): void {
  for (const algorithm of SUPPORTED_ALGORITHMS) {
    const expectedDigests = expected.tokens[algorithm];
    const registryDigests = registry.tokens[algorithm];
    if (
      expectedDigests.length > 0 &&
      registryDigests.length > 0 &&
      !containsMatchingDigest(expectedDigests, registryDigests)
    ) {
      throw integrityMismatch(
        `Expected and Registry ${algorithm} digests do not match`,
      );
    }
  }
}

function assertArtifactMatches(
  parsed: ParsedIntegrity | undefined,
  digests: ReadonlyMap<SriAlgorithm, Buffer>,
  label: string,
): void {
  if (parsed === undefined) {
    return;
  }

  const actual = requireDigest(digests, parsed.strongestAlgorithm);
  const expected = parsed.tokens[parsed.strongestAlgorithm];
  if (!containsMatchingDigest([actual], expected)) {
    throw integrityMismatch(`${label} does not match the Artifact`);
  }
}

function containsMatchingDigest(
  left: readonly Buffer[],
  right: readonly Buffer[],
): boolean {
  let matches = 0;
  for (const leftDigest of left) {
    for (const rightDigest of right) {
      if (leftDigest.length === rightDigest.length) {
        matches |= Number(timingSafeEqual(leftDigest, rightDigest));
      }
    }
  }
  return matches !== 0;
}

function requireDigest(
  digests: ReadonlyMap<SriAlgorithm, Buffer>,
  algorithm: SriAlgorithm,
): Buffer {
  const digest = digests.get(algorithm);
  if (digest === undefined) {
    throw new ArtifactStorageError('Required Artifact digest was not calculated');
  }
  return digest;
}

function isSupportedAlgorithm(value: string): value is SriAlgorithm {
  return SUPPORTED_ALGORITHMS.some((algorithm) => algorithm === value);
}

function integrityMismatch(message: string): IntegrityVerificationError {
  return new IntegrityVerificationError(
    ScannerErrorCode.INTEGRITY_MISMATCH,
    message,
  );
}
