import type { NpmjsRegistryId } from '../registry-config/registry-config';

export interface RegistryMetadataInput {
  registryId: NpmjsRegistryId;
  packageName: string;
  packageVersion: string;
}

export interface RegistryMetadataResult {
  registryId: NpmjsRegistryId;
  metadataUrl: string;
  tarballUrl: string;
  registryIntegrity?: string;
  registryMetadata: Record<string, unknown>;
}
