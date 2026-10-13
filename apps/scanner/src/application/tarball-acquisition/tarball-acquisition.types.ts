import type { DownloadedArtifact } from '../../artifact/artifact.types';
import type { RegistryMetadataResult } from '../../registry/metadata-client/registry-metadata.types';
import type { NpmjsRegistryId } from '../../registry/registry-config/registry-config';

export interface TarballAcquisitionInput {
  registryId: NpmjsRegistryId;
  packageName: string;
  packageVersion: string;
  expectedIntegrity?: string;
  scanId: string;
}

export interface TarballAcquisitionResult {
  registryMetadata: RegistryMetadataResult;
  artifact: DownloadedArtifact;
}
