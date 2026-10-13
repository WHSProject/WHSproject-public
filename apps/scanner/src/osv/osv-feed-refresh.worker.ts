import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import type { OsvFeedClient, OsvDetailedResult } from './osv-feed-client';
import type { OsvFeedInput, OsvFeedResult } from './osv-feed.types';
import { FEED_SNAPSHOT_STORE, type FeedRefreshCandidate, type FeedSnapshotStore } from './osv-feed-cache';

export type RefreshJobStatus = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'TIMEOUT';

export interface RefreshJob {
  jobId: string;
  packageName: string;
  packageVersion: string;
  status: RefreshJobStatus;
  attemptCount: number;
  snapshotId: string | null;
  errorCode: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface RefreshWorkerOptions {
  intervalMs?: number;
  lookbackMs?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
  maxRetryAfterMs?: number;
  requestTimeoutMs?: number;
  circuitFailureThreshold?: number;
  circuitOpenMs?: number;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export interface ReevaluationTrigger {
  process(jobId: string, signal: AbortSignal): Promise<void>;
}

export interface FeedRefreshValidator {
  validate(feed: OsvFeedResult, signal: AbortSignal): Promise<{ contentDigest: string; validationResult: Record<string, unknown> }>;
}

export class HttpFeedRefreshValidator implements FeedRefreshValidator {
  constructor(
    private readonly baseUrl = process.env.POLICY_URL ?? 'http://localhost:8000',
    private readonly timeoutMs = Number(process.env.POLICY_TIMEOUT_MS ?? 10_000),
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async validate(feed: OsvFeedResult, signal: AbortSignal): Promise<{ contentDigest: string; validationResult: Record<string, unknown> }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const onAbort = (): void => controller.abort(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      const response = await this.fetcher(`${this.baseUrl.replace(/\/+$/u, '')}/internal/v1/feed-validation`, {
        method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({ feed }), signal: controller.signal,
      });
      if (!response.ok) throw new Error(`FEED_VALIDATION_HTTP_${response.status}`);
      const body = await response.json() as Record<string, unknown>;
      if (typeof body.contentDigest !== 'string' || typeof body.validationResult !== 'object' || body.validationResult === null) throw new Error('FEED_VALIDATION_INVALID_RESPONSE');
      return { contentDigest: body.contentDigest, validationResult: body.validationResult as Record<string, unknown> };
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
    }
  }
}

export class HttpReevaluationTrigger implements ReevaluationTrigger {
  constructor(
    private readonly baseUrl = process.env.POLICY_URL ?? 'http://localhost:8000',
    private readonly timeoutMs = Number(process.env.POLICY_TIMEOUT_MS ?? 10_000),
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async process(jobId: string, signal: AbortSignal): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const onAbort = (): void => controller.abort(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      const response = await this.fetcher(`${this.baseUrl.replace(/\/+$/u, '')}/internal/v1/reevaluation-jobs/${encodeURIComponent(jobId)}/process`, { method: 'POST', headers: { accept: 'application/json' }, signal: controller.signal });
      if (!response.ok) throw new Error(`REEVALUATION_PROCESS_HTTP_${response.status}`);
      const body = await response.json() as { status?: unknown; errorCode?: unknown };
      if (body.status === 'FAILED') throw new Error(typeof body.errorCode === 'string' ? body.errorCode : 'REEVALUATION_FAILED');
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
    }
  }
}

interface CircuitState {
  state: 'CLOSED' | 'OPEN' | 'HALF_OPEN';
  failures: number;
  openedAt: number | null;
  probeInFlight: boolean;
}

/** Background OSV refresh is intentionally independent from a live package scan. */
@Injectable()
export class OsvFeedRefreshWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OsvFeedRefreshWorker.name);
  private readonly jobs = new Map<string, RefreshJob>();
  private readonly runningKeys = new Set<string>();
  private readonly circuits = new Map<string, CircuitState>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private shutdownController = new AbortController();
  private readonly options: Required<RefreshWorkerOptions>;

  constructor(
    private readonly client: OsvFeedClient,
    @Inject(FEED_SNAPSHOT_STORE)
    private readonly store: FeedSnapshotStore,
    options: RefreshWorkerOptions = {},
    private readonly reevaluationTrigger?: ReevaluationTrigger,
    private readonly feedValidator?: FeedRefreshValidator,
  ) {
    this.options = {
      intervalMs: options.intervalMs ?? 3_600_000,
      lookbackMs: options.lookbackMs ?? 7 * 24 * 3_600_000,
      maxAttempts: options.maxAttempts ?? 3,
      retryDelayMs: options.retryDelayMs ?? 250,
      maxRetryAfterMs: options.maxRetryAfterMs ?? 30_000,
      requestTimeoutMs: options.requestTimeoutMs ?? 2_500,
      circuitFailureThreshold: options.circuitFailureThreshold ?? 3,
      circuitOpenMs: options.circuitOpenMs ?? 60_000,
      now: options.now ?? Date.now,
      sleep: options.sleep ?? defaultSleep,
    };
  }

  onModuleInit(): void {
    if (process.env.OSV_REFRESH_WORKER_ENABLED === 'false') return;
    this.start();
  }

  onModuleDestroy(): void {
    this.stop();
  }

  start(): void {
    if (this.timer !== undefined) return;
    if (this.shutdownController.signal.aborted) this.shutdownController = new AbortController();
    this.timer = setInterval(() => { void this.runOnce(); }, this.options.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    this.shutdownController.abort(new Error('WORKER_STOPPED'));
  }

  async runOnce(signal: AbortSignal = new AbortController().signal): Promise<RefreshJob[]> {
    const effectiveSignal = AbortSignal.any([signal, this.shutdownController.signal]);
    const candidates = await this.store.listRefreshCandidates(
      new Date(this.options.now() - this.options.lookbackMs).toISOString(),
      effectiveSignal,
    );
    const results: RefreshJob[] = [];
    for (const candidate of candidates) {
      if (effectiveSignal.aborted) break;
      const job = await this.refreshCandidate(candidate, effectiveSignal);
      if (job !== null) results.push(job);
    }
    return results;
  }

  forceRefresh(packageName: string, packageVersion: string): RefreshJob {
    const key = this.key(packageName, packageVersion);
    const existing = [...this.jobs.values()].find((job) => this.key(job.packageName, job.packageVersion) === key && ['QUEUED', 'RUNNING'].includes(job.status));
    if (existing !== undefined) return { ...existing };
    const now = new Date(this.options.now()).toISOString();
    const job: RefreshJob = { jobId: randomUUID(), packageName, packageVersion, status: 'QUEUED', attemptCount: 0, snapshotId: null, errorCode: null, createdAt: now, startedAt: null, completedAt: null };
    this.jobs.set(job.jobId, job);
    void this.runJob(job, { source: 'OSV', ecosystem: 'npm', packageName, packageVersion, lastRequestedAt: now }, this.shutdownController.signal);
    return { ...job };
  }

  getJob(jobId: string): RefreshJob | null {
    const job = this.jobs.get(jobId);
    return job === undefined ? null : { ...job };
  }

  circuitStatus(packageName: string, packageVersion: string): CircuitState['state'] {
    return this.circuits.get(this.key(packageName, packageVersion))?.state ?? 'CLOSED';
  }

  private async refreshCandidate(candidate: FeedRefreshCandidate, signal: AbortSignal): Promise<RefreshJob | null> {
    const key = this.key(candidate.packageName, candidate.packageVersion);
    if (this.runningKeys.has(key)) return null;
    const state = this.circuitFor(key);
    if (!this.allowCircuit(state)) return null;
    const now = new Date(this.options.now()).toISOString();
    const job: RefreshJob = { jobId: randomUUID(), packageName: candidate.packageName, packageVersion: candidate.packageVersion, status: 'QUEUED', attemptCount: 0, snapshotId: null, errorCode: null, createdAt: now, startedAt: null, completedAt: null };
    this.jobs.set(job.jobId, job);
    return this.runJob(job, candidate, signal);
  }

  private async runJob(job: RefreshJob, candidate: FeedRefreshCandidate, parentSignal: AbortSignal): Promise<RefreshJob> {
    const key = this.key(job.packageName, job.packageVersion);
    if (this.runningKeys.has(key)) return { ...job };
    this.runningKeys.add(key);
    job.status = 'RUNNING';
    job.startedAt = new Date(this.options.now()).toISOString();
    const controller = new AbortController();
    const onAbort = (): void => controller.abort(parentSignal.reason);
    parentSignal.addEventListener('abort', onAbort, { once: true });
    try {
      for (let attempt = 1; attempt <= this.options.maxAttempts; attempt++) {
        job.attemptCount = attempt;
        const detailed = await this.query(candidate, controller.signal);
        const validation = this.feedValidator === undefined || detailed.result.feedStatus !== 'SUCCESS' || !detailed.result.complete
          ? undefined
          : await this.feedValidator.validate(detailed.result, controller.signal);
        const persisted = await this.store.persistLookup({ requestId: randomUUID(), scanId: null, feed: detailed.result, ...validation }, controller.signal);
        for (const jobId of persisted.reevaluationJobIds ?? []) {
          await this.reevaluationTrigger?.process(jobId, controller.signal);
        }
        if (detailed.result.feedStatus === 'SUCCESS' && detailed.result.complete) {
          this.recordSuccess(key);
          job.status = 'SUCCEEDED';
          job.snapshotId = persisted.snapshotId;
          job.completedAt = new Date(this.options.now()).toISOString();
          break;
        }
        job.errorCode = detailed.result.errorCode;
        this.recordFailure(key);
        if (attempt >= this.options.maxAttempts || !this.retryable(detailed.result)) {
          job.status = detailed.result.feedStatus === 'TIMEOUT' ? 'TIMEOUT' : 'FAILED';
          job.completedAt = new Date(this.options.now()).toISOString();
          break;
        }
        const waitMs = Math.min(detailed.retryAfterMs ?? this.options.retryDelayMs * attempt, this.options.maxRetryAfterMs);
        await this.options.sleep(waitMs, controller.signal);
      }
    } catch (error) {
      job.status = controller.signal.aborted || parentSignal.aborted ? 'TIMEOUT' : 'FAILED';
      job.errorCode = controller.signal.aborted ? 'PARENT_ABORTED' : 'WORKER_ERROR';
      job.completedAt = new Date(this.options.now()).toISOString();
      this.recordFailure(key);
      this.logger.warn(`OSV refresh failed for ${key}: ${job.errorCode}`);
      void error;
    } finally {
      parentSignal.removeEventListener('abort', onAbort);
      this.runningKeys.delete(key);
    }
    return { ...job };
  }

  private async query(candidate: FeedRefreshCandidate, signal: AbortSignal): Promise<OsvDetailedResult> {
    const controller = new AbortController();
    const onAbort = (): void => controller.abort(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    const timeout = setTimeout(() => controller.abort(new Error('WORKER_REQUEST_TIMEOUT')), this.options.requestTimeoutMs);
    try {
      const input: OsvFeedInput = { ecosystem: 'npm', packageName: candidate.packageName, packageVersion: candidate.packageVersion, permission: { allowed: true, basis: 'VERIFIED_PUBLIC_NPM' }, remainingMs: this.options.requestTimeoutMs, signal: controller.signal };
      const detailed = this.client.queryDetailed?.(input, { coalesce: false });
      if (detailed !== undefined) return detailed;
      return { result: await this.client.query(input) };
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
    }
  }

  private circuitFor(key: string): CircuitState {
    let state = this.circuits.get(key);
    if (state === undefined) {
      state = { state: 'CLOSED', failures: 0, openedAt: null, probeInFlight: false };
      this.circuits.set(key, state);
    }
    return state;
  }

  private allowCircuit(state: CircuitState): boolean {
    if (state.state === 'CLOSED') return true;
    if (state.state === 'OPEN' && state.openedAt !== null && this.options.now() - state.openedAt >= this.options.circuitOpenMs) {
      state.state = 'HALF_OPEN'; state.probeInFlight = false;
    }
    if (state.state === 'HALF_OPEN' && state.probeInFlight) return false;
    if (state.state === 'HALF_OPEN') state.probeInFlight = true;
    return state.state !== 'OPEN';
  }

  private recordSuccess(key: string): void {
    const state = this.circuitFor(key); state.state = 'CLOSED'; state.failures = 0; state.openedAt = null; state.probeInFlight = false;
  }

  private recordFailure(key: string): void {
    const state = this.circuitFor(key); state.probeInFlight = false; state.failures++;
    if (state.failures >= this.options.circuitFailureThreshold) { state.state = 'OPEN'; state.openedAt = this.options.now(); }
  }

  private retryable(feed: OsvFeedResult): boolean { return feed.feedStatus === 'FAILED' || feed.feedStatus === 'TIMEOUT'; }
  private key(packageName: string, packageVersion: string): string { return `npm\u0000${packageName}\u0000${packageVersion}`; }
}

async function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const onAbort = (): void => { clearTimeout(timer); reject(signal.reason ?? new Error('aborted')); };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
