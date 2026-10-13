import {
  BadRequestException,
  ConflictException,
  Controller,
  Get,
  Logger,
  Module,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import { PackageNotAllowedError } from '../src/errors/approval.errors';
import { GatewayModule } from '../src/gateway.module';
import type { GatewayErrorResponse } from '../src/dto/gateway-error-response.dto';
import { createGatewayApplication } from '../src/main';

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const INTERNAL_ERROR_MESSAGE =
  'database password leaked from /Users/example/private-config.ts';

const UPSTREAM_ERROR_MESSAGE = 'upstream registry connection refused';

@Controller('__test__')
class GatewayErrorTestController {
  @Get('bad-request')
  badRequest(): never {
    throw new BadRequestException('Invalid test input');
  }

  @Get('internal-error')
  internalError(): never {
    throw new Error(INTERNAL_ERROR_MESSAGE);
  }

  @Get('forbidden')
  forbidden(): never {
    throw new PackageNotAllowedError(['REJECT']);
  }

  @Get('conflict')
  conflict(): never {
    throw new ConflictException('Conflicting test state');
  }

  @Get('service-unavailable')
  serviceUnavailable(): never {
    throw new ServiceUnavailableException(UPSTREAM_ERROR_MESSAGE);
  }
}

@Controller('npm/__test__')
class NpmGatewayErrorTestController {
  @Get('forbidden')
  forbidden(): never {
    throw new PackageNotAllowedError(['REJECT']);
  }
}

@Module({
  imports: [GatewayModule],
  controllers: [GatewayErrorTestController, NpmGatewayErrorTestController],
})
class GatewayErrorTestModule {}

describe('Gateway Error Contract', () => {
  let app: NestFastifyApplication;
  let errorLogSpy: jest.SpyInstance;

  beforeAll(() => {
    errorLogSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
  });

  afterAll(() => {
    errorLogSpy.mockRestore();
  });

  beforeEach(() => {
    errorLogSpy.mockClear();
  });

  beforeAll(async () => {
    app = await createGatewayApplication(GatewayErrorTestModule);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('maps HTTP 400 to INVALID_REQUEST', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/__test__/bad-request',
    });

    const requestId = response.headers['x-request-id'];
    const responseBody = response.json() as GatewayErrorResponse;

    expect(response.statusCode).toBe(400);
    expect(requestId).toMatch(UUID_V4_PATTERN);
    expect(responseBody).toEqual({
      requestId,
      error: {
        code: 'INVALID_REQUEST',
        message: 'Invalid request',
        retryable: false,
      },
    });
  });

  it('maps HTTP 404 to RESOURCE_NOT_FOUND', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/missing-route',
    });

    const requestId = response.headers['x-request-id'];
    const responseBody = response.json() as GatewayErrorResponse;

    expect(response.statusCode).toBe(404);
    expect(requestId).toMatch(UUID_V4_PATTERN);
    expect(responseBody).toEqual({
      requestId,
      error: {
        code: 'RESOURCE_NOT_FOUND',
        message: 'Requested resource was not found',
        retryable: false,
      },
    });
  });

  it('maps unhandled errors to a sanitized GATEWAY_INTERNAL_ERROR', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/__test__/internal-error',
    });

    const requestId = response.headers['x-request-id'];
    const responseBody = response.json() as GatewayErrorResponse;

    expect(response.statusCode).toBe(500);
    expect(requestId).toMatch(UUID_V4_PATTERN);
    expect(responseBody).toEqual({
      requestId,
      error: {
        code: 'GATEWAY_INTERNAL_ERROR',
        message: 'Internal server error',
        retryable: false,
      },
    });
    expect(response.body).not.toContain(INTERNAL_ERROR_MESSAGE);
    expect(response.body).not.toContain('/Users/example');
    expect(response.body).not.toContain('private-config.ts');
    expect(responseBody).not.toHaveProperty('stack');
    expect(responseBody.error).not.toHaveProperty('stack');
  });

  // Decision 집행으로 차단된 요청. 요청 형식은 정상이므로 구분한다.
  it('maps 403 to PACKAGE_NOT_ALLOWED', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/__test__/forbidden',
    });

    const requestId = response.headers['x-request-id'];
    const responseBody = response.json() as GatewayErrorResponse;

    expect(response.statusCode).toBe(403);
    expect(requestId).toMatch(UUID_V4_PATTERN);
    expect(responseBody).toEqual({
      requestId,
      error: {
        code: 'PACKAGE_NOT_ALLOWED',
        message: 'Package is not allowed',
        retryable: false,
      },
    });
  });

  it('uses an npm-compatible string error for registry routes', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/npm/__test__/forbidden',
    });

    const requestId = response.headers['x-request-id'];
    const responseBody = response.json() as {
      requestId: string;
      error: string;
      code: string;
      retryable: boolean;
    };

    expect(response.statusCode).toBe(403);
    expect(requestId).toMatch(UUID_V4_PATTERN);
    expect(responseBody).toEqual({
      requestId,
      error: 'Package is not allowed',
      code: 'PACKAGE_NOT_ALLOWED',
      retryable: false,
    });
    expect(typeof responseBody.error).toBe('string');
  });

  it('keeps the original status for other client errors', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/__test__/conflict',
    });

    const requestId = response.headers['x-request-id'];
    const responseBody = response.json() as GatewayErrorResponse;

    expect(response.statusCode).toBe(409);
    expect(requestId).toMatch(UUID_V4_PATTERN);
    expect(responseBody).toEqual({
      requestId,
      error: {
        code: 'INVALID_REQUEST',
        message: 'Invalid request',
        retryable: false,
      },
    });
  });

  it('generalizes server-side HTTP exceptions to GATEWAY_INTERNAL_ERROR', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/__test__/service-unavailable',
    });

    const requestId = response.headers['x-request-id'];
    const responseBody = response.json() as GatewayErrorResponse;

    expect(response.statusCode).toBe(500);
    expect(requestId).toMatch(UUID_V4_PATTERN);
    expect(responseBody).toEqual({
      requestId,
      error: {
        code: 'GATEWAY_INTERNAL_ERROR',
        message: 'Internal server error',
        retryable: false,
      },
    });
    expect(response.body).not.toContain(UPSTREAM_ERROR_MESSAGE);
  });

  it('logs unhandled errors on the server with the request ID', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/__test__/internal-error',
    });

    const requestId = String(response.headers['x-request-id']);

    expect(response.statusCode).toBe(500);
    expect(errorLogSpy).toHaveBeenCalled();

    const loggedWithRequestId = errorLogSpy.mock.calls.some(
      (call: unknown[]) =>
        call.some(
          (argument) =>
            typeof argument === 'string' && argument.includes(requestId),
        ),
    );

    expect(loggedWithRequestId).toBe(true);
  });

  it('does not log client errors as server errors', async () => {
    await app.inject({ method: 'GET', url: '/__test__/bad-request' });
    await app.inject({ method: 'GET', url: '/missing-route' });
    await app.inject({ method: 'GET', url: '/__test__/forbidden' });

    expect(errorLogSpy).not.toHaveBeenCalled();
  });
});
