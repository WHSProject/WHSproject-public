import { Injectable } from '@nestjs/common';

const DEFAULT_ROOT_INTENT_TTL_MS = 60_000;

interface RootInstallIntent {
  packageName: string;
  expiresAt: number;
}

@Injectable()
export class RootInstallIntentService {
  private readonly intents = new Map<string, RootInstallIntent>();

  register(
    packageName: string,
    ttlMs = DEFAULT_ROOT_INTENT_TTL_MS,
  ): void {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new TypeError('ttlMs must be a positive number');
    }

    this.intents.set(packageName, {
      packageName,
      expiresAt: Date.now() + ttlMs,
    });
  }

  consume(packageName: string): boolean {
    const intent = this.intents.get(packageName);

    if (!intent) {
      return false;
    }

    this.intents.delete(packageName);

    if (intent.expiresAt <= Date.now()) {
      return false;
    }

    return true;
  }

  clear(): void {
    this.intents.clear();
  }
}
