import type { ScanResult } from '../src/domain/analysis.types';
import { ScanHistoryService } from '../src/history/scan-history.service';
import { ScannerErrorCode } from '../src/domain/scanner-error-code';

function result(scanId: string, requestId = 'request-1', status: ScanResult['status'] = 'COMPLETED'): ScanResult {
  return {
    schemaVersion: '0.1',
    requestId,
    scanId,
    subject: { name: 'example', version: '1.0.0', ecosystem: 'npm' },
    artifactHash: `hash-${scanId}`,
    status,
    evidences: [],
    analyzerSummaries: [{
      name: 'metadata',
      status: status === 'COMPLETED' ? 'SUCCESS' : status,
      findingCount: 1,
      errorCount: status === 'COMPLETED' ? 0 : 1,
    }],
    errors: status === 'COMPLETED' ? [] : [{
      code: ScannerErrorCode.INTERNAL_ERROR,
      stage: 'ANALYZER',
      message: `${status} result`,
      retryable: false,
    }],
  };
}

describe('ScanHistoryService', () => {
  it('stores and retrieves a ScanResult by scanId without changing its data', () => {
    const history = new ScanHistoryService();
    const stored = result('scan-1');
    stored.shadowAnalyses = [{
      analyzer: 'obfuscation',
      analyzerVersion: '0.2.0',
      mode: 'SHADOW',
      data: { gpt: { status: 'NOT_REQUESTED' } },
    }];

    expect(history.save(stored)).toBe(stored);
    expect(history.findByScanId('scan-1')).toBe(stored);
    expect(history.findByScanId('scan-1')).toMatchObject({
      status: 'COMPLETED',
      analyzerSummaries: stored.analyzerSummaries,
      shadowAnalyses: stored.shadowAnalyses,
      errors: [],
    });
  });

  it('preserves Atomic Evidence and Normalizer errors in the stored ScanResult', () => {
    const history = new ScanHistoryService();
    const stored = result('scan-evidence', 'request-evidence', 'PARTIAL');
    stored.evidences = [
      {
        schemaVersion: '0.1',
        evidenceId: 'evidence-1',
        kind: 'ATOMIC',
        signal: {
          id: 'capability.lifecycle.postinstall',
          type: 'POSTINSTALL_SCRIPT',
          category: 'METADATA',
        },
        sources: [
          {
            analyzer: 'metadata',
            analyzerVersion: '0.1.0',
            rawFindingId: 'finding-1',
          },
        ],
        provenance: {
          scanId: stored.scanId,
          generatedBy: 'EVIDENCE_NORMALIZER',
        },
      },
    ];
    stored.errors.push({
      code: ScannerErrorCode.INTERNAL_ERROR,
      stage: 'NORMALIZATION:UNMAPPED_FINDINGS',
      message: '1 Finding could not be normalized to Evidence',
      retryable: false,
    });

    history.save(stored);

    expect(history.findByScanId(stored.scanId)).toBe(stored);
    expect(history.findByScanId(stored.scanId)).toMatchObject({
      evidences: [
        {
          evidenceId: 'evidence-1',
          provenance: { scanId: stored.scanId },
        },
      ],
      errors: expect.arrayContaining([
        expect.objectContaining({
          stage: 'NORMALIZATION:UNMAPPED_FINDINGS',
        }),
      ]),
    });
  });

  it('returns undefined for an unknown scanId', () => {
    expect(new ScanHistoryService().findByScanId('missing')).toBeUndefined();
  });

  it('returns all scans for a requestId in insertion order', () => {
    const history = new ScanHistoryService();
    const first = result('scan-1');
    const second = result('scan-2');
    const other = result('scan-3', 'request-2');

    history.save(first);
    history.save(second);
    history.save(other);

    expect(history.findByRequestId('request-1')).toEqual([first, second]);
    expect(history.findByRequestId('missing')).toEqual([]);
  });

  it.each(['FAILED', 'PARTIAL', 'TIMEOUT'] as const)(
    'preserves %s ScanResult values',
    (status) => {
      const history = new ScanHistoryService();
      const stored = result(`scan-${status}`, 'request-1', status);

      history.save(stored);

      expect(history.findByScanId(stored.scanId)).toBe(stored);
      expect(history.findByScanId(stored.scanId)?.status).toBe(status);
      expect(history.findByScanId(stored.scanId)?.errors).toEqual(stored.errors);
    },
  );

  it('overwrites an existing scanId without duplicating request history', () => {
    const history = new ScanHistoryService();
    const original = result('scan-1');
    const replacement = result('scan-1', 'request-1', 'PARTIAL');

    history.save(original);
    history.save(replacement);

    expect(history.findByScanId('scan-1')).toBe(replacement);
    expect(history.findByRequestId('request-1')).toEqual([replacement]);
  });
});
