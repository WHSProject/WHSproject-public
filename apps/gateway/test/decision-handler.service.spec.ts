import { DecisionHandlerService } from '../src/services/decision-handler.service';
import { DecisionLookupBatch } from '../src/types/decision-lookup.types';
import {
  Decision,
  DecisionLookupStatus,
} from '../src/types/decision.types';

describe('DecisionHandlerService', () => {
  const service = new DecisionHandlerService();

  it('classifies FOUND results and converts only NOT_FOUND results', () => {
    const batch: DecisionLookupBatch = {
      requestId: 'req-1234',
      results: [
        {
          artifact: {
            packageName: 'accepted-package',
            version: '1.0.0',
            integrity: 'sha512-accepted',
          },
          lookupStatus: DecisionLookupStatus.FOUND,
          decision: {
            decisionId: 'decision-1',
            ecosystem: 'npm',
            packageName: 'accepted-package',
            version: '1.0.0',
            integrity: 'sha512-accepted',
            decision: Decision.ACCEPT,
            evaluatedAt: '2026-08-21T00:00:00.000Z',
          },
        },
        {
          artifact: {
            packageName: 'new-package',
            version: '2.0.0',
            integrity: 'sha512-new',
          },
          lookupStatus: DecisionLookupStatus.NOT_FOUND,
        },
      ],
    };
    const originalBatch = JSON.stringify(batch);

    const result = service.classifyAndCreateScannerRequests(batch);

    expect(result.hits).toEqual([batch.results[0]]);
    expect(result.scannerTargets).toEqual([batch.results[1].artifact]);
    expect(result.scannerRequest).toEqual({
      requestId: 'req-1234',
      packages: [
        {
          packageName: 'new-package',
          version: '2.0.0',
          integrity: 'sha512-new',
        },
      ],
    });
    expect(JSON.stringify(batch)).toBe(originalBatch);
  });

  it('puts every NOT_FOUND result into a single Scanner request', () => {
    const result = service.classifyAndCreateScannerRequests({
      requestId: 'req-5678',
      results: [
        {
          artifact: {
            packageName: 'first-package',
            version: '1.0.0',
            integrity: 'sha512-first',
          },
          lookupStatus: DecisionLookupStatus.NOT_FOUND,
        },
        {
          artifact: {
            packageName: 'second-package',
            version: '2.0.0',
            integrity: 'sha512-second',
          },
          lookupStatus: DecisionLookupStatus.NOT_FOUND,
        },
      ],
    });

    expect(result.hits).toHaveLength(0);
    expect(result.scannerTargets).toHaveLength(2);

    // 대상이 몇 개든 요청은 1건이다
    expect(result.scannerRequest).toEqual({
      requestId: 'req-5678',
      packages: [
        {
          packageName: 'first-package',
          version: '1.0.0',
          integrity: 'sha512-first',
        },
        {
          packageName: 'second-package',
          version: '2.0.0',
          integrity: 'sha512-second',
        },
      ],
    });
  });

  // 전부 기존 판정이 있으면 Scanner를 호출할 이유가 없다
  it('returns a null Scanner request when nothing needs analysis', () => {
    const result = service.classifyAndCreateScannerRequests({
      requestId: 'req-all-hit',
      results: [
        {
          artifact: {
            packageName: 'accepted-package',
            version: '1.0.0',
            integrity: 'sha512-accepted',
          },
          lookupStatus: DecisionLookupStatus.FOUND,
          decision: {
            decisionId: 'decision-1',
            ecosystem: 'npm',
            packageName: 'accepted-package',
            version: '1.0.0',
            integrity: 'sha512-accepted',
            decision: Decision.ACCEPT,
            evaluatedAt: '2026-08-21T00:00:00.000Z',
          },
        },
      ],
    });

    expect(result.scannerTargets).toHaveLength(0);
    expect(result.scannerRequest).toBeNull();
  });

  it('returns a null Scanner request for an empty result list', () => {
    const result = service.classifyAndCreateScannerRequests({
      requestId: 'req-empty',
      results: [],
    });

    expect(result.hits).toHaveLength(0);
    expect(result.scannerTargets).toHaveLength(0);
    expect(result.scannerRequest).toBeNull();
  });

  it('rejects an empty requestId', () => {
    expect(() => service.classifyAndCreateScannerRequests({
      requestId: '   ',
      results: [],
    })).toThrow('requestId is required');
  });

  it('rejects a FOUND result without a DecisionRecord', () => {
    const batch = {
      requestId: 'req-invalid-found',
      results: [
        {
          artifact: {
            packageName: 'invalid-package',
            version: '1.0.0',
            integrity: 'sha512-invalid',
          },
          lookupStatus: DecisionLookupStatus.FOUND,
        },
      ],
    } as unknown as DecisionLookupBatch;

    expect(() => service.classifyAndCreateScannerRequests(batch)).toThrow(
      'FOUND result must include a DecisionRecord',
    );
  });

  it('rejects an unsupported lookup status', () => {
    const batch = {
      requestId: 'req-invalid-status',
      results: [
        {
          artifact: {
            packageName: 'invalid-package',
            version: '1.0.0',
            integrity: 'sha512-invalid',
          },
          lookupStatus: 'UNKNOWN',
        },
      ],
    } as unknown as DecisionLookupBatch;

    expect(() => service.classifyAndCreateScannerRequests(batch)).toThrow(
      'Unsupported Decision lookup status',
    );
  });

  describe('evaluateEnforcement', () => {
    // null은 아래 defensive regression test에서만 의도적으로 사용한다.
    // 정상 Gateway Critical Path의 ArtifactIdentity는 integrity 필수다.
    function found(
      packageName: string,
      decision: Decision,
      integrity: string | null = 'sha512-x',
    ) {
      return {
        artifact: { packageName, version: '1.0.0', integrity },
        lookupStatus: DecisionLookupStatus.FOUND,
        decision: {
          decisionId: 'decision-1',
          ecosystem: 'npm' as const,
          packageName,
          version: '1.0.0',
          decision,
          evaluatedAt: '2026-08-26T00:00:00.000Z',
        },
      };
    }

    function notFound(packageName: string) {
      return {
        artifact: { packageName, version: '1.0.0', integrity: 'sha512-x' },
        lookupStatus: DecisionLookupStatus.NOT_FOUND,
      };
    }

    it('allows when every decision is ACCEPT', () => {
      const result = service.evaluateEnforcement({
        requestId: 'req-1',
        results: [found('a', Decision.ACCEPT), found('b', Decision.ACCEPT)],
      } as unknown as DecisionLookupBatch);

      expect(result.allowed).toBe(true);
      expect(result.blocked).toHaveLength(0);
      expect(result.approvalRequest).toEqual({
        requestId: 'req-1',
        packages: [
          { packageName: 'a', version: '1.0.0', integrity: 'sha512-x' },
          { packageName: 'b', version: '1.0.0', integrity: 'sha512-x' },
        ],
      });
    });

    // MVP에서는 셋을 구분하지 않고 모두 차단한다
    it.each([Decision.REJECT, Decision.HOLD, Decision.REVIEW])(
      'blocks when a decision is %s',
      (decision) => {
        const result = service.evaluateEnforcement({
          requestId: 'req-1',
          results: [found('a', Decision.ACCEPT), found('b', decision)],
        } as unknown as DecisionLookupBatch);

        expect(result.allowed).toBe(false);
        expect(result.approvalRequest).toBeNull();
        expect(result.blocked).toEqual([
          { artifact: expect.objectContaining({ packageName: 'b' }), reason: decision },
        ]);
      },
    );

    // 재조회 후에도 판정이 없으면 검사되지 않은 Package다
    it('blocks when a package is NOT_FOUND', () => {
      const result = service.evaluateEnforcement({
        requestId: 'req-1',
        results: [found('a', Decision.ACCEPT), notFound('b')],
      } as unknown as DecisionLookupBatch);

      expect(result.allowed).toBe(false);
      expect(result.blocked[0].reason).toBe(DecisionLookupStatus.NOT_FOUND);
    });

    // 차단 대상이 여럿이면 전부 담아야 원인 파악이 된다
    it('collects every blocked artifact', () => {
      const result = service.evaluateEnforcement({
        requestId: 'req-1',
        results: [
          found('a', Decision.REJECT),
          found('b', Decision.ACCEPT),
          notFound('c'),
        ],
      } as unknown as DecisionLookupBatch);

      expect(result.blocked).toHaveLength(2);
      expect(result.blocked.map((b) => b.artifact.packageName)).toEqual(['a', 'c']);
    });

    it('does not allow an empty result list', () => {
      const result = service.evaluateEnforcement({
        requestId: 'req-1',
        results: [],
      } as unknown as DecisionLookupBatch);

      expect(result.allowed).toBe(false);
      expect(result.approvalRequest).toBeNull();
    });

    // Verdaccio Plugin이 빈 문자열을 거부한다.
    // 조용히 빼면 승인되지 않은 Package가 통과한다
    it('throws when an approved artifact has no integrity', () => {
      expect(() => service.evaluateEnforcement({
        requestId: 'req-1',
        results: [found('a', Decision.ACCEPT, null)],
      } as unknown as DecisionLookupBatch)).toThrow(
        /integrity is required to register an approval/,
      );
    });

    it('rejects an empty requestId', () => {
      expect(() => service.evaluateEnforcement({
        requestId: '   ',
        results: [],
      } as unknown as DecisionLookupBatch)).toThrow('requestId is required');
    });

    it('rejects a FOUND result without a DecisionRecord', () => {
      expect(() => service.evaluateEnforcement({
        requestId: 'req-1',
        results: [{
          artifact: { packageName: 'a', version: '1.0.0', integrity: 'sha512-x' },
          lookupStatus: DecisionLookupStatus.FOUND,
        }],
      } as unknown as DecisionLookupBatch)).toThrow(
        'FOUND result must include a DecisionRecord',
      );
    });
  });
});
