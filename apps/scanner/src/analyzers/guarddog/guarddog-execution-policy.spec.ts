import type { AnalyzerResult, Finding } from '../../domain/analysis.types';
import {
  decideGuardDogExecution,
  skippedGuardDogResult,
} from './guarddog-execution-policy';

function result(analyzer: string, findings: Finding[] = [], status: AnalyzerResult['status'] = 'SUCCESS'): AnalyzerResult {
  return { requestId: 'request', scanId: 'scan', analyzer, analyzerVersion: '1', status, findings, errors: [] };
}

function finding(ruleId: string, data: Record<string, unknown> = {}): Finding {
  return { findingId: `${ruleId}:1`, ruleId, type: 'CAPABILITY', message: ruleId, data };
}

describe('GuardDog execution policy', () => {
  it('runs when cheap analyzers have no signal because absence is not benign proof', () => {
    expect(decideGuardDogExecution(result('metadata'), result('custom-rule'))).toEqual({
      shouldRun: true,
      reason: 'NO_CHEAP_SIGNAL',
    });
  });

  it('runs for a generic single capability to preserve GuardDog-only coverage', () => {
    expect(decideGuardDogExecution(
      result('metadata'),
      result('custom-rule', [finding('custom.network-outbound')]),
    )).toEqual({
      shouldRun: true,
      reason: 'GENERIC_SINGLE_SIGNAL_REVIEW',
    });
  });

  it.each([
    'metadata.lifecycle.prepare',
    'metadata.repository.mismatch',
  ])('runs for metadata signal %s', (ruleId) => {
    expect(decideGuardDogExecution(
      result('metadata', [finding(ruleId)]),
      result('custom-rule'),
    ).shouldRun).toBe(true);
  });

  it('runs for corroborated custom-rule evidence and high-confidence findings', () => {
    expect(decideGuardDogExecution(
      result('metadata'),
      result('custom-rule', [finding('custom.sensitive-file-network-coexistence')]),
    ).reason).toBe('CUSTOM_RULE_CORROBORATION');
    expect(decideGuardDogExecution(
      result('metadata'),
      result('custom-rule', [finding('custom.network-outbound', { confidence: 'HIGH' })]),
    ).reason).toBe('CUSTOM_RULE_HIGH_CONFIDENCE');
  });

  it('runs when cheap analysis fails so a failure cannot become a silent skip', () => {
    expect(decideGuardDogExecution(
      result('metadata'),
      result('custom-rule', [], 'FAILED'),
    )).toEqual({ shouldRun: true, reason: 'CHEAP_ANALYZER_UNAVAILABLE' });
  });

  it('represents skip without an error, preserving the existing Analyzer contract', () => {
    expect(skippedGuardDogResult({ requestId: 'request', scanId: 'scan' }, '0.1.0')).toMatchObject({
      analyzer: 'guarddog', analyzerVersion: '0.1.0', status: 'SKIPPED', findings: [], errors: [],
    });
  });
});
