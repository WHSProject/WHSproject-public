'use strict';

const { createHash, timingSafeEqual } = require('node:crypto');

const { ACTIONS, RESULTS } = require('./audit');

const SERVICE_TOKEN_ENV = 'WHS_APPROVAL_SERVICE_TOKEN';

// Verdaccio 의 요청 로거는 헤더를 그대로 출력하지만 authorization 과 cookie 는
// <Classified> 로 가린다. 전용 헤더를 쓰면 Token 이 평문으로 로그에 남는다(실측).
const SERVICE_TOKEN_HEADER = 'authorization';
const BEARER_SCHEME = 'bearer ';
const UNAUTHORIZED_RESPONSE = Object.freeze({
  error: 'unauthorized service request',
});

// 배포 환경에서 Secret 을 파일로 주입하면 끝에 개행이 붙는 경우가 있다. 그대로 두면
// Gateway 가 보낸 값과 조용히 어긋나므로 양끝 공백을 정리한다. 공백뿐이면 미설정으로
// 본다.
function configuredServiceToken(environment = process.env) {
  const token = environment?.[SERVICE_TOKEN_ENV];
  if (typeof token !== 'string') {
    return undefined;
  }

  const trimmed = token.trim();
  return trimmed === '' ? undefined : trimmed;
}

// Authorization: Bearer <token> 에서 Token 만 꺼낸다. Header 가 여러 번 오면
// Node 가 배열로 주므로 문자열이 아닌 값은 그대로 거부한다.
function readServiceToken(request) {
  const headerValue = request?.headers?.[SERVICE_TOKEN_HEADER];
  if (typeof headerValue !== 'string') {
    return undefined;
  }

  // Scheme 은 대소문자를 가리지 않는다(RFC 7235).
  if (
    headerValue.slice(0, BEARER_SCHEME.length).toLowerCase() !== BEARER_SCHEME
  ) {
    return undefined;
  }

  const token = headerValue.slice(BEARER_SCHEME.length).trim();
  return token === '' ? undefined : token;
}

function tokenDigest(token) {
  return createHash('sha256').update(token, 'utf8').digest();
}

function isAuthorizedServiceRequest(request, expectedToken) {
  const providedToken = readServiceToken(request);
  if (expectedToken === undefined || providedToken === undefined) {
    return false;
  }

  return timingSafeEqual(tokenDigest(expectedToken), tokenDigest(providedToken));
}

function protectApprovalHandler(
  handler,
  { expectedToken, logger, auditLogger } = {},
) {
  return async (request, response) => {
    if (!isAuthorizedServiceRequest(request, expectedToken)) {
      safeWarn(logger, '[verdaccio-whs-approval] rejected unauthorized service request');
      recordUnauthorized(auditLogger, request);
      response.status(401).json(UNAUTHORIZED_RESPONSE);
      return;
    }

    return handler(request, response);
  };
}

// Token 누락과 불일치를 응답에서 구분하지 않듯 Event 에서도 나누지 않는다.
// Token 값 자체는 어느 쪽으로도 남기지 않는다.
function recordUnauthorized(auditLogger, request) {
  try {
    auditLogger?.recordFields?.({
      action: ACTIONS.serviceAuthRejected,
      result: RESULTS.failure,
      requestId: readRequestId(request),
      statusCode: 401,
      reason: 'invalid_service_token',
    });
  } catch {
    // Audit 실패가 401 을 500 으로 바꾸지 않게 한다.
  }
}

// 본문을 읽기 전이라 Body 의 requestId 는 아직 알 수 없다. Gateway 가 Header 를
// 붙였다면 그 값으로 두 Component 의 로그를 이을 수 있다.
function readRequestId(request) {
  const header = request?.headers?.['x-request-id'];

  return typeof header === 'string' ? header : undefined;
}

function safeWarn(logger, message) {
  try {
    logger?.warn?.(message);
  } catch {
    // 인증 로그 실패가 HTTP 응답 흐름을 바꾸지 않게 한다.
  }
}

module.exports = {
  BEARER_SCHEME,
  SERVICE_TOKEN_ENV,
  SERVICE_TOKEN_HEADER,
  UNAUTHORIZED_RESPONSE,
  configuredServiceToken,
  isAuthorizedServiceRequest,
  protectApprovalHandler,
  readServiceToken,
};
