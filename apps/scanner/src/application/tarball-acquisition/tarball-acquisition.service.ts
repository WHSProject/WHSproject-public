import { Injectable } from '@nestjs/common';

import { TarballDownloader } from '../../artifact/downloader/tarball-downloader';
import type { TarballDownloadInput } from '../../artifact/artifact.types';
import { ScannerErrorCode } from '../../domain/scanner-error-code';
import { RegistryMetadataClient } from '../../registry/metadata-client/registry-metadata-client';
import type {
  TarballAcquisitionInput,
  TarballAcquisitionResult,
} from './tarball-acquisition.types';

interface ScannerOperationalError extends Error {
  code: string;
  retryable: boolean;
}

const SCANNER_ERROR_CODES: ReadonlySet<string> = new Set(
  Object.values(ScannerErrorCode),
);

class TarballAcquisitionInternalError extends Error {
  readonly code = ScannerErrorCode.INTERNAL_ERROR;
  readonly retryable = false;

  constructor() {
    super('Unexpected internal error while acquiring Registry tarball');
    this.name = 'TarballAcquisitionInternalError';
  }
}

function isScannerOperationalError(
  error: unknown,
): error is ScannerOperationalError {
  return (
    error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string' &&
    SCANNER_ERROR_CODES.has(error.code) &&
    'retryable' in error &&
    typeof error.retryable === 'boolean'
  );
}

@Injectable()
export class TarballAcquisitionService {
  constructor(
    private readonly metadataClient: RegistryMetadataClient,
    private readonly downloader: TarballDownloader,
  ) {}

  async acquire(
    input: TarballAcquisitionInput,
  ): Promise<TarballAcquisitionResult> {
    try {
      const registryMetadata = await this.metadataClient.query({
        registryId: input.registryId,
        packageName: input.packageName,
        packageVersion: input.packageVersion,
      });

      const downloadInput: TarballDownloadInput = {
        registryId: registryMetadata.registryId,
        scanId: input.scanId,
        tarballUrl: registryMetadata.tarballUrl,
        ...(input.expectedIntegrity === undefined
          ? {}
          : { expectedIntegrity: input.expectedIntegrity }),
        ...(registryMetadata.registryIntegrity === undefined
          ? {}
          : { registryIntegrity: registryMetadata.registryIntegrity }),
      };
      const artifact = await this.downloader.download(downloadInput);

      return { registryMetadata, artifact };
    } catch (error) {
      if (isScannerOperationalError(error)) {
        throw error;
      }

      throw new TarballAcquisitionInternalError();
    }
  }
}
