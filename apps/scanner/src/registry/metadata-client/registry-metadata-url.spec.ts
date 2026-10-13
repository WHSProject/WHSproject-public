import type { RegistryMetadataInput } from './registry-metadata.types';
import { buildRegistryMetadataUrl } from './registry-metadata-url';

describe('buildRegistryMetadataUrl', () => {
  it('encodes the package name and version as independent path segments', () => {
    const input: RegistryMetadataInput = {
      registryId: 'npmjs',
      packageName: '@scope/example',
      packageVersion: '1.0.0',
    };

    expect(buildRegistryMetadataUrl(input)).toBe(
      'https://registry.npmjs.org/%40scope%2Fexample/1.0.0',
    );
  });
});
