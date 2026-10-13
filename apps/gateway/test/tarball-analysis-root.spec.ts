import { AnalyzedArtifactRegistry } from '../src/cache/analyzed-artifact.registry';
import { ApprovalClient } from '../src/clients/approval.client';
import { ScannerClient } from '../src/clients/scanner.client';
import { PackageNotAllowedError } from '../src/errors/approval.errors';
import { ScannerRequestError } from '../src/errors/scanner.errors';
import { DecisionHandlerService } from '../src/services/decision-handler.service';
import { DecisionLookupService } from '../src/services/decision-lookup.service';
import { DependencyTreeService } from '../src/services/dependency-tree.service';
import { InstallDependencyHistoryService } from '../src/services/install-dependency-history.service';
import { RootInstallIntentService } from '../src/services/root-install-intent.service';
import { TarballAnalysisService } from '../src/services/tarball-analysis.service';
import type { ArtifactIdentity } from '../src/types/artifact.types';
import {
  Decision,
  DecisionLookupStatus,
} from '../src/types/decision.types';

function artifact(
  packageName: string,
  version: string,
): ArtifactIdentity {
  return {
    packageName,
    version,
    integrity: 'sha512-test',
  };
}

function foundBatch(
  requestId: string,
  target: ArtifactIdentity,
  decision: Decision,
) {
  return {
    requestId,
    results: [
      {
        artifact: target,
        lookupStatus: DecisionLookupStatus.FOUND,
        decision: {
          decisionId: `decision-${target.packageName}`,
          ecosystem: 'npm' as const,
          packageName: target.packageName,
          version: target.version,
          integrity: target.integrity,
          decision,
          evaluatedAt: '2026-10-04T00:00:00.000Z',
        },
      },
    ],
  };
}

describe('TarballAnalysisService Root tracking', () => {
  let service: TarballAnalysisService;
  let rootIntentService: RootInstallIntentService;
  const scan = jest.fn();
  const originalScannerEnabled = process.env.SCANNER_ENABLED;

  const recall = jest.fn();
  const forget = jest.fn();
  const remember = jest.fn();
  const runExclusive = jest.fn(
    async (task: () => Promise<unknown>) => task(),
  );

  const resolveForVersion = jest.fn();
  const recordHistory = jest.fn();

  const lookup = jest.fn();
  const registerApproval = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.SCANNER_ENABLED = 'true';

    rootIntentService = new RootInstallIntentService();

    recall.mockImplementation(
      (packageName: string, version: string) =>
        artifact(packageName, version),
    );

    lookup.mockImplementation(async (resolution) => {
      const target = resolution.artifacts[0];

      return foundBatch(
        resolution.requestId,
        target,
        Decision.ACCEPT,
      );
    });

    resolveForVersion.mockImplementation(
      async (
        requestId: string,
        packageName: string,
        version: string,
      ) => {
        const root = artifact(packageName, version);

        return {
          requestId,
          root,
          artifacts: [
            root,
            artifact('dep-a', '1.0.0'),
          ],
        };
      },
    );

    recordHistory.mockResolvedValue(undefined);
    registerApproval.mockResolvedValue(undefined);
    scan.mockResolvedValue(undefined);

    service = new TarballAnalysisService(
      {
        resolveForVersion,
      } as unknown as DependencyTreeService,

      {
        lookup,
      } as unknown as DecisionLookupService,

      new DecisionHandlerService(),

      {
        scan,
      } as unknown as ScannerClient,

      {
        register: registerApproval,
      } as unknown as ApprovalClient,

      {
        recall,
        runExclusive,
        remember,
        forget,
      } as unknown as AnalyzedArtifactRegistry,

      {
        record: recordHistory,
      } as unknown as InstallDependencyHistoryService,

      rootIntentService,
    );
  });

  afterAll(() => {
    if (originalScannerEnabled === undefined) {
      delete process.env.SCANNER_ENABLED;
    } else {
      process.env.SCANNER_ENABLED = originalScannerEnabled;
    }
  });

  it('returns Root=true once with ACCEPT decision metadata', async () => {
    rootIntentService.register('lodash');

    const first = await service.analyze(
      'request-1',
      'lodash',
      '4.17.21',
    );

    const second = await service.analyze(
      'request-2',
      'lodash',
      '4.17.21',
    );

    expect(first).toEqual({
      decision: Decision.ACCEPT,
      decisionId: 'decision-lodash',
      isRoot: true,
    });

    expect(second).toEqual({
      decision: Decision.ACCEPT,
      decisionId: 'decision-lodash',
      isRoot: false,
    });
  });

  it('keeps a dependency false without consuming the Root intent', async () => {
    rootIntentService.register('lodash');

    const dependency = await service.analyze(
      'request-dependency',
      'dep-a',
      '1.0.0',
    );

    const root = await service.analyze(
      'request-root',
      'lodash',
      '4.17.21',
    );

    expect(dependency.isRoot).toBe(false);
    expect(root.isRoot).toBe(true);
  });

  it('preserves decision metadata when the Root package is blocked', async () => {
    rootIntentService.register('lodash');

    lookup.mockImplementation(async (resolution) => {
      const target = resolution.artifacts[0];

      return foundBatch(
        resolution.requestId,
        target,
        Decision.REJECT,
      );
    });

    await expect(
      service.analyze(
        'request-blocked',
        'lodash',
        '4.17.21',
      ),
    ).rejects.toMatchObject({
      reasons: ['lodash@4.17.21=REJECT'],
      decision: Decision.REJECT,
      decisionId: 'decision-lodash',
      isRoot: true,
    });

    expect(forget).toHaveBeenCalledWith(
      'lodash',
      '4.17.21',
    );
  });

  it('stores the full Arborist closure for a Root request even on cache HIT',
    async () => {
      rootIntentService.register('lodash');

      await service.analyze(
        'request-root-history',
        'lodash',
        '4.17.21',
      );

      expect(resolveForVersion).toHaveBeenCalledWith(
        'request-root-history',
        'lodash',
        '4.17.21',
      );

      expect(recordHistory).toHaveBeenCalledWith({
        rootRequestId: 'request-root-history',
        root: {
          packageName: 'lodash',
          version: '4.17.21',
          integrity: 'sha512-test',
        },
        artifacts: [
          {
            packageName: 'lodash',
            version: '4.17.21',
            integrity: 'sha512-test',
          },
          {
            packageName: 'dep-a',
            version: '1.0.0',
            integrity: 'sha512-test',
          },
        ],
      });
    });

  it('reuses the resolved Root tree on cache MISS without a second Arborist call',
    async () => {
      rootIntentService.register('lodash');

      recall.mockReturnValue(undefined);

      const root = artifact('lodash', '4.17.21');

      resolveForVersion.mockResolvedValueOnce({
        requestId: 'request-root-miss',
        root,
        artifacts: [root],
      });

      await service.analyze(
        'request-root-miss',
        'lodash',
        '4.17.21',
      );

      expect(resolveForVersion).toHaveBeenCalledTimes(1);

      expect(recordHistory).toHaveBeenCalledWith({
        rootRequestId: 'request-root-miss',
        root,
        artifacts: [root],
      });
    });


  it('does not build or record Root history for a normal dependency request',
    async () => {
      await service.analyze(
        'request-dependency-only',
        'dep-a',
        '1.0.0',
      );

      expect(resolveForVersion).not.toHaveBeenCalled();
      expect(recordHistory).not.toHaveBeenCalled();
    });


  it('throws PackageNotAllowedError on a blocked package', async () => {
    lookup.mockImplementation(async (resolution) => {
      const target = resolution.artifacts[0];

      return foundBatch(
        resolution.requestId,
        target,
        Decision.HOLD,
      );
    });

    await expect(
      service.analyze(
        'request-hold',
        'lodash',
        '4.17.21',
      ),
    ).rejects.toBeInstanceOf(PackageNotAllowedError);
  });

  it('enforces a persisted fail-closed Decision after Scanner returns an error',
    async () => {
      rootIntentService.register('lodash');
      recall.mockReturnValue(undefined);
      scan.mockRejectedValue(new ScannerRequestError('scanner returned 500', 500));

      let lookupCount = 0;
      lookup.mockImplementation(async (resolution) => {
        lookupCount += 1;
        const target = resolution.artifacts[0];
        return lookupCount === 1
          ? {
              requestId: resolution.requestId,
              results: [{
                artifact: target,
                lookupStatus: DecisionLookupStatus.NOT_FOUND,
              }],
            }
          : foundBatch(resolution.requestId, target, Decision.REVIEW);
      });

      await expect(service.analyze(
        'request-scanner-error',
        'lodash',
        '4.17.21',
      )).rejects.toMatchObject({
        reasons: ['lodash@4.17.21=REVIEW'],
        decision: Decision.REVIEW,
        decisionId: 'decision-lodash',
        isRoot: true,
      });

      expect(scan).toHaveBeenCalledTimes(1);
      expect(lookup).toHaveBeenCalledTimes(2);
      expect(registerApproval).not.toHaveBeenCalled();
    });

  it('preserves the Scanner error when no persisted Decision exists', async () => {
    recall.mockReturnValue(undefined);
    const scannerError = new ScannerRequestError('scanner returned 500', 500);
    scan.mockRejectedValue(scannerError);
    lookup.mockImplementation(async (resolution) => ({
      requestId: resolution.requestId,
      results: [{
        artifact: resolution.artifacts[0],
        lookupStatus: DecisionLookupStatus.NOT_FOUND,
      }],
    }));

    await expect(service.analyze(
      'request-no-decision',
      'lodash',
      '4.17.21',
    )).rejects.toBe(scannerError);
  });
});
