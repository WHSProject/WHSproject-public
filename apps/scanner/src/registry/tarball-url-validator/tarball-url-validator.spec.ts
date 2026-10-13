import type { LookupAddress } from 'node:dns';

import {
  NPMJS_TARBALL_HOST,
  NPMJS_TARBALL_PORT,
} from '../registry-config/registry-config';
import { TarballUrlValidationError } from './tarball-url-validation.error';
import {
  createCanonicalRedirectKey,
  redactUrlForLogging,
  validateDnsAddresses,
  validateRedirectTarget,
  validateTarballTarget,
  validateTarballUrl,
  type DnsLookup,
} from './tarball-url-validator';

const publicAddresses: readonly LookupAddress[] = [
  { address: '104.16.24.34', family: 4 },
  { address: '2606:4700::6810:1822', family: 6 },
];

const publicDnsLookup: DnsLookup = async () => publicAddresses;

describe('Tarball URL validation', () => {
  it('accepts the exact npmjs HTTPS host', () => {
    expect(
      validateTarballUrl(
        'https://registry.npmjs.org/package/-/package-1.0.0.tgz',
      ).href,
    ).toBe('https://registry.npmjs.org/package/-/package-1.0.0.tgz');
  });

  it('preserves a query on a valid URL', () => {
    const url = validateTarballUrl(
      'https://registry.npmjs.org/package.tgz?token=sensitive&download=1',
    );

    expect(url.search).toBe('?token=sensitive&download=1');
  });

  it('accepts an explicit HTTPS default port', () => {
    expect(
      validateTarballUrl(
        'https://registry.npmjs.org:443/package.tgz',
      ).href,
    ).toBe('https://registry.npmjs.org/package.tgz');
  });

  it.each([
    ['HTTP', 'http://registry.npmjs.org/package.tgz'],
    ['another hostname', 'https://example.com/package.tgz'],
    ['suffix spoofing', 'https://registry.npmjs.org.example.com/package.tgz'],
    ['userinfo', 'https://user:password@registry.npmjs.org/package.tgz'],
    ['fragment', 'https://registry.npmjs.org/package.tgz#fragment'],
    ['another port', 'https://registry.npmjs.org:8443/package.tgz'],
    ['IPv4 literal', 'https://127.0.0.1/package.tgz'],
    ['IPv6 literal', 'https://[::1]/package.tgz'],
  ])('rejects %s URLs', (_caseName, value) => {
    expectValidationFailure(() => validateTarballUrl(value));
  });

  it('does not expose a query value in a validation error', () => {
    try {
      validateTarballUrl('https://example.com/package.tgz?token=sensitive');
      throw new Error('Expected validation to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(TarballUrlValidationError);
      expect((error as Error).message).not.toContain('sensitive');
    }
  });
});

describe('Tarball DNS validation', () => {
  it('accepts public IPv4 and IPv6 results and prepares a pinned connection', async () => {
    const target = await validateTarballTarget(
      'https://registry.npmjs.org/package.tgz',
      publicDnsLookup,
    );

    expect(target.addresses).toEqual(publicAddresses);
    expect(target.connection).toMatchObject({
      address: publicAddresses[0]?.address,
      family: publicAddresses[0]?.family,
      hostname: NPMJS_TARBALL_HOST,
      port: NPMJS_TARBALL_PORT,
      servername: NPMJS_TARBALL_HOST,
    });

    const callback = jest.fn();
    target.connection.lookup(
      NPMJS_TARBALL_HOST,
      { family: 0, all: false },
      callback,
    );
    expect(callback).toHaveBeenCalledWith(
      null,
      publicAddresses[0]?.address,
      publicAddresses[0]?.family,
    );

    const unexpectedHostnameCallback = jest.fn();
    target.connection.lookup(
      'example.com',
      { family: 0, all: false },
      unexpectedHostnameCallback,
    );
    expect(unexpectedHostnameCallback).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'EINVAL' }),
      '',
      0,
    );
  });

  it.each([
    ['IPv4 loopback', '127.0.0.1', 4],
    ['IPv6 loopback', '::1', 6],
    ['IPv4 link-local', '169.254.1.1', 4],
    ['IPv6 link-local', 'fe80::1', 6],
    ['private IPv4', '10.0.0.1', 4],
    ['private IPv6', 'fd00::1', 6],
    ['IPv4 multicast', '224.0.0.1', 4],
    ['IPv6 multicast', 'ff02::1', 6],
    ['IPv4 unspecified', '0.0.0.0', 4],
    ['IPv6 unspecified', '::', 6],
    ['reserved IPv4', '192.0.2.1', 4],
    ['reserved IPv6', '2001:db8::1', 6],
    ['IPv4-mapped IPv6', '::ffff:8.8.8.8', 6],
    ['hex IPv4-mapped IPv6', '::ffff:0808:0808', 6],
    ['IPv4-translated IPv6', '64:ff9b::7f00:1', 6],
  ] as const)('rejects %s addresses', (_caseName, address, family) => {
    expectValidationFailure(() => validateDnsAddresses([{ address, family }]));
  });

  it('rejects all DNS results when any result is private', () => {
    expectValidationFailure(() =>
      validateDnsAddresses([
        { address: '104.16.24.34', family: 4 },
        { address: '10.0.0.1', family: 4 },
      ]),
    );
  });

  it('does not perform a real DNS lookup in tests', async () => {
    const dnsLookup = jest.fn(publicDnsLookup);

    await validateTarballTarget(
      'https://registry.npmjs.org/package.tgz',
      dnsLookup,
    );

    expect(dnsLookup).toHaveBeenCalledTimes(1);
    expect(dnsLookup).toHaveBeenCalledWith(NPMJS_TARBALL_HOST);
  });
});

describe('Tarball redirect URL helpers', () => {
  it('resolves and validates a relative redirect with the same rules', async () => {
    const target = await validateRedirectTarget(
      '../next/package.tgz?download=1',
      new URL('https://registry.npmjs.org/first/package.tgz'),
      publicDnsLookup,
    );

    expect(target.url.href).toBe(
      'https://registry.npmjs.org/next/package.tgz?download=1',
    );
  });

  it('rejects a redirected destination on a different host', async () => {
    await expect(
      validateRedirectTarget(
        'https://registry.npmjs.org.example.com/package.tgz',
        new URL('https://registry.npmjs.org/first/package.tgz'),
        publicDnsLookup,
      ),
    ).rejects.toMatchObject({
      code: 'DOWNLOAD_FAILED',
      stage: 'TARBALL_URL_VALIDATION',
      retryable: false,
    });
  });

  it('generates the same opaque loop key for equivalent URLs', () => {
    const first = new URL(
      'https://REGISTRY.NPMJS.ORG:443/package.tgz?token=sensitive',
    );
    const second = new URL(
      'https://registry.npmjs.org/package.tgz?token=sensitive',
    );

    expect(createCanonicalRedirectKey(first)).toBe(
      createCanonicalRedirectKey(second),
    );
    expect(createCanonicalRedirectKey(first)).not.toContain('sensitive');
  });

  it('removes credentials, query, and fragment from a logging URL', () => {
    const redacted = redactUrlForLogging(
      new URL(
        'https://user:password@registry.npmjs.org/package.tgz?token=sensitive#fragment',
      ),
    );

    expect(redacted).toBe('https://registry.npmjs.org/package.tgz');
    expect(redacted).not.toContain('sensitive');
    expect(redacted).not.toContain('password');
  });
});

function expectValidationFailure(action: () => unknown): void {
  try {
    action();
    throw new Error('Expected validation to fail');
  } catch (error) {
    expect(error).toBeInstanceOf(TarballUrlValidationError);
    expect(error).toMatchObject({
      code: 'DOWNLOAD_FAILED',
      stage: 'TARBALL_URL_VALIDATION',
      retryable: false,
    });
  }
}
