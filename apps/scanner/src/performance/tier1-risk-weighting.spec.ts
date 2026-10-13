import { assessTier1Risk } from './tier1-risk-weighting';
import { evaluateTier1Tier2Benchmark } from './tier1-tier2-benchmark';
import type { AnalyzerResult, Finding } from '../domain/analysis.types';
import type { AtomicEvidenceV0_1, EvidenceSignalType } from '../evidence/normalizer/evidence-normalizer.types';

const subject = { ecosystem: 'npm' as const, packageName: 'fixture', packageVersion: '1.0.0', artifactHash: 'a'.repeat(64) };

function evidence(
  type: EvidenceSignalType,
  id = type.toLowerCase(),
  locations: AtomicEvidenceV0_1['locations'] = [],
): AtomicEvidenceV0_1 {
  return {
    schemaVersion: '0.1', evidenceId: id, kind: 'ATOMIC', analysisPass: 'TIER1',
    signal: { id, type, category: 'EXECUTION' }, subject,
    assertion: { summary: type, basis: 'PATTERN_MATCH' }, sources: [], locations,
    provenance: { scanId: 'scan', generatedBy: 'EVIDENCE_NORMALIZER', observedAt: '2026-01-01T00:00:00.000Z' }, limitations: [],
  };
}

function lifecycleLocation(script = 'prepare') {
  return [{ type: 'METADATA' as const, jsonPointer: `/scripts/${script}` }];
}

function result(findings: Finding[] = []): AnalyzerResult {
  return { requestId: 'request', scanId: 'scan', analyzer: 'custom-rule', analyzerVersion: 'test', status: 'SUCCESS', findings, errors: [] };
}

function finding(ruleId: string, type = 'CAPABILITY_PATTERN'): Finding {
  return { findingId: ruleId, ruleId, type, message: ruleId, data: {} };
}

describe('Tier1 risk weighting', () => {
  it.each([
    'SYSTEM_INFO', 'NETWORK_EGRESS', 'CHILD_PROCESS', 'REMOTE_FETCH', 'FILE_WRITE',
    'SENSITIVE_FILE_READ', 'CREDENTIAL_READ',
  ] as EvidenceSignalType[])('does not escalate a generic single signal: %s', (type) => {
    expect(assessTier1Risk({ findings: [], evidences: [evidence(type)] }).malicious).toBe(false);
  });

  it('keeps the high-trust combinations', () => {
    expect(assessTier1Risk({ findings: [finding('threat-process-download-exec', 'THREAT_INDICATOR')], evidences: [evidence('CHILD_PROCESS')] }).malicious).toBe(false);
    expect(assessTier1Risk({ findings: [finding('threat-process-download-exec', 'THREAT_INDICATOR'), finding('capability-process-spawn')], evidences: [evidence('CHILD_PROCESS')] }).reasons).toContain('THREAT_WITH_CAPABILITY');
    expect(assessTier1Risk({ findings: [], evidences: [evidence('LIFECYCLE_SCRIPT'), evidence('REMOTE_FETCH'), evidence('CHILD_PROCESS')] }).reasons).toContain('LIFECYCLE_DOWNLOAD_EXECUTION');
    expect(assessTier1Risk({ findings: [], evidences: [evidence('SENSITIVE_FILE_READ'), evidence('NETWORK_EGRESS')] }).reasons).toContain('SENSITIVE_READ_NETWORK');
    expect(assessTier1Risk({ findings: [], evidences: [evidence('CREDENTIAL_READ'), evidence('NETWORK_EGRESS')] }).reasons).toContain('CREDENTIAL_SOURCE_NETWORK');
  });

  it('does not combine a lifecycle declaration with unrelated package runtime signals', () => {
    const lifecycle = evidence('LIFECYCLE_SCRIPT', 'capability.lifecycle.prepare', lifecycleLocation());
    const runtimeDownload = { ...evidence('REMOTE_FETCH', 'runtime-download'), locations: [{ type: 'SOURCE_FILE' as const, path: 'worker.js' }] };
    const runtimeProcess = { ...evidence('CHILD_PROCESS', 'runtime-process'), locations: [{ type: 'SOURCE_FILE' as const, path: 'index.js' }] };

    expect(assessTier1Risk({ findings: [], evidences: [lifecycle, runtimeDownload, runtimeProcess] })).toMatchObject({
      malicious: false,
      lifecycleDownloadExecution: false,
    });
  });

  it('keeps lifecycle download and execution when all three signals share one script', () => {
    const locations = lifecycleLocation('postinstall');
    const lifecycle = evidence('POSTINSTALL_SCRIPT', 'lifecycle-postinstall', locations);
    const download = evidence('REMOTE_FETCH', 'lifecycle-download', locations);
    const process = evidence('CHILD_PROCESS', 'lifecycle-process', locations);

    expect(assessTier1Risk({ findings: [], evidences: [lifecycle, download, process] })).toMatchObject({
      malicious: true,
      lifecycleDownloadExecution: true,
    });
  });

  it('keeps a prepare lifecycle download and execution when the script is corroborated', () => {
    const locations = lifecycleLocation();
    const lifecycle = evidence('LIFECYCLE_SCRIPT', 'capability.lifecycle.prepare', locations);
    const download = evidence('REMOTE_FETCH', 'prepare-download', locations);
    const process = evidence('CHILD_PROCESS', 'prepare-process', locations);

    expect(assessTier1Risk({ findings: [], evidences: [lifecycle, download, process] })).toMatchObject({
      malicious: true,
      lifecycleDownloadExecution: true,
    });
  });

  it('regresses a reproducible 20 normal / 20 malicious synthetic Tier1 corpus', () => {
    const normalSignals: EvidenceSignalType[][] = [
      ['SYSTEM_INFO'], ['NETWORK_EGRESS'], ['CHILD_PROCESS'], ['REMOTE_FETCH'], ['FILE_WRITE'],
      ['SENSITIVE_FILE_READ'], ['CREDENTIAL_READ'], ['SYSTEM_INFO', 'NETWORK_EGRESS'],
      ['CHILD_PROCESS', 'NETWORK_EGRESS'], ['REMOTE_FETCH', 'FILE_WRITE'], ['REMOTE_FETCH', 'CHILD_PROCESS'],
      ['LIFECYCLE_SCRIPT', 'CHILD_PROCESS'], ['SENSITIVE_FILE_READ', 'CHILD_PROCESS'], ['CREDENTIAL_READ', 'FILE_WRITE'],
      ['LIFECYCLE_SCRIPT'], ['INSTALL_SCRIPT'], ['ENV_READ'], ['FILE_READ'], ['NETWORK_EGRESS', 'FILE_WRITE'], ['SYSTEM_INFO', 'CHILD_PROCESS'],
    ];
    const maliciousSignals: EvidenceSignalType[][] = [
      ['LIFECYCLE_SCRIPT', 'REMOTE_FETCH', 'CHILD_PROCESS'], ['INSTALL_SCRIPT', 'REMOTE_FETCH', 'SHELL_EXEC'],
      ['POSTINSTALL_SCRIPT', 'REMOTE_FETCH', 'CHILD_PROCESS'], ['LIFECYCLE_SCRIPT', 'REMOTE_FETCH', 'DYNAMIC_CODE_EXECUTION'],
      ['PREINSTALL_SCRIPT', 'REMOTE_FETCH', 'CHILD_PROCESS'], ['SENSITIVE_FILE_READ', 'NETWORK_EGRESS'],
      ['SENSITIVE_FILE_READ', 'NETWORK_EGRESS', 'CHILD_PROCESS'], ['SENSITIVE_FILE_READ', 'NETWORK_EGRESS', 'REMOTE_FETCH'],
      ['SENSITIVE_FILE_READ', 'NETWORK_EGRESS', 'FILE_WRITE'], ['SENSITIVE_FILE_READ', 'NETWORK_EGRESS', 'SHELL_EXEC'],
      ['CREDENTIAL_READ', 'NETWORK_EGRESS'], ['CREDENTIAL_READ', 'NETWORK_EGRESS', 'CHILD_PROCESS'],
      ['SECRET_READ', 'NETWORK_EGRESS'], ['CREDENTIAL_READ', 'NETWORK_EGRESS', 'REMOTE_FETCH'],
      ['SECRET_READ', 'NETWORK_EGRESS', 'SHELL_EXEC'],
      ['CHILD_PROCESS'], ['CHILD_PROCESS'], ['CHILD_PROCESS'], ['CHILD_PROCESS'], ['CHILD_PROCESS'],
    ];
    const samples = [
      ...normalSignals.map((signals, index) => ({ sampleId: `normal-${index + 1}`, truth: 'BENIGN' as const, tier1Results: [result()], tier1Evidences: signals.map((type) => evidence(type, `normal-${index}-${type}`)) })),
      ...maliciousSignals.map((signals, index) => ({
        sampleId: `malicious-${index + 1}`, truth: 'MALICIOUS' as const,
        tier1Results: index >= 15 ? [result([finding(`threat-${index}`, 'THREAT_INDICATOR'), finding(`capability-${index}`)])] : [result()],
        tier1Evidences: signals.map((type) => evidence(type, `malicious-${index}-${type}`)),
      })),
    ];
    const report = evaluateTier1Tier2Benchmark(samples);
    expect(report.sampleCount).toBe(40);
    expect(report.confusion).toMatchObject({ truePositive: 20, falsePositive: 0, trueNegative: 20, falseNegative: 0, falsePositiveRate: 0, falseNegativeRate: 0 });
  });
});
