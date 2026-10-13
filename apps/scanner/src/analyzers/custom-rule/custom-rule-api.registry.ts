export interface CustomRuleApiRegistryEntry {
  module: string;
  methods: readonly string[];
  role: 'NETWORK' | 'DOWNLOAD';
  limitation: string;
}

/**
 * Static API recognition only. Registry membership is not a maliciousness
 * assertion and does not prove that communication or download succeeded.
 */
export const CUSTOM_RULE_API_REGISTRY: readonly CustomRuleApiRegistryEntry[] =
  Object.freeze([
    {
      module: 'axios',
      methods: ['request', 'get', 'post', 'put', 'patch'],
      role: 'NETWORK',
      limitation: 'Axios wrappers and configured instances are not resolved.',
    },
    {
      module: 'axios',
      methods: ['get', 'request'],
      role: 'DOWNLOAD',
      limitation: 'A returned Axios response is only a download candidate until its body is consumed.',
    },
    {
      module: 'request',
      methods: ['request', 'get', 'post'],
      role: 'NETWORK',
      limitation: 'Request-compatible wrappers are not resolved.',
    },
    {
      module: 'socket.io-client',
      methods: ['emit', 'send'],
      role: 'NETWORK',
      limitation: 'Socket event semantics and remote reception are not verified.',
    },
  ]);

export function registryMethods(module: string, role: CustomRuleApiRegistryEntry['role']): readonly string[] {
  return CUSTOM_RULE_API_REGISTRY
    .filter((entry) => entry.module === module && entry.role === role)
    .flatMap((entry) => [...entry.methods]);
}
