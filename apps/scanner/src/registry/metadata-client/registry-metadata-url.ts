import { resolveRegistryConfig } from '../registry-config/registry-config';
import type { RegistryMetadataInput } from './registry-metadata.types';

export function buildRegistryMetadataUrl(
  input: RegistryMetadataInput,
): string {
  const registry = resolveRegistryConfig(input.registryId);
  const baseUrl = registry.baseUrl.replace(/\/+$/, '');
  const encodedPackageName = encodeURIComponent(input.packageName);
  const encodedPackageVersion = encodeURIComponent(input.packageVersion);

  return `${baseUrl}/${encodedPackageName}/${encodedPackageVersion}`;
}
