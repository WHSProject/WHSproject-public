import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import { RootInstallIntentController } from '../src/controllers/root-install-intent.controller';
import { GatewayExceptionFilter } from '../src/http/gateway-exception.filter';
import { createGatewayApplication } from '../src/main';
import { PackageNameParserService } from '../src/services/package-name-parser.service';
import { RootInstallIntentService } from '../src/services/root-install-intent.service';

@Module({
  controllers: [RootInstallIntentController],
  providers: [
    PackageNameParserService,
    RootInstallIntentService,
    {
      provide: APP_FILTER,
      useClass: GatewayExceptionFilter,
    },
  ],
})
class RootInstallIntentTestModule {}

describe('RootInstallIntentController', () => {
  let app: NestFastifyApplication;
  let intentService: RootInstallIntentService;

  beforeAll(async () => {
    app = await createGatewayApplication(RootInstallIntentTestModule);

    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    intentService = app.get(RootInstallIntentService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    intentService.clear();
  });

  it('registers a root install intent with production body parsing', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/internal/v1/install-intents',
      headers: {
        'content-type': 'application/json',
      },
      payload: JSON.stringify({
        packageName: 'express',
      }),
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({
      registered: true,
      packageName: 'express',
    });

    expect(intentService.consume('express')).toBe(true);
    expect(intentService.consume('express')).toBe(false);
  });

  it('registers a scoped package intent', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/internal/v1/install-intents',
      headers: {
        'content-type': 'application/json',
      },
      payload: JSON.stringify({
        packageName: '@babel/core',
      }),
    });

    expect(response.statusCode).toBe(201);
    expect(intentService.consume('@babel/core')).toBe(true);
  });

  it('rejects a missing package name', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/internal/v1/install-intents',
      headers: {
        'content-type': 'application/json',
      },
      payload: JSON.stringify({}),
    });

    expect(response.statusCode).toBe(400);
  });

  it('rejects an invalid package name', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/internal/v1/install-intents',
      headers: {
        'content-type': 'application/json',
      },
      payload: JSON.stringify({
        packageName: 'React',
      }),
    });

    expect(response.statusCode).toBe(400);
  });

  it('rejects malformed JSON', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/internal/v1/install-intents',
      headers: {
        'content-type': 'application/json',
      },
      payload: '{"packageName":',
    });

    expect(response.statusCode).toBe(400);
  });
});
