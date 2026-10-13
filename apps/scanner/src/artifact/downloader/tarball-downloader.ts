import type { IncomingHttpHeaders } from 'node:http';

import {
  loadScannerEnvironment,
  type ScannerEnvironment,
} from '../../config/scanner-environment';
import type {
  DownloadOptions,
  DownloadResult,
  DownloadedArtifact,
  TarballDownloadInput,
  TarballSource,
} from '../artifact.types';
import {
  IntegrityVerifier,
  type StreamingIntegrityVerification,
} from '../integrity/integrity-verifier';
import { IntegrityVerificationError } from '../integrity/integrity-verification.error';
import {
  ArtifactFileManager,
  type ArtifactTempFile,
} from '../storage/artifact-file-manager';
import { ArtifactStorageError } from '../storage/artifact-storage.error';
import {
  validateRedirectTarget,
  validateTarballTarget,
  type DnsLookup,
  type ValidatedTarballTarget,
} from '../../registry/tarball-url-validator/tarball-url-validator';
import { TarballUrlValidationError } from '../../registry/tarball-url-validator/tarball-url-validation.error';
import {
  resolveRegistryConfig,
  type RegistryConfig,
} from '../../registry/registry-config/registry-config';
import {
  NodeHttpsTransport,
  type TarballHttpResponse,
  type TarballHttpTransport,
} from './node-https-transport';
import {
  TarballConnectTimeoutError,
  TarballDownloadError,
  TarballNetworkError,
} from './tarball-download.error';

const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);
const ALLOWED_CONTENT_TYPES = new Set([
  'application/octet-stream',
  'application/gzip',
  'application/x-gzip',
]);
const NETWORK_ERROR_CODES = new Set([
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EPIPE',
  'ETIMEDOUT',
]);

export const TARBALL_ACCEPT_HEADER =
  'application/octet-stream, application/gzip, application/x-gzip';
export const DEFAULT_SCANNER_USER_AGENT = 'whs-scanner/0.1.0';

type TarballEnvironment = Pick<
  ScannerEnvironment,
  | 'MAX_TARBALL_BYTES'
  | 'TARBALL_CONNECT_TIMEOUT_MS'
  | 'TARBALL_DOWNLOAD_TIMEOUT_MS'
  | 'TARBALL_MAX_REDIRECTS'
>;

export interface TarballDownloaderDependencies {
  dnsLookup?: DnsLookup;
  environment?: TarballEnvironment;
  fileManager?: ArtifactFileManager;
  integrityVerifier?: IntegrityVerifier;
  transport?: TarballHttpTransport;
  userAgent?: string;
}

interface ValidatedResponseHeaders {
  contentLength?: number;
}

export type TarballDownloaderResult = DownloadedArtifact & DownloadResult;

type CompatibleTarballDownloadInput = TarballDownloadInput | TarballSource;

interface EffectiveDownloadOptions {
  fileManager: ArtifactFileManager;
  maxRedirects: number;
  maxTarballBytes: number;
  timeoutMs: number;
  signal?: AbortSignal;
  validateRedirectUrl?: DownloadOptions['validateRedirectUrl'];
}

export class TarballDownloader {
  private readonly dnsLookup: DnsLookup | undefined;
  private readonly environment: TarballEnvironment;
  private readonly fileManager: ArtifactFileManager;
  private readonly integrityVerifier: IntegrityVerifier;
  private readonly transport: TarballHttpTransport;
  private readonly userAgent: string;

  constructor(dependencies: TarballDownloaderDependencies = {}) {
    this.dnsLookup = dependencies.dnsLookup;
    this.environment = dependencies.environment ?? loadScannerEnvironment();
    this.fileManager = dependencies.fileManager ?? new ArtifactFileManager();
    this.integrityVerifier =
      dependencies.integrityVerifier ?? new IntegrityVerifier();
    this.transport = dependencies.transport ?? new NodeHttpsTransport();
    this.userAgent = dependencies.userAgent ?? DEFAULT_SCANNER_USER_AGENT;
  }

  download(
    input: TarballSource,
    options?: DownloadOptions,
  ): Promise<TarballDownloaderResult>;
  download(
    input: TarballDownloadInput,
    options?: DownloadOptions,
  ): Promise<DownloadedArtifact>;
  async download(
    input: CompatibleTarballDownloadInput,
    options: DownloadOptions = {},
  ): Promise<TarballDownloaderResult> {
    const normalizedInput = normalizeDownloadInput(input);
    const effectiveOptions = this.resolveDownloadOptions(options);
    const registry = resolveRegistryConfig(normalizedInput.registryId);
    const preparedIntegrity = this.integrityVerifier.prepare(normalizedInput);
    const abortController = new AbortController();
    let overallTimedOut = false;
    let tempFile: ArtifactTempFile | undefined;
    let activeResponse: TarballHttpResponse | undefined;

    const abortFromCaller = (): void => {
      abortController.abort(effectiveOptions.signal?.reason);
      activeResponse?.body.destroy();
    };
    if (effectiveOptions.signal?.aborted === true) {
      abortFromCaller();
    } else {
      effectiveOptions.signal?.addEventListener('abort', abortFromCaller, {
        once: true,
      });
    }

    const overallTimer = setTimeout(() => {
      overallTimedOut = true;
      abortController.abort();
      activeResponse?.body.destroy();
    }, effectiveOptions.timeoutMs);

    try {
      const streamingIntegrity =
        this.integrityVerifier.createStreamingVerification(preparedIntegrity);
      let target = await this.validateInitialTarget(
        normalizedInput.tarballUrl,
        abortController.signal,
        registry,
      );
      const visited = new Set([target.canonicalRedirectKey]);
      let redirectCount = 0;

      tempFile = await effectiveOptions.fileManager.create(
        normalizedInput.scanId,
      );

      while (true) {
        this.throwIfTimedOut(abortController.signal);
        activeResponse = await this.request(target, abortController.signal);

        if (REDIRECT_STATUS_CODES.has(activeResponse.statusCode)) {
          activeResponse.body.destroy();
          if (redirectCount >= effectiveOptions.maxRedirects) {
            throw downloadFailure('Tarball redirect limit exceeded', false);
          }

          const location = requireSingleHeader(
            activeResponse.headers,
            'location',
            'Redirect Location is missing or duplicated',
          );
          const redirectTarget = await this.validateRedirect(
            location,
            target.url,
            abortController.signal,
            registry,
          );
          if (
            effectiveOptions.validateRedirectUrl !== undefined &&
            !(await effectiveOptions.validateRedirectUrl(
              redirectTarget.url,
              target.url,
            ))
          ) {
            throw downloadFailure(
              'Tarball redirect destination was not accepted',
              false,
            );
          }
          if (visited.has(redirectTarget.canonicalRedirectKey)) {
            throw downloadFailure('Tarball redirect loop detected', false);
          }

          visited.add(redirectTarget.canonicalRedirectKey);
          redirectCount += 1;
          target = redirectTarget;
          activeResponse = undefined;
          continue;
        }

        if (activeResponse.statusCode !== 200) {
          activeResponse.body.destroy();
          throw httpStatusError(activeResponse.statusCode);
        }

        const headers = validateResponseHeaders(
          activeResponse.headers,
          effectiveOptions.maxTarballBytes,
        );
        const receivedBytes = await this.streamResponseToFile(
          activeResponse,
          tempFile,
          headers,
          abortController.signal,
          streamingIntegrity,
          effectiveOptions.maxTarballBytes,
        );
        activeResponse = undefined;

        this.throwIfTimedOut(abortController.signal);
        const integrity = streamingIntegrity.finish();
        this.throwIfTimedOut(abortController.signal);
        await effectiveOptions.fileManager.seal(tempFile);
        this.throwIfTimedOut(abortController.signal);
        const finalized = await effectiveOptions.fileManager.finalize(
          tempFile,
          integrity,
        );

        return {
          artifactPath: finalized.artifactPath,
          bytes: receivedBytes,
          calculatedIntegrity: integrity.calculatedIntegrity,
          finalUrl: target.url.href,
          receivedBytes,
          scanDir: tempFile.scanDirectory,
          scanId: normalizedInput.scanId,
          sha256: integrity.sha256,
        };
      }
    } catch (error) {
      activeResponse?.body.destroy();
      if (tempFile !== undefined) {
        await effectiveOptions.fileManager.cleanup(tempFile);
      }
      throw normalizeError(error, overallTimedOut);
    } finally {
      clearTimeout(overallTimer);
      effectiveOptions.signal?.removeEventListener('abort', abortFromCaller);
    }
  }

  private resolveDownloadOptions(
    options: DownloadOptions,
  ): EffectiveDownloadOptions {
    const maxTarballBytes = stricterPositiveLimit(
      options.maxTarballBytes,
      this.environment.MAX_TARBALL_BYTES,
      'Maximum Tarball size',
    );
    const timeoutMs = stricterPositiveLimit(
      options.timeoutMs,
      this.environment.TARBALL_DOWNLOAD_TIMEOUT_MS,
      'Tarball download timeout',
    );
    const maxRedirects = stricterNonNegativeLimit(
      options.maxRedirects,
      this.environment.TARBALL_MAX_REDIRECTS,
      'Maximum Tarball redirects',
    );

    return {
      fileManager:
        options.tempDir === undefined
          ? this.fileManager
          : new ArtifactFileManager(options.tempDir),
      maxRedirects,
      maxTarballBytes,
      timeoutMs,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.validateRedirectUrl === undefined
        ? {}
        : { validateRedirectUrl: options.validateRedirectUrl }),
    };
  }

  private async validateInitialTarget(
    tarballUrl: string,
    signal: AbortSignal,
    registry: RegistryConfig,
  ): Promise<ValidatedTarballTarget> {
    try {
      return await raceWithAbort(
        validateTarballTarget(tarballUrl, this.dnsLookup, registry),
        signal,
      );
    } catch (error) {
      if (error instanceof TarballUrlValidationError) {
        throw error;
      }
      throw networkFailure(error);
    }
  }

  private async validateRedirect(
    location: string,
    previousUrl: URL,
    signal: AbortSignal,
    registry: RegistryConfig,
  ): Promise<ValidatedTarballTarget> {
    try {
      return await raceWithAbort(
        validateRedirectTarget(location, previousUrl, this.dnsLookup, registry),
        signal,
      );
    } catch (error) {
      if (error instanceof TarballUrlValidationError) {
        throw downloadFailure(
          'Tarball redirect destination is not allowed',
          false,
        );
      }
      throw networkFailure(error);
    }
  }

  private async request(
    target: ValidatedTarballTarget,
    signal: AbortSignal,
  ): Promise<TarballHttpResponse> {
    try {
      return await this.transport.request({
        connectTimeoutMs: this.environment.TARBALL_CONNECT_TIMEOUT_MS,
        headers: {
          Accept: TARBALL_ACCEPT_HEADER,
          'Accept-Encoding': 'identity',
          'User-Agent': this.userAgent,
        },
        signal,
        target,
      });
    } catch (error) {
      throw networkFailure(error);
    }
  }

  private async streamResponseToFile(
    response: TarballHttpResponse,
    tempFile: ArtifactTempFile,
    headers: ValidatedResponseHeaders,
    signal: AbortSignal,
    streamingIntegrity: StreamingIntegrityVerification,
    maxTarballBytes: number,
  ): Promise<number> {
    let receivedBytes = 0;

    try {
      for await (const chunk of response.body) {
        if (signal.aborted) {
          throw downloadFailure('Tarball download timed out', true);
        }

        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (buffer.length > maxTarballBytes - receivedBytes) {
          response.body.destroy();
          throw downloadFailure('Tarball exceeds the configured size limit', false);
        }

        await writeEntireChunk(tempFile, buffer);
        streamingIntegrity.update(buffer);
        receivedBytes += buffer.length;
      }
    } catch (error) {
      if (
        error instanceof TarballDownloadError ||
        error instanceof ArtifactStorageError
      ) {
        throw error;
      }
      throw downloadFailure('Tarball response stream ended unexpectedly', true);
    }

    if (!response.isComplete()) {
      throw downloadFailure('Tarball response stream ended unexpectedly', true);
    }
    if (receivedBytes === 0) {
      throw downloadFailure('Tarball response body is empty', false);
    }
    if (
      headers.contentLength !== undefined &&
      headers.contentLength !== receivedBytes
    ) {
      throw downloadFailure('Tarball response length does not match', true);
    }

    return receivedBytes;
  }

  private throwIfTimedOut(signal: AbortSignal): void {
    if (signal.aborted) {
      throw downloadFailure('Tarball download timed out', true);
    }
  }
}

function normalizeDownloadInput(
  input: CompatibleTarballDownloadInput,
): TarballDownloadInput {
  return {
    registryId: 'registryId' in input ? input.registryId : 'npmjs',
    scanId: input.scanId,
    tarballUrl: input.tarballUrl,
    ...(input.expectedIntegrity === undefined ||
    input.expectedIntegrity === null
      ? {}
      : { expectedIntegrity: input.expectedIntegrity }),
    ...(input.registryIntegrity === undefined ||
    input.registryIntegrity === null
      ? {}
      : { registryIntegrity: input.registryIntegrity }),
  };
}

function stricterPositiveLimit(
  requested: number | undefined,
  configured: number,
  label: string,
): number {
  if (requested === undefined) {
    return configured;
  }
  if (!Number.isSafeInteger(requested) || requested <= 0) {
    throw downloadFailure(`${label} must be a positive safe integer`, false);
  }
  return Math.min(requested, configured);
}

function stricterNonNegativeLimit(
  requested: number | undefined,
  configured: number,
  label: string,
): number {
  if (requested === undefined) {
    return configured;
  }
  if (!Number.isSafeInteger(requested) || requested < 0) {
    throw downloadFailure(
      `${label} must be a non-negative safe integer`,
      false,
    );
  }
  return Math.min(requested, configured);
}

function validateResponseHeaders(
  headers: IncomingHttpHeaders,
  maxTarballBytes: number,
): ValidatedResponseHeaders {
  const contentType = optionalSingleHeader(
    headers,
    'content-type',
    'Content-Type is duplicated',
  );
  if (contentType !== undefined) {
    const mediaType = contentType.split(';', 1)[0]?.trim().toLowerCase();
    if (mediaType === undefined || !ALLOWED_CONTENT_TYPES.has(mediaType)) {
      throw downloadFailure('Tarball Content-Type is not allowed', false);
    }
  }

  const contentEncoding = optionalSingleHeader(
    headers,
    'content-encoding',
    'Content-Encoding is duplicated',
  );
  if (
    contentEncoding !== undefined &&
    contentEncoding.trim().toLowerCase() !== 'identity'
  ) {
    throw downloadFailure('Tarball Content-Encoding is not allowed', false);
  }

  const contentLengthValue = optionalSingleHeader(
    headers,
    'content-length',
    'Content-Length is duplicated',
  );
  const transferEncoding = optionalSingleHeader(
    headers,
    'transfer-encoding',
    'Transfer-Encoding is duplicated',
  );
  if (contentLengthValue !== undefined && transferEncoding !== undefined) {
    throw downloadFailure(
      'Content-Length and Transfer-Encoding must not be combined',
      false,
    );
  }

  if (contentLengthValue === undefined) {
    return {};
  }
  if (!/^\d+$/u.test(contentLengthValue)) {
    throw downloadFailure('Content-Length is invalid', false);
  }

  const contentLength = Number(contentLengthValue);
  if (!Number.isSafeInteger(contentLength)) {
    throw downloadFailure('Content-Length is invalid', false);
  }
  if (contentLength > maxTarballBytes) {
    throw downloadFailure('Tarball exceeds the configured size limit', false);
  }

  return { contentLength };
}

async function writeEntireChunk(
  tempFile: ArtifactTempFile,
  chunk: Buffer,
): Promise<void> {
  let offset = 0;
  try {
    while (offset < chunk.length) {
      const { bytesWritten } = await tempFile.fileHandle.write(
        chunk,
        offset,
        chunk.length - offset,
      );
      if (bytesWritten <= 0) {
        throw new Error('Artifact write made no progress');
      }
      offset += bytesWritten;
    }
  } catch {
    throw new ArtifactStorageError('Unable to write Artifact temporary file');
  }
}

function optionalSingleHeader(
  headers: IncomingHttpHeaders,
  name: string,
  errorMessage: string,
): string | undefined {
  const value = headers[name];
  if (value === undefined) {
    return undefined;
  }
  if (Array.isArray(value)) {
    if (value.length !== 1 || value[0] === undefined) {
      throw downloadFailure(errorMessage, false);
    }
    return value[0];
  }
  return value;
}

function requireSingleHeader(
  headers: IncomingHttpHeaders,
  name: string,
  errorMessage: string,
): string {
  const value = optionalSingleHeader(headers, name, errorMessage);
  if (value === undefined || value.length === 0) {
    throw downloadFailure(errorMessage, false);
  }
  return value;
}

function httpStatusError(statusCode: number): TarballDownloadError {
  return downloadFailure(
    'Tarball Registry returned an unsuccessful status',
    statusCode === 429 || (statusCode >= 500 && statusCode <= 599),
  );
}

function networkFailure(error: unknown): Error {
  if (
    error instanceof TarballDownloadError ||
    error instanceof TarballUrlValidationError ||
    error instanceof IntegrityVerificationError ||
    error instanceof ArtifactStorageError
  ) {
    return error;
  }

  const errorCode = getErrorCode(error);
  if (errorCode?.startsWith('HPE_') === true) {
    return downloadFailure('Tarball response headers are invalid', false);
  }
  if (
    error instanceof TarballConnectTimeoutError ||
    error instanceof TarballNetworkError ||
    (errorCode !== undefined && NETWORK_ERROR_CODES.has(errorCode)) ||
    (error instanceof Error && error.name === 'AbortError')
  ) {
    return downloadFailure('Tarball network request failed', true);
  }

  return new ArtifactStorageError('Unexpected Tarball transport failure');
}

function normalizeError(error: unknown, overallTimedOut: boolean): Error {
  if (overallTimedOut) {
    return downloadFailure('Tarball download timed out', true);
  }
  if (
    error instanceof TarballDownloadError ||
    error instanceof TarballUrlValidationError ||
    error instanceof IntegrityVerificationError ||
    error instanceof ArtifactStorageError
  ) {
    return error;
  }
  return new ArtifactStorageError('Unexpected Tarball download failure');
}

function getErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : undefined;
}

function downloadFailure(
  message: string,
  retryable: boolean,
): TarballDownloadError {
  return new TarballDownloadError(message, retryable);
}

function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(downloadFailure('Tarball download timed out', true));
  }

  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      reject(downloadFailure('Tarball download timed out', true));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}
