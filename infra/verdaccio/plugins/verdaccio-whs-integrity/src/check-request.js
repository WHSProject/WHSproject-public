'use strict';

const { isSafePackageName } = require('./verify-tarball');

class CheckRequestError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CheckRequestError';
  }
}

// 수동 검사 요청 본문을 검사 대상 목록으로 바꾼다.
//
// 오류 메시지에는 요청 값을 넣지 않고 위치만 적는다. 값은 요청자가 보낸 문자열이라
// 그대로 응답이나 로그에 되돌리지 않는다.
function validateCheckRequest(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new CheckRequestError('request body must be a JSON object');
  }

  const { packages } = body;
  if (!Array.isArray(packages) || packages.length === 0) {
    throw new CheckRequestError('packages must be a non-empty array');
  }

  const targets = [];
  const seen = new Set();

  packages.forEach((entry, index) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new CheckRequestError(`packages[${index}] must be an object`);
    }

    const { packageName, version } = entry;
    if (typeof packageName !== 'string' || packageName.trim() === '') {
      throw new CheckRequestError(
        `packages[${index}].packageName must be a non-empty string`,
      );
    }

    // verifyTarball 도 같은 검사를 하지만, 잘못된 이름은 검사 결과가 아니라 요청
    // 오류로 돌려준다. Storage 에 닿기 전에 끊는다.
    if (!isSafePackageName(packageName)) {
      throw new CheckRequestError(
        `packages[${index}].packageName is not a valid package name`,
      );
    }

    if (typeof version !== 'string' || version.trim() === '') {
      throw new CheckRequestError(
        `packages[${index}].version must be a non-empty string`,
      );
    }

    // 같은 요청 안에서 같은 Tarball 을 두 번 해싱하지 않는다.
    const key = JSON.stringify([packageName, version]);
    if (seen.has(key)) {
      return;
    }

    seen.add(key);
    targets.push({ packageName, version });
  });

  return targets;
}

module.exports = {
  CheckRequestError,
  validateCheckRequest,
};
