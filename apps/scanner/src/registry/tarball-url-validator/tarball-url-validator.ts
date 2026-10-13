import { createHash } from 'node:crypto';
import type { LookupAddress } from 'node:dns';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP, type LookupFunction } from 'node:net';

import {
  NPMJS_REGISTRY_ID,
  resolveRegistryConfig,
  type RegistryConfig,
} from '../registry-config/registry-config';
import { TarballUrlValidationError } from './tarball-url-validation.error';

export type DnsLookup = (
  hostname: string,
) => Promise<readonly LookupAddress[]>;

export interface ValidatedDnsAddress {
  address: string;
  family: 4 | 6;
}

export interface PinnedConnection {
  address: string;
  family: 4 | 6;
  hostname: string;
  lookup: LookupFunction;
  port: number;
  servername: string;
}

export interface ValidatedTarballTarget {
  addresses: readonly ValidatedDnsAddress[];
  canonicalRedirectKey: string;
  connection: PinnedConnection;
  redactedUrl: string;
  url: URL;
}

const ipv4NonPublicAddresses = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['192.88.99.0', 24],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  ipv4NonPublicAddresses.addSubnet(network, prefix, 'ipv4');
}

const ipv6NonPublicAddresses = new BlockList();
for (const [network, prefix] of [
  ['::', 96],
  ['::ffff:0:0', 96],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
  ['5f00::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
] as const) {
  ipv6NonPublicAddresses.addSubnet(network, prefix, 'ipv6');
}

export const systemDnsLookup: DnsLookup = (hostname) =>
  lookup(hostname, { all: true, verbatim: true });

export function validateTarballUrl(
  value: string,
  registry: RegistryConfig = resolveRegistryConfig(NPMJS_REGISTRY_ID),
): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw validationError('Tarball URL must be an absolute URL');
  }

  if (url.protocol !== registry.tarballProtocol) {
    throw validationError('Tarball URL must use HTTPS');
  }
  if (url.username !== '' || url.password !== '') {
    throw validationError('Tarball URL must not contain credentials');
  }
  if (url.hash !== '') {
    throw validationError('Tarball URL must not contain a fragment');
  }
  if (url.port !== '' && url.port !== String(registry.tarballPort)) {
    throw validationError('Tarball URL uses a disallowed port');
  }

  const hostname = stripIpv6Brackets(url.hostname);
  if (isIP(hostname) !== 0) {
    throw validationError('Tarball URL must not use an IP address literal');
  }
  if (hostname.toLowerCase() !== registry.tarballHost.toLowerCase()) {
    throw validationError('Tarball URL host is not allowed');
  }

  return url;
}

export function validateDnsAddresses(
  addresses: readonly LookupAddress[],
): readonly ValidatedDnsAddress[] {
  if (addresses.length === 0) {
    throw validationError('Tarball host did not resolve to an address');
  }

  const validated = addresses.map((result) => {
    const detectedFamily = isIP(result.address);
    if (
      (result.family !== 4 && result.family !== 6) ||
      detectedFamily !== result.family ||
      isNonPublicAddress(result.address, result.family)
    ) {
      throw validationError('Tarball host resolved to a disallowed address');
    }

    return Object.freeze<ValidatedDnsAddress>({
      address: result.address,
      family: detectedFamily,
    });
  });

  return Object.freeze(validated);
}

export async function validateTarballTarget(
  value: string,
  dnsLookup: DnsLookup = systemDnsLookup,
  registry: RegistryConfig = resolveRegistryConfig(NPMJS_REGISTRY_ID),
): Promise<ValidatedTarballTarget> {
  const url = validateTarballUrl(value, registry);
  const addresses = validateDnsAddresses(await dnsLookup(url.hostname));
  const selectedAddress = addresses[0];

  if (selectedAddress === undefined) {
    throw validationError('Tarball host did not resolve to an address');
  }

  return {
    addresses,
    canonicalRedirectKey: createCanonicalRedirectKey(url),
    connection: {
      address: selectedAddress.address,
      family: selectedAddress.family,
      hostname: url.hostname,
      lookup: createPinnedLookup(url.hostname, selectedAddress),
      port: registry.tarballPort,
      servername: url.hostname,
    },
    redactedUrl: redactUrlForLogging(url),
    url,
  };
}

export async function validateRedirectTarget(
  location: string,
  previousUrl: URL,
  dnsLookup: DnsLookup = systemDnsLookup,
  registry: RegistryConfig = resolveRegistryConfig(NPMJS_REGISTRY_ID),
): Promise<ValidatedTarballTarget> {
  let resolvedUrl: URL;
  try {
    resolvedUrl = new URL(location, previousUrl);
  } catch {
    throw validationError('Redirect Location is not a valid URL');
  }

  return validateTarballTarget(resolvedUrl.href, dnsLookup, registry);
}

export function createCanonicalRedirectKey(url: URL): string {
  return createHash('sha256').update(url.href).digest('hex');
}

export function redactUrlForLogging(url: URL): string {
  const redacted = new URL(url.href);
  redacted.username = '';
  redacted.password = '';
  redacted.search = '';
  redacted.hash = '';
  return redacted.href;
}

function createPinnedLookup(
  expectedHostname: string,
  selectedAddress: ValidatedDnsAddress,
): LookupFunction {
  return (hostname, options, callback): void => {
    if (hostname.toLowerCase() !== expectedHostname.toLowerCase()) {
      const error = new Error('Pinned lookup received an unexpected hostname');
      Object.assign(error, { code: 'EINVAL' });
      callback(error as NodeJS.ErrnoException, '', 0);
      return;
    }

    if (options.all === true) {
      callback(null, [{ ...selectedAddress }]);
      return;
    }

    callback(null, selectedAddress.address, selectedAddress.family);
  };
}

function isNonPublicAddress(address: string, family: 4 | 6): boolean {
  return family === 4
    ? ipv4NonPublicAddresses.check(address, 'ipv4')
    : ipv6NonPublicAddresses.check(address, 'ipv6');
}

function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
}

function validationError(message: string): TarballUrlValidationError {
  return new TarballUrlValidationError(message);
}
