import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import { createGatewayApplication } from '../src/main';

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('Gateway Health Check', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await createGatewayApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /health returns 200 and gateway status', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: 'ok',
      service: 'gateway',
    });
    expect(response.headers['x-request-id']).toMatch(UUID_V4_PATTERN);
  });

  it('generates a different request ID for each request', async () => {
    const firstResponse = await app.inject({
      method: 'GET',
      url: '/health',
    });

    const secondResponse = await app.inject({
      method: 'GET',
      url: '/health',
    });

    const firstRequestId = firstResponse.headers['x-request-id'];
    const secondRequestId = secondResponse.headers['x-request-id'];

    expect(firstRequestId).toMatch(UUID_V4_PATTERN);
    expect(secondRequestId).toMatch(UUID_V4_PATTERN);
    expect(firstRequestId).not.toBe(secondRequestId);
  });

  it('ignores a client-supplied request ID', async () => {
    const clientRequestId = 'client-controlled-request-id';

    const response = await app.inject({
      method: 'GET',
      url: '/health',
      headers: {
        'x-request-id': clientRequestId,
      },
    });

    const responseRequestId = response.headers['x-request-id'];

    expect(responseRequestId).toMatch(UUID_V4_PATTERN);
    expect(responseRequestId).not.toBe(clientRequestId);
  });
});
