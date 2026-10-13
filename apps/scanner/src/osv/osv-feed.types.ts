/** Internal interface draft; not a Scanner → Policy transport contract. */
export interface OsvQuery {
  ecosystem: string;
  packageName: string;
  packageVersion: string;
}

/** Must be produced by trusted Scanner acquisition/configuration, never a request DTO. */
export type OsvQueryPermission =
  | { allowed: true; basis: 'VERIFIED_PUBLIC_NPM' }
  | { allowed: false; reason: 'DISABLED' | 'UNSUPPORTED_TARGET' | 'PRIVATE_PACKAGE' | 'PROVENANCE_UNCONFIRMED' };

export interface OsvFeedInput extends OsvQuery {
  permission: OsvQueryPermission;
  remainingMs: number;
  signal: AbortSignal;
}

export type OsvErrorCode =
  | 'HTTP_ERROR' | 'NETWORK_ERROR' | 'INVALID_JSON' | 'INVALID_RESPONSE'
  | 'RESPONSE_TOO_LARGE' | 'TOTAL_RESPONSE_TOO_LARGE' | 'JSON_TOO_DEEP'
  | 'JSON_STRING_TOO_LONG' | 'PAGE_LIMIT_EXCEEDED' | 'REPEATED_PAGE_TOKEN'
  | 'DEADLINE_EXCEEDED' | 'SCAN_BUDGET_EXHAUSTED' | 'PARENT_ABORTED';

export type OsvSkippedReason =
  | 'DISABLED' | 'UNSUPPORTED_TARGET' | 'PRIVATE_PACKAGE'
  | 'PROVENANCE_UNCONFIRMED' | 'INVALID_PACKAGE_IDENTITY' | 'INVALID_SCAN_BUDGET';

export interface OsvFeedResult {
  source: 'OSV';
  feedStatus: 'SUCCESS' | 'FAILED' | 'TIMEOUT' | 'SKIPPED';
  query: OsvQuery;
  /** Raw records; advisory semantics are exclusively Policy's responsibility. */
  advisories: Record<string, unknown>[];
  /** Collection only, never Policy validation. */
  complete: boolean;
  pagesFetched: number;
  /** Attempt start (UTC ISO), null when no HTTP request was started. Not a TTL base. */
  collectedAt: string | null;
  /** Successful full collection only (UTC ISO); candidate future collection TTL base. */
  completedAt: string | null;
  errorCode: OsvErrorCode | null;
  skippedReason: OsvSkippedReason | null;
}

export interface OsvLimits {
  timeoutMs: number;
  maxPages: number;
  maxPageBytes: number;
  maxTotalBytes: number;
  maxJsonDepth: number;
  maxJsonStringLength: number;
}

export interface OsvTransportOptions {
  method: 'POST';
  headers: { Accept: 'application/json'; 'Content-Type': 'application/json' };
  body: string;
  redirect: 'manual';
  signal: AbortSignal;
}

export interface OsvTransportResponse {
  status: number;
  body: ReadableStream<Uint8Array> | null;
  /** Kept optional so existing fixture transports remain source compatible. */
  headers?: { get(name: string): string | null };
}

/** One attempt, no redirects/retries; body must be streamed, not prebuffered. */
export type OsvTransport = (
  url: string,
  options: OsvTransportOptions,
) => Promise<OsvTransportResponse>;
