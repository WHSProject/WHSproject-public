import { createHash } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { MetadataController } from '../src/controllers/metadata.controller';
import { TarballController } from '../src/controllers/tarball.controller';
import { GatewayExceptionFilter } from '../src/http/gateway-exception.filter';
import { RegistryProxy } from '../src/http/registry-proxy';
import { NpmAuthService } from '../src/services/npm-auth.service';
import { UserDbService } from '../src/services/user-db.service';
import { DownloadEventService } from '../src/services/download-event.service';
import { PackageNameParserService } from '../src/services/package-name-parser.service';
import { TarballPathParserService } from '../src/services/tarball-path-parser.service';
import { TarballAnalysisService } from '../src/services/tarball-analysis.service';

const TOKEN = `whs_npm_${'a'.repeat(43)}`;
const TARBALL = '/npm/lodash/-/lodash-4.17.21.tgz';
const USER = { id: 'user-a', username: 'alice', role: 'developer', active: true };
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

// HTTP Route에서 실제 인증 서비스를 거친다. DB와 하위 서비스만 대체한다.
describe('npm authentication HTTP boundary', () => {
  let app: NestFastifyApplication;
  const query = jest.fn();
  const getPool = jest.fn(() => ({ query }));
  const analyze = jest.fn();
  const forward = jest.fn(async (_request, reply) => { await reply.send('ok'); });
  const record = jest.fn();

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [MetadataController, TarballController],
      providers: [NpmAuthService, PackageNameParserService, TarballPathParserService,
        { provide: UserDbService, useValue: { getPool } },
        { provide: TarballAnalysisService, useValue: { analyze } },
        { provide: RegistryProxy, useValue: { forward } },
        { provide: DownloadEventService, useValue: { record } },
        { provide: APP_FILTER, useClass: GatewayExceptionFilter },
      ],
    }).compile();
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), { logger: false });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });
  afterAll(async () => app.close());
  beforeEach(() => {
    jest.clearAllMocks();
    getPool.mockImplementation(() => ({ query }));
    query.mockReset().mockResolvedValue({ rows: [USER] });
    analyze.mockResolvedValue({
      decision: null,
      decisionId: null,
      isRoot: false,
    });
    record.mockResolvedValue(undefined);
  });

  it.each(['/npm/lodash', TARBALL, '/npm/@scope/name'])('requires authentication before any downstream call: %s', async (url) => {
    const response = await app.inject({ method: 'GET', url });
    expect(response.statusCode).toBe(401);
    expect(response.json().code).toBe('AUTHENTICATION_REQUIRED');
    expect(query).not.toHaveBeenCalled();
    expect(analyze).not.toHaveBeenCalled();
    expect(forward).not.toHaveBeenCalled();
  });

  it.each(['Basic abc', 'Bearer invalid', `Bearer ${TOKEN} extra`])('rejects invalid credentials without querying DB (%s)', async (authorization) => {
    expect((await app.inject({ method: 'GET', url: TARBALL, headers: { authorization } })).statusCode).toBe(401);
    expect(query).not.toHaveBeenCalled();
    expect(forward).not.toHaveBeenCalled();
  });

  it('records one anonymous event for an expired/revoked token and does not trust supplied identity', async () => {
    query.mockResolvedValue({ rows: [] });
    const response = await app.inject({ method: 'GET', url: TARBALL, headers: { authorization: `Bearer ${TOKEN}`, username: 'admin', 'x-user-id': 'admin' } });
    await settle();
    expect(response.statusCode).toBe(401);
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'UNAUTHENTICATED', userId: null, username: null, httpStatus: 401 }));
    expect(query.mock.calls[0][1]).toEqual([createHash('sha256').update(TOKEN).digest('hex')]);
    expect(analyze).not.toHaveBeenCalled();
    expect(forward).not.toHaveBeenCalled();
  });

  it.each([
    { role: 'viewer', active: true }, { role: null, active: true },
    { role: 'unknown', active: true }, { role: 'admin', active: false },
  ])('records forbidden with verified identity for %j', async (state) => {
    query.mockResolvedValue({ rows: [{ ...USER, ...state }] });
    const response = await app.inject({ method: 'GET', url: TARBALL, headers: { authorization: `Bearer ${TOKEN}` } });
    await settle();
    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe('INSTALL_NOT_PERMITTED');
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'FORBIDDEN', userId: USER.id, username: USER.username, decision: null }));
    expect(analyze).not.toHaveBeenCalled();
    expect(forward).not.toHaveBeenCalled();
  });

  it.each(['developer', 'editor', 'admin'])('allows %s and records verified identity', async (role) => {
    query.mockResolvedValue({ rows: [{ ...USER, role }] });
    expect((await app.inject({ method: 'GET', url: TARBALL, headers: { authorization: `Bearer ${TOKEN}`, username: 'forged' } })).statusCode).toBe(200);
    await settle();
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'DELIVERED', userId: USER.id, username: 'alice' }));
    expect(analyze).toHaveBeenCalledTimes(1);
    expect(forward).toHaveBeenCalledTimes(1);
  });

  it('checks current role on every request without an auth cache', async () => {
    const request = { method: 'GET' as const, url: '/npm/lodash', headers: { authorization: `Bearer ${TOKEN}` } };
    expect((await app.inject(request)).statusCode).toBe(200);
    query.mockResolvedValue({ rows: [{ ...USER, role: 'viewer' }] });
    expect((await app.inject(request)).statusCode).toBe(403);
    expect(query).toHaveBeenCalledTimes(2);
    expect(forward).toHaveBeenCalledTimes(1);
  });

  it.each(['unconfigured', 'unreachable'])('fails closed when DB is %s', async (mode) => {
    if (mode === 'unconfigured') getPool.mockImplementation(() => { throw new Error('User DB is not configured'); });
    else query.mockRejectedValue(new Error('connection failed'));
    const response = await app.inject({ method: 'GET', url: TARBALL, headers: { authorization: `Bearer ${TOKEN}` } });
    await settle();
    expect(response.statusCode).toBe(500);
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'ERROR', userId: null }));
    expect(analyze).not.toHaveBeenCalled();
    expect(forward).not.toHaveBeenCalled();
  });

  it('a real UserDbService rejects valid tokens when DB_HOST is missing', async () => {
    const host = process.env.DB_HOST;
    delete process.env.DB_HOST;
    try {
      const service = new NpmAuthService(new UserDbService());
      await expect(service.authenticate(`Bearer ${TOKEN}`)).rejects.toThrow('not configured');
    } finally {
      if (host !== undefined) process.env.DB_HOST = host;
    }
  });
});
