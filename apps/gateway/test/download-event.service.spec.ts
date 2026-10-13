import { UserDbService } from '../src/services/user-db.service';
import { Logger } from '@nestjs/common';

const poolQuery = jest.fn();
const poolEnd = jest.fn();
const poolOn = jest.fn();

// 실제 DB에 접속하지 않도록 Pool을 대체한다.
jest.mock('pg', () => ({
  Pool: jest.fn().mockImplementation(() => ({
    query: poolQuery,
    end: poolEnd,
    on: poolOn,
  })),
}));

// eslint-disable-next-line import/first
import { Pool } from 'pg';
// eslint-disable-next-line import/first
import {
  DownloadEventService,
  type DownloadEvent,
} from '../src/services/download-event.service';
// eslint-disable-next-line import/first
import { Decision } from '../src/types/decision.types';

const poolMock = Pool as unknown as jest.Mock;

const EVENT: DownloadEvent = {
  occurredAt: new Date('2026-10-04T00:00:00.000Z'),
  requestId: 'request-1',
  sourceIp: '127.0.0.1',
  packageName: 'lodash',
  version: '4.17.21',
  outcome: 'DELIVERED',
  httpStatus: 200,
  decision: Decision.ACCEPT,
  decisionId: 'decision-1',
  isRoot: true,
  userId: '00000000-0000-0000-0000-000000000001',
  username: 'alice',
};

describe('DownloadEventService', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    poolMock.mockClear();
    poolQuery.mockReset();
    poolEnd.mockReset();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  // 테스트·로컬 실행이 개발자 DB에 기록하지 않도록 DB_HOST가 있어야만 켠다
  it('does nothing when DB_HOST is not set', async () => {
    delete process.env.DB_HOST;

    const db = new UserDbService();
    const service = new DownloadEventService(db);

    await expect(service.record(EVENT)).resolves.toBeUndefined();
    expect(poolMock).not.toHaveBeenCalled();
  });

  it('inserts the event with parameters in column order', async () => {
    process.env.DB_HOST = 'postgres';
    process.env.DB_PORT = '5433';
    poolQuery.mockResolvedValue({ rowCount: 1 });

    const db = new UserDbService();
    const service = new DownloadEventService(db);
    await service.record(EVENT);

    expect(poolMock).toHaveBeenCalledWith(expect.objectContaining({
      host: 'postgres',
      port: 5433,
      database: 'user_db',
    }));

    const [sql, params] = poolQuery.mock.calls[0] as [string, unknown[]];

    expect(sql).toContain('INSERT INTO download_events');
    expect(params).toEqual([
      EVENT.occurredAt,
      'request-1',
      '127.0.0.1',
      'lodash',
      '4.17.21',
      'DELIVERED',
      200,
      'ACCEPT',
      'decision-1',
      true,
      '00000000-0000-0000-0000-000000000001',
      'alice',
    ]);
  });

  it('reuses one pool and closes it on module destroy', async () => {
    process.env.DB_HOST = 'postgres';
    poolQuery.mockResolvedValue({ rowCount: 1 });

    const db = new UserDbService();
    const service = new DownloadEventService(db);
    await service.record(EVENT);
    await service.record(EVENT);
    await db.onModuleDestroy();

    expect(poolMock).toHaveBeenCalledTimes(1);
    expect(poolEnd).toHaveBeenCalledTimes(1);
  });

  // 기록 실패가 설치를 막으면 안 된다
  it('resolves and logs a warning when the insert fails', async () => {
    process.env.DB_HOST = 'postgres';
    poolQuery.mockRejectedValue(new Error('connect ECONNREFUSED'));
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();

    const db = new UserDbService();
    const service = new DownloadEventService(db);

    await expect(service.record(EVENT)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('requestId=request-1'),
    );

    warn.mockRestore();
  });
});
