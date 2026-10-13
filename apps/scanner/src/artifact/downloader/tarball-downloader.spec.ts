import { createHash } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import type { ScannerEnvironment } from '../../config/scanner-environment';
import type { DnsLookup } from '../../registry/tarball-url-validator/tarball-url-validator';
import { IntegrityVerifier } from '../integrity/integrity-verifier';
import {
  ArtifactFileManager,
  type ArtifactTempFile,
} from '../storage/artifact-file-manager';
import { ArtifactStorageError } from '../storage/artifact-storage.error';
import type {
  TarballHttpResponse,
  TarballHttpTransport,
  TarballTransportRequest,
} from './node-https-transport';
import {
  DEFAULT_SCANNER_USER_AGENT,
  TARBALL_ACCEPT_HEADER,
  TarballDownloader,
} from './tarball-downloader';

const payload = Buffer.from('tarball artifact payload');
const tarballUrl = 'https://registry.npmjs.org/package/-/package-1.0.0.tgz';
const publicDnsLookup: DnsLookup = async () => [
  { address: '104.16.24.34', family: 4 },
  { address: '2606:4700::6810:1822', family: 6 },
];

const environment: ScannerEnvironment = {
  POLICY_URL: 'http://policy:8000',
  POLICY_TIMEOUT_MS: 10_000,
  SCANNER_PACKAGE_TIMEOUT_MS: 30_000,
  OBFUSCATION_GPT_MODE: 'off',
  METADATA_MAX_RESPONSE_BYTES: 2_097_152,
  METADATA_TIMEOUT_MS: 10_000,
  MAX_TARBALL_BYTES: 1024,
  TARBALL_CONNECT_TIMEOUT_MS: 50,
  TARBALL_DOWNLOAD_TIMEOUT_MS: 500,
  TARBALL_MAX_REDIRECTS: 3,
};

describe('TarballDownloader HTTP streaming', () => {
  let testDirectory: string;
  let transport: ScriptedTransport;

  beforeEach(async () => {
    testDirectory = await mkdtemp(join(tmpdir(), 'scanner-http-download-'));
    transport = new ScriptedTransport();
  });

  afterEach(async () => {
    await rm(testDirectory, { recursive: true, force: true });
  });

  it('streams a normal response into the finalized Artifact', async () => {
    transport.enqueue(response(200, [payload], {
      'content-length': String(payload.length),
      'content-type': 'application/octet-stream',
    }));

    const result = await downloader().download(input('normal'));

    expect(await readFile(result.artifactPath)).toEqual(payload);
    expect(result).toMatchObject({
      calculatedIntegrity: sri(payload),
      finalUrl: tarballUrl,
      receivedBytes: payload.length,
      sha256: createHash('sha256').update(payload).digest('hex'),
    });
    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0]).toMatchObject({
      connectTimeoutMs: environment.TARBALL_CONNECT_TIMEOUT_MS,
      headers: {
        Accept: TARBALL_ACCEPT_HEADER,
        'Accept-Encoding': 'identity',
        'User-Agent': DEFAULT_SCANNER_USER_AGENT,
      },
      target: {
        connection: {
          address: '104.16.24.34',
          hostname: 'registry.npmjs.org',
          servername: 'registry.npmjs.org',
        },
      },
    });
    await expectPartCleaned('normal');
  });

  it('writes multiple chunks without collecting the full body', async () => {
    const chunks = [payload.subarray(0, 3), payload.subarray(3, 9), payload.subarray(9)];
    const concatSpy = jest.spyOn(Buffer, 'concat');
    transport.enqueue(response(200, chunks));

    const result = await downloader().download(input('chunks'));

    expect(await readFile(result.artifactPath)).toEqual(payload);
    expect(concatSpy).not.toHaveBeenCalled();
    concatSpy.mockRestore();
  });

  it('follows one validated redirect', async () => {
    const redirectResponse = response(302, [], {
      location: '/redirected.tgz',
    });
    transport.enqueue(redirectResponse);
    transport.enqueue(response(200, [payload]));
    const dnsLookup = jest.fn(publicDnsLookup);
    const redirectDownloader = new TarballDownloader({
      dnsLookup,
      environment,
      fileManager: new ArtifactFileManager(testDirectory),
      transport,
    });

    const result = await redirectDownloader.download(input('redirect-once'));

    expect(result.finalUrl).toBe('https://registry.npmjs.org/redirected.tgz');
    expect(transport.calls).toHaveLength(2);
    expect(dnsLookup).toHaveBeenCalledTimes(2);
    expect(redirectResponse.body.destroyed).toBe(true);
  });

  it.each([303, 308])('follows an allowed HTTP %i redirect', async (statusCode) => {
    transport.enqueue(response(statusCode, [], { location: '/allowed.tgz' }));
    transport.enqueue(response(200, [payload]));

    await expect(
      downloader().download(input(`redirect-${statusCode}`)),
    ).resolves.toMatchObject({
      finalUrl: 'https://registry.npmjs.org/allowed.tgz',
    });
  });

  it('resolves a relative redirect against the previous URL', async () => {
    transport.enqueue(response(307, [], { location: '../next.tgz?download=1' }));
    transport.enqueue(response(200, [payload]));

    const result = await downloader().download(input('relative'));

    expect(result.finalUrl).toBe(
      'https://registry.npmjs.org/package/next.tgz?download=1',
    );
  });

  it('blocks a redirect loop', async () => {
    transport.enqueue(response(301, [], { location: tarballUrl }));

    await expectFailure('loop', false);
    expect(transport.calls).toHaveLength(1);
  });

  it('allows three redirects', async () => {
    for (const location of ['/one', '/two', '/three']) {
      transport.enqueue(response(302, [], { location }));
    }
    transport.enqueue(response(200, [payload]));

    await expect(downloader().download(input('three-redirects'))).resolves.toMatchObject({
      finalUrl: 'https://registry.npmjs.org/three',
    });
    expect(transport.calls).toHaveLength(4);
  });

  it('rejects a fourth redirect without another request', async () => {
    for (const location of ['/one', '/two', '/three', '/four']) {
      transport.enqueue(response(302, [], { location }));
    }

    await expectFailure('four-redirects', false);
    expect(transport.calls).toHaveLength(4);
  });

  it('blocks a redirect to another host before requesting it', async () => {
    transport.enqueue(
      response(302, [], { location: 'https://example.com/package.tgz' }),
    );

    await expectFailure('redirect-host', false);
    expect(transport.calls).toHaveLength(1);
  });

  it('blocks a redirect protocol downgrade', async () => {
    transport.enqueue(
      response(302, [], { location: 'http://registry.npmjs.org/package.tgz' }),
    );

    await expectFailure('redirect-http', false);
    expect(transport.calls).toHaveLength(1);
  });

  it('requires a single Redirect Location', async () => {
    transport.enqueue(response(302, []));
    await expectFailure('redirect-location-missing', false);
  });

  it('does not reset the overall timeout for redirects', async () => {
    // Leave room for DNS validation and temporary file creation on slow filesystems.
    // The second response still exceeds the single overall deadline.
    transport.enqueue(async () => {
      await delay(250);
      return response(302, [], { location: '/one' });
    });
    transport.enqueue(async () => {
      await delay(250);
      return response(302, [], { location: '/two' });
    });

    const error = await captureFailure('redirect-budget', {
      ...environment,
      TARBALL_DOWNLOAD_TIMEOUT_MS: 375,
    });

    expect(error).toMatchObject({ retryable: true });
    expect(transport.calls).toHaveLength(2);
  });

  it.each([206, 404, 600])('rejects final HTTP %i without retry', async (statusCode) => {
    transport.enqueue(response(statusCode, [Buffer.from('sensitive body')]));

    const error = await captureFailure(`status-${statusCode}`);

    expect(error).toMatchObject({ retryable: false });
    expect((error as Error).message).not.toContain('sensitive body');
    expect(transport.calls).toHaveLength(1);
  });

  it.each([429, 500])('marks HTTP %i retryable but does not retry', async (statusCode) => {
    transport.enqueue(response(statusCode, [Buffer.from('error body')]));

    await expectFailure(`status-${statusCode}`, true);
    expect(transport.calls).toHaveLength(1);
  });

  it.each([
    'application/octet-stream',
    'application/gzip',
    'application/x-gzip; charset=binary',
  ])('accepts Content-Type %s', async (contentType) => {
    transport.enqueue(response(200, [payload], { 'content-type': contentType }));

    await expect(
      downloader().download(input(`mime-${contentType.length}`)),
    ).resolves.toMatchObject({ receivedBytes: payload.length });
  });

  it('allows a missing Content-Type', async () => {
    transport.enqueue(response(200, [payload]));
    await expect(downloader().download(input('mime-missing'))).resolves.toBeDefined();
  });

  it('rejects an unsupported Content-Type', async () => {
    transport.enqueue(response(200, [payload], { 'content-type': 'text/html' }));
    await expectFailure('mime-rejected', false);
  });

  it('rejects HTTP Content-Encoding gzip', async () => {
    transport.enqueue(response(200, [payload], { 'content-encoding': 'gzip' }));
    await expectFailure('encoding-gzip', false);
  });

  it('accepts a matching Content-Length', async () => {
    transport.enqueue(response(200, [payload], {
      'content-length': String(payload.length),
    }));
    await expect(downloader().download(input('length-ok'))).resolves.toBeDefined();
  });

  it.each(['-1', '1.5', 'NaN'])('rejects invalid Content-Length %s', async (value) => {
    transport.enqueue(response(200, [payload], { 'content-length': value }));
    await expectFailure(`length-invalid-${value}`, false);
  });

  it('rejects an oversized Content-Length before reading the body', async () => {
    const body = response(200, [payload], { 'content-length': '1025' });
    transport.enqueue(body);

    await expectFailure('length-large', false);
    expect(body.body.destroyed).toBe(true);
  });

  it('marks a declared Content-Length mismatch retryable', async () => {
    transport.enqueue(response(200, [payload], {
      'content-length': String(payload.length + 1),
    }));
    await expectFailure('length-mismatch', true);
  });

  it('rejects combined Transfer-Encoding and Content-Length', async () => {
    transport.enqueue(response(200, [payload], {
      'content-length': String(payload.length),
      'transfer-encoding': 'chunked',
    }));
    await expectFailure('length-transfer', false);
  });

  it('rejects a duplicated Content-Length', async () => {
    const duplicatedHeaders = {
      'content-length': [String(payload.length), String(payload.length)],
    } as unknown as IncomingHttpHeaders;
    transport.enqueue(response(200, [payload], duplicatedHeaders));
    await expectFailure('length-duplicate', false);
  });

  it('rejects an empty body', async () => {
    transport.enqueue(response(200, []));
    await expectFailure('empty', false);
  });

  it('stops a stream when accumulated chunks exceed the limit', async () => {
    const largeChunk = Buffer.alloc(700, 1);
    const streamed = response(200, [largeChunk, largeChunk, largeChunk]);
    transport.enqueue(streamed);

    await expectFailure('chunk-limit', false);
    expect(streamed.body.destroyed).toBe(true);
  });

  it('retries partial file writes until the complete chunk is stored', async () => {
    const storage = mockStorage((_buffer, _offset, length) =>
      Math.min(4, length),
    );
    const integrity = mockIntegrityVerifier();
    transport.enqueue(response(200, [payload]));

    const result = await downloaderWithMocks(
      storage,
      integrity.verifier,
    ).download(input('partial-write'));

    expect(result.artifactPath).toBe(storage.tempFile.artifactPath);
    expect(storage.write).toHaveBeenCalledTimes(Math.ceil(payload.length / 4));
    expect(integrity.update).toHaveBeenCalledTimes(1);
    expect(integrity.update).toHaveBeenCalledWith(payload);
    expect(
      storage.write.mock.invocationCallOrder.at(-1),
    ).toBeLessThan(integrity.update.mock.invocationCallOrder[0] ?? 0);
    expect(integrity.finish).toHaveBeenCalledTimes(1);
    expect(storage.fileManager.seal).toHaveBeenCalledTimes(1);
    expect(storage.fileManager.finalize).toHaveBeenCalledTimes(1);
    expect(integrity.finish.mock.invocationCallOrder[0]).toBeLessThan(
      storage.fileManager.seal.mock.invocationCallOrder[0] ?? 0,
    );
    expect(storage.fileManager.seal.mock.invocationCallOrder[0]).toBeLessThan(
      storage.fileManager.finalize.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it('does not write the chunk that would exceed the configured size', async () => {
    const storage = mockStorage((_buffer, _offset, length) => length);
    const integrity = mockIntegrityVerifier();
    const largeChunk = Buffer.alloc(700, 1);
    transport.enqueue(response(200, [largeChunk, largeChunk, largeChunk]));

    await expect(
      downloaderWithMocks(storage, integrity.verifier).download(
        input('write-limit'),
      ),
    ).rejects.toMatchObject({
      code: 'DOWNLOAD_FAILED',
      retryable: false,
    });

    expect(storage.write).toHaveBeenCalledTimes(1);
    expect(integrity.update).toHaveBeenCalledTimes(1);
    expect(storage.fileManager.cleanup).toHaveBeenCalledTimes(1);
  });

  it('does not update or use a digest when writing the chunk fails', async () => {
    const storage = mockStorage(() => {
      throw new Error('write failure');
    });
    const integrity = mockIntegrityVerifier();
    transport.enqueue(response(200, [payload]));

    await expect(
      downloaderWithMocks(storage, integrity.verifier).download(
        input('write-failure'),
      ),
    ).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
      stage: 'ARTIFACT_STORAGE',
      retryable: false,
    });

    expect(integrity.update).not.toHaveBeenCalled();
    expect(integrity.finish).not.toHaveBeenCalled();
    expect(storage.fileManager.cleanup).toHaveBeenCalledTimes(1);
  });

  it('does not call the legacy file-based Integrity verification path', async () => {
    const integrityVerifier = new IntegrityVerifier();
    const verifyPrepared = jest.spyOn(integrityVerifier, 'verifyPrepared');
    transport.enqueue(response(200, [payload]));

    await new TarballDownloader({
      dnsLookup: publicDnsLookup,
      environment,
      fileManager: new ArtifactFileManager(testDirectory),
      integrityVerifier,
      transport,
    }).download(input('one-pass-integrity'));

    expect(verifyPrepared).not.toHaveBeenCalled();
  });

  it.each(['expectedIntegrity', 'registryIntegrity'] as const)(
    'rejects a mismatched %s without creating the final Artifact',
    async (integrityField) => {
      transport.enqueue(response(200, [payload]));
      const scanId = `mismatch-${integrityField}`;
      const mismatchedInput = {
        registryId: 'npmjs' as const,
        scanId,
        tarballUrl,
        [integrityField]: sri(Buffer.from('different payload')),
      };

      await expect(
        downloader().download(mismatchedInput),
      ).rejects.toMatchObject({
        code: 'INTEGRITY_MISMATCH',
        stage: 'INTEGRITY_VERIFICATION',
        retryable: false,
      });
      await expectPartCleaned(scanId);
      await expect(
        access(join(testDirectory, scanId, 'artifact.tgz')),
      ).rejects.toBeDefined();
    },
  );

  it('fails before creating a file or making an HTTP request when Integrity is absent', async () => {
    const missingIntegrity = {
      registryId: 'npmjs' as const,
      scanId: 'missing-integrity',
      tarballUrl,
    };

    await expect(downloader().download(missingIntegrity)).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      stage: 'INTEGRITY_VERIFICATION',
      retryable: false,
    });
    expect(transport.calls).toHaveLength(0);
    await expect(
      access(join(testDirectory, 'missing-integrity')),
    ).rejects.toBeDefined();
  });

  it('preserves the primary Download error when cleanup reports a failure', async () => {
    const storage = mockStorage((_buffer, _offset, length) => length);
    storage.fileManager.cleanup.mockResolvedValue(
      new ArtifactStorageError('cleanup failure'),
    );
    transport.enqueue(response(500, [Buffer.from('external error body')]));

    await expect(
      downloaderWithMocks(storage).download(input('cleanup-failure')),
    ).rejects.toMatchObject({
      code: 'DOWNLOAD_FAILED',
      stage: 'TARBALL_DOWNLOAD',
      retryable: true,
    });
    expect(storage.fileManager.cleanup).toHaveBeenCalledTimes(1);
  });

  it('maps connect timeout as retryable without retrying', async () => {
    transport.enqueue(Object.assign(new Error('connect timeout'), { code: 'ETIMEDOUT' }));

    await expectFailure('connect-timeout', true);
    expect(transport.calls).toHaveLength(1);
  });

  it('maps a network error as retryable without retrying', async () => {
    transport.enqueue(Object.assign(new Error('socket reset'), { code: 'ECONNRESET' }));

    await expectFailure('network-error', true);
    expect(transport.calls).toHaveLength(1);
  });

  it('maps an HTTP parser header error as non-retryable', async () => {
    transport.enqueue(
      Object.assign(new Error('duplicate content length'), {
        code: 'HPE_UNEXPECTED_CONTENT_LENGTH',
      }),
    );

    await expectFailure('parser-header-error', false);
    expect(transport.calls).toHaveLength(1);
  });

  it('uses one overall timeout budget and cleans the partial file', async () => {
    const delayedBody = Readable.from((async function* () {
      yield Buffer.from('partial');
      await new Promise((resolve) => setTimeout(resolve, 40));
      yield payload;
    })()) as IncomingMessage;
    transport.enqueue({
      body: delayedBody,
      headers: {},
      isComplete: () => false,
      statusCode: 200,
    });

    const error = await captureFailure('overall-timeout', {
      ...environment,
      TARBALL_DOWNLOAD_TIMEOUT_MS: 10,
    });

    expect(error).toMatchObject({ retryable: true });
    await expectPartCleaned('overall-timeout');
  });

  it('marks a prematurely terminated response retryable', async () => {
    const body = new Readable({
      read() {
        this.push(Buffer.from('partial'));
        this.destroy(new Error('socket closed'));
      },
    }) as IncomingMessage;
    transport.enqueue({
      body,
      headers: {},
      isComplete: () => false,
      statusCode: 200,
    });

    await expectFailure('premature', true);
    await expectPartCleaned('premature');
  });

  it('does not expose a URL query or response body in an HTTP error', async () => {
    transport.enqueue(response(404, [Buffer.from('registry secret body')]));

    const error = await captureFailure(
      'redaction',
      environment,
      `${tarballUrl}?token=query-secret`,
    );

    expect((error as Error).message).not.toContain('query-secret');
    expect((error as Error).message).not.toContain('registry secret body');
  });

  function downloader(
    selectedEnvironment: ScannerEnvironment = environment,
  ): TarballDownloader {
    return new TarballDownloader({
      dnsLookup: publicDnsLookup,
      environment: selectedEnvironment,
      fileManager: new ArtifactFileManager(testDirectory),
      transport,
    });
  }

  function downloaderWithMocks(
    storage: MockStorage,
    integrityVerifier: IntegrityVerifier = mockIntegrityVerifier().verifier,
  ): TarballDownloader {
    return new TarballDownloader({
      dnsLookup: publicDnsLookup,
      environment,
      fileManager: storage.fileManager as unknown as ArtifactFileManager,
      integrityVerifier,
      transport,
    });
  }

  function input(scanId: string, url = tarballUrl) {
    return {
      registryId: 'npmjs' as const,
      registryIntegrity: sri(payload),
      scanId,
      tarballUrl: url,
    };
  }

  async function expectFailure(
    scanId: string,
    retryable: boolean,
  ): Promise<void> {
    await expect(downloader().download(input(scanId))).rejects.toMatchObject({
      code: 'DOWNLOAD_FAILED',
      stage: 'TARBALL_DOWNLOAD',
      retryable,
    });
    await expectPartCleaned(scanId);
  }

  async function captureFailure(
    scanId: string,
    selectedEnvironment: ScannerEnvironment = environment,
    url = tarballUrl,
  ): Promise<unknown> {
    try {
      await downloader(selectedEnvironment).download(input(scanId, url));
      throw new Error('Expected download to fail');
    } catch (error) {
      return error;
    }
  }

  async function expectPartCleaned(scanId: string): Promise<void> {
    await expect(
      access(join(testDirectory, scanId, 'artifact.tgz.part')),
    ).rejects.toBeDefined();
  }
});

interface MockIntegrityVerifier {
  finish: jest.Mock;
  update: jest.Mock;
  verifier: IntegrityVerifier;
}

function mockIntegrityVerifier(): MockIntegrityVerifier {
  const update = jest.fn();
  const finish = jest.fn().mockReturnValue({
    verified: true,
    calculatedIntegrity: sri(payload),
    sha256: createHash('sha256').update(payload).digest('hex'),
  });
  const verifier = {
    createStreamingVerification: jest.fn().mockReturnValue({ finish, update }),
    prepare: jest.fn().mockReturnValue({
      requiredAlgorithms: ['sha512', 'sha256'],
    }),
    verifyPrepared: jest.fn(),
  } as unknown as IntegrityVerifier;

  return { finish, update, verifier };
}

interface MockStorage {
  fileManager: {
    cleanup: jest.Mock;
    create: jest.Mock;
    finalize: jest.Mock;
    seal: jest.Mock;
  };
  tempFile: ArtifactTempFile;
  write: jest.Mock;
}

function mockStorage(
  bytesWritten: (buffer: Buffer, offset: number, length: number) => number,
): MockStorage {
  const write = jest.fn(
    async (buffer: Buffer, offset: number, length: number) => ({
      buffer,
      bytesWritten: bytesWritten(buffer, offset, length),
    }),
  );
  const tempFile: ArtifactTempFile = {
    artifactPath: '/temporary/scan/artifact.tgz',
    fileHandle: { write } as unknown as FileHandle,
    partPath: '/temporary/scan/artifact.tgz.part',
    scanDirectory: '/temporary/scan',
  };
  const fileManager = {
    cleanup: jest.fn().mockResolvedValue(undefined),
    create: jest.fn().mockResolvedValue(tempFile),
    finalize: jest.fn().mockResolvedValue({
      artifactPath: tempFile.artifactPath,
    }),
    seal: jest.fn().mockResolvedValue(undefined),
  };

  return { fileManager, tempFile, write };
}

class ScriptedTransport implements TarballHttpTransport {
  readonly calls: TarballTransportRequest[] = [];
  private readonly scripts: Array<
    TarballHttpResponse | Error | (() => Promise<TarballHttpResponse>)
  > = [];

  enqueue(
    script: TarballHttpResponse | Error | (() => Promise<TarballHttpResponse>),
  ): void {
    this.scripts.push(script);
  }

  async request(options: TarballTransportRequest): Promise<TarballHttpResponse> {
    this.calls.push(options);
    const script = this.scripts.shift();
    if (script === undefined) {
      throw new Error('Unexpected HTTP request');
    }
    if (script instanceof Error) {
      throw script;
    }
    return typeof script === 'function' ? script() : script;
  }
}

function response(
  statusCode: number,
  chunks: readonly Buffer[],
  headers: IncomingHttpHeaders = {},
): TarballHttpResponse {
  const body = Readable.from(chunks) as IncomingMessage;
  return {
    body,
    headers,
    isComplete: () => true,
    statusCode,
  };
}

function sri(value: Buffer): string {
  return `sha512-${createHash('sha512').update(value).digest('base64')}`;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
