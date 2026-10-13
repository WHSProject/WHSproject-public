import type { OsvErrorCode, OsvLimits } from './osv-feed.types';

export class OsvCollectionError extends Error {
  constructor(readonly code: OsvErrorCode) {
    super(code);
    this.name = 'OsvCollectionError';
  }
}

/** Streaming lexical bounds, applied before JSON.parse; escapes count conservatively. */
export class OsvJsonGuard {
  private depth = 0;
  private inString = false;
  private escaped = false;
  private stringLength = 0;

  constructor(private readonly limits: OsvLimits) {}

  accept(text: string): void {
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (this.inString) {
        if (!this.escaped && c === '"') {
          this.inString = false;
          continue;
        }
        if (++this.stringLength > this.limits.maxJsonStringLength) {
          throw new OsvCollectionError('JSON_STRING_TOO_LONG');
        }
        if (this.escaped) this.escaped = false;
        else if (c === '\\') this.escaped = true;
      } else if (c === '"') {
        this.inString = true;
        this.stringLength = 0;
      } else if (c === '{' || c === '[') {
        if (++this.depth > this.limits.maxJsonDepth) {
          throw new OsvCollectionError('JSON_TOO_DEEP');
        }
      } else if (c === '}' || c === ']') {
        this.depth--;
      }
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function parseOsvPage(text: string): {
  advisories: Record<string, unknown>[];
  nextToken: string | undefined;
} {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new OsvCollectionError('INVALID_JSON');
  }
  if (!isRecord(value) ||
      (value.vulns !== undefined && (!Array.isArray(value.vulns) || !value.vulns.every(isRecord))) ||
      (value.next_page_token !== undefined && typeof value.next_page_token !== 'string')) {
    throw new OsvCollectionError('INVALID_RESPONSE');
  }
  return {
    advisories: (value.vulns ?? []) as Record<string, unknown>[],
    nextToken: (value.next_page_token || undefined) as string | undefined,
  };
}
