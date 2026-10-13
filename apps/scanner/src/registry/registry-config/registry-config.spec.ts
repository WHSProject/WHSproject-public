import { ScannerErrorCode } from '../../domain/scanner-error-code';

import {
  NPMJS_REGISTRY_BASE_URL,
  NPMJS_REGISTRY_ID,
  NPMJS_TARBALL_HOST,
  NPMJS_TARBALL_PORT,
  NPMJS_TARBALL_PROTOCOL,
  resolveRegistryConfig,
} from './registry-config';
import { UnsupportedRegistryError } from './unsupported-registry.error';

describe('resolveRegistryConfig', () => {
  it('returns the fixed public npmjs registry configuration', () => {
    expect(resolveRegistryConfig(NPMJS_REGISTRY_ID)).toEqual({
      id: NPMJS_REGISTRY_ID,
      baseUrl: NPMJS_REGISTRY_BASE_URL,
      tarballHost: NPMJS_TARBALL_HOST,
      tarballProtocol: NPMJS_TARBALL_PROTOCOL,
      tarballPort: NPMJS_TARBALL_PORT,
    });
  });

  it('rejects an unregistered registry before any external request', () => {
    expect.assertions(3);

    try {
      resolveRegistryConfig('private-registry');
    } catch (error) {
      expect(error).toBeInstanceOf(UnsupportedRegistryError);
      expect((error as UnsupportedRegistryError).code).toBe(
        ScannerErrorCode.INVALID_INPUT,
      );
      expect((error as UnsupportedRegistryError).retryable).toBe(false);
    }
  });
});
