import type { Finding } from '../domain/analysis.types';
import type { AtomicEvidenceV0_1 } from '../evidence/normalizer/evidence-normalizer.types';

export type Tier1RiskReason =
  | 'THREAT_WITH_CAPABILITY'
  | 'LIFECYCLE_DOWNLOAD_EXECUTION'
  | 'SENSITIVE_READ_NETWORK'
  | 'CREDENTIAL_SOURCE_NETWORK';

export interface Tier1RiskInput {
  findings: readonly Pick<Finding, 'ruleId' | 'type'>[];
  evidences: readonly AtomicEvidenceV0_1[];
}

export interface Tier1RiskAssessment {
  malicious: boolean;
  reasons: Tier1RiskReason[];
  threatWithCapability: boolean;
  lifecycleDownloadExecution: boolean;
  sensitiveReadNetwork: boolean;
  credentialSourceNetwork: boolean;
}

const LIFECYCLE_SIGNALS = new Set(['LIFECYCLE_SCRIPT', 'PREINSTALL_SCRIPT', 'INSTALL_SCRIPT', 'POSTINSTALL_SCRIPT']);
const PROCESS_SIGNALS = new Set(['CHILD_PROCESS', 'SHELL_EXEC', 'DYNAMIC_CODE_EXECUTION']);
const SENSITIVE_SIGNALS = new Set(['SENSITIVE_FILE_READ']);
const CREDENTIAL_SIGNALS = new Set(['CREDENTIAL_READ', 'SECRET_READ']);

/**
 * Tier 1 is a static signal source, not a package-level malware oracle.
 * A generic capability is therefore only a corroborator for a higher-trust
 * threat or a narrowly defined source/sink/execution combination.
 */
export function assessTier1Risk(input: Tier1RiskInput): Tier1RiskAssessment {
  const evidenceSignals = new Set(input.evidences.map(({ signal }) => signal.type));
  const hasThreat = input.findings.some(isThreatFinding)
    || input.evidences.some((evidence) => isThreatEvidence(evidence));
  const hasCapability = input.findings.some(isCapabilityFinding)
    || input.evidences.some((evidence) => isCapabilityEvidence(evidence));
  const threatWithCapability = hasThreat && hasCapability;
  const hasPrepareLifecycle = input.evidences.some(({ signal }) => signal.id === 'capability.lifecycle.prepare');
  const hasOtherLifecycle = input.evidences.some(({ signal }) => (
    LIFECYCLE_SIGNALS.has(signal.type) && signal.id !== 'capability.lifecycle.prepare'
  ));
  const lifecycleDownloadExecution = hasPrepareLifecycle && !hasOtherLifecycle
    ? hasLifecycleDownloadExecution(input.evidences)
    : hasAny(evidenceSignals, LIFECYCLE_SIGNALS)
      && evidenceSignals.has('REMOTE_FETCH')
      && hasAny(evidenceSignals, PROCESS_SIGNALS);
  const sensitiveReadNetwork = hasAny(evidenceSignals, SENSITIVE_SIGNALS)
    && evidenceSignals.has('NETWORK_EGRESS');
  const credentialSourceNetwork = hasAny(evidenceSignals, CREDENTIAL_SIGNALS)
    && evidenceSignals.has('NETWORK_EGRESS');

  const reasons: Tier1RiskReason[] = [];
  if (threatWithCapability) reasons.push('THREAT_WITH_CAPABILITY');
  if (lifecycleDownloadExecution) reasons.push('LIFECYCLE_DOWNLOAD_EXECUTION');
  if (sensitiveReadNetwork) reasons.push('SENSITIVE_READ_NETWORK');
  if (credentialSourceNetwork) reasons.push('CREDENTIAL_SOURCE_NETWORK');

  return {
    malicious: reasons.length > 0,
    reasons,
    threatWithCapability,
    lifecycleDownloadExecution,
    sensitiveReadNetwork,
    credentialSourceNetwork,
  };
}

function isThreatFinding(finding: Pick<Finding, 'ruleId' | 'type'>): boolean {
  return finding.type.startsWith('THREAT') || finding.ruleId.startsWith('threat-');
}

function isCapabilityFinding(finding: Pick<Finding, 'ruleId' | 'type'>): boolean {
  return finding.type.startsWith('CAPABILITY') || finding.ruleId.startsWith('capability-');
}

function isThreatEvidence(evidence: AtomicEvidenceV0_1): boolean {
  return evidence.signal.id?.startsWith('threat.') === true
    || evidence.sources.some(({ ruleId }) => ruleId.startsWith('threat-'));
}

function isCapabilityEvidence(evidence: AtomicEvidenceV0_1): boolean {
  return evidence.signal.id?.startsWith('capability.') === true
    || evidence.sources.some(({ ruleId }) => ruleId.startsWith('capability-'));
}

function hasAny(values: ReadonlySet<string>, candidates: ReadonlySet<string>): boolean {
  return [...candidates].some((candidate) => values.has(candidate));
}

function hasLifecycleDownloadExecution(evidences: readonly AtomicEvidenceV0_1[]): boolean {
  const lifecycleScriptPointers = new Set(
    evidences
      .filter((evidence) => LIFECYCLE_SIGNALS.has(evidence.signal.type))
      .flatMap((evidence) => evidence.locations)
      .filter((location) => location.type === 'METADATA' && location.jsonPointer?.startsWith('/scripts/') === true)
      .map((location) => location.jsonPointer as string),
  );

  // Test and legacy callers may provide signal-only evidence without locations.
  // Keep that contract's existing behavior; production normalized evidence has
  // locations, so unrelated package-level runtime signals cannot satisfy the
  // newly-added prepare lifecycle predicate.
  if (lifecycleScriptPointers.size === 0) {
    const signalTypes = new Set(evidences.map(({ signal }) => signal.type));
    return hasAny(signalTypes, LIFECYCLE_SIGNALS)
      && signalTypes.has('REMOTE_FETCH')
      && hasAny(signalTypes, PROCESS_SIGNALS);
  }

  return [...lifecycleScriptPointers].some((scriptPointer) => {
    const hasDownload = evidences.some((evidence) => evidence.signal.type === 'REMOTE_FETCH'
      && hasMetadataScriptPointer(evidence, scriptPointer));
    const hasProcess = evidences.some((evidence) => PROCESS_SIGNALS.has(evidence.signal.type)
      && hasMetadataScriptPointer(evidence, scriptPointer));
    return hasDownload && hasProcess;
  });
}

function hasMetadataScriptPointer(evidence: AtomicEvidenceV0_1, scriptPointer: string): boolean {
  return evidence.locations.some((location) => location.type === 'METADATA'
    && location.jsonPointer === scriptPointer);
}
