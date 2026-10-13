'use strict';

const {
  ApprovalMismatchError,
  getPackageMetadata,
  verifyApprovedArtifact,
} = require('./package-preparer');
const { ACTIONS, RESULTS } = require('../../shared/audit');

function createRegistryGuard({
  approvals,
  storage,
  logger = console,
  auditLogger,
}) {
  return async function registryGuard(request, response, next) {
    const target = parseRegistryRequest(request);
    if (target === undefined) {
      next();
      return;
    }

    if (target.type === 'metadata') {
      next();
      return;
    }

    if (target.type === 'version') {
      const approvedArtifacts = approvals
        .findByPackage(target.packageName)
        .filter((artifact) => artifact.version === target.version);
      if (approvedArtifacts.length === 0) {
        recordGuardBlocked(auditLogger, request, {
          packageName: target.packageName,
          version: target.version,
          reason: 'version_not_approved',
        });
        sendForbidden(
          response,
          `package version is not approved: ${target.packageName}@${target.version}`,
        );
        return;
      }

      installVersionMetadataFilter(
        response,
        approvals,
        target.packageName,
        target.version,
        request,
        auditLogger,
      );
      next();
      return;
    }

    const approvedArtifacts = approvals.findByTarball(
      target.packageName,
      target.filename,
    );
    if (approvedArtifacts.length === 0) {
      recordGuardBlocked(auditLogger, request, {
        packageName: target.packageName,
        reason: 'tarball_not_approved',
      });
      sendForbidden(
        response,
        `tarball is not approved: ${target.packageName}/${target.filename}`,
      );
      return;
    }

    try {
      const metadata = await getPackageMetadata(storage, target.packageName, request);

      // Metadata 를 기다리는 사이에 승인이 만료될 수 있다. 앞에서 읽어 둔 목록을
      // 그대로 쓰면 만료된 승인으로 한 번 통과한다.
      const activeArtifacts = approvals.findByTarball(
        target.packageName,
        target.filename,
      );
      if (activeArtifacts.length === 0) {
        recordGuardBlocked(auditLogger, request, {
          packageName: target.packageName,
          reason: 'tarball_not_approved',
        });
        sendForbidden(
          response,
          `tarball is not approved: ${target.packageName}/${target.filename}`,
        );
        return;
      }

      const mismatchReasons = [];
      const matchesCurrentMetadata = activeArtifacts.some((artifact) => {
        try {
          verifyApprovedArtifact(artifact, metadata);
          return true;
        } catch (error) {
          if (error instanceof ApprovalMismatchError) {
            mismatchReasons.push(error.reason);
            return false;
          }
          throw error;
        }
      });

      if (!matchesCurrentMetadata) {
        recordGuardBlocked(auditLogger, request, {
          packageName: target.packageName,
          version:
            activeArtifacts.length === 1
              ? activeArtifacts[0].version
              : undefined,
          reason: mismatchReasons.every((reason) => reason === 'version_not_found')
            ? 'version_not_found'
            : 'metadata_integrity_mismatch',
        });
        sendForbidden(
          response,
          `integrity mismatch: ${target.packageName}/${target.filename}`,
        );
        return;
      }
      next();
    } catch (error) {
      try {
        logger.error?.(
          { err: error, packageName: target.packageName, filename: target.filename },
          '[verdaccio-whs-approval] failed to verify tarball request',
        );
      } catch {
        // 로그 실패가 기존 500 응답을 바꾸지 않게 한다.
      }
      response.status(500).json({ error: 'failed to verify approved tarball' });
    }
  };
}

function parseRegistryRequest(request) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return undefined;
  }

  const pathname = getPathname(request);
  const rawSegments = pathname.split('/').filter(Boolean);
  if (rawSegments.length === 0 || rawSegments[0] === '-') {
    return undefined;
  }

  let segments;
  try {
    segments = rawSegments.map((segment) => decodeURIComponent(segment));
  } catch {
    return undefined;
  }

  const packageTarget = readPackageName(segments);
  if (packageTarget === undefined) {
    return undefined;
  }

  const remaining = segments.slice(packageTarget.consumedSegments);
  if (remaining.length === 0) {
    return { type: 'metadata', packageName: packageTarget.packageName };
  }

  if (remaining.length === 1 && remaining[0] !== '-') {
    return {
      type: 'version',
      packageName: packageTarget.packageName,
      version: remaining[0],
    };
  }

  if (
    remaining.length === 2 &&
    remaining[0] === '-' &&
    remaining[1].endsWith('.tgz')
  ) {
    return {
      type: 'tarball',
      packageName: packageTarget.packageName,
      filename: remaining[1],
    };
  }

  return undefined;
}

function getPathname(request) {
  if (typeof request.path === 'string') {
    return request.path;
  }

  const url = request.originalUrl ?? request.url ?? '';
  return url.split('?')[0];
}

function readPackageName(segments) {
  const first = segments[0];
  if (!first.startsWith('@')) {
    return { packageName: first, consumedSegments: 1 };
  }

  if (first.includes('/')) {
    const [scope, name, ...rest] = first.split('/');
    if (scope === '' || name === '' || rest.length > 0) {
      return undefined;
    }
    return { packageName: `${scope}/${name}`, consumedSegments: 1 };
  }

  if (segments.length < 2 || segments[1] === '' || segments[1] === '-') {
    return undefined;
  }

  return {
    packageName: `${first}/${segments[1]}`,
    consumedSegments: 2,
  };
}

function installVersionMetadataFilter(
  response,
  approvals,
  packageName,
  requestedVersion,
  request,
  auditLogger,
) {
  const originalSend = response.send;

  response.send = function sendApprovedVersionMetadata(body) {
    response.send = originalSend;

    const versionMetadata = parseMetadataBody(body);
    const integrity = versionMetadata?.dist?.integrity;
    const responseVersion = versionMetadata?.version;
    const metadataMatches =
      responseVersion === requestedVersion && typeof integrity === 'string';
    const activeArtifacts = metadataMatches
      ? approvals
          .findByPackage(packageName)
          .filter((artifact) => artifact.version === requestedVersion)
      : [];
    const approved = activeArtifacts.some(
      (artifact) => artifact.integrity === integrity,
    );

    if (!approved) {
      recordGuardBlocked(auditLogger, request, {
        packageName,
        version: requestedVersion,
        reason: responseVersion !== requestedVersion
          ? 'metadata_version_mismatch'
          : typeof integrity !== 'string'
            ? 'metadata_integrity_missing'
            : activeArtifacts.length === 0
              ? 'version_not_approved'
              : 'metadata_integrity_mismatch',
      });
      sendForbidden(
        response,
        `package version is not approved: ${packageName}@${requestedVersion}`,
      );
      return response;
    }

    return originalSend.call(response, body);
  };
}

function recordGuardBlocked(auditLogger, request, fields) {
  auditLogger?.recordFields?.({
    action: ACTIONS.guardBlocked,
    result: RESULTS.failure,
    requestId: readRequestId(request),
    ...fields,
  });
}

function readRequestId(request) {
  const header = request?.headers?.['x-request-id'];

  return typeof header === 'string' ? header : undefined;
}

function parseMetadataBody(body) {
  if (body !== null && typeof body === 'object' && !Buffer.isBuffer(body)) {
    return body;
  }

  if (typeof body !== 'string' && !Buffer.isBuffer(body)) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(body.toString());
    return parsed !== null && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function clearBodyHeaders(response) {
  response.removeHeader?.('ETag');
  response.removeHeader?.('Content-Length');
}

function sendForbidden(response, message) {
  clearBodyHeaders(response);
  response.locals ??= {};
  response.locals._verdaccio_error = message;
  response.status(403).json({ error: message });
}

module.exports = {
  createRegistryGuard,
  parseRegistryRequest,
};
