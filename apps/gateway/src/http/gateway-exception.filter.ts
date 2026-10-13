import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';

import { PackageNotAllowedError } from '../errors/approval.errors';
import { NpmAuthenticationError, InstallNotPermittedError } from '../errors/npm-auth.errors';
import type { GatewayErrorResponse } from '../dto/gateway-error-response.dto';
import { GatewayErrorCode } from '../errors/gateway-error-code';

interface GatewayErrorMapping {
  statusCode: number;
  code: GatewayErrorCode;
  message: string;
}

function mapGatewayError(exception: unknown): GatewayErrorMapping {
  const statusCode =
    exception instanceof HttpException
      ? exception.getStatus()
      : HttpStatus.INTERNAL_SERVER_ERROR;

  if (exception instanceof NpmAuthenticationError) {
    return { statusCode: 401, code: GatewayErrorCode.AUTHENTICATION_REQUIRED, message: 'Configure an npm token issued in Dashboard settings' };
  }
  if (exception instanceof InstallNotPermittedError) {
    return { statusCode: 403, code: GatewayErrorCode.INSTALL_NOT_PERMITTED, message: 'This account cannot install packages' };
  }
  if (exception instanceof PackageNotAllowedError) {
    return {
      statusCode: HttpStatus.FORBIDDEN,
      code: GatewayErrorCode.PACKAGE_NOT_ALLOWED,
      message: 'Package is not allowed',
    };
  }

  if (statusCode === HttpStatus.NOT_FOUND) {
    return {
      statusCode: HttpStatus.NOT_FOUND,
      code: GatewayErrorCode.RESOURCE_NOT_FOUND,
      message: 'Requested resource was not found',
    };
  }

  // 4xx는 원래 상태 코드를 유지하고, 5xx만 500으로 일반화한다
  if (
    statusCode >= HttpStatus.BAD_REQUEST &&
    statusCode < HttpStatus.INTERNAL_SERVER_ERROR
  ) {
    return {
      statusCode,
      code: GatewayErrorCode.INVALID_REQUEST,
      message: 'Invalid request',
    };
  }

  return {
    statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
    code: GatewayErrorCode.GATEWAY_INTERNAL_ERROR,
    message: 'Internal server error',
  };
}

@Catch()
export class GatewayExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GatewayExceptionFilter.name);

  constructor(private readonly httpAdapterHost: HttpAdapterHost) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const httpContext = host.switchToHttp();
    const request = httpContext.getRequest<{ id: string; url?: string }>();
    const response = httpContext.getResponse();

    const mapping = mapGatewayError(exception);

    const apiResponseBody: GatewayErrorResponse = {
      requestId: request.id,
      error: {
        code: mapping.code,
        message: mapping.message,
        retryable: false,
      },
    };

    // npm CLI는 registry 오류 응답의 `error`를 문자열로 출력한다.
    // /npm/ 경로에서는 일반 Gateway API contract를 깨지 않으면서
    // npm이 사람이 읽을 수 있는 메시지를 표시하도록 별도 envelope를 사용한다.
    const responseBody =
      request.url?.startsWith('/npm/') === true
        ? {
            requestId: request.id,
            error: mapping.message,
            code: mapping.code,
            retryable: false,
          }
        : apiResponseBody;

    // 응답은 일반 메시지만 내보내므로 원인은 서버 로그에만 남긴다
    if (mapping.statusCode === HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        `Unhandled gateway error requestId=${request.id} status=${mapping.statusCode}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    this.httpAdapterHost.httpAdapter.reply(
      response,
      responseBody,
      mapping.statusCode,
    );
  }
}
