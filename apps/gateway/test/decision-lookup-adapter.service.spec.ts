import { DecisionLookupInvalidResponseError } from '../src/errors/decision-lookup.errors';
import { DecisionLookupAdapterService } from '../src/services/decision-lookup-adapter.service';
import type { ArtifactIdentity } from '../src/types/artifact.types';
import {
  Decision,
  DecisionLookupStatus,
} from '../src/types/decision.types';

const EXPRESS: ArtifactIdentity = {
  packageName: 'express',
  version: '5.2.1',
  integrity: 'sha512-express',
};

const LOCAL_DEP: ArtifactIdentity = {
  packageName: 'local-dep',
  version: '1.0.0',
  integrity: 'sha512-local',
};

function foundResult(overrides: Record<string, unknown> = {}): unknown {
  return {
    packageName: 'express',
    version: '5.2.1',
    integrity: 'sha512-express',
    lookupStatus: 'FOUND',
    decisionId: 'dec-001',
    decision: 'ACCEPT',
    policyKey: 'default-npm-policy',
    policyVersion: '1.0.0',
    evaluatedAt: '2026-08-22T08:00:00Z',
    ...overrides,
  };
}

function notFoundResult(overrides: Record<string, unknown> = {}): unknown {
  return {
    packageName: 'express',
    version: '5.2.1',
    integrity: 'sha512-express',
    lookupStatus: 'NOT_FOUND',
    ...overrides,
  };
}

describe('DecisionLookupAdapterService', () => {
  const service = new DecisionLookupAdapterService();

  it('keeps the request ID', () => {
    const batch = service.adapt('req-1', [EXPRESS], {
      results: [notFoundResult()],
    });

    expect(batch.requestId).toBe('req-1');
  });

  it('maps a NOT_FOUND result', () => {
    const batch = service.adapt('req-1', [EXPRESS], {
      results: [notFoundResult()],
    });

    expect(batch.results[0]).toEqual({
      artifact: EXPRESS,
      lookupStatus: DecisionLookupStatus.NOT_FOUND,
    });
  });

  it.each([
    ['ACCEPT', Decision.ACCEPT],
    ['REJECT', Decision.REJECT],
    ['HOLD', Decision.HOLD],
    ['REVIEW', Decision.REVIEW],
  ])('maps a FOUND result carrying decision %s', (raw, expected) => {
    const batch = service.adapt('req-1', [EXPRESS], {
      results: [foundResult({ decision: raw })],
    });

    const [result] = batch.results;

    expect(result.lookupStatus).toBe(DecisionLookupStatus.FOUND);
    expect(result).toHaveProperty('decision.decision', expected);
  });

  it('builds a complete DecisionRecord from a FOUND result', () => {
    const batch = service.adapt('req-1', [EXPRESS], {
      results: [foundResult()],
    });

    expect(batch.results[0]).toEqual({
      artifact: EXPRESS,
      lookupStatus: DecisionLookupStatus.FOUND,
      decision: {
        decisionId: 'dec-001',
        ecosystem: 'npm',
        packageName: 'express',
        version: '5.2.1',
        integrity: 'sha512-express',
        decision: Decision.ACCEPT,
        policyKey: 'default-npm-policy',
        policyVersion: '1.0.0',
        evaluatedAt: '2026-08-22T08:00:00Z',
      },
    });
  });

  it('omits optional policy fields when they are absent', () => {
    const batch = service.adapt('req-1', [EXPRESS], {
      results: [foundResult({ policyKey: undefined, policyVersion: undefined })],
    });

    const { decision } = batch.results[0] as { decision: object };

    expect(decision).not.toHaveProperty('policyKey');
    expect(decision).not.toHaveProperty('policyVersion');
  });

  it('preserves the requested order for a mixed response', () => {
    const artifacts = [EXPRESS, LOCAL_DEP];

    const batch = service.adapt('req-1', artifacts, {
      results: [
        foundResult(),
        notFoundResult({
          packageName: 'local-dep',
          version: '1.0.0',
          integrity: 'sha512-local',
        }),
      ],
    });

    expect(batch.results.map((r) => r.lookupStatus))
      .toEqual([DecisionLookupStatus.FOUND, DecisionLookupStatus.NOT_FOUND]);
    expect(batch.results.map((r) => r.artifact)).toEqual(artifacts);
  });

  describe('계약 위반 응답 거부', () => {
    it.each([
      [undefined, 'response must be an object'],
      [null, 'response must be an object'],
      ['ok', 'response must be an object'],
      [[], 'response must be an object'],
      [{}, 'results must be an array'],
      [{ results: 'nope' }, 'results must be an array'],
    ])('rejects a malformed envelope: %p', (response, reason) => {
      expect(() => service.adapt('req-1', [EXPRESS], response))
        .toThrow(reason);
    });

    it('rejects a response missing one of the requested packages', () => {
      expect(() => service.adapt('req-1', [EXPRESS, LOCAL_DEP], {
        results: [foundResult()],
      })).toThrow('results length 1 does not match the requested 2');
    });

    // FOUND는 판정이 있다는 뜻이며 그 판정이 REJECT일 수 있다.
    // decision 값이 없으면 허용과 차단을 구분할 수 없다.
    it('rejects a FOUND result without a decision', () => {
      expect(() => service.adapt('req-1', [EXPRESS], {
        results: [foundResult({ decision: undefined })],
      })).toThrow('must include a valid decision');
    });

    it.each(['accept', 'PASS', 'ok', '', 42, null])(
      'rejects a FOUND result with an unknown decision value: %p',
      (decision) => {
        expect(() => service.adapt('req-1', [EXPRESS], {
          results: [foundResult({ decision })],
        })).toThrow('must include a valid decision');
      },
    );

    it('rejects a FOUND result without a decisionId', () => {
      expect(() => service.adapt('req-1', [EXPRESS], {
        results: [foundResult({ decisionId: '  ' })],
      })).toThrow('must include decisionId');
    });

    it.each(['HIT', 'MISS', 'found', '', undefined])(
      'rejects an unsupported lookupStatus: %p',
      (lookupStatus) => {
        expect(() => service.adapt('req-1', [EXPRESS], {
          results: [notFoundResult({ lookupStatus })],
        })).toThrow('unsupported lookupStatus');
      },
    );

    it('rejects a result for a different package', () => {
      expect(() => service.adapt('req-1', [EXPRESS], {
        results: [notFoundResult({ packageName: 'lodash' })],
      })).toThrow('expected packageName "express", received "lodash"');
    });

    it('rejects a result for a different version', () => {
      expect(() => service.adapt('req-1', [EXPRESS], {
        results: [notFoundResult({ version: '4.0.0' })],
      })).toThrow('expected version "5.2.1"');
    });

    // 합의된 계약은 세 값이 모두 일치할 때만 FOUND다.
    // integrity를 비교하지 않으면 다른 Artifact의 판정을 적용하게 된다.
    it('rejects a result whose integrity differs from the request', () => {
      expect(() => service.adapt('req-1', [EXPRESS], {
        results: [foundResult({ integrity: 'sha512-different' })],
      })).toThrow('expected integrity "sha512-express"');
    });

    it('rejects a result that drops the integrity we sent', () => {
      expect(() => service.adapt('req-1', [EXPRESS], {
        results: [foundResult({ integrity: null })],
      })).toThrow('expected integrity "sha512-express"');
    });

    // 다른 요청의 응답을 받으면 엉뚱한 요청의 판정을 적용하게 된다
    it('rejects a response carrying a different requestId', () => {
      expect(() => service.adapt('req-1', [EXPRESS], {
        requestId: 'req-999',
        results: [notFoundResult()],
      })).toThrow('expected requestId "req-1", received "req-999"');
    });

    it('accepts a response echoing the same requestId', () => {
      const batch = service.adapt('req-1', [EXPRESS], {
        requestId: 'req-1',
        results: [notFoundResult()],
      });

      expect(batch.requestId).toBe('req-1');
    });

    it('throws DecisionLookupInvalidResponseError for every violation', () => {
      expect(() => service.adapt('req-1', [EXPRESS], { results: [null] }))
        .toThrow(DecisionLookupInvalidResponseError);
    });
  });
});
