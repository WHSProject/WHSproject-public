import { NpmAuthService } from '../src/services/npm-auth.service';
import { APP_FILTER } from '@nestjs/core';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { FastifyReply } from 'fastify';

import { TarballController } from '../src/controllers/tarball.controller';
import { PackageNotAllowedError } from '../src/errors/approval.errors';
import { GatewayExceptionFilter } from '../src/http/gateway-exception.filter';
import { RegistryProxy } from '../src/http/registry-proxy';
import { DownloadEventService } from '../src/services/download-event.service';
import { PackageNameParserService } from '../src/services/package-name-parser.service';
import { TarballAnalysisService } from '../src/services/tarball-analysis.service';
import { TarballPathParserService } from '../src/services/tarball-path-parser.service';
import { Decision } from '../src/types/decision.types';

const TARBALL_URL = '/npm/lodash/-/lodash-4.17.21.tgz';

// 기록은 응답이 닫힌 뒤(close) 비동기로 남으므로 잠시 기다린다.
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

describe('Tarball 다운로드 기록', () => {
  let app: NestFastifyApplication;
  const analyze = jest.fn();
  const forward = jest.fn();
  const record = jest.fn();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [TarballController],
      providers: [
        { provide: NpmAuthService, useValue: { authenticate: jest.fn().mockResolvedValue({ userId: 'user-1', username: 'alice' }) } },
        PackageNameParserService,
        TarballPathParserService,
        { provide: TarballAnalysisService, useValue: { analyze } },
        { provide: RegistryProxy, useValue: { forward } },
        { provide: DownloadEventService, useValue: { record } },
        { provide: APP_FILTER, useClass: GatewayExceptionFilter },
      ],
    }).compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
      { logger: false },
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    analyze.mockReset().mockResolvedValue({
      decision: Decision.ACCEPT,
      decisionId: 'decision-lodash',
      isRoot: true,
    });
    record.mockReset().mockResolvedValue(undefined);
    forward.mockReset().mockImplementation(
      async (_request: unknown, reply: FastifyReply) => {
        reply.status(200);
        await reply.send(Buffer.from('tarball'));
      },
    );
  });

  it('records DELIVERED with the final status', async () => {
    const response = await app.inject({ method: 'GET', url: TARBALL_URL });
    await settle();

    expect(response.statusCode).toBe(200);
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith({
      occurredAt: expect.any(Date),
      requestId: expect.any(String),
      sourceIp: '127.0.0.1',
      packageName: 'lodash',
      version: '4.17.21',
      outcome: 'DELIVERED',
      httpStatus: 200,
      decision: Decision.ACCEPT,
      decisionId: 'decision-lodash',
      isRoot: true,
      userId: 'user-1',
      username: 'alice',
    });
  });

  it('records the scoped package name', async () => {
    await app.inject({ method: 'GET', url: '/npm/@babel/core/-/core-8.0.1.tgz' });
    await settle();

    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      packageName: '@babel/core',
      version: '8.0.1',
    }));
  });

  it('records BLOCKED with 403 when the package is not allowed', async () => {
    analyze.mockRejectedValue(
      new PackageNotAllowedError(
        ['lodash@4.17.21=REJECT'],
        Decision.REJECT,
        'decision-reject',
        true,
      ),
    );

    const response = await app.inject({ method: 'GET', url: TARBALL_URL });
    await settle();

    expect(response.statusCode).toBe(403);
    expect(forward).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'BLOCKED',
      httpStatus: 403,
      decision: Decision.REJECT,
      decisionId: 'decision-reject',
      isRoot: true,
    }));
  });

  it('records ERROR with 500 on other errors', async () => {
    analyze.mockRejectedValue(new Error('decision lookup failed'));

    const response = await app.inject({ method: 'GET', url: TARBALL_URL });
    await settle();

    expect(response.statusCode).toBe(500);
    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'ERROR',
      httpStatus: 500,
    }));
  });

  it('records ERROR when forwarding fails', async () => {
    forward.mockRejectedValue(new Error('verdaccio unreachable'));

    const response = await app.inject({ method: 'GET', url: TARBALL_URL });
    await settle();

    expect(response.statusCode).toBe(500);
    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'ERROR',
      httpStatus: 500,
    }));
  });

  // Verdaccio가 돌려준 4xx·5xx는 중계는 됐지만 전달되지 않은 것이다
  it('records ERROR when Verdaccio answers with an error status', async () => {
    forward.mockImplementation(
      async (_request: unknown, reply: FastifyReply) => {
        reply.status(404);
        await reply.send('not found');
      },
    );

    await app.inject({ method: 'GET', url: TARBALL_URL });
    await settle();

    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'ERROR',
      httpStatus: 404,
    }));
  });

  // 응답 전에 연결이 끊기면 상태 코드 기본값(200)을 믿지 않는다
  it('records ERROR without a status when the connection closes early',
    async () => {
      forward.mockImplementation(
        async (_request: unknown, reply: FastifyReply) => {
          reply.raw.destroy();
        },
      );

      await app.inject({ method: 'GET', url: TARBALL_URL }).catch(() => undefined);
      await settle();

      expect(record).toHaveBeenCalledWith(expect.objectContaining({
        outcome: 'ERROR',
        httpStatus: null,
      }));
    });

  // 패키지·Version을 알 수 없어 기록할 수 없다
  it('does not record an invalid tarball path', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/npm/lodash/-/other-4.17.21.tgz',
    });
    await settle();

    expect(response.statusCode).toBe(400);
    expect(record).not.toHaveBeenCalled();
  });

  it('does not delay the response while recording', async () => {
    record.mockReturnValue(new Promise(() => undefined));

    const response = await app.inject({ method: 'GET', url: TARBALL_URL });

    expect(response.statusCode).toBe(200);
  });
});
