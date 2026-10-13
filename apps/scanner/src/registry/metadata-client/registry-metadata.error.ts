import { ScannerErrorCode } from '../../domain/scanner-error-code';

export class InvalidRegistryMetadataInputError extends Error {
  readonly code = ScannerErrorCode.INVALID_INPUT;
  readonly retryable = false;

  constructor(message: string) {
    super(message);
    this.name = 'InvalidRegistryMetadataInputError';
  }
}

export class InvalidRegistryMetadataResponseError extends Error {
  readonly code = ScannerErrorCode.METADATA_FETCH_FAILED;
  readonly retryable = false;

  constructor(message: string) {
    super(message);
    this.name = 'InvalidRegistryMetadataResponseError';
  }
}

export class RegistryMetadataFetchError extends Error {
  readonly code = ScannerErrorCode.METADATA_FETCH_FAILED;

  constructor(
    message: string,
    readonly retryable: boolean,
    readonly statusCode?: number,
  ) {
    super(message);
    this.name = 'RegistryMetadataFetchError';
  }
}

export class RegistryMetadataInternalError extends Error {
  readonly code = ScannerErrorCode.INTERNAL_ERROR;
  readonly retryable = false;

  constructor() {
    super('Unexpected internal error while fetching Registry metadata');
    this.name = 'RegistryMetadataInternalError';
  }
}
