import npmRegistryFetch = require('npm-registry-fetch');

import {
  loadScannerEnvironment,
  type ScannerEnvironment,
} from '../../config/scanner-environment';
import { UnsupportedRegistryError } from '../registry-config/unsupported-registry.error';
import {
  InvalidRegistryMetadataInputError,
  InvalidRegistryMetadataResponseError,
  RegistryMetadataFetchError,
  RegistryMetadataInternalError,
} from './registry-metadata.error';
import { validateRegistryMetadataInput } from './registry-metadata-input';
import { validateRegistryMetadataResponse } from './registry-metadata-response';
import type { RegistryMetadataResult } from './registry-metadata.types';
import { buildRegistryMetadataUrl } from './registry-metadata-url';

export interface RegistryMetadataRequestOptions {
  method: 'GET';
  headers: {
    Accept: 'application/json';
  };
  timeout: number;
  fetchRetries: 0;
  signal: AbortSignal;
}

export type RegistryFetch = (
  url: string,
  options: RegistryMetadataRequestOptions,
) => Promise<unknown>;

export interface RegistryMetadataQueryOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

const defaultRegistryFetch: RegistryFetch = (url, options) =>
  npmRegistryFetch(url, options);

const NETWORK_ERROR_CODES = new Set([
  'EADDRINUSE',
  'ECONNECTIONTIMEOUT',
  'ECONNREFUSED',
  'ECONNRESET',
  'ENETDOWN',
  'ENETUNREACH',
  'ENOTFOUND',
  'EPIPE',
  'EHOSTUNREACH',
  'ETIMEDOUT',
]);

const TIMEOUT_ERROR_TYPES = new Set(['body-timeout', 'request-timeout']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  if (
    value === null ||
    (typeof value !== 'object' && typeof value !== 'function')
  ) {
    return false;
  }

  return (
    Symbol.asyncIterator in value &&
    typeof value[Symbol.asyncIterator] === 'function'
  );
}

function destroyBody(value: unknown): void {
  if (isRecord(value) && typeof value.destroy === 'function') {
    value.destroy();
  }
}

function toBuffer(chunk: unknown): Buffer {
  if (typeof chunk === 'string') {
    return Buffer.from(chunk);
  }

  if (chunk instanceof Uint8Array) {
    return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  }

  throw new RegistryMetadataInternalError();
}

async function readLimitedResponseBody(
  response: unknown,
  maximumBytes: number,
): Promise<Buffer> {
  if (!isRecord(response) || !('body' in response)) {
    throw new RegistryMetadataInternalError();
  }

  if (response.body === null) {
    return Buffer.alloc(0);
  }

  if (!isAsyncIterable(response.body)) {
    throw new RegistryMetadataInternalError();
  }

  const chunks: Buffer[] = [];
  let receivedBytes = 0;

  for await (const chunk of response.body) {
    const buffer = toBuffer(chunk);
    receivedBytes += buffer.byteLength;

    if (receivedBytes > maximumBytes) {
      destroyBody(response.body);
      throw new RegistryMetadataFetchError(
        'Registry metadata response exceeded the configured size limit',
        false,
      );
    }

    chunks.push(buffer);
  }

  return Buffer.concat(chunks, receivedBytes);
}

function parseRegistryMetadata(body: Buffer): unknown {
  try {
    const parsed: unknown = JSON.parse(body.toString('utf8'));
    return parsed;
  } catch {
    throw new RegistryMetadataFetchError(
      'Registry metadata response was not valid JSON',
      false,
    );
  }
}

function isKnownScannerError(error: unknown): error is Error {
  return (
    error instanceof InvalidRegistryMetadataInputError ||
    error instanceof InvalidRegistryMetadataResponseError ||
    error instanceof RegistryMetadataFetchError ||
    error instanceof RegistryMetadataInternalError ||
    error instanceof UnsupportedRegistryError
  );
}

function getStringProperty(
  value: unknown,
  propertyName: string,
): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const property = value[propertyName];
  return typeof property === 'string' ? property : undefined;
}

function mapRegistryFetchError(error: unknown): Error {
  if (isKnownScannerError(error)) {
    return error;
  }

  if (isRecord(error) && typeof error.statusCode === 'number') {
    const statusCode = error.statusCode;
    const retryable =
      statusCode === 429 || (statusCode >= 500 && statusCode <= 599);

    return new RegistryMetadataFetchError(
      `Registry metadata request failed with HTTP ${statusCode}`,
      retryable,
      statusCode,
    );
  }

  const errorName = getStringProperty(error, 'name');
  const errorType = getStringProperty(error, 'type');
  const errorCode = getStringProperty(error, 'code');

  if (
    errorName === 'AbortError' ||
    (errorType !== undefined && TIMEOUT_ERROR_TYPES.has(errorType)) ||
    (errorCode !== undefined &&
      (errorCode === 'ETIMEDOUT' || errorCode === 'ECONNECTIONTIMEOUT'))
  ) {
    return new RegistryMetadataFetchError(
      'Registry metadata request timed out',
      true,
    );
  }

  if (
    errorType === 'system' ||
    (errorCode !== undefined && NETWORK_ERROR_CODES.has(errorCode))
  ) {
    return new RegistryMetadataFetchError(
      'Registry metadata request failed due to a network error',
      true,
    );
  }

  return new RegistryMetadataInternalError();
}

export class RegistryMetadataClient {
  constructor(
    private readonly environment: ScannerEnvironment =
      loadScannerEnvironment(),
    private readonly registryFetch: RegistryFetch = defaultRegistryFetch,
  ) {}

  async query(
    value: unknown,
    options: RegistryMetadataQueryOptions = {},
  ): Promise<RegistryMetadataResult> {
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    let parentAbortHandler: (() => void) | undefined;

    try {
      const input = validateRegistryMetadataInput(value);
      const metadataUrl = buildRegistryMetadataUrl(input);
      const abortController = new AbortController();
      const timeoutMs = Math.min(
        this.environment.METADATA_TIMEOUT_MS,
        options.timeoutMs ?? this.environment.METADATA_TIMEOUT_MS,
      );
      const parentAbort = options.signal;
      if (parentAbort?.aborted === true) abortController.abort(parentAbort.reason);
      parentAbortHandler = () => abortController.abort(parentAbort?.reason);
      parentAbort?.addEventListener('abort', parentAbortHandler, { once: true });
      const timeout = new Promise<never>((_resolve, reject) => {
        timeoutHandle = setTimeout(() => {
          abortController.abort();
          reject(
            new RegistryMetadataFetchError(
              'Registry metadata request timed out',
              true,
            ),
          );
        }, timeoutMs);
      });

      return await Promise.race([
        this.fetchAndValidate(input, metadataUrl, abortController.signal, timeoutMs),
        timeout,
      ]);
    } catch (error) {
      throw mapRegistryFetchError(error);
    } finally {
      if (timeoutHandle !== undefined) {
        clearTimeout(timeoutHandle);
      }
      options.signal?.removeEventListener('abort', parentAbortHandler as () => void);
    }
  }

  private async fetchAndValidate(
    input: ReturnType<typeof validateRegistryMetadataInput>,
    metadataUrl: string,
    signal: AbortSignal,
    timeoutMs: number,
  ): Promise<RegistryMetadataResult> {
    const response = await this.registryFetch(metadataUrl, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
      },
      timeout: timeoutMs,
      fetchRetries: 0,
      signal,
    });
    const body = await readLimitedResponseBody(
      response,
      this.environment.METADATA_MAX_RESPONSE_BYTES,
    );
    const metadata = parseRegistryMetadata(body);

    return validateRegistryMetadataResponse(input, metadataUrl, metadata);
  }
}
