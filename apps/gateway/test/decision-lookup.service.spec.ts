import { DecisionLookupClient } from '../src/clients/decision-lookup.client';
import { DecisionLookupAdapterService } from '../src/services/decision-lookup-adapter.service';
import { DecisionLookupService } from '../src/services/decision-lookup.service';
import { DecisionLookupStatus } from '../src/types/decision.types';
import type {
  DependencyResolutionResult,
} from '../src/types/dependency-tree.types';

const RESOLUTION: DependencyResolutionResult = {
  requestId: 'req-trace-1',
  root: { packageName: 'express', version: '5.2.1', integrity: 'sha512-a' },
  artifacts: [
    { packageName: 'express', version: '5.2.1', integrity: 'sha512-a' },
    { packageName: 'accepts', version: '1.3.8', integrity: 'sha512-b' },
    { packageName: 'local-dep', version: '1.0.0', integrity: 'sha512-c' },
  ],
};

describe('DecisionLookupService', () => {
  let decisionLookupClient: jest.Mocked<Pick<DecisionLookupClient, 'lookup'>>;
  let service: DecisionLookupService;

  beforeEach(() => {
    decisionLookupClient = {
      lookup: jest.fn().mockResolvedValue({
        results: RESOLUTION.artifacts.map((artifact) => ({
          packageName: artifact.packageName,
          version: artifact.version,
          integrity: artifact.integrity,
          lookupStatus: 'NOT_FOUND',
        })),
      }),
    };

    service = new DecisionLookupService(
      decisionLookupClient as unknown as DecisionLookupClient,
      new DecisionLookupAdapterService(),
    );
  });

  it('sends every artifact in one request', async () => {
    await service.lookup(RESOLUTION);

    expect(decisionLookupClient.lookup).toHaveBeenCalledTimes(1);
    expect(decisionLookupClient.lookup).toHaveBeenCalledWith({
      requestId: 'req-trace-1',
      packages: [
        { packageName: 'express', version: '5.2.1', integrity: 'sha512-a' },
        { packageName: 'accepts', version: '1.3.8', integrity: 'sha512-b' },
        { packageName: 'local-dep', version: '1.0.0', integrity: 'sha512-c' },
      ],
    });
  });

  // 의존성이 많아도 요청은 1회여야 한다
  it('still sends one request for a large tree', async () => {
    const artifacts = Array.from({ length: 120 }, (_, i) => ({
      packageName: `pkg-${i}`,
      version: '1.0.0',
      integrity: `sha512-${i}`,
    }));

    decisionLookupClient.lookup.mockResolvedValue({
      results: artifacts.map((a) => ({
        packageName: a.packageName,
        version: a.version,
        integrity: a.integrity,
        lookupStatus: 'NOT_FOUND',
      })),
    });

    const batch = await service.lookup({ ...RESOLUTION, artifacts });

    expect(decisionLookupClient.lookup).toHaveBeenCalledTimes(1);
    expect(batch.results).toHaveLength(120);
  });

  it('returns a batch carrying the request ID', async () => {
    const batch = await service.lookup(RESOLUTION);

    expect(batch.requestId).toBe('req-trace-1');
    expect(batch.results.map((r) => r.lookupStatus))
      .toEqual(Array(3).fill(DecisionLookupStatus.NOT_FOUND));
  });

  it('does not send a request when the request ID is blank', async () => {
    await expect(service.lookup({ ...RESOLUTION, requestId: '  ' }))
      .rejects.toThrow('requestId is required');

    expect(decisionLookupClient.lookup).not.toHaveBeenCalled();
  });

  it('propagates a client failure', async () => {
    decisionLookupClient.lookup.mockRejectedValue(new Error('connection lost'));

    await expect(service.lookup(RESOLUTION)).rejects.toThrow('connection lost');
  });

  it('propagates a contract violation from the response', async () => {
    decisionLookupClient.lookup.mockResolvedValue({
      results: [{
        packageName: 'express',
        version: '5.2.1',
        integrity: 'sha512-a',
        lookupStatus: 'FOUND',
        decisionId: 'dec-1',
        // decision 누락
      }],
    });

    await expect(service.lookup({
      ...RESOLUTION,
      artifacts: [RESOLUTION.root],
    })).rejects.toThrow('must include a valid decision');
  });
});
