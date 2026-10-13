import { UnsupportedRegistryError } from './unsupported-registry.error';

export const NPMJS_REGISTRY_ID = 'npmjs' as const;
export const NPMJS_REGISTRY_BASE_URL = 'https://registry.npmjs.org' as const;
export const NPMJS_TARBALL_HOST = 'registry.npmjs.org' as const;
export const NPMJS_TARBALL_PROTOCOL = 'https:' as const;
export const NPMJS_TARBALL_PORT = 443 as const;

export type NpmjsRegistryId = typeof NPMJS_REGISTRY_ID;

export interface RegistryConfig {
  id: NpmjsRegistryId;
  baseUrl: typeof NPMJS_REGISTRY_BASE_URL;
  tarballHost: typeof NPMJS_TARBALL_HOST;
  tarballProtocol: typeof NPMJS_TARBALL_PROTOCOL;
  tarballPort: typeof NPMJS_TARBALL_PORT;
}

const npmjsRegistryConfig: RegistryConfig = Object.freeze({
  id: NPMJS_REGISTRY_ID,
  baseUrl: NPMJS_REGISTRY_BASE_URL,
  tarballHost: NPMJS_TARBALL_HOST,
  tarballProtocol: NPMJS_TARBALL_PROTOCOL,
  tarballPort: NPMJS_TARBALL_PORT,
});

export function resolveRegistryConfig(registryId: string): RegistryConfig {
  if (registryId !== NPMJS_REGISTRY_ID) {
    throw new UnsupportedRegistryError(registryId);
  }

  return npmjsRegistryConfig;
}
