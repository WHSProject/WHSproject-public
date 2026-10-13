'use strict';

class ApprovalRequestError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ApprovalRequestError';
  }
}

function requireNonEmptyString(value, fieldName) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ApprovalRequestError(`${fieldName} must be a non-empty string`);
  }

  return value.trim();
}

function validateApprovalRequest(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new ApprovalRequestError('request body must be an object');
  }

  const requestId = requireNonEmptyString(body.requestId, 'requestId');

  if (!Array.isArray(body.packages) || body.packages.length === 0) {
    throw new ApprovalRequestError('packages must be a non-empty array');
  }

  const packages = body.packages.map((artifact, index) => {
    if (artifact === null || typeof artifact !== 'object' || Array.isArray(artifact)) {
      throw new ApprovalRequestError(`packages[${index}] must be an object`);
    }

    return {
      packageName: requireNonEmptyString(
        artifact.packageName,
        `packages[${index}].packageName`,
      ),
      version: requireNonEmptyString(artifact.version, `packages[${index}].version`),
      integrity: requireNonEmptyString(artifact.integrity, `packages[${index}].integrity`),
    };
  });

  return { requestId, packages };
}

module.exports = {
  ApprovalRequestError,
  validateApprovalRequest,
};
