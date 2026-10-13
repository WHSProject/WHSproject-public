'use strict';

const {
  ACTIONS,
  RESULTS,
  buildAuditEvent,
  reasonOf,
  resultOf,
} = require('./src/audit-event');
const { AUDIT_LOG_MESSAGE, createAuditLogger } = require('./src/audit-logger');
const { classifyRequest } = require('./src/request-classifier');
const { observeStorage } = require('./src/storage-observer');

class WhsAuditMiddleware {
  constructor(config = {}, options = {}) {
    this.enabled = config.enabled !== false;
    this.logger = options.logger ?? console;
    this.auditLogger = createAuditLogger({
      logger: this.logger,
      now: options.now,
    });
  }

  register_middlewares(app, auth, storage) {
    if (!this.enabled) {
      this.logger.warn?.(
        '[verdaccio-whs-audit] audit logging is disabled by configuration',
      );
      return;
    }

    app.use(createAuditMiddleware(this.auditLogger));

    // Storage 와 Uplink 오류는 요청 Middleware 에서 볼 수 없다. Verdaccio 가
    // 내부에서 부르기 때문이다. 관측을 붙이지 못해도 Registry 는 그대로 돈다.
    try {
      observeStorage({
        storage,
        auditLogger: this.auditLogger,
        logger: this.logger,
      });
    } catch (error) {
      this.logger.warn?.(
        { err: error.message },
        '[verdaccio-whs-audit] failed to observe storage errors: @{err}',
      );
    }
  }
}

// 요청이 아니라 응답이 끝난 시점에 기록한다. 상태 코드가 정해져야 성공과 실패를
// 나눌 수 있다. 본문은 읽지도 바꾸지도 않는다.
function createAuditMiddleware(auditLogger) {
  return function auditMiddleware(request, response, next) {
    let target;
    try {
      target = classifyRequest(request);
    } catch {
      target = undefined;
    }

    // 감사 대상이 아닌 요청에는 Listener 를 붙이지 않는다.
    if (target === undefined) {
      next();
      return;
    }

    let recorded = false;
    let completed = false;

    const recordOnce = () => {
      if (recorded) {
        return;
      }
      recorded = true;

      try {
        auditLogger.record(
          buildAuditEvent(
            collectFields(request, response, target, completed),
            auditLogger.now(),
          ),
        );
      } catch {
        // Event 를 만들지 못해도 응답은 이미 끝났다. 요청 처리에 영향을 주지 않는다.
      }
    };

    // 연결이 끊기면 finish 없이 close 만 온다. 둘 다 걸고 한 번만 기록하되,
    // 어느 쪽으로 끝났는지는 구분한다. statusCode 기본값이 200 이라 응답을 보내지
    // 못한 요청까지 성공으로 남을 수 있다.
    response.once?.('finish', () => {
      completed = true;
      recordOnce();
    });
    response.once?.('close', recordOnce);

    next();
  };
}

function collectFields(request, response, target, completed) {
  const statusCode = response?.statusCode;

  return {
    action: target.action,
    // 응답을 끝내지 못한 요청은 상태 코드를 신뢰할 수 없다. 클라이언트는 그 코드를
    // 받지 못했으므로 성공으로 보지 않고, 코드 자체도 남기지 않는다.
    result: completed ? resultOf(statusCode) : RESULTS.failure,
    reason: completed ? reasonOf(statusCode) : 'client_disconnected',
    statusCode: completed ? statusCode : undefined,
    requestId: readRequestId(request),
    // 로그인은 인증 전이라 경로에서, 나머지는 인증 결과에서 사용자를 읽는다.
    actor: target.actor ?? readAuthenticatedActor(request),
    sourceIp: readSourceIp(request),
    packageName: target.packageName,
  };
}

// Gateway 요청과 Verdaccio 로그를 잇는 값이다. 없다고 새로 만들면 다른 Component 와
// 이어지지 않는 ID 가 생기므로 생략한다.
function readRequestId(request) {
  const header = request?.headers?.['x-request-id'];

  return typeof header === 'string' ? header : undefined;
}

// Verdaccio 인증 Middleware 가 앞에서 채워 둔 값만 쓴다. Authorization Header 나
// Token 을 직접 해석하지 않는다.
function readAuthenticatedActor(request) {
  const name = request?.remote_user?.name;

  return typeof name === 'string' ? name : undefined;
}

// trustProxy 가 적용된 값을 그대로 쓴다. X-Forwarded-For 원문을 복사하지 않는다.
function readSourceIp(request) {
  if (typeof request?.ip === 'string') {
    return request.ip;
  }

  const remoteAddress = request?.socket?.remoteAddress;

  return typeof remoteAddress === 'string' ? remoteAddress : undefined;
}

function createWhsAuditMiddleware(config, options) {
  return new WhsAuditMiddleware(config, options);
}

module.exports = createWhsAuditMiddleware;
module.exports.WhsAuditMiddleware = WhsAuditMiddleware;
module.exports.ACTIONS = ACTIONS;
module.exports.RESULTS = RESULTS;
module.exports.AUDIT_LOG_MESSAGE = AUDIT_LOG_MESSAGE;
module.exports.buildAuditEvent = buildAuditEvent;
module.exports.classifyRequest = classifyRequest;
module.exports.createAuditLogger = createAuditLogger;
module.exports.observeStorage = observeStorage;
