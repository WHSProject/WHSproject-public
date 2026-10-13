import type { GatewayErrorCode } from '../errors/gateway-error-code';

export interface GatewayErrorResponse {
  requestId: string;

  error: {
    code: GatewayErrorCode;
    message: string;
    retryable: boolean;
  };
}
