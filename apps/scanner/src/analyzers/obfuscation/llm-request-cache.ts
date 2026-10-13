import { createHash } from 'node:crypto';

import type {
  AgentAnalysisRequestV0_1,
  CodeUnderstandingAssistant,
  GptShadowOutcome,
} from './agent-analysis.types';
import { canonicalizeEvidencePath } from './path-utils';

export const LLM_REQUEST_CACHE_STATUSES = [
  'HIT',
  'MISS',
  'COALESCED',
  'BYPASS',
] as const;

export type LlmRequestCacheStatus = (typeof LLM_REQUEST_CACHE_STATUSES)[number];

export interface LlmRequestIdentityOptions {
  provider: NonNullable<GptShadowOutcome['provider']>;
  model: string;
  promptVersion: string;
  analyzerVersion: string;
  request: AgentAnalysisRequestV0_1;
}

export interface LlmRequestCacheOptions {
  enabled: boolean;
  ttlMs: number;
  maxEntries: number;
}

interface CacheEntry {
  value: GptShadowOutcome;
  expiresAt: number;
}

/**
 * Builds the provider-visible semantic identity without volatile scan/request
 * identifiers or restore output paths.
 */
export function buildLlmRequestIdentity(
  options: LlmRequestIdentityOptions,
): Record<string, unknown> {
  const { request } = options;
  return {
    analyzerVersion: options.analyzerVersion,
    model: options.model,
    promptVersion: options.promptVersion,
    provider: options.provider,
    request: {
      schemaVersion: request.schemaVersion,
      sampleId: request.sampleId,
      purpose: request.purpose,
      package: canonicalizePackage(request.package),
      candidates: request.candidates
        .map(canonicalizeCandidate)
        .sort((left, right) => left.path.localeCompare(right.path)),
    },
  };
}

export function createLlmRequestHash(options: LlmRequestIdentityOptions): string {
  const canonical = canonicalJson(buildLlmRequestIdentity(options));
  return `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

export class BoundedLlmResultCache {
  private readonly entries = new Map<string, CacheEntry>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries: number,
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
      throw new Error('LLM cache TTL must be a positive safe integer');
    }
    if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
      throw new Error('LLM cache max entries must be a positive safe integer');
    }
  }

  get(key: string): GptShadowOutcome | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }

    // Refresh insertion order so eviction is bounded LRU-like behavior.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: GptShadowOutcome): void {
    this.removeExpired();
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  get size(): number {
    this.removeExpired();
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }

  private removeExpired(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
  }
}

export class CachedCodeUnderstandingAssistant implements CodeUnderstandingAssistant {
  private readonly inFlight = new Map<string, Promise<GptShadowOutcome>>();

  constructor(
    private readonly delegate: CodeUnderstandingAssistant,
    private readonly identity: Omit<LlmRequestIdentityOptions, 'request'> & {
      analyzerVersion: string;
    },
    private readonly options: LlmRequestCacheOptions,
    private readonly cache = new BoundedLlmResultCache(options.ttlMs, options.maxEntries),
    private readonly now: () => number = Date.now,
  ) {}

  async analyze(
    request: AgentAnalysisRequestV0_1,
    signal?: AbortSignal,
  ): Promise<GptShadowOutcome> {
    const startedAt = this.now();
    const requestHash = createLlmRequestHash({ ...this.identity, request });

    if (!this.options.enabled) {
      const outcome = await this.delegate.analyze(request, signal);
      return withCacheMetadata(outcome, requestHash, 'BYPASS');
    }

    const cached = this.cache.get(requestHash);
    if (cached !== undefined) {
      return withCacheMetadata(cached, requestHash, 'HIT', this.now() - startedAt);
    }

    const existing = this.inFlight.get(requestHash);
    if (existing !== undefined) {
      const outcome = await existing;
      return withCacheMetadata(outcome, requestHash, 'COALESCED', this.now() - startedAt);
    }

    const pending = this.delegate.analyze(request, signal);
    this.inFlight.set(requestHash, pending);
    try {
      const outcome = await pending;
      if (outcome.status === 'COMPLETED') this.cache.set(requestHash, outcome);
      return withCacheMetadata(outcome, requestHash, 'MISS');
    } finally {
      if (this.inFlight.get(requestHash) === pending) this.inFlight.delete(requestHash);
    }
  }

  get cacheSize(): number {
    return this.cache.size;
  }
}

function withCacheMetadata(
  outcome: GptShadowOutcome,
  requestHash: string,
  cacheStatus: LlmRequestCacheStatus,
  durationMs?: number,
): GptShadowOutcome {
  const usage = cacheStatus === 'HIT' || cacheStatus === 'COALESCED'
    ? outcome.status === 'COMPLETED'
      ? { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
      : undefined
    : outcome.usage === undefined
      ? undefined
      : {
          ...outcome.usage,
          ...(outcome.usage.totalTokens === undefined
            ? { totalTokens: outcome.usage.inputTokens + outcome.usage.outputTokens }
            : {}),
        };
  return {
    ...outcome,
    requestHash,
    cacheStatus,
    ...(usage === undefined ? {} : { usage }),
    ...(durationMs === undefined ? {} : { durationMs }),
  };
}

function canonicalizePackage(
  value: AgentAnalysisRequestV0_1['package'],
): Record<string, unknown> {
  return {
    ecosystem: value.ecosystem,
    name: value.name,
    version: value.version,
    artifactHash: value.artifactHash,
    description: value.description,
    lifecycleScripts: value.lifecycleScripts.map((script) => ({
      name: script.name,
      command: script.command,
    })),
  };
}

function canonicalizeCandidate(
  candidate: AgentAnalysisRequestV0_1['candidates'][number],
): AgentAnalysisRequestV0_1['candidates'][number] {
  return {
    ...candidate,
    path: canonicalizeEvidencePath(candidate.path),
    supportingReasons: [...candidate.supportingReasons].sort(),
    matchedSignals: [...candidate.matchedSignals].sort(),
    residualCapabilities: [...candidate.residualCapabilities].sort(),
    derivedNewRuleIds: [...candidate.derivedNewRuleIds].sort(),
    restoration: {
      ...candidate.restoration,
      limitations: [...candidate.restoration.limitations].sort(),
      stageResults: candidate.restoration.stageResults.map((stage) => ({
        stage: stage.stage,
        applied: stage.applied,
        status: stage.status,
        changed: stage.changed,
        ...(stage.reason === undefined ? {} : { reason: stage.reason }),
        ...(stage.detail === undefined ? {} : { detail: stage.detail }),
        ...(stage.metadata === undefined ? {} : { metadata: stage.metadata }),
      })),
      appliedStages: [...candidate.restoration.appliedStages],
      ...(candidate.restoration.reason === undefined
        ? {}
        : { reason: candidate.restoration.reason }),
      ...(candidate.restoration.validation === undefined
        ? {}
        : { validation: candidate.restoration.validation }),
    },
    evidences: candidate.evidences
      .map((evidence) => ({
        ...evidence,
        path: canonicalizeEvidencePath(evidence.path),
      }))
      .sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right))),
    // Slice order is prompt-visible and therefore deliberately preserved.
    slices: candidate.slices.map((slice) => ({
      ...slice,
      file: canonicalizeEvidencePath(slice.file),
    })),
  };
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalValue(item)]),
    );
  }
  return value;
}
