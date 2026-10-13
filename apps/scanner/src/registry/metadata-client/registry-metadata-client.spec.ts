import { ScannerErrorCode } from '../../domain/scanner-error-code';
import type { ScannerEnvironment } from '../../config/scanner-environment';
import { InvalidRegistryMetadataResponseError } from './registry-metadata.error';
import {
  RegistryMetadataClient,
  type RegistryFetch,
} from './registry-metadata-client';

const validInput = {
  registryId: 'npmjs',
  packageName: '@scope/example',
  packageVersion: '1.0.0',
};
const metadataUrl =
  'https://registry.npmjs.org/%40scope%2Fexample/1.0.0';
const tarballUrl =
  'https://registry.npmjs.org/@scope/example/-/example-1.0.0.tgz';
const validSri =
  'sha512-7iaw3Ur350mqGo7jwQrpkj9hiYB3Lkc/iBml1JQODbJ6wYX4oOHV+E+IvIh/1nsUNzLDBMxfqa2Ob1f1ACio/w==';

const environment: ScannerEnvironment = {
  POLICY_URL: 'http://policy:8000',
  POLICY_TIMEOUT_MS: 10_000,
  SCANNER_PACKAGE_TIMEOUT_MS: 30_000,
  OBFUSCATION_GPT_MODE: 'off',
  METADATA_TIMEOUT_MS: 10_000,
  METADATA_MAX_RESPONSE_BYTES: 2_097_152,
  TARBALL_CONNECT_TIMEOUT_MS: 5_000,
  TARBALL_DOWNLOAD_TIMEOUT_MS: 60_000,
  MAX_TARBALL_BYTES: 104_857_600,
  TARBALL_MAX_REDIRECTS: 3,
};

describe('RegistryMetadataClient', () => {
  it('performs one bounded GET and returns validated Registry metadata', async () => {
    const metadata = validMetadata();
    const registryFetch = mockRegistryFetch(
      async (_url, _options) => responseFromJson(metadata),
    );
    const client = new RegistryMetadataClient(environment, registryFetch);

    await expect(client.query(validInput)).resolves.toEqual({
      registryId: 'npmjs',
      metadataUrl,
      tarballUrl,
      registryIntegrity: validSri,
      registryMetadata: metadata,
    });

    expectRequestContract(registryFetch, metadataUrl);
  });

  it('accepts a valid unscoped package response', async () => {
    const input = {
      registryId: 'npmjs',
      packageName: 'lodash',
      packageVersion: '4.17.21',
    };
    const expectedUrl = 'https://registry.npmjs.org/lodash/4.17.21';
    const metadata = {
      name: input.packageName,
      version: input.packageVersion,
      dist: {
        tarball:
          'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz',
      },
    };
    const registryFetch = mockRegistryFetch(async () =>
      responseFromJson(metadata),
    );
    const client = new RegistryMetadataClient(environment, registryFetch);

    await expect(client.query(input)).resolves.toMatchObject({
      registryId: 'npmjs',
      metadataUrl: expectedUrl,
      tarballUrl: metadata.dist.tarball,
      registryMetadata: metadata,
    });

    expectRequestContract(registryFetch, expectedUrl);
  });

  it('omits registryIntegrity when dist.integrity is absent', async () => {
    const metadata = {
      name: validInput.packageName,
      version: validInput.packageVersion,
      dist: { tarball: tarballUrl },
    };
    const registryFetch = mockRegistryFetch(async () =>
      responseFromJson(metadata),
    );
    const client = new RegistryMetadataClient(environment, registryFetch);

    const result = await client.query(validInput);

    expect(result).not.toHaveProperty('registryIntegrity');
    expect(result.registryMetadata).toEqual(metadata);
    expectRequestContract(registryFetch, metadataUrl);
  });

  it('rejects invalid input before making an HTTP request', async () => {
    const registryFetch: jest.MockedFunction<RegistryFetch> = jest.fn();
    const client = new RegistryMetadataClient(environment, registryFetch);

    await expect(
      client.query({ ...validInput, registryId: 'private' }),
    ).rejects.toMatchObject({
      code: ScannerErrorCode.INVALID_INPUT,
      retryable: false,
    });
    expect(registryFetch).not.toHaveBeenCalled();
  });

  it('stops reading and rejects a response over the byte limit', async () => {
    const body = {
      destroy: jest.fn(),
      async *[Symbol.asyncIterator](): AsyncGenerator<Buffer> {
        yield Buffer.from('12345');
        yield Buffer.from('67890');
      },
    };
    const registryFetch = mockRegistryFetch(async () => ({ body }));
    const client = new RegistryMetadataClient(
      { ...environment, METADATA_MAX_RESPONSE_BYTES: 9 },
      registryFetch,
    );

    await expect(client.query(validInput)).rejects.toMatchObject({
      code: ScannerErrorCode.METADATA_FETCH_FAILED,
      retryable: false,
    });
    expect(body.destroy).toHaveBeenCalledTimes(1);
    expectRequestContract(registryFetch, metadataUrl);
  });

  it('maps invalid JSON to a non-retryable metadata failure', async () => {
    const registryFetch = mockRegistryFetch(async () =>
      responseFromText('{invalid'),
    );
    const client = new RegistryMetadataClient(
      environment,
      registryFetch,
    );

    await expect(client.query(validInput)).rejects.toMatchObject({
      code: ScannerErrorCode.METADATA_FETCH_FAILED,
      retryable: false,
    });
    expectRequestContract(registryFetch, metadataUrl);
  });

  it('preserves a response validation failure instead of remapping it', async () => {
    const registryFetch = mockRegistryFetch(async () =>
      responseFromJson({
        name: validInput.packageName,
        version: validInput.packageVersion,
      }),
    );
    const client = new RegistryMetadataClient(
      environment,
      registryFetch,
    );
    const request = client.query(validInput);

    await expect(request).rejects.toBeInstanceOf(
      InvalidRegistryMetadataResponseError,
    );
    await expect(request).rejects.toMatchObject({
      code: ScannerErrorCode.METADATA_FETCH_FAILED,
      retryable: false,
    });
    expectRequestContract(registryFetch, metadataUrl);
  });

  it.each([
    [429, true],
    [500, true],
    [503, true],
    [400, false],
    [404, false],
  ])(
    'maps HTTP %i to retryable=%s',
    async (statusCode, retryable) => {
      const registryBody = 'REGISTRY_BODY_MUST_NOT_LEAK';
      const registryFetch = mockRegistryFetch(async () => {
        throw Object.assign(new Error(registryBody), {
          statusCode,
          body: registryBody,
        });
      });
      const client = new RegistryMetadataClient(
        environment,
        registryFetch,
      );
      const request = client.query(validInput);

      await expect(request).rejects.toMatchObject({
        code: ScannerErrorCode.METADATA_FETCH_FAILED,
        retryable,
        statusCode,
        message: expect.not.stringContaining(registryBody),
      });
      await expect(request).rejects.not.toHaveProperty('body');
      await expect(request).rejects.not.toHaveProperty('cause');
      expectRequestContract(registryFetch, metadataUrl);
    },
  );

  it.each([
    [{ name: 'FetchError', type: 'system', code: 'FETCH_ERROR' }],
    [{ name: 'Error', code: 'ENOTFOUND' }],
    [{ name: 'Error', code: 'ECONNRESET' }],
  ])('maps a network error to a retryable metadata failure', async (details) => {
    const registryFetch = mockRegistryFetch(async () => {
      throw Object.assign(new Error('external network error'), details);
    });
    const client = new RegistryMetadataClient(
      environment,
      registryFetch,
    );

    await expect(client.query(validInput)).rejects.toMatchObject({
      code: ScannerErrorCode.METADATA_FETCH_FAILED,
      retryable: true,
    });
    expectRequestContract(registryFetch, metadataUrl);
  });

  it.each(['request-timeout', 'body-timeout'])(
    'maps FetchError type %s to a retryable timeout',
    async (type) => {
      const registryFetch = mockRegistryFetch(async () => {
        throw Object.assign(new Error('external timeout'), {
          name: 'FetchError',
          code: 'FETCH_ERROR',
          type,
        });
      });
      const client = new RegistryMetadataClient(
        environment,
        registryFetch,
      );

      await expect(client.query(validInput)).rejects.toMatchObject({
        code: ScannerErrorCode.METADATA_FETCH_FAILED,
        retryable: true,
      });
      expectRequestContract(registryFetch, metadataUrl);
    },
  );

  it('enforces the configured timeout even if the fetch does not settle', async () => {
    jest.useFakeTimers();

    try {
      const registryFetch = mockRegistryFetch(
        async (_url, _options) => new Promise<unknown>(() => undefined),
      );
      const client = new RegistryMetadataClient(
        { ...environment, METADATA_TIMEOUT_MS: 25 },
        registryFetch,
      );
      const request = client.query(validInput);
      const rejection = expect(request).rejects.toMatchObject({
        code: ScannerErrorCode.METADATA_FETCH_FAILED,
        retryable: true,
      });

      await jest.advanceTimersByTimeAsync(25);
      await rejection;

      expect(registryFetch.mock.calls[0]?.[1].signal.aborted).toBe(true);
      expectRequestContract(registryFetch, metadataUrl, 25);
    } finally {
      jest.useRealTimers();
    }
  });

  it('maps an unexpected implementation error to INTERNAL_ERROR', async () => {
    const registryFetch = mockRegistryFetch(async () => {
      throw new Error('unexpected implementation failure');
    });
    const client = new RegistryMetadataClient(
      environment,
      registryFetch,
    );

    await expect(client.query(validInput)).rejects.toMatchObject({
      code: ScannerErrorCode.INTERNAL_ERROR,
      retryable: false,
    });
    expectRequestContract(registryFetch, metadataUrl);
  });
});

function validMetadata(): Record<string, unknown> {
  return {
    name: validInput.packageName,
    version: validInput.packageVersion,
    dist: {
      tarball: tarballUrl,
      integrity: validSri,
    },
  };
}

function responseFromJson(value: unknown): { body: AsyncIterable<Buffer> } {
  return responseFromText(JSON.stringify(value));
}

function responseFromText(value: string): { body: AsyncIterable<Buffer> } {
  return {
    body: {
      async *[Symbol.asyncIterator](): AsyncGenerator<Buffer> {
        yield Buffer.from(value);
      },
    },
  };
}

type RegistryFetchMock = jest.Mock<
  ReturnType<RegistryFetch>,
  Parameters<RegistryFetch>
>;

function mockRegistryFetch(implementation: RegistryFetch): RegistryFetchMock {
  return jest.fn<ReturnType<RegistryFetch>, Parameters<RegistryFetch>>(
    implementation,
  );
}

function expectRequestContract(
  registryFetch: RegistryFetchMock,
  expectedUrl: string,
  expectedTimeout = environment.METADATA_TIMEOUT_MS,
): void {
  expect(registryFetch).toHaveBeenCalledTimes(1);
  expect(registryFetch).toHaveBeenCalledWith(expectedUrl, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
    },
    timeout: expectedTimeout,
    fetchRetries: 0,
    signal: expect.any(AbortSignal),
  });

  const requestOptions = registryFetch.mock.calls[0]?.[1];
  expect(requestOptions).not.toHaveProperty('body');
  expect(requestOptions).not.toHaveProperty('cache');
  expect(requestOptions).not.toHaveProperty('cachePath');
  expect(requestOptions).not.toHaveProperty('retry');
}
