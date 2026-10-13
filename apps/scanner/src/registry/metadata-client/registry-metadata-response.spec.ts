import { ScannerErrorCode } from '../../domain/scanner-error-code';
import { InvalidRegistryMetadataResponseError } from './registry-metadata.error';
import { validateRegistryMetadataResponse } from './registry-metadata-response';
import type { RegistryMetadataInput } from './registry-metadata.types';

const input: RegistryMetadataInput = {
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

describe('validateRegistryMetadataResponse', () => {
  it('accepts valid metadata, preserves the full object, and returns valid SRI', () => {
    const metadata = {
      name: input.packageName,
      version: input.packageVersion,
      description: 'preserved field',
      dist: {
        tarball: tarballUrl,
        integrity: validSri,
        shasum: 'legacy-sha1',
      },
    };

    const result = validateRegistryMetadataResponse(
      input,
      metadataUrl,
      metadata,
    );

    expect(result).toEqual({
      registryId: 'npmjs',
      metadataUrl,
      tarballUrl,
      registryIntegrity: validSri,
      registryMetadata: metadata,
    });
    expect(result.registryMetadata).toBe(metadata);
  });

  it('accepts missing dist.integrity without converting dist.shasum', () => {
    const metadata = validMetadata({ shasum: 'legacy-sha1' });

    const result = validateRegistryMetadataResponse(
      input,
      metadataUrl,
      metadata,
    );

    expect(result).not.toHaveProperty('registryIntegrity');
    expect(result.registryMetadata).toBe(metadata);
  });

  it.each([
    ['missing dist', { name: input.packageName, version: input.packageVersion }],
    [
      'missing tarball',
      {
        name: input.packageName,
        version: input.packageVersion,
        dist: {},
      },
    ],
    ['relative tarball URL', validMetadata({ tarball: './example.tgz' })],
    [
      'HTTP tarball URL',
      validMetadata({ tarball: 'http://registry.npmjs.org/example.tgz' }),
    ],
    [
      'credentialed tarball URL',
      validMetadata({ tarball: 'https://user:pass@registry.npmjs.org/a.tgz' }),
    ],
    ['empty SRI', validMetadata({ integrity: '' })],
    ['invalid SRI', validMetadata({ integrity: 'not-sri' })],
    [
      'mismatched package name',
      { ...validMetadata(), name: '@scope/different' },
    ],
    [
      'mismatched package version',
      { ...validMetadata(), version: '2.0.0' },
    ],
    ['null response', null],
    ['array response', []],
    ['string response', 'metadata'],
  ])('rejects %s using the metadata fetch error contract', (_caseName, value) => {
    expectInvalidResponse(() =>
      validateRegistryMetadataResponse(input, metadataUrl, value),
    );
  });
});

function validMetadata(
  distOverrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    name: input.packageName,
    version: input.packageVersion,
    dist: {
      tarball: tarballUrl,
      ...distOverrides,
    },
  };
}

function expectInvalidResponse(action: () => unknown): void {
  expect.assertions(3);

  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(InvalidRegistryMetadataResponseError);
    expect(error).toMatchObject({
      code: ScannerErrorCode.METADATA_FETCH_FAILED,
      retryable: false,
    });
    expect(error).toBeInstanceOf(Error);
  }
}
