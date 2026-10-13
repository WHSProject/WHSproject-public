import { parse as parseSri } from 'ssri';

import { InvalidRegistryMetadataResponseError } from './registry-metadata.error';
import type {
  RegistryMetadataInput,
  RegistryMetadataResult,
} from './registry-metadata.types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(message: string): never {
  throw new InvalidRegistryMetadataResponseError(message);
}

function validateTarballUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    fail('dist.tarball must be a non-empty string');
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    fail('dist.tarball must be an absolute URL');
  }

  if (url.protocol !== 'https:') {
    fail('dist.tarball must use HTTPS');
  }

  if (url.username.length > 0 || url.password.length > 0) {
    fail('dist.tarball must not contain credentials');
  }

  return value;
}

function validateRegistryIntegrity(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'string' || value.length === 0) {
    fail('dist.integrity must be a non-empty string when present');
  }

  try {
    const parsed: unknown = parseSri(value, { strict: true });
    const hasDigest =
      isRecord(parsed) &&
      Object.values(parsed).some(
        (digests) => Array.isArray(digests) && digests.length > 0,
      );

    if (!hasDigest) {
      fail('dist.integrity must contain at least one valid SRI digest');
    }
  } catch (error) {
    if (error instanceof InvalidRegistryMetadataResponseError) {
      throw error;
    }

    fail('dist.integrity is not valid SRI');
  }

  return value;
}

export function validateRegistryMetadataResponse(
  input: RegistryMetadataInput,
  metadataUrl: string,
  value: unknown,
): RegistryMetadataResult {
  if (!isRecord(value)) {
    fail('Registry metadata must be a JSON object');
  }

  if (value.name !== input.packageName) {
    fail('Registry metadata name does not match the requested package');
  }

  if (value.version !== input.packageVersion) {
    fail('Registry metadata version does not match the requested version');
  }

  if (!isRecord(value.dist)) {
    fail('Registry metadata dist must be an object');
  }

  const tarballUrl = validateTarballUrl(value.dist.tarball);
  const registryIntegrity = validateRegistryIntegrity(value.dist.integrity);

  return {
    registryId: input.registryId,
    metadataUrl,
    tarballUrl,
    ...(registryIntegrity === undefined ? {} : { registryIntegrity }),
    registryMetadata: value,
  };
}
