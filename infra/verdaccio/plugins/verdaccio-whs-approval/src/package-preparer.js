'use strict';

const {
  ApprovalConflictError,
  conflictMessage,
  findConflictingIntegrity,
} = require('./approval-store');

const DEFAULT_CONCURRENCY = 10;
const CACHE_CHECK_ATTEMPTS = 100;
const CACHE_CHECK_INTERVAL_MS = 50;

class ApprovalMismatchError extends Error {
  constructor(message, reason = 'approval_mismatch', artifact) {
    super(message);
    this.name = 'ApprovalMismatchError';
    this.reason = reason;
    this.packageName = artifact?.packageName;
    this.version = artifact?.version;
  }
}

class PackagePreparationError extends Error {
  constructor(message, cause, artifact) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'PackagePreparationError';
    this.packageName = artifact?.packageName;
    this.version = artifact?.version;
  }
}

// pendingTarballs 는 Plugin 이 소유해 요청 사이에 공유한다. 기본값을 두면 단독 호출도
// 동작하지만, 그 경우 중복 준비 방지는 해당 호출 안에서만 적용된다.
async function preparePackages(
  packages,
  storage,
  request,
  pendingTarballs = new Map(),
  approvals,
) {
  assertStorage(storage);

  const artifacts = uniqueArtifacts(packages);
  const packageNames = [...new Set(artifacts.map((artifact) => artifact.packageName))];
  const metadataEntries = await mapWithConcurrency(
    packageNames,
    DEFAULT_CONCURRENCY,
    async (packageName) => [
      packageName,
      await getPackageMetadata(storage, packageName, request),
    ],
  );
  const metadataByPackage = new Map(metadataEntries);

  const tarballs = artifacts.map((artifact) =>
    resolveApprovedTarball(artifact, metadataByPackage.get(artifact.packageName)),
  );

  // filename 은 Metadata 를 봐야 알 수 있으므로 여기서 처음 검사할 수 있다.
  // Cache 준비를 시작하기 전에 걸러, 충돌한 요청 때문에 Tarball 을 내려받지 않는다.
  // 요청에 Package 가 여럿이면 하나만 충돌해도 전부 준비하지 않는다.
  const conflict =
    approvals === undefined
      ? findConflictingIntegrity(tarballs)
      : approvals.findIntegrityConflict(tarballs);
  if (conflict !== undefined) {
    throw new ApprovalConflictError(conflictMessage(conflict), conflict.artifact);
  }

  await mapWithConcurrency(tarballs, DEFAULT_CONCURRENCY, (tarball) =>
    ensureTarballCached(storage, tarball, pendingTarballs),
  );

  return tarballs;
}

function assertStorage(storage) {
  if (
    storage === null ||
    typeof storage !== 'object' ||
    typeof storage.getPackage !== 'function' ||
    typeof storage.getTarball !== 'function' ||
    typeof storage.hasLocalTarball !== 'function'
  ) {
    throw new PackagePreparationError('Verdaccio storage API is unavailable');
  }
}

function uniqueArtifacts(packages) {
  const unique = new Map();

  for (const artifact of packages) {
    const key = JSON.stringify([
      artifact.packageName,
      artifact.version,
      artifact.integrity,
    ]);
    unique.set(key, artifact);
  }

  return [...unique.values()];
}

function getPackageMetadata(storage, packageName, request) {
  return new Promise((resolve, reject) => {
    storage.getPackage({
      name: packageName,
      uplinksLook: true,
      req: request,
      callback(error, metadata) {
        if (error) {
          reject(
            new PackagePreparationError(
              `failed to cache metadata for ${packageName}`,
              error,
              { packageName },
            ),
          );
          return;
        }

        resolve(metadata);
      },
    });
  });
}

function resolveApprovedTarball(artifact, metadata) {
  const versionMetadata = verifyApprovedArtifact(artifact, metadata);
  const dist = versionMetadata.dist;

  let filename;
  try {
    const pathname = new URL(dist.tarball).pathname;
    filename = decodeURIComponent(pathname.slice(pathname.lastIndexOf('/') + 1));
  } catch (error) {
    throw new PackagePreparationError(
      `invalid tarball URL: ${artifact.packageName}@${artifact.version}`,
      error,
      artifact,
    );
  }

  if (filename === '') {
    throw new PackagePreparationError(
      `tarball filename is missing: ${artifact.packageName}@${artifact.version}`,
      undefined,
      artifact,
    );
  }

  return { ...artifact, filename };
}

function verifyApprovedArtifact(artifact, metadata) {
  const versionMetadata = metadata?.versions?.[artifact.version];

  if (versionMetadata === undefined) {
    throw new ApprovalMismatchError(
      `approved version is missing from metadata: ${artifact.packageName}@${artifact.version}`,
      'version_not_found',
      artifact,
    );
  }

  if (versionMetadata.dist?.integrity !== artifact.integrity) {
    throw new ApprovalMismatchError(
      `integrity mismatch: ${artifact.packageName}@${artifact.version}`,
      'metadata_integrity_mismatch',
      artifact,
    );
  }

  return versionMetadata;
}

// 같은 Tarball 준비가 이미 진행 중이면 그 작업을 기다린다. Cache 확인과 다운로드
// 사이에는 틈이 있어, 동시에 들어온 요청이 각자 "Cache 없음"을 보고 같은 파일을
// 두 번 내려받을 수 있다.
//
// 준비가 실패하면 기다리던 요청도 같은 실패를 받는다. 둘 다 등록되지 않아야 하므로
// 의도한 동작이다.
function ensureTarballCached(storage, artifact, pendingTarballs) {
  const key = pendingKeyOf(artifact);
  const pending = pendingTarballs.get(key);
  if (pending !== undefined) {
    // 같은 파일인데 기대하는 integrity 가 다르면 둘 중 하나는 틀린 승인이다.
    // 어느 쪽이 맞는지 여기서 알 수 없으므로 뒤따라온 요청을 거부한다.
    if (pending.integrity !== artifact.integrity) {
      throw new ApprovalConflictError(
        `conflicting integrity for pending tarball: ${artifact.packageName}/${artifact.filename}`,
        artifact,
      );
    }

    return pending.promise;
  }

  const preparation = prepareTarball(storage, artifact).finally(() => {
    pendingTarballs.delete(key);
  });
  pendingTarballs.set(key, { integrity: artifact.integrity, promise: preparation });

  return preparation;
}

// 준비 단위는 실제로 내려받는 파일이다. Version 이 달라도 같은 파일을 가리키면
// 한 번만 받으면 된다. 기대 integrity 는 Key 가 아니라 값으로 두고 대조한다.
function pendingKeyOf({ packageName, filename }) {
  return JSON.stringify([packageName, filename]);
}

// 같은 Approval 이 다시 등록될 때 이미 받아둔 Tarball 을 또 내려받지 않는다.
// Metadata 와 integrity 는 이 시점에 이미 재확인된 뒤이므로, Cache 가 남아 있다면
// 준비는 끝난 상태다.
async function prepareTarball(storage, artifact) {
  if (await isTarballCached(storage, artifact)) {
    return;
  }

  await cacheTarball(storage, artifact);
}

// 확인에 실패하면 Cache 여부를 알 수 없으므로 건너뛰지 않고 다시 준비한다.
// 준비 경로가 저장 여부를 다시 확인하므로 실제 문제라면 거기서 드러난다.
async function isTarballCached(storage, { packageName, filename }) {
  try {
    return (await storage.hasLocalTarball(packageName, filename)) === true;
  } catch {
    return false;
  }
}

function cacheTarball(storage, artifact) {
  return new Promise((resolve, reject) => {
    let stream;
    try {
      stream = storage.getTarball(artifact.packageName, artifact.filename);
    } catch (error) {
      reject(
        new PackagePreparationError(
          `failed to cache tarball for ${artifact.packageName}@${artifact.version}`,
          error,
          artifact,
        ),
      );
      return;
    }

    stream.once('error', (error) => {
      reject(
        new PackagePreparationError(
          `failed to cache tarball for ${artifact.packageName}@${artifact.version}`,
          error,
          artifact,
        ),
      );
    });
    stream.once('end', async () => {
      try {
        await waitForLocalTarball(storage, artifact);
        resolve();
      } catch (error) {
        reject(error);
      }
    });
    stream.resume();
  });
}

async function waitForLocalTarball(storage, artifact) {
  const { packageName, filename } = artifact;
  for (let attempt = 0; attempt < CACHE_CHECK_ATTEMPTS; attempt += 1) {
    try {
      if (await storage.hasLocalTarball(packageName, filename)) {
        return;
      }
    } catch (error) {
      throw new PackagePreparationError(
        `failed to verify cached tarball: ${packageName}/${filename}`,
        error,
        artifact,
      );
    }

    if (attempt + 1 < CACHE_CHECK_ATTEMPTS) {
      await delay(CACHE_CHECK_INTERVAL_MS);
    }
  }

  throw new PackagePreparationError(
    `tarball was not stored in cache: ${packageName}/${filename}`,
    undefined,
    artifact,
  );
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  async function runWorker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index]);
    }
  }

  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  return results;
}

module.exports = {
  ApprovalMismatchError,
  PackagePreparationError,
  getPackageMetadata,
  preparePackages,
  verifyApprovedArtifact,
};
