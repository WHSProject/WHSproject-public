import { Test } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';

import { ScanController } from '../src/api/scan.controller';
import { ScanService } from '../src/application/scan-service/scan.service';
import type { ScanResult } from '../src/domain/analysis.types';

const VALID_INTEGRITY = `sha512-${'A'.repeat(86)}`;

function scanResult(
  scanId: string,
  status: ScanResult['status'] = 'COMPLETED',
): ScanResult {
  return {
    schemaVersion: '0.1',
    requestId: '123e4567-e89b-12d3-a456-426614174000',
    scanId,
    subject: { name: 'example', version: '1.0.0', ecosystem: 'npm' },
    artifactHash: 'sha256-hash',
    status,
    evidences: [],
    analyzerSummaries: [],
    errors: [],
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolvePromise!: () => void;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });

  return { promise, resolve: resolvePromise };
}

describe('ScanController', () => {
  let app: NestFastifyApplication;
  let scan: jest.MockedFunction<ScanService['scan']>;

  beforeEach(async () => {
    scan = jest.fn()
      .mockResolvedValueOnce(scanResult('scan-1'))
      .mockResolvedValueOnce(scanResult('scan-2'));

    const moduleRef = await Test.createTestingModule({
      controllers: [ScanController],
      providers: [{ provide: ScanService, useValue: { scan } }],
    }).compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('accepts a valid batch and maps every package to ScanService', async () => {
    const response = await app.getHttpAdapter().getInstance().inject({
      method: 'POST',
      url: '/internal/v1/scans',
      payload: {
        requestId: '123e4567-e89b-12d3-a456-426614174000',
        packages: [
          { packageName: 'example', version: '1.0.0', integrity: VALID_INTEGRITY },
          { packageName: '@scope/other', version: '2.0.0', integrity: VALID_INTEGRITY },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('');
    expect(scan).toHaveBeenNthCalledWith(1, {
      requestId: '123e4567-e89b-12d3-a456-426614174000',
      packageName: 'example',
      version: '1.0.0',
      integrity: VALID_INTEGRITY,
    });
    expect(scan).toHaveBeenNthCalledWith(2, {
      requestId: '123e4567-e89b-12d3-a456-426614174000',
      packageName: '@scope/other',
      version: '2.0.0',
      integrity: VALID_INTEGRITY,
    });
  });

  it.each([
    ['requestId missing', { packages: [{ packageName: 'example', version: '1.0.0', integrity: VALID_INTEGRITY }] }],
    ['requestId invalid UUID', {
      requestId: 'not-a-uuid',
      packages: [{ packageName: 'example', version: '1.0.0', integrity: VALID_INTEGRITY }],
    }],
    ['packages missing', { requestId: '123e4567-e89b-12d3-a456-426614174000' }],
    ['packages empty', { requestId: '123e4567-e89b-12d3-a456-426614174000', packages: [] }],
    ['packageName missing', {
      requestId: '123e4567-e89b-12d3-a456-426614174000',
      packages: [{ version: '1.0.0', integrity: null }],
    }],
    ['packageName empty', {
      requestId: '123e4567-e89b-12d3-a456-426614174000',
      packages: [{ packageName: '', version: '1.0.0', integrity: null }],
    }],
    ['packageName invalid npm name', {
      requestId: '123e4567-e89b-12d3-a456-426614174000',
      packages: [{ packageName: 'not a package', version: '1.0.0', integrity: VALID_INTEGRITY }],
    }],
    ['version missing', {
      requestId: '123e4567-e89b-12d3-a456-426614174000',
      packages: [{ packageName: 'example', integrity: null }],
    }],
    ['version empty', {
      requestId: '123e4567-e89b-12d3-a456-426614174000',
      packages: [{ packageName: 'example', version: '', integrity: null }],
    }],
    ['version non-exact semver', {
      requestId: '123e4567-e89b-12d3-a456-426614174000',
      packages: [{ packageName: 'example', version: '^1.0.0', integrity: VALID_INTEGRITY }],
    }],
    ['integrity missing', {
      requestId: '123e4567-e89b-12d3-a456-426614174000',
      packages: [{ packageName: 'example', version: '1.0.0' }],
    }],
    ['integrity null', {
      requestId: '123e4567-e89b-12d3-a456-426614174000',
      packages: [{ packageName: 'example', version: '1.0.0', integrity: null }],
    }],
    ['integrity non-SHA512 SRI', {
      requestId: '123e4567-e89b-12d3-a456-426614174000',
      packages: [{ packageName: 'example', version: '1.0.0', integrity: 'sha256-AAAA' }],
    }],
    ['integrity invalid SRI', {
      requestId: '123e4567-e89b-12d3-a456-426614174000',
      packages: [{ packageName: 'example', version: '1.0.0', integrity: 'not-integrity' }],
    }],
    ['integrity non-string', {
      requestId: '123e4567-e89b-12d3-a456-426614174000',
      packages: [{ packageName: 'example', version: '1.0.0', integrity: 123 }],
    }],
  ] as const)('rejects invalid %s without scanning', async (_case, payload) => {
    const response = await app.getHttpAdapter().getInstance().inject({
      method: 'POST',
      url: '/internal/v1/scans',
      payload,
    });

    expect(response.statusCode).toBe(400);
    expect(scan).not.toHaveBeenCalled();
  });

  it('does not use 202 for the synchronous response', async () => {
    const response = await app.getHttpAdapter().getInstance().inject({
      method: 'POST',
      url: '/internal/v1/scans',
      payload: {
        requestId: '123e4567-e89b-12d3-a456-426614174000',
        packages: [{ packageName: 'example', version: '1.0.0', integrity: VALID_INTEGRITY }],
      },
    });

    expect(response.statusCode).not.toBe(202);
  });

  it('processes the batch with bounded concurrency', async () => {
    scan.mockReset();
    let active = 0;
    let maximumActive = 0;
    let nextScanId = 1;

    scan.mockImplementation(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await Promise.resolve();
      active -= 1;
      return scanResult(`scan-${nextScanId++}`);
    });

    const response = await app.getHttpAdapter().getInstance().inject({
      method: 'POST',
      url: '/internal/v1/scans',
      payload: {
        requestId: '123e4567-e89b-12d3-a456-426614174000',
        packages: [
          { packageName: 'one', version: '1.0.0', integrity: VALID_INTEGRITY },
          { packageName: 'two', version: '1.0.0', integrity: VALID_INTEGRITY },
          { packageName: 'three', version: '1.0.0', integrity: VALID_INTEGRITY },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(maximumActive).toBe(3);
    expect(scan).toHaveBeenCalledTimes(3);
  });

  it('uses only as many workers as there are packages', async () => {
    scan.mockReset();
    let active = 0;
    let maximumActive = 0;

    scan.mockImplementation(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await Promise.resolve();
      active -= 1;
      return scanResult('scan');
    });

    const response = await app.getHttpAdapter().getInstance().inject({
      method: 'POST',
      url: '/internal/v1/scans',
      payload: {
        requestId: '123e4567-e89b-12d3-a456-426614174000',
        packages: [
          { packageName: 'one', version: '1.0.0', integrity: VALID_INTEGRITY },
          { packageName: 'two', version: '1.0.0', integrity: VALID_INTEGRITY },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(maximumActive).toBe(2);
    expect(scan).toHaveBeenCalledTimes(2);
  });

  it('starts the next package when a worker becomes available', async () => {
    scan.mockReset();
    const slowA = deferred();
    const dStarted = deferred();
    const started: string[] = [];

    scan.mockImplementation(async ({ packageName }) => {
      started.push(packageName);
      if (packageName === 'd') {
        dStarted.resolve();
      }
      if (packageName === 'a') {
        await slowA.promise;
      }
      return scanResult(`scan-${packageName}`);
    });

    const responsePromise = app.getHttpAdapter().getInstance().inject({
      method: 'POST',
      url: '/internal/v1/scans',
      payload: {
        requestId: '123e4567-e89b-12d3-a456-426614174000',
        packages: [
          { packageName: 'a', version: '1.0.0', integrity: VALID_INTEGRITY },
          { packageName: 'b', version: '1.0.0', integrity: VALID_INTEGRITY },
          { packageName: 'c', version: '1.0.0', integrity: VALID_INTEGRITY },
          { packageName: 'd', version: '1.0.0', integrity: VALID_INTEGRITY },
        ],
      },
    });

    await dStarted.promise;
    expect(started).toEqual(expect.arrayContaining(['a', 'b', 'c', 'd']));

    slowA.resolve();
    const response = await responsePromise;
    expect(response.statusCode).toBe(200);
    expect(scan).toHaveBeenCalledTimes(4);
  });

  it('continues to the next package after an unexpected scan failure', async () => {
    scan.mockReset();
    scan
      .mockRejectedValueOnce(new Error('package A failed'))
      .mockResolvedValueOnce(scanResult('scan-b'));

    const response = await app.getHttpAdapter().getInstance().inject({
      method: 'POST',
      url: '/internal/v1/scans',
      payload: {
        requestId: '123e4567-e89b-12d3-a456-426614174000',
        packages: [
          { packageName: 'a', version: '1.0.0', integrity: VALID_INTEGRITY },
          { packageName: 'b', version: '1.0.0', integrity: VALID_INTEGRITY },
        ],
      },
    });

    expect(scan).toHaveBeenCalledTimes(2);
    expect(scan).toHaveBeenNthCalledWith(2, {
      requestId: '123e4567-e89b-12d3-a456-426614174000',
      packageName: 'b',
      version: '1.0.0',
      integrity: VALID_INTEGRITY,
    });
    expect(response.statusCode).not.toBe(200);
  });

  it('attempts every package when an unexpected scan failure occurs', async () => {
    scan.mockReset();
    scan
      .mockRejectedValueOnce(new Error('package A failed'))
      .mockResolvedValueOnce(scanResult('scan-b'))
      .mockResolvedValueOnce(scanResult('scan-c'));

    const response = await app.getHttpAdapter().getInstance().inject({
      method: 'POST',
      url: '/internal/v1/scans',
      payload: {
        requestId: '123e4567-e89b-12d3-a456-426614174000',
        packages: [
          { packageName: 'a', version: '1.0.0', integrity: VALID_INTEGRITY },
          { packageName: 'b', version: '1.0.0', integrity: VALID_INTEGRITY },
          { packageName: 'c', version: '1.0.0', integrity: VALID_INTEGRITY },
        ],
      },
    });

    expect(scan).toHaveBeenCalledTimes(3);
    expect(scan.mock.calls.map(([request]) => request.packageName)).toEqual(['a', 'b', 'c']);
    expect(response.statusCode).not.toBe(200);
  });

  it('continues every package after one worker failure', async () => {
    scan.mockReset();
    scan.mockImplementation(async ({ packageName }) => {
      if (packageName === 'a') {
        throw new Error('package A failed');
      }
      return scanResult(`scan-${packageName}`);
    });

    const response = await app.getHttpAdapter().getInstance().inject({
      method: 'POST',
      url: '/internal/v1/scans',
      payload: {
        requestId: '123e4567-e89b-12d3-a456-426614174000',
        packages: [
          { packageName: 'a', version: '1.0.0', integrity: VALID_INTEGRITY },
          { packageName: 'b', version: '1.0.0', integrity: VALID_INTEGRITY },
          { packageName: 'c', version: '1.0.0', integrity: VALID_INTEGRITY },
          { packageName: 'd', version: '1.0.0', integrity: VALID_INTEGRITY },
        ],
      },
    });

    expect(response.statusCode).not.toBe(200);
    expect(scan).toHaveBeenCalledTimes(4);
    expect(scan.mock.calls.map(([request]) => request.packageName)).toEqual(
      expect.arrayContaining(['a', 'b', 'c', 'd']),
    );
  });

  it.each(['FAILED', 'PARTIAL', 'TIMEOUT'] as const)(
    'handles a resolved %s ScanResult according to its status',
    async (status) => {
      scan.mockReset();
      scan.mockResolvedValue(scanResult('scan-result', status));

      const response = await app.getHttpAdapter().getInstance().inject({
        method: 'POST',
        url: '/internal/v1/scans',
        payload: {
          requestId: '123e4567-e89b-12d3-a456-426614174000',
          packages: [
            { packageName: 'a', version: '1.0.0', integrity: VALID_INTEGRITY },
            { packageName: 'b', version: '1.0.0', integrity: VALID_INTEGRITY },
          ],
        },
      });

      expect(response.statusCode).toBe(status === 'PARTIAL' ? 200 : 500);
      expect(scan).toHaveBeenCalledTimes(2);
    },
  );
});
