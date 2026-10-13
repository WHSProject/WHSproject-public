import {
  ScannerErrorCode,
  ScannerErrorStage,
} from '../../domain/scanner-error-code';

type IntegrityErrorCode =
  | typeof ScannerErrorCode.INVALID_INPUT
  | typeof ScannerErrorCode.INTEGRITY_MISMATCH;

export class IntegrityVerificationError extends Error {
  readonly stage = ScannerErrorStage.INTEGRITY_VERIFICATION;
  readonly retryable = false;

  constructor(
    readonly code: IntegrityErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'IntegrityVerificationError';
  }
}
