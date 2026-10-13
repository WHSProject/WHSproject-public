import { valid as validSemver } from 'semver';
import validateNpmPackageName = require('validate-npm-package-name');

import { resolveRegistryConfig } from '../registry-config/registry-config';
import { InvalidRegistryMetadataInputError } from './registry-metadata.error';
import type { RegistryMetadataInput } from './registry-metadata.types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireNonBlankUntrimmedString(
  value: unknown,
  fieldName: string,
): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.trim() !== value
  ) {
    throw new InvalidRegistryMetadataInputError(
      `${fieldName} must be a non-empty string without surrounding whitespace`,
    );
  }

  return value;
}

export function validateRegistryMetadataInput(
  value: unknown,
): RegistryMetadataInput {
  if (!isRecord(value)) {
    throw new InvalidRegistryMetadataInputError('Input must be an object');
  }

  const registryId = requireNonBlankUntrimmedString(
    value.registryId,
    'registryId',
  );
  const registry = resolveRegistryConfig(registryId);
  const packageName = requireNonBlankUntrimmedString(
    value.packageName,
    'packageName',
  );
  const packageVersion = requireNonBlankUntrimmedString(
    value.packageVersion,
    'packageVersion',
  );

  if (!validateNpmPackageName(packageName).validForNewPackages) {
    throw new InvalidRegistryMetadataInputError(
      'packageName is not a valid npm package name',
    );
  }

  if (validSemver(packageVersion) !== packageVersion) {
    throw new InvalidRegistryMetadataInputError(
      'packageVersion must be an exact semantic version',
    );
  }

  return {
    registryId: registry.id,
    packageName,
    packageVersion,
  };
}
