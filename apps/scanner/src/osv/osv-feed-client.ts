import { valid as validSemver } from 'semver';
import validateNpmPackageName = require('validate-npm-package-name');
import { performance } from 'node:perf_hooks';
import type {
  OsvFeedInput,
  OsvFeedResult,
  OsvLimits,
  OsvSkippedReason,
  OsvTransport,
} from './osv-feed.types';
import type { OsvTransportResponse } from './osv-feed.types';
import { OsvCollectionError, OsvJsonGuard, parseOsvPage } from './osv-response';

export const OSV_QUERY_ENDPOINT = 'https://api.osv.dev/v1/query';
/** Provisional collection limits; see README. timeoutMs can only shorten the 2s cap. */
export const DEFAULT_OSV_LIMITS: Readonly<OsvLimits> = Object.freeze({
  timeoutMs: 2_000,
  maxPages: 10,
  maxPageBytes: 2_097_152,
  maxTotalBytes: 4_194_304,
  maxJsonDepth: 64,
  maxJsonStringLength: 262_144,
});

const defaultTransport: OsvTransport = (url, options) => fetch(url, options);

export const DEFAULT_OSV_MAX_CONCURRENT_REQUESTS = 4;

export interface OsvDetailedResult {
  result: OsvFeedResult;
  retryAfterMs?: number;
}

export interface OsvQueryOptions {
  /** Background refreshes must not share the live request's in-flight promise. */
  coalesce?: boolean;
}

/** A process-wide limiter. OSV requests from different Scanner clients share it. */
export class OsvConcurrencyLimiter {
  private active = 0;
  private readonly waiters: Array<{
    signal: AbortSignal;
    resolve: (release: () => void) => void;
    reject: (error: unknown) => void;
    onAbort: () => void;
  }> = [];

  constructor(private readonly maxConcurrent = DEFAULT_OSV_MAX_CONCURRENT_REQUESTS) {
    if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent <= 0) {
      throw new TypeError('OSV maxConcurrentRequests must be a positive safe integer');
    }
  }

  acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    if (this.active < this.maxConcurrent) {
      this.active++;
      return Promise.resolve(this.releaseFactory());
    }
    return new Promise<() => void>((resolve, reject) => {
      const onAbort = (): void => {
        const index = this.waiters.findIndex((waiter) => waiter.onAbort === onAbort);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      };
      this.waiters.push({ signal, resolve, reject, onAbort });
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  private releaseFactory(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      let waiter = this.waiters.shift();
      while (waiter !== undefined && waiter.signal.aborted) {
        waiter.signal.removeEventListener('abort', waiter.onAbort);
        waiter.reject(waiter.signal.reason ?? new DOMException('Aborted', 'AbortError'));
        waiter = this.waiters.shift();
      }
      if (waiter === undefined) return;
      waiter.signal.removeEventListener('abort', waiter.onAbort);
      this.active++;
      waiter.resolve(this.releaseFactory());
    };
  }
}

const processOsvLimiter = new OsvConcurrencyLimiter();
const inFlightQueries = new Map<string, {
  promise: Promise<OsvDetailedResult>;
  controller: AbortController;
  subscribers: number;
}>();

function queryKey(input: OsvFeedInput): string {
  return `${input.ecosystem}\u0000${input.packageName}\u0000${input.packageVersion}`;
}

function isCoalescable(input: OsvFeedInput): boolean {
  return input.permission?.allowed === true
    && input.permission.basis === 'VERIFIED_PUBLIC_NPM'
    && input.ecosystem === 'npm'
    && typeof input.packageName === 'string'
    && typeof input.packageVersion === 'string'
    && validateNpmPackageName(input.packageName).validForNewPackages
    && validSemver(input.packageVersion) === input.packageVersion
    && Number.isFinite(input.remainingMs)
    && input.remainingMs > 0;
}

function parentAbortedResult(input: OsvFeedInput): OsvDetailedResult {
  return {
    result: {
      source: 'OSV', feedStatus: 'TIMEOUT',
      query: { ecosystem: input.ecosystem, packageName: input.packageName, packageVersion: input.packageVersion },
      advisories: [], complete: false, pagesFetched: 0, collectedAt: null, completedAt: null,
      errorCode: 'PARENT_ABORTED', skippedReason: null,
    },
  };
}

function deadlineResult(input: OsvFeedInput): OsvDetailedResult {
  return {
    result: {
      source: 'OSV', feedStatus: 'TIMEOUT',
      query: { ecosystem: input.ecosystem, packageName: input.packageName, packageVersion: input.packageVersion },
      advisories: [], complete: false, pagesFetched: 0, collectedAt: null, completedAt: null,
      errorCode: 'DEADLINE_EXCEEDED', skippedReason: null,
    },
  };
}

export class OsvFeedClient {
  private readonly limits: OsvLimits;

  constructor(
    limits: Partial<OsvLimits> = {},
    private readonly transport: OsvTransport = defaultTransport,
    private readonly limiter: OsvConcurrencyLimiter = processOsvLimiter,
  ) {
    this.limits = { ...DEFAULT_OSV_LIMITS, ...limits };
    for (const [name, value] of Object.entries(this.limits)) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new TypeError(`OSV ${name} must be a positive safe integer`);
      }
    }
    this.limits.timeoutMs = Math.min(2_000, this.limits.timeoutMs);
  }

  async query(input: OsvFeedInput, options: OsvQueryOptions = {}): Promise<OsvFeedResult> {
    return (await this.queryDetailed(input, options)).result;
  }

  async queryDetailed(input: OsvFeedInput, options: OsvQueryOptions = {}): Promise<OsvDetailedResult> {
    if (input.signal.aborted) return parentAbortedResult(input);
    if (options.coalesce === false || !isCoalescable(input)) return this.queryUncoalesced(input);
    const key = queryKey(input);
    let shared = inFlightQueries.get(key);
    if (shared === undefined) {
      const controller = new AbortController();
      const promise = this.queryUncoalesced({ ...input, signal: controller.signal });
      shared = { promise, controller, subscribers: 0 };
      inFlightQueries.set(key, shared);
      void promise.finally(() => {
        if (inFlightQueries.get(key)?.promise === promise) inFlightQueries.delete(key);
      }).catch(() => undefined);
    }
    shared.subscribers++;
    try {
      return await this.withCallerAbort(shared.promise, input);
    } finally {
      shared.subscribers--;
      if (shared.subscribers === 0 && !shared.controller.signal.aborted) shared.controller.abort(new OsvCollectionError('PARENT_ABORTED'));
    }
  }

  private async withCallerAbort(
    promise: Promise<OsvDetailedResult>,
    input: OsvFeedInput,
  ): Promise<OsvDetailedResult> {
    if (input.signal.aborted) return parentAbortedResult(input);
    return new Promise<OsvDetailedResult>((resolve) => {
      let settled = false;
      const finish = (value: OsvDetailedResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        input.signal.removeEventListener('abort', onAbort);
        resolve(value);
      };
      const onAbort = (): void => {
        finish(parentAbortedResult(input));
      };
      const timer = setTimeout(() => finish(deadlineResult(input)), input.remainingMs);
      input.signal.addEventListener('abort', onAbort, { once: true });
      void promise.then((value) => {
        finish(value);
      });
    });
  }

  private async queryUncoalesced(input: OsvFeedInput): Promise<OsvDetailedResult> {
    const started = performance.now();
    const result: OsvFeedResult = {
      source: 'OSV',
      feedStatus: 'SKIPPED',
      query: {
        ecosystem: input.ecosystem,
        packageName: input.packageName,
        packageVersion: input.packageVersion,
      },
      advisories: [],
      complete: false,
      pagesFetched: 0,
      collectedAt: null,
      completedAt: null,
      errorCode: null,
      skippedReason: null,
    };
    const skip = (reason: OsvSkippedReason): OsvDetailedResult => ({ result: { ...result, skippedReason: reason } });
    if (input.permission?.allowed !== true) {
      return skip(input.permission?.reason ?? 'PROVENANCE_UNCONFIRMED');
    }
    if (input.permission.basis !== 'VERIFIED_PUBLIC_NPM') return skip('PROVENANCE_UNCONFIRMED');
    if (input.ecosystem !== 'npm') return skip('UNSUPPORTED_TARGET');
    if (typeof input.packageName !== 'string' || typeof input.packageVersion !== 'string' ||
        !validateNpmPackageName(input.packageName).validForNewPackages ||
        validSemver(input.packageVersion) !== input.packageVersion) {
      return skip('INVALID_PACKAGE_IDENTITY');
    }
    if (!Number.isFinite(input.remainingMs)) return skip('INVALID_SCAN_BUDGET');
    if (input.signal.aborted) return { result: { ...result, feedStatus: 'TIMEOUT', errorCode: 'PARENT_ABORTED' } };
    if (input.remainingMs <= 0) return { result: { ...result, feedStatus: 'TIMEOUT', errorCode: 'SCAN_BUDGET_EXHAUSTED' } };

    const deadline = started + Math.min(this.limits.timeoutMs, input.remainingMs);
    const controller = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let retryAfterMs: number | undefined;
    const check = (): void => {
      if (controller.signal.aborted) throw controller.signal.reason;
      if (performance.now() >= deadline) throw new OsvCollectionError('DEADLINE_EXCEEDED');
    };
    let rejectStop!: (error: OsvCollectionError) => void;
    const stopped = new Promise<never>((_, reject) => { rejectStop = reject; });
    const stop = (code: 'PARENT_ABORTED' | 'DEADLINE_EXCEEDED'): void => {
      if (controller.signal.aborted) return;
      const error = new OsvCollectionError(code);
      rejectStop(error);
      controller.abort(error);
      void reader?.cancel().catch(() => undefined);
    };
    const onAbort = (): void => stop('PARENT_ABORTED');
    input.signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => stop('DEADLINE_EXCEEDED'), Math.max(0, deadline - performance.now()));
    const collect = async (): Promise<Record<string, unknown>[]> => {
      const advisories: Record<string, unknown>[] = [];
      const tokens = new Set<string>();
      let nextToken: string | undefined;
      let totalBytes = 0;
      do {
        check();
        if (result.pagesFetched >= this.limits.maxPages) throw new OsvCollectionError('PAGE_LIMIT_EXCEEDED');
        result.collectedAt ??= new Date().toISOString();
        const release = await this.limiter.acquire(controller.signal);
        let response: OsvTransportResponse;
        try {
          response = await this.transport(OSV_QUERY_ENDPOINT, {
          method: 'POST',
          redirect: 'manual',
          signal: controller.signal,
          headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify({
            package: { ecosystem: input.ecosystem, name: input.packageName },
            version: input.packageVersion,
            ...(nextToken === undefined ? {} : { page_token: nextToken }),
          }),
          });
        } finally {
          release();
        }
        retryAfterMs = parseRetryAfter(response.headers);
        // A non-cooperative injected transport may settle after the caller timed out.
        if (controller.signal.aborted) {
          void response.body?.cancel().catch(() => undefined);
          check();
        }
        reader = response.body?.getReader();
        check();
        if (response.status < 200 || response.status >= 300) throw new OsvCollectionError('HTTP_ERROR');
        const decoder = new TextDecoder('utf-8', { fatal: true });
        const guard = new OsvJsonGuard(this.limits);
        let pageBytes = 0;
        let text = '';
        if (reader) {
          while (true) {
            check();
            const chunk = await reader.read();
            check();
            if (chunk.done) break;
            pageBytes += chunk.value.byteLength;
            totalBytes += chunk.value.byteLength;
            if (pageBytes > this.limits.maxPageBytes) throw new OsvCollectionError('RESPONSE_TOO_LARGE');
            if (totalBytes > this.limits.maxTotalBytes) throw new OsvCollectionError('TOTAL_RESPONSE_TOO_LARGE');
            let decoded: string;
            try {
              decoded = decoder.decode(chunk.value, { stream: true });
            } catch {
              throw new OsvCollectionError('INVALID_JSON');
            }
            guard.accept(decoded);
            text += decoded;
          }
          reader.releaseLock();
          reader = undefined;
        }
        let tail: string;
        try {
          tail = decoder.decode();
        } catch {
          throw new OsvCollectionError('INVALID_JSON');
        }
        guard.accept(tail);
        const page = parseOsvPage(text + tail);
        check();
        result.pagesFetched++;
        for (const advisory of page.advisories) advisories.push(advisory);
        nextToken = page.nextToken;
        if (nextToken !== undefined) {
          if (tokens.has(nextToken)) throw new OsvCollectionError('REPEATED_PAGE_TOKEN');
          tokens.add(nextToken);
        }
      } while (nextToken !== undefined);
      check();
      return advisories;
    };
    try {
      const advisories = await Promise.race([collect(), stopped]);
      check();
      return { result: {
          ...result,
          feedStatus: 'SUCCESS',
          advisories,
          complete: true,
          completedAt: new Date().toISOString(),
        }, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) };
    } catch (error) {
      const code = error instanceof OsvCollectionError ? error.code : 'NETWORK_ERROR';
      return { result: {
          ...result,
          feedStatus: code === 'PARENT_ABORTED' || code === 'DEADLINE_EXCEEDED'
            ? 'TIMEOUT' : 'FAILED',
          errorCode: code,
        }, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) };
    } finally {
      clearTimeout(timer);
      input.signal.removeEventListener('abort', onAbort);
      controller.abort();
      void reader?.cancel().catch(() => undefined);
    }
  }
}

function parseRetryAfter(headers: OsvTransportResponse['headers']): number | undefined {
  const value = headers?.get('retry-after');
  if (value === null || value === undefined) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1_000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}
