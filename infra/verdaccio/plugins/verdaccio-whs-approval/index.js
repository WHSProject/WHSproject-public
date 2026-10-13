'use strict';

const {
  ACTIONS,
  RESULTS,
  createAuditLogger,
} = require('../shared/audit');

const {
  ApprovalConflictError,
  ApprovalStore,
  resolveTtlSeconds,
} = require('./src/approval-store');
const { ApprovalRequestError, validateApprovalRequest } = require('./src/approval-request');
const {
  ApprovalMismatchError,
  PackagePreparationError,
  preparePackages,
} = require('./src/package-preparer');
const { createRegistryGuard } = require('./src/registry-guard');
const {
  SERVICE_TOKEN_ENV,
  configuredServiceToken,
  protectApprovalHandler,
} = require('../shared/service-auth');

class WhsApprovalMiddleware {
  constructor(config = {}, options = {}) {
    this.endpoint = config.endpoint;
    this.guardEnabled = config.guard_enabled !== false;
    // Gateway 가 Token 을 보내도록 연동되기 전까지 끌 수 있게 둔다. guard_enabled 와
    // 같은 임시 설정이다. 생략하면 켜진다. 실수로 빠뜨려도 API 가 열리지 않게 한다.
    this.serviceAuthEnabled = config.service_auth_enabled !== false;
    this.logger = options.logger ?? console;
    this.serviceToken = configuredServiceToken(options.environment);
    this.auditLogger = createAuditLogger({
      logger: this.logger,
      now: options.now,
    });
    this.approvals = new ApprovalStore({
      ttlSeconds: resolveTtlSeconds(config.approval_ttl_seconds, this.logger),
      now: options.now,
      onExpired: (artifact, removedAtMs) => {
        this.auditLogger.recordFields(
          {
            action: ACTIONS.approvalExpired,
            result: RESULTS.failure,
            packageName: artifact.packageName,
            version: artifact.version,
            reason: 'ttl_expired',
          },
          removedAtMs,
        );
      },
    });
    // 진행 중인 Tarball 준비. 동시에 들어온 같은 Approval 요청이 같은 파일을
    // 중복으로 내려받지 않도록 요청 사이에 공유한다.
    this.pendingTarballs = new Map();
  }

  register_middlewares(app, _auth, storage) {
    if (!this.endpoint) {
      safeLog(this.logger, 'warn', undefined,
        '[verdaccio-whs-approval] endpoint is not configured; approval API is disabled',
      );
      return;
    }

    const registerApproval = async (request, response) => {
      // 오류 응답에도 requestId 를 남기기 위해 검사 전에 확보한다. Gateway 요청과
      // Verdaccio 로그를 잇는 유일한 값이라, 실패했을 때야말로 필요하다.
      // 본문 자체가 깨져 requestId 를 못 읽는 경우는 null 로 남는다.
      let requestId = null;
      let attemptedPackage;

      try {
        const body = await readJsonBody(request);
        requestId = readRequestId(body);
        const payload = validateApprovalRequest(body);
        requestId = payload.requestId;
        attemptedPackage = singlePackageOf(payload.packages);
        const preparedPackages = await preparePackages(
          payload.packages,
          storage,
          request,
          this.pendingTarballs,
          this.approvals,
        );
        this.approvals.register(preparedPackages);

        this.auditLogger.recordFields({
          action: ACTIONS.approvalRegistered,
          result: RESULTS.success,
          requestId: payload.requestId,
        });

        safeLog(this.logger, 'info',
          {
            requestId: payload.requestId,
            packageCount: payload.packages.length,
          },
          '[verdaccio-whs-approval] approval list registered',
        );

        response.status(200).json({
          requestId: payload.requestId,
          status: 'REGISTERED',
          packageCount: payload.packages.length,
        });
      } catch (error) {
        if (error instanceof ApprovalRequestError) {
          safeLog(this.logger, 'warn',
            { requestId, reason: error.message },
            '[verdaccio-whs-approval] rejected invalid approval request',
          );
          this.recordRejectedApproval({
            action: ACTIONS.approvalRejected,
            requestId,
            attemptedPackage,
            reason: 'invalid_request',
          });
          response.status(400).json({ error: error.message });
          return;
        }

        if (error instanceof ApprovalConflictError) {
          safeLog(this.logger, 'warn',
            { requestId, reason: error.message },
            '[verdaccio-whs-approval] rejected conflicting approval request',
          );
          this.recordRejectedApproval({
            action: ACTIONS.integrityConflict,
            requestId,
            attemptedPackage,
            error,
            reason: 'integrity_conflict',
          });
          response.status(403).json({ error: error.message });
          return;
        }

        if (error instanceof ApprovalMismatchError) {
          safeLog(this.logger, 'warn',
            { requestId, reason: error.message },
            '[verdaccio-whs-approval] rejected mismatched approval request',
          );
          this.recordRejectedApproval({
            action: ACTIONS.approvalRejected,
            requestId,
            attemptedPackage,
            error,
            reason: error.reason,
          });
          response.status(403).json({ error: error.message });
          return;
        }

        if (error instanceof PackagePreparationError) {
          safeLog(this.logger, 'error',
            { requestId, err: error },
            '[verdaccio-whs-approval] failed to prepare approved packages',
          );
          this.recordRejectedApproval({
            action: ACTIONS.approvalRejected,
            requestId,
            attemptedPackage,
            error,
            reason: 'package_preparation_failed',
          });
          response.status(500).json({ error: error.message });
          return;
        }

        this.recordRejectedApproval({
          action: ACTIONS.approvalRejected,
          requestId,
          attemptedPackage,
          reason: 'internal_error',
        });
        safeLog(this.logger, 'error',
          { requestId, err: error },
          '[verdaccio-whs-approval] failed to register approval list',
        );
        response.status(500).json({ error: 'internal plugin error' });
      }
    };

    // 꺼진 상태는 Token 없이도 누구나 승인 목록을 바꿀 수 있다. 연동 뒤 켜는 것을
    // 잊지 않도록 기동할 때마다 알린다.
    if (!this.serviceAuthEnabled) {
      safeLog(this.logger, 'warn', undefined,
        '[verdaccio-whs-approval] service auth is disabled; approval API accepts requests without a token',
      );
    // 미설정이면 Approval API 가 전부 401 이 된다. Registry 와 Healthcheck 는
    // 정상이라 요청이 실패하기 전까지 원인이 드러나지 않으므로 기동 시 알린다.
    } else if (this.serviceToken === undefined) {
      safeLog(this.logger, 'warn', undefined,
        `[verdaccio-whs-approval] ${SERVICE_TOKEN_ENV} is not set; approval API rejects every request`,
      );
    }

    app.post(this.endpoint, this.protect(registerApproval));

    // Verdaccio 가 넘겨주는 Express app 에는 항상 있지만, 없으면 조회/취소가 조용히
    // 사라져 404 만 보인다. 원인을 찾을 수 있도록 남긴다.
    if (typeof app.get !== 'function' || typeof app.delete !== 'function') {
      safeLog(this.logger, 'warn', undefined,
        '[verdaccio-whs-approval] approval list/revoke API is not available on this app',
      );
    }

    if (typeof app.get === 'function') {
      app.get(this.endpoint, this.protect((_request, response) => {
        const approvals = this.approvals.listActive().map(toApprovalSummary);
        response.status(200).json({
          status: 'OK',
          count: approvals.length,
          approvals,
        });
      }));
    }

    if (typeof app.delete === 'function') {
      app.delete(this.endpoint, this.protect((request, response) => {
        const packageName = readQueryString(request, 'packageName');
        const version = readQueryString(request, 'version');
        if (packageName === undefined || version === undefined) {
          // 읽힌 쪽만 남긴다. 한쪽만 빠진 요청을 구분할 수 있어야
          // Gateway 연동 오류인지 탐색 시도인지 가려낼 수 있다.
          this.recordRevoke(request, {
            packageName,
            version,
            result: RESULTS.failure,
            statusCode: 400,
            reason: 'invalid_request',
          });
          response.status(400).json({
            error: 'packageName and version query parameters are required',
          });
          return;
        }

        const revokedCount = this.approvals.revokeByPackageVersion(
          packageName,
          version,
        );
        if (revokedCount === 0) {
          this.recordRevoke(request, {
            packageName,
            version,
            result: RESULTS.failure,
            statusCode: 404,
            reason: 'approval_not_found',
          });
          response.status(404).json({ error: 'approval not found' });
          return;
        }

        this.recordRevoke(request, {
          packageName,
          version,
          result: RESULTS.success,
          statusCode: 200,
        });

        // 같은 Package/Version 의 Approval 은 보통 하나다. 둘 이상이 지워졌다면
        // Integrity 충돌 차단을 통과한 비정상 상태였다는 뜻이라 남긴다.
        if (revokedCount > 1) {
          safeLog(this.logger, 'warn',
            { packageName, version, revokedCount },
            '[verdaccio-whs-approval] revoked multiple approvals for one version',
          );
        }

        response.status(200).json({
          status: 'REVOKED',
          packageName,
          version,
        });
      }));
    }

    if (this.guardEnabled && typeof app.use === 'function') {
      app.use(
        createRegistryGuard({
          approvals: this.approvals,
          storage,
          logger: this.logger,
          auditLogger: this.auditLogger,
        }),
      );
    } else if (!this.guardEnabled) {
      safeLog(this.logger, 'warn', undefined,
        '[verdaccio-whs-approval] registry guard is disabled',
      );
    }
  }

  // 세 API 가 같은 인증을 쓴다. 새 Endpoint 를 추가할 때 이 래퍼를 빠뜨리면
  // 인증 없이 열리므로 등록 지점을 한 곳으로 모은다.
  protect(handler) {
    if (!this.serviceAuthEnabled) {
      return handler;
    }

    return protectApprovalHandler(handler, {
      expectedToken: this.serviceToken,
      logger: this.logger,
      auditLogger: this.auditLogger,
    });
  }

  // 취소는 Guard 를 닫는 동작이지만, 진행 중이던 설치가 403 으로 바뀐다.
  // 원인을 추적할 수 있도록 성공과 실패를 모두 남긴다.
  recordRevoke(request, { packageName, version, result, statusCode, reason }) {
    this.auditLogger.recordFields({
      action: ACTIONS.approvalRevoked,
      result,
      requestId: readHeaderRequestId(request),
      packageName,
      version,
      statusCode,
      reason,
    });
  }

  recordRejectedApproval({ action, requestId, attemptedPackage, reason, error }) {
    const errorPackage = error?.packageName
      ? { packageName: error.packageName, version: error.version }
      : undefined;
    const targetPackage = errorPackage ?? attemptedPackage;
    this.auditLogger.recordFields({
      action,
      result: RESULTS.failure,
      requestId,
      packageName: targetPackage?.packageName,
      version: targetPackage?.version,
      reason,
    });
  }
}

// DELETE 는 Body 가 없어 Gateway 가 보낸 Header 로만 요청을 식별할 수 있다.
function readHeaderRequestId(request) {
  const header = request?.headers?.['x-request-id'];

  return typeof header === 'string' ? header : undefined;
}

function singlePackageOf(packages) {
  return Array.isArray(packages) && packages.length === 1
    ? packages[0]
    : undefined;
}

function toApprovalSummary(artifact) {
  return {
    packageName: artifact.packageName,
    version: artifact.version,
    registeredAt: artifact.registeredAt,
    expiresAt: artifact.expiresAt,
  };
}

function readQueryString(request, field) {
  const value = request?.query?.[field];
  if (typeof value !== 'string' || value.trim() === '') {
    return undefined;
  }

  return value.trim();
}

function safeLog(logger, level, payload, message) {
  try {
    if (payload === undefined) {
      logger?.[level]?.(message);
      return;
    }
    logger?.[level]?.(payload, message);
  } catch {
    // 운영 로그 실패도 Registry 요청 흐름으로 전파하지 않는다.
  }
}

// 검사 전 본문에서 requestId 만 꺼낸다. 형식 검사는 validateApprovalRequest 가
// 하므로 여기서는 로그에 쓸 수 있는 문자열인지만 본다.
function readRequestId(body) {
  if (body && typeof body === 'object' && typeof body.requestId === 'string') {
    return body.requestId;
  }

  return null;
}

async function readJsonBody(request) {
  if (request.body !== undefined) {
    return request.body;
  }

  let rawBody = '';
  for await (const chunk of request) {
    rawBody += chunk;
  }

  if (rawBody.trim() === '') {
    return undefined;
  }

  try {
    return JSON.parse(rawBody);
  } catch {
    throw new ApprovalRequestError('request body must contain valid JSON');
  }
}

function createWhsApprovalMiddleware(config, options) {
  return new WhsApprovalMiddleware(config, options);
}

module.exports = createWhsApprovalMiddleware;
module.exports.WhsApprovalMiddleware = WhsApprovalMiddleware;
module.exports.ApprovalStore = ApprovalStore;
module.exports.ApprovalConflictError = ApprovalConflictError;
module.exports.resolveTtlSeconds = resolveTtlSeconds;
module.exports.ApprovalRequestError = ApprovalRequestError;
module.exports.validateApprovalRequest = validateApprovalRequest;
module.exports.ApprovalMismatchError = ApprovalMismatchError;
module.exports.PackagePreparationError = PackagePreparationError;
module.exports.preparePackages = preparePackages;
module.exports.createRegistryGuard = createRegistryGuard;
module.exports.configuredServiceToken = configuredServiceToken;
module.exports.protectApprovalHandler = protectApprovalHandler;
