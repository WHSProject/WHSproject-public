import { ScannerErrorCode } from '../../domain/scanner-error-code';

export class UnsupportedRegistryError extends Error {
  readonly code = ScannerErrorCode.INVALID_INPUT;
  readonly retryable = false;

  constructor(registryId: string) {
    super(`Registry ID "${registryId}" is not supported`);
    this.name = 'UnsupportedRegistryError';
  }
}
