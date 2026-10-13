import type { SealedSmokeManifest } from './smoke-invocation-budget';

export type SmokeHarnessPhase = 'SELECT' | 'PREFLIGHT' | 'SEALED' | 'EXECUTE';

/** Phase helpers deliberately have no analyzer dependency in selection or preflight. */
export function selectSmokeCohort<T>(candidates: readonly T[]): readonly T[] {
  return Object.freeze([...candidates]);
}

export async function preflightSmokeEnvironment(
  checks: readonly (() => Promise<void>)[],
): Promise<void> {
  for (const check of checks) await check();
}

export async function executeSealedSample<T>(
  manifest: SealedSmokeManifest,
  sampleId: string,
  analyze: () => Promise<T>,
): Promise<T> {
  if (!manifest.sealed || !manifest.sampleIds.includes(sampleId)) {
    throw new Error('SMOKE_SAMPLE_NOT_IN_SEALED_MANIFEST');
  }
  return analyze();
}
