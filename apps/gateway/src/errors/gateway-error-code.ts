export const GatewayErrorCode = {
  AUTHENTICATION_REQUIRED: 'AUTHENTICATION_REQUIRED',
  INSTALL_NOT_PERMITTED: 'INSTALL_NOT_PERMITTED',
  INVALID_REQUEST: 'INVALID_REQUEST',
  RESOURCE_NOT_FOUND: 'RESOURCE_NOT_FOUND',

  // Decision이 ACCEPT가 아니어서 차단됨.
  // 요청 형식은 정상이므로 INVALID_REQUEST와 구분한다.
  PACKAGE_NOT_ALLOWED: 'PACKAGE_NOT_ALLOWED',

  GATEWAY_INTERNAL_ERROR: 'GATEWAY_INTERNAL_ERROR',
} as const;

export type GatewayErrorCode =
  (typeof GatewayErrorCode)[keyof typeof GatewayErrorCode];
