import type { DownloadedArtifact } from '../../artifact/artifact.types';
import { TarballDownloadError } from '../../artifact/downloader/tarball-download.error';
import { TarballDownloader } from '../../artifact/downloader/tarball-downloader';
import { IntegrityVerificationError } from '../../artifact/integrity/integrity-verification.error';
import { ScannerErrorCode } from '../../domain/scanner-error-code';
import { RegistryMetadataClient } from '../../registry/metadata-client/registry-metadata-client';
import { RegistryMetadataFetchError } from '../../registry/metadata-client/registry-metadata.error';
import type { RegistryMetadataResult } from '../../registry/metadata-client/registry-metadata.types';
import { TarballAcquisitionService } from './tarball-acquisition.service';
import type { TarballAcquisitionInput } from './tarball-acquisition.types';

describe('TarballAcquisitionService', () => {
  let query: jest.MockedFunction<RegistryMetadataClient['query']>;
  let download: jest.MockedFunction<TarballDownloader['download']>;
  let service: TarballAcquisitionService;

  beforeEach(() => {
    query = jest.fn();
    download = jest.fn();
    service = new TarballAcquisitionService(
      { query } as unknown as RegistryMetadataClient,
      { download } as unknown as TarballDownloader,
    );
  });

  it('maps a successful Metadata result to the Downloader input', async () => {
    const metadata = createMetadata();
    const artifact = createArtifact();
    query.mockResolvedValue(metadata);
    download.mockResolvedValue(artifact);

    await service.acquire(createInput());

    expect(download).toHaveBeenCalledWith({
      registryId: 'npmjs',
      scanId: 'scan-123',
      tarballUrl: metadata.tarballUrl,
      expectedIntegrity: 'sha512-expected',
      registryIntegrity: 'sha512-registry',
    });
  });

  it('passes an unscoped package to the Metadata Client', async () => {
    arrangeSuccess(query, download);

    await service.acquire(createInput({ packageName: 'lodash' }));

    expect(query).toHaveBeenCalledWith({
      registryId: 'npmjs',
      packageName: 'lodash',
      packageVersion: '1.0.0',
    });
  });

  it('passes a scoped package to the Metadata Client without rewriting it', async () => {
    arrangeSuccess(query, download);

    await service.acquire(createInput({ packageName: '@scope/example' }));

    expect(query).toHaveBeenCalledWith({
      registryId: 'npmjs',
      packageName: '@scope/example',
      packageVersion: '1.0.0',
    });
  });

  it('passes only expectedIntegrity when Registry Integrity is absent', async () => {
    query.mockResolvedValue(createMetadata({ registryIntegrity: undefined }));
    download.mockResolvedValue(createArtifact());

    await service.acquire(createInput());

    const downloadInput = getDownloadInput(download);
    expect(downloadInput).toMatchObject({ expectedIntegrity: 'sha512-expected' });
    expect(downloadInput).not.toHaveProperty('registryIntegrity');
  });

  it('passes only registryIntegrity when expectedIntegrity is absent', async () => {
    arrangeSuccess(query, download);

    await service.acquire(createInput({ expectedIntegrity: undefined }));

    const downloadInput = getDownloadInput(download);
    expect(downloadInput).not.toHaveProperty('expectedIntegrity');
    expect(downloadInput).toMatchObject({
      registryIntegrity: 'sha512-registry',
    });
  });

  it('passes both Integrity values when both are present', async () => {
    arrangeSuccess(query, download);

    await service.acquire(createInput());

    expect(getDownloadInput(download)).toMatchObject({
      expectedIntegrity: 'sha512-expected',
      registryIntegrity: 'sha512-registry',
    });
  });

  it('omits both optional fields and delegates the final check to the Downloader', async () => {
    query.mockResolvedValue(createMetadata({ registryIntegrity: undefined }));
    download.mockResolvedValue(createArtifact());

    await service.acquire(createInput({ expectedIntegrity: undefined }));

    const downloadInput = getDownloadInput(download);
    expect(downloadInput).not.toHaveProperty('expectedIntegrity');
    expect(downloadInput).not.toHaveProperty('registryIntegrity');
  });

  it('passes scanId unchanged to the Downloader', async () => {
    arrangeSuccess(query, download);

    await service.acquire(createInput({ scanId: 'internal-scan-id' }));

    expect(getDownloadInput(download)).toMatchObject({
      scanId: 'internal-scan-id',
    });
  });

  it('passes the Metadata tarballUrl unchanged to the Downloader', async () => {
    const tarballUrl =
      'https://registry.npmjs.org/pkg/-/pkg-1.0.0.tgz?source=metadata';
    query.mockResolvedValue(createMetadata({ tarballUrl }));
    download.mockResolvedValue(createArtifact());

    await service.acquire(createInput());

    expect(getDownloadInput(download)).toMatchObject({ tarballUrl });
  });

  it('does not call the Downloader when Metadata lookup fails', async () => {
    const failure = new RegistryMetadataFetchError(
      'Registry metadata request failed with HTTP 500',
      true,
      500,
    );
    query.mockRejectedValue(failure);

    await expect(service.acquire(createInput())).rejects.toBe(failure);
    expect(download).not.toHaveBeenCalled();
  });

  it('preserves a Downloader error code, stage, retryable value, and identity', async () => {
    const failure = new TarballDownloadError(
      'Tarball request failed with HTTP 500',
      true,
    );
    query.mockResolvedValue(createMetadata());
    download.mockRejectedValue(failure);

    await expect(service.acquire(createInput())).rejects.toBe(failure);
    expect(failure).toMatchObject({
      code: ScannerErrorCode.DOWNLOAD_FAILED,
      stage: 'TARBALL_DOWNLOAD',
      retryable: true,
    });
  });

  it('does not replace an Integrity mismatch with another error', async () => {
    const failure = new IntegrityVerificationError(
      ScannerErrorCode.INTEGRITY_MISMATCH,
      'Artifact does not match required Integrity',
    );
    query.mockResolvedValue(createMetadata());
    download.mockRejectedValue(failure);

    await expect(service.acquire(createInput())).rejects.toBe(failure);
    expect(failure).toMatchObject({
      code: ScannerErrorCode.INTEGRITY_MISMATCH,
      stage: 'INTEGRITY_VERIFICATION',
      retryable: false,
    });
  });

  it('returns the original Metadata and DownloadedArtifact results', async () => {
    const metadata = createMetadata();
    const artifact = createArtifact();
    query.mockResolvedValue(metadata);
    download.mockResolvedValue(artifact);

    await expect(service.acquire(createInput())).resolves.toEqual({
      registryMetadata: metadata,
      artifact,
    });
  });

  it('returns only the finalized artifact path and never adds a part path', async () => {
    arrangeSuccess(query, download);

    const result = await service.acquire(createInput());

    expect(result.artifact.artifactPath).toBe(
      '/tmp/scanner/scan-123/artifact.tgz',
    );
    expect(JSON.stringify(result)).not.toContain('artifact.tgz.part');
  });

  it('calls the Metadata Client and Downloader exactly once', async () => {
    arrangeSuccess(query, download);

    await service.acquire(createInput());

    expect(query).toHaveBeenCalledTimes(1);
    expect(download).toHaveBeenCalledTimes(1);
  });

  it('maps an unexpected coordination error to a safe internal error', async () => {
    query.mockRejectedValue(
      Object.assign(new Error('sensitive unexpected details'), {
        code: 'UNRECOGNIZED_ERROR',
        retryable: true,
      }),
    );

    const promise = service.acquire(createInput());

    await expect(promise).rejects.toMatchObject({
      code: ScannerErrorCode.INTERNAL_ERROR,
      retryable: false,
    });
    await expect(promise).rejects.not.toThrow('sensitive unexpected details');
  });
});

function createInput(
  overrides: Partial<TarballAcquisitionInput> = {},
): TarballAcquisitionInput {
  return {
    registryId: 'npmjs',
    packageName: 'example',
    packageVersion: '1.0.0',
    expectedIntegrity: 'sha512-expected',
    scanId: 'scan-123',
    ...overrides,
  };
}

function createMetadata(
  overrides: Partial<RegistryMetadataResult> = {},
): RegistryMetadataResult {
  return {
    registryId: 'npmjs',
    metadataUrl: 'https://registry.npmjs.org/example/1.0.0',
    tarballUrl: 'https://registry.npmjs.org/example/-/example-1.0.0.tgz',
    registryIntegrity: 'sha512-registry',
    registryMetadata: {
      name: 'example',
      version: '1.0.0',
      dist: {
        tarball:
          'https://registry.npmjs.org/example/-/example-1.0.0.tgz',
      },
    },
    ...overrides,
  };
}

function createArtifact(): DownloadedArtifact {
  return {
    artifactPath: '/tmp/scanner/scan-123/artifact.tgz',
    finalUrl: 'https://registry.npmjs.org/example/-/example-1.0.0.tgz',
    receivedBytes: 1024,
    calculatedIntegrity: 'sha512-calculated',
    sha256: 'a'.repeat(64),
  };
}

function arrangeSuccess(
  query: jest.MockedFunction<RegistryMetadataClient['query']>,
  download: jest.MockedFunction<TarballDownloader['download']>,
): void {
  query.mockResolvedValue(createMetadata());
  download.mockResolvedValue(createArtifact());
}

function getDownloadInput(
  download: jest.MockedFunction<TarballDownloader['download']>,
) {
  const call = download.mock.calls[0];
  if (call === undefined) {
    throw new Error('Expected Downloader to have been called');
  }

  return call[0];
}
