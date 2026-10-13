import {
  ScannerErrorCode,
  ScannerErrorStage,
} from '../../domain/scanner-error-code';

export class TarballUrlValidationError extends Error {
  readonly code = ScannerErrorCode.DOWNLOAD_FAILED;
  readonly stage = ScannerErrorStage.TARBALL_URL_VALIDATION;
  readonly retryable = false;

  constructor(message: string) {
    super(message);
    this.name = 'TarballUrlValidationError';
  }
}
