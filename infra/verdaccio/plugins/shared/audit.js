'use strict';

const AUDIT_LOG_MESSAGE = '[verdaccio-whs-audit] audit event';

// 요청 객체나 Error 를 통째로 받지 않고, 기록이 허용된 값만 Event 로 옮긴다.
const OPTIONAL_FIELDS = Object.freeze([
  'requestId',
  'actor',
  'actorRole',
  'sourceIp',
  'packageName',
  'version',
  'statusCode',
  'reason',
  // Storage·Uplink 오류에서 쓴다. operation 은 실패한 동작(readTarball 등),
  // uplink 는 설정의 Uplink 이름(npmjs)이다. 둘 다 값이 아니라 이름이라 민감하지 않다.
  'operation',
  'uplink',
]);

const ACTIONS = Object.freeze({
  login: 'login',
  publish: 'publish',
  unpublish: 'unpublish',
  approvalRegistered: 'approval.registered',
  approvalRejected: 'approval.rejected',
  approvalExpired: 'approval.expired',
  approvalRevoked: 'approval.revoked',
  guardBlocked: 'guard.blocked',
  integrityConflict: 'integrity.conflict',
  serviceAuthRejected: 'service_auth.rejected',
  // 저장소(로컬 Volume 또는 S3)와 Uplink(npmjs) 접근 실패. HTTP 맥락이 없어
  // actor 와 requestId 가 비어 있다.
  storageError: 'storage.error',
  uplinkError: 'uplink.error',
});

const RESULTS = Object.freeze({
  success: 'success',
  failure: 'failure',
});

function isRecordable(value) {
  // 확인하지 못한 값은 생략한다. 빈 문자열이나 unknown 으로 채우면
  // "값이 없음"과 "확인할 수 없음"을 구분할 수 없다.
  if (typeof value === 'string') {
    return value.trim() !== '';
  }

  return typeof value === 'number' && Number.isFinite(value);
}

function buildAuditEvent(fields, nowMs) {
  const event = {
    eventType: 'audit',
    timestamp: new Date(nowMs).toISOString(),
    action: fields.action,
    result: fields.result,
  };

  for (const field of OPTIONAL_FIELDS) {
    if (isRecordable(fields[field])) {
      event[field] = fields[field];
    }
  }

  return event;
}

function resultOf(statusCode) {
  return statusCode >= 200 && statusCode <= 299
    ? RESULTS.success
    : RESULTS.failure;
}

function reasonOf(statusCode) {
  // 응답 본문이나 Error 객체에는 민감정보가 섞일 수 있어 상태 코드로만 만든다.
  if (statusCode >= 200 && statusCode <= 299) {
    return undefined;
  }

  switch (statusCode) {
    case 401:
      return 'unauthorized';
    case 403:
      return 'forbidden';
    case 404:
      return 'not_found';
    case 409:
      return 'conflict';
    default:
      return statusCode >= 500 ? 'server_error' : 'client_error';
  }
}

function levelOf(event) {
  // 성공은 info, 실패와 차단은 warn으로 분리한다. warn만 수집하면 로그 양은
  // 줄지만 정상 로그인·배포·승인 이력을 잃으므로 운영 정책에서 선택해야 한다.
  return event?.result === RESULTS.failure ? 'warn' : 'info';
}

// 감사 로그를 남기지 못하는 것보다 Registry 요청이 중단되는 피해가 더 크다.
// Logger 또는 Event 생성 실패는 요청 처리 흐름으로 전파하지 않는다.
function createAuditLogger({ logger, now = Date.now } = {}) {
  return {
    now,
    record(event) {
      try {
        logger?.[levelOf(event)]?.(event, AUDIT_LOG_MESSAGE);
      } catch {
        // Logger 가 죽은 상태라 여기서 다시 로그를 남길 방법이 없다.
      }
    },
    recordFields(fields, nowMs = now()) {
      try {
        this.record(buildAuditEvent(fields, nowMs));
      } catch {
        // 잘못된 시각 등으로 Event 생성이 실패해도 요청 흐름은 유지한다.
      }
    },
  };
}

module.exports = {
  ACTIONS,
  AUDIT_LOG_MESSAGE,
  OPTIONAL_FIELDS,
  RESULTS,
  buildAuditEvent,
  createAuditLogger,
  levelOf,
  reasonOf,
  resultOf,
};
