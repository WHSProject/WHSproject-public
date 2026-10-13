import {
  ScannerErrorCode,
  ScannerErrorStage,
} from '../../domain/scanner-error-code';

export class ArtifactStorageError extends Error {
  readonly code = ScannerErrorCode.INTERNAL_ERROR;
  readonly stage = ScannerErrorStage.ARTIFACT_STORAGE;
  readonly retryable = false;

  constructor(message: string) {
    super(message);
    this.name = 'ArtifactStorageError';
  }
}
