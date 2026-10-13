import {
  ScannerErrorCode,
  ScannerErrorStage,
} from '../../domain/scanner-error-code';

export class TarballDownloadError extends Error {
  readonly code = ScannerErrorCode.DOWNLOAD_FAILED;
  readonly stage = ScannerErrorStage.TARBALL_DOWNLOAD;

  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'TarballDownloadError';
  }
}

export class TarballConnectTimeoutError extends Error {
  readonly code = 'ETIMEDOUT';

  constructor() {
    super('Tarball connection timed out');
    this.name = 'TarballConnectTimeoutError';
  }
}

export class TarballNetworkError extends Error {
  readonly code: string | undefined;

  constructor(cause: unknown) {
    super('Tarball network request failed', { cause });
    this.name = 'TarballNetworkError';
    this.code =
      typeof cause === 'object' && cause !== null && 'code' in cause
        ? String(cause.code)
        : undefined;
  }
}
