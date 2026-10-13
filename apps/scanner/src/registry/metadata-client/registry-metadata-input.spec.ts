import { ScannerErrorCode } from '../../domain/scanner-error-code';
import { UnsupportedRegistryError } from '../registry-config/unsupported-registry.error';
import { InvalidRegistryMetadataInputError } from './registry-metadata.error';
import { validateRegistryMetadataInput } from './registry-metadata-input';

describe('validateRegistryMetadataInput', () => {
  it.each([
    ['unscoped package', 'lodash', '4.17.21'],
    ['scoped package', '@scope/example', '1.0.0'],
    ['prerelease version', 'example', '1.0.0-beta.1'],
  ])('accepts a valid %s', (_caseName, packageName, packageVersion) => {
    expect(
      validateRegistryMetadataInput({
        registryId: 'npmjs',
        packageName,
        packageVersion,
      }),
    ).toEqual({ registryId: 'npmjs', packageName, packageVersion });
  });

  it('rejects an unsupported Registry ID with the input error contract', () => {
    expectInvalidInput(
      () =>
        validateRegistryMetadataInput({
          registryId: 'private',
          packageName: 'example',
          packageVersion: '1.0.0',
        }),
      UnsupportedRegistryError,
    );
  });

  it.each(['', ' example', 'example '])(
    'rejects invalid package name %j',
    (packageName) => {
      expectInvalidInput(() =>
        validateRegistryMetadataInput({
          registryId: 'npmjs',
          packageName,
          packageVersion: '1.0.0',
        }),
      );
    },
  );

  it.each(['latest', '^1.0.0', '1.x', '*'])(
    'rejects non-exact package version %j',
    (packageVersion) => {
      expectInvalidInput(() =>
        validateRegistryMetadataInput({
          registryId: 'npmjs',
          packageName: 'example',
          packageVersion,
        }),
      );
    },
  );
});

function expectInvalidInput(
  action: () => unknown,
  expectedType: typeof InvalidRegistryMetadataInputError | typeof UnsupportedRegistryError =
    InvalidRegistryMetadataInputError,
): void {
  expect.assertions(3);

  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(expectedType);
    expect(error).toMatchObject({
      code: ScannerErrorCode.INVALID_INPUT,
      retryable: false,
    });
    expect(error).toBeInstanceOf(Error);
  }
}
