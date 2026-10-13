import { InstallDependencyHistoryService } from '../src/services/install-dependency-history.service';
import { UserDbService } from '../src/services/user-db.service';

describe('InstallDependencyHistoryService', () => {
  const query = jest.fn();
  const getPool = jest.fn(() => ({ query }));

  let configured = true;
  let service: InstallDependencyHistoryService;

  const db = {
    get configured() {
      return configured;
    },
    getPool,
  } as unknown as UserDbService;

  const root = {
    packageName: 'accepts',
    version: '1.3.8',
    integrity: 'sha512-root',
  };

  const dependency = {
    packageName: 'mime-db',
    version: '1.52.0',
    integrity: 'sha512-dependency',
  };

  beforeEach(() => {
    configured = true;

    query.mockReset().mockResolvedValue({
      rowCount: 2,
      rows: [],
    });

    getPool.mockClear();

    service = new InstallDependencyHistoryService(db);
  });

  it('does nothing when user DB is not configured', async () => {
    configured = false;

    await service.record({
      rootRequestId: 'root-request-1',
      root,
      artifacts: [root, dependency],
    });

    expect(getPool).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it('stores all artifacts under the same Root request id', async () => {
    const capturedAt = new Date('2026-10-05T00:00:00.000Z');

    await service.record({
      rootRequestId: 'root-request-1',
      root,
      artifacts: [root, dependency],
      capturedAt,
    });

    expect(query).toHaveBeenCalledTimes(1);

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining(
        'INSERT INTO install_dependency_history',
      ),
      [
        'root-request-1',
        'accepts',
        '1.3.8',
        ['accepts', 'mime-db'],
        ['1.3.8', '1.52.0'],
        ['sha512-root', 'sha512-dependency'],
        capturedAt,
      ],
    );
  });

  it('uses the shared UserDbService pool', async () => {
    await service.record({
      rootRequestId: 'root-request-1',
      root,
      artifacts: [root],
    });

    expect(getPool).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('does not block installation when persistence fails', async () => {
    query.mockRejectedValueOnce(
      new Error('database unavailable'),
    );

    await expect(
      service.record({
        rootRequestId: 'root-request-failure',
        root,
        artifacts: [root, dependency],
      }),
    ).resolves.toBeUndefined();
  });
});
