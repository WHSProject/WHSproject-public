import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export const SMOKE_INVOCATION_LEDGER_SCHEMA_VERSION = '1.0.0';

export type SmokeAnalyzerName = 'guarddog' | 'metadata' | 'custom-rule';
export type SmokeExecutionMode = 'REAL' | 'MOCK';
export type SmokeBackendAttestation = 'VERIFIED_EXTERNAL_CONTAINER' | 'TEST_DOUBLE';

export interface SmokeInvocationPolicy {
  runId: string;
  executionPurpose: string;
  approvedSampleIds: readonly string[];
  maxUniqueSamples: number;
  maxCallsPerSampleAnalyzer: number;
  maxTotalCalls: number;
  maxCallsByAnalyzer?: Partial<Record<SmokeAnalyzerName, number>>;
  retryLimit: 0;
  executionMode: SmokeExecutionMode;
}

export interface SealedSmokeManifest {
  runId: string;
  sampleIds: readonly string[];
  digest: string;
  sealed: true;
}

export interface SmokeInvocationCall {
  callId: string;
  sampleId: string;
  analyzer: SmokeAnalyzerName;
  executionMode: SmokeExecutionMode;
  backendAttestation: SmokeBackendAttestation;
  attempt: number;
}

export interface SmokeInvocationViolation {
  code: string;
  sampleId?: string;
  analyzer?: SmokeAnalyzerName;
}

export interface SmokeInvocationLedger {
  schemaVersion: typeof SMOKE_INVOCATION_LEDGER_SCHEMA_VERSION;
  runId: string;
  executionPurpose: string;
  approvedSampleIds: string[];
  maxUniqueSamples: number;
  maxCallsPerSampleAnalyzer: number;
  maxTotalCalls: number;
  maxCallsByAnalyzer: Record<SmokeAnalyzerName, number>;
  retryLimit: 0;
  executionMode: SmokeExecutionMode;
  sealedManifest?: SealedSmokeManifest;
  attemptedSampleIds: string[];
  calls: SmokeInvocationCall[];
  remainingBudget: number;
  violations: SmokeInvocationViolation[];
}

export interface SmokeInvocationReceipt {
  callId: string;
  consumedRealBudget: boolean;
}

/** A fail-closed, cross-process budget. Reservations happen before analyzer entry. */
export class AtomicSmokeInvocationBudget {
  private readonly lockPath: string;

  constructor(private readonly ledgerPath: string, private readonly policy: SmokeInvocationPolicy) {
    this.lockPath = `${ledgerPath}.lock`;
    validatePolicy(policy);
  }

  async initialize(): Promise<void> {
    await mkdir(dirname(this.ledgerPath), { recursive: true });
    await this.withLock(async () => {
      const existing = await this.readOptional();
      if (existing) {
        assertPolicyMatches(existing, this.policy);
        return;
      }
      await this.atomicWrite({
        schemaVersion: SMOKE_INVOCATION_LEDGER_SCHEMA_VERSION,
        runId: this.policy.runId,
        executionPurpose: this.policy.executionPurpose,
        approvedSampleIds: [...this.policy.approvedSampleIds].sort(),
        maxUniqueSamples: this.policy.maxUniqueSamples,
        maxCallsPerSampleAnalyzer: this.policy.maxCallsPerSampleAnalyzer,
        maxTotalCalls: this.policy.maxTotalCalls,
        maxCallsByAnalyzer: analyzerLimits(this.policy),
        retryLimit: 0,
        executionMode: this.policy.executionMode,
        attemptedSampleIds: [], calls: [], remainingBudget: this.policy.maxTotalCalls, violations: [],
      });
    });
  }

  async sealManifest(sampleIds: readonly string[]): Promise<SealedSmokeManifest> {
    return this.withLock(async () => {
      const ledger = await this.readRequired();
      const normalized = [...sampleIds];
      if (new Set(normalized).size !== normalized.length) return this.reject(ledger, 'DUPLICATE_MANIFEST_SAMPLE');
      if (normalized.length > ledger.maxUniqueSamples) return this.reject(ledger, 'UNIQUE_SAMPLE_LIMIT_EXCEEDED');
      if (normalized.some((id) => !ledger.approvedSampleIds.includes(id))) return this.reject(ledger, 'SAMPLE_NOT_APPROVED');
      const digest = manifestDigest(ledger.runId, normalized);
      if (ledger.sealedManifest) {
        if (ledger.sealedManifest.digest !== digest) return this.reject(ledger, 'SEALED_MANIFEST_IMMUTABLE');
        return ledger.sealedManifest;
      }
      const sealedManifest: SealedSmokeManifest = { runId: ledger.runId, sampleIds: normalized, digest, sealed: true };
      ledger.sealedManifest = sealedManifest;
      await this.atomicWrite(ledger);
      return sealedManifest;
    });
  }

  async reserve(sampleId: string, analyzer: SmokeAnalyzerName, attestation: SmokeBackendAttestation): Promise<SmokeInvocationReceipt> {
    return this.withLock(async () => {
      const ledger = await this.readRequired();
      if (!ledger.sealedManifest) return this.reject(ledger, 'MANIFEST_NOT_SEALED', sampleId, analyzer);
      if (!ledger.approvedSampleIds.includes(sampleId)) return this.reject(ledger, 'SAMPLE_NOT_APPROVED', sampleId, analyzer);
      if (!ledger.sealedManifest.sampleIds.includes(sampleId)) return this.reject(ledger, 'SAMPLE_NOT_IN_SEALED_MANIFEST', sampleId, analyzer);
      const expectedAttestation = ledger.executionMode === 'REAL' ? 'VERIFIED_EXTERNAL_CONTAINER' : 'TEST_DOUBLE';
      if (attestation !== expectedAttestation) return this.reject(ledger, 'BACKEND_ATTESTATION_MISMATCH', sampleId, analyzer);

      if (ledger.executionMode === 'MOCK') {
        return { callId: `mock-${randomUUID()}`, consumedRealBudget: false };
      }
      const previous = ledger.calls.filter((call) => call.sampleId === sampleId && call.analyzer === analyzer).length;
      const analyzerCalls = ledger.calls.filter((call) => call.analyzer === analyzer).length;
      if (analyzerCalls >= ledger.maxCallsByAnalyzer[analyzer]) {
        return this.reject(ledger, 'ANALYZER_CALL_LIMIT_EXCEEDED', sampleId, analyzer);
      }
      if (previous >= ledger.maxCallsPerSampleAnalyzer || (ledger.retryLimit === 0 && previous > 0)) {
        return this.reject(ledger, 'DUPLICATE_ANALYZER_INVOCATION', sampleId, analyzer);
      }
      const attempted = new Set(ledger.attemptedSampleIds);
      attempted.add(sampleId);
      if (attempted.size > ledger.maxUniqueSamples) return this.reject(ledger, 'UNIQUE_SAMPLE_LIMIT_EXCEEDED', sampleId, analyzer);
      if (ledger.calls.length >= ledger.maxTotalCalls) return this.reject(ledger, 'TOTAL_CALL_LIMIT_EXCEEDED', sampleId, analyzer);
      const callId = randomUUID();
      ledger.calls.push({ callId, sampleId, analyzer, executionMode: 'REAL', backendAttestation: attestation, attempt: previous + 1 });
      ledger.attemptedSampleIds = [...attempted].sort();
      ledger.remainingBudget = ledger.maxTotalCalls - ledger.calls.length;
      await this.atomicWrite(ledger);
      return { callId, consumedRealBudget: true };
    });
  }

  async read(): Promise<SmokeInvocationLedger> { return this.readRequired(); }

  private async reject<T>(ledger: SmokeInvocationLedger, code: string, sampleId?: string, analyzer?: SmokeAnalyzerName): Promise<T> {
    ledger.violations.push({ code, ...(sampleId ? { sampleId } : {}), ...(analyzer ? { analyzer } : {}) });
    await this.atomicWrite(ledger);
    throw new Error(`SMOKE_INVOCATION_BUDGET:${code}`);
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    let handle;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      try { handle = await open(this.lockPath, 'wx', 0o600); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
    if (!handle) throw new Error('SMOKE_INVOCATION_LEDGER_LOCK_TIMEOUT');
    try { return await operation(); }
    finally { await handle.close(); await unlink(this.lockPath).catch(() => undefined); }
  }

  private async readOptional(): Promise<SmokeInvocationLedger | undefined> {
    try { return JSON.parse(await readFile(this.ledgerPath, 'utf8')) as SmokeInvocationLedger; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  }
  private async readRequired(): Promise<SmokeInvocationLedger> {
    const ledger = await this.readOptional();
    if (!ledger) throw new Error('SMOKE_INVOCATION_LEDGER_NOT_INITIALIZED');
    assertPolicyMatches(ledger, this.policy);
    return ledger;
  }
  private async atomicWrite(ledger: SmokeInvocationLedger): Promise<void> {
    const temporary = `${this.ledgerPath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.ledgerPath);
  }
}

function manifestDigest(runId: string, sampleIds: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify({ runId, sampleIds })).digest('hex');
}

function validatePolicy(policy: SmokeInvocationPolicy): void {
  if (!policy.runId || !policy.executionPurpose) throw new Error('SMOKE_INVOCATION_POLICY_INVALID');
  if (new Set(policy.approvedSampleIds).size !== policy.approvedSampleIds.length) throw new Error('SMOKE_APPROVED_SAMPLE_DUPLICATE');
  if (policy.maxUniqueSamples < 1 || policy.maxUniqueSamples > policy.approvedSampleIds.length) throw new Error('SMOKE_UNIQUE_LIMIT_INVALID');
  if (policy.maxCallsPerSampleAnalyzer < 1 || policy.maxTotalCalls < 1 || policy.retryLimit !== 0) throw new Error('SMOKE_CALL_LIMIT_INVALID');
  if (Object.values(analyzerLimits(policy)).some((value) => !Number.isSafeInteger(value) || value < 0)) throw new Error('SMOKE_ANALYZER_LIMIT_INVALID');
}

function assertPolicyMatches(ledger: SmokeInvocationLedger, policy: SmokeInvocationPolicy): void {
  const expected = JSON.stringify({ runId: policy.runId, purpose: policy.executionPurpose, approved: [...policy.approvedSampleIds].sort(), unique: policy.maxUniqueSamples, per: policy.maxCallsPerSampleAnalyzer, total: policy.maxTotalCalls, analyzers: analyzerLimits(policy), retry: policy.retryLimit, mode: policy.executionMode });
  const actual = JSON.stringify({ runId: ledger.runId, purpose: ledger.executionPurpose, approved: ledger.approvedSampleIds, unique: ledger.maxUniqueSamples, per: ledger.maxCallsPerSampleAnalyzer, total: ledger.maxTotalCalls, analyzers: ledger.maxCallsByAnalyzer, retry: ledger.retryLimit, mode: ledger.executionMode });
  if (actual !== expected) throw new Error('SMOKE_INVOCATION_POLICY_MISMATCH');
}

function analyzerLimits(policy: SmokeInvocationPolicy): Record<SmokeAnalyzerName, number> {
  return {
    guarddog: policy.maxCallsByAnalyzer?.guarddog ?? policy.maxTotalCalls,
    metadata: policy.maxCallsByAnalyzer?.metadata ?? policy.maxTotalCalls,
    'custom-rule': policy.maxCallsByAnalyzer?.['custom-rule'] ?? policy.maxTotalCalls,
  };
}
