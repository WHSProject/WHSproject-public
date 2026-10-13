'use strict';

// htpasswd 에는 Group 이 없어 역할이 곧 계정 이름이다. config.yaml 의 목록으로
// 허용 계정을 정하고, 설정이 없으면 가장 좁은 기본값으로 둔다.
const DEFAULT_ALLOWED_USERS = Object.freeze(['admin']);

function resolveAllowedUsers(value, logger) {
  if (value === undefined) {
    return DEFAULT_ALLOWED_USERS;
  }

  const users = Array.isArray(value)
    ? value
        .filter((user) => typeof user === 'string' && user.trim() !== '')
        .map((user) => user.trim())
    : [];

  if (users.length === 0) {
    // 잘못된 설정을 "아무도 허용 안 함" 이나 "모두 허용" 으로 해석하지 않는다.
    // 운영자가 알아챌 수 있게 남기고 기본값으로 돌아간다.
    safeWarn(
      logger,
      '[verdaccio-whs-integrity] allowed_users is invalid; falling back to admin only',
    );
    return DEFAULT_ALLOWED_USERS;
  }

  return Object.freeze([...new Set(users)]);
}

// Verdaccio 는 Plugin Route 보다 먼저 JWT 를 확인해 request.remote_user 에 넣는다.
// 로그인하지 않은 요청은 name 없이 $anonymous Group 으로 들어온다.
function authorizeAdmin(request, allowedUsers = DEFAULT_ALLOWED_USERS) {
  const name = request?.remote_user?.name;
  if (typeof name !== 'string' || name.trim() === '') {
    return { status: 401, error: 'authentication required' };
  }

  if (!allowedUsers.includes(name)) {
    return { status: 403, name, error: 'admin permission required' };
  }

  return { status: 200, name };
}

function safeWarn(logger, message) {
  try {
    logger?.warn?.(message);
  } catch {
    // 설정 경고를 남기지 못해도 기본값으로 동작은 계속한다.
  }
}

module.exports = {
  DEFAULT_ALLOWED_USERS,
  authorizeAdmin,
  resolveAllowedUsers,
};
