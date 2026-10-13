import type { ScannerErrorCode } from '../domain/scanner-error-code';
import type { RegistryMetadataResult } from '../registry/metadata-client/registry-metadata.types';

export class ArtifactProcessingError extends Error {
  constructor(
    readonly code: ScannerErrorCode,
    readonly stage: 'DOWNLOAD' | 'INTEGRITY' | 'HASH' | 'EXTRACT' | 'IDENTITY',
    message: string,
  ) {
    super(message);
    this.name = 'ArtifactProcessingError';
  }
}

export type TarballSource = Pick<RegistryMetadataResult, 'tarballUrl' | 'registryIntegrity'> & {
  scanId: string;
  expectedIntegrity?: string | null;
};

export interface TarballDownloadInput {
  registryId: 'npmjs';
  scanId: string;
  tarballUrl: string;
  expectedIntegrity?: string;
  registryIntegrity?: string;
}

export interface DownloadedArtifact {
  artifactPath: string;
  finalUrl: string;
  receivedBytes: number;
  calculatedIntegrity: string;
  sha256: string;
}

export interface DownloadOptions {
  tempDir?: string;
  maxTarballBytes?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxRedirects?: number;
  validateRedirectUrl?: (url: URL, fromUrl: URL) => boolean | Promise<boolean>;
}

export interface DownloadResult {
  scanId: string;
  artifactPath: string;
  bytes: number;
  scanDir: string;
}

export interface IntegrityResult {
  verified: true;
  sha256: string;
  calculatedIntegrity: string;
  registryIntegrity?: string;
  expectedIntegrity?: string;
}

export interface ExtractOptions {
  artifactPath: string;
  extractedPath: string;
  integrity: Pick<IntegrityResult, 'verified'>;
  maxExtractedBytes?: number;
  maxExtractedFiles?: number;
  maxPathDepth?: number;
}

export interface ExtractResult {
  extractedPath: string;
  files: number;
  bytes: number;
}
