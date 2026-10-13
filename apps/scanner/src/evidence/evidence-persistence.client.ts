import { Injectable } from '@nestjs/common';

export class EvidencePersistenceError extends Error {
  constructor(message: string, readonly statusCode?: number, readonly retryable = false) { super(message); }
}

/** Stores the already-produced Scanner Evidence for later feed re-evaluation.
 * This client never creates derived or synthetic Evidence.
 */
@Injectable()
export class EvidencePersistenceClient {
  constructor(
    private readonly baseUrl = process.env.EVIDENCE_DB_URL ?? 'http://evidence-api:8100',
    private readonly timeoutMs = Number(process.env.EVIDENCE_DB_TIMEOUT_MS ?? 5_000),
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async saveAll(evidences: readonly unknown[], signal?: AbortSignal): Promise<void> {
    for (const evidence of evidences) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      const onAbort = (): void => controller.abort(signal?.reason);
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        const response = await this.fetcher(`${this.baseUrl.replace(/\/+$/u, '')}/internal/v1/evidences`, {
          method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' },
          body: JSON.stringify(evidence), signal: controller.signal,
        });
        if (response.status === 409) continue;
        if (!response.ok) throw new EvidencePersistenceError(`EVIDENCE_DB_HTTP_${response.status}`, response.status, response.status >= 500);
      } catch (error) {
        if (error instanceof EvidencePersistenceError) throw error;
        throw new EvidencePersistenceError(controller.signal.aborted ? 'EVIDENCE_DB_TIMEOUT' : 'EVIDENCE_DB_UNAVAILABLE', undefined, true);
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', onAbort);
      }
    }
  }
}
