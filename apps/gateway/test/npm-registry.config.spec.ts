import { resolveNpmRegistryBaseUrl } from '../src/config/npm-registry.config';

describe('resolveNpmRegistryBaseUrl', () => {
  const originalRegistryUrl = process.env.NPM_REGISTRY_URL;

  afterEach(() => {
    if (originalRegistryUrl === undefined) {
      delete process.env.NPM_REGISTRY_URL;
      return;
    }

    process.env.NPM_REGISTRY_URL = originalRegistryUrl;
  });

  it('uses NPM_REGISTRY_URL and strips a trailing slash', () => {
    process.env.NPM_REGISTRY_URL = 'http://registry.internal:4873/';

    expect(resolveNpmRegistryBaseUrl()).toBe('http://registry.internal:4873');
  });

  it('falls back to the public registry when the variable is blank', () => {
    process.env.NPM_REGISTRY_URL = '   ';

    expect(resolveNpmRegistryBaseUrl()).toBe('https://registry.npmjs.org');
  });

  it('falls back to the public registry when the variable is unset', () => {
    delete process.env.NPM_REGISTRY_URL;

    expect(resolveNpmRegistryBaseUrl()).toBe('https://registry.npmjs.org');
  });
});
