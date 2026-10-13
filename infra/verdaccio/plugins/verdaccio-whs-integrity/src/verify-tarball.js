'use strict';

const {
  SUPPORTED_ALGORITHMS,
  formatSri,
  hashStream,
  isValidDigest,
  isValidShasum,
  normalizeDigest,
  parseSri,
  selectStrongest,
} = require('./sri');

const STATUS = Object.freeze({
  pass: 'PASS',
  fail: 'FAIL',
  unverifiable: 'UNVERIFIABLE',
});

// 검증을 끝내지 못한 이유와 실제 불일치를 구분한다. FAIL 은 해시를 계산해 본 뒤
// 값이 다른 경우에만 쓴다. verify-cache.sh 의 diagnostic 과 같은 이름을 유지한다.
const REASON = Object.freeze({
  metadataUnreadable: 'METADATA_UNREADABLE',
  versionNotFound: 'VERSION_NOT_FOUND',
  noReferenceHash: 'NO_REFERENCE_HASH',
  invalidIntegrity: 'INVALID_INTEGRITY_FORMAT',
  unsupportedAlgorithm: 'UNSUPPORTED_ALGORITHM',
  invalidShasum: 'INVALID_SHASUM_FORMAT',
  unsafePackageName: 'UNSAFE_PACKAGE_NAME',
  unsafeTarballName: 'UNSAFE_TARBALL_NAME',
  tarballNameUnknown: 'TARBALL_NAME_UNKNOWN',
  tarballNotFound: 'TARBALL_NOT_FOUND',
  tarballPresenceUnknown: 'TARBALL_PRESENCE_UNKNOWN',
  tarballUnreadable: 'TARBALL_UNREADABLE',
  integrityMismatch: 'INTEGRITY_MISMATCH',
  shasumMismatch: 'SHASUM_MISMATCH',
});

// 저장된 Tarball 을 직접 해싱해 Metadata 의 기준값과 대조한다.
//
// Verdaccio Storage API 만 사용한다. Package 이름이나 파일명을 직접 경로로 이어
// 붙이지 않으므로 Storage 밖의 파일을 읽을 수 없고, 나중에 Object Storage 로 바꿔도
// 같은 코드가 동작한다.
//
// 읽기만 한다. 파일을 만들거나 고치거나 지우지 않는다.
async function verifyTarball(storage, { packageName, version }) {
  const subject = { packageName, version };

  // Storage 가 경로를 만들기 전에 먼저 막는다. Storage 구현이 바뀌어도 이 검사는 남는다.
  if (!isSafePackageName(packageName)) {
    return unverifiable(subject, REASON.unsafePackageName);
  }

  let packument;
  try {
    packument = await readLocalPackument(storage, packageName);
  } catch (error) {
    return unverifiable(subject, REASON.metadataUnreadable, error.message);
  }

  const versionMetadata = packument?.versions?.[version];
  if (versionMetadata === undefined) {
    return unverifiable(subject, REASON.versionNotFound);
  }

  const dist = versionMetadata.dist ?? {};
  const filename = readTarballName(dist.tarball);
  if (filename === undefined) {
    return unverifiable(subject, REASON.tarballNameUnknown);
  }

  // Metadata 의 dist.tarball 은 Uplink 가 준 값이다. %2F 를 풀면 경로 구분자가 나올 수
  // 있으므로, Decode 한 뒤에 한 번 더 본다.
  if (!isSafeTarballName(filename)) {
    return unverifiable({ ...subject, filename }, REASON.unsafeTarballName);
  }

  const target = { ...subject, filename };

  const reference = selectReference(dist);
  if (reference.error !== undefined) {
    return unverifiable(target, reference.error);
  }

  let present;
  try {
    present = (await storage.hasLocalTarball(packageName, filename)) === true;
  } catch (error) {
    // 있는지 모르는 상태다. "없다" 고 단정하면 실제로는 저장돼 있는 파일을 검사하지
    // 않고 넘어간 것이 된다.
    return unverifiable(target, REASON.tarballPresenceUnknown, error.message);
  }

  if (!present) {
    return unverifiable(target, REASON.tarballNotFound);
  }

  let actualDigest;
  try {
    actualDigest = await hashStream(
      storage.getTarball(packageName, filename),
      reference.algorithm,
      reference.encoding,
    );
  } catch (error) {
    return unverifiable(target, REASON.tarballUnreadable, error.message);
  }

  const expected = formatReference(reference);
  const actual = formatActual(reference, actualDigest);

  // 표기가 아니라 값이 같은지를 본다. reference.digests 는 Metadata 에 적힌 원문이므로
  // 보고용으로만 쓰고, 비교는 표기를 맞춘 reference.comparable 로 한다.
  if (reference.comparable.includes(actualDigest)) {
    return {
      status: STATUS.pass,
      ...target,
      algorithm: reference.algorithm,
      expected,
      actual,
    };
  }

  return {
    status: STATUS.fail,
    ...target,
    algorithm: reference.algorithm,
    expected,
    actual,
    reason: reference.kind === 'shasum'
      ? REASON.shasumMismatch
      : REASON.integrityMismatch,
  };
}

// 어떤 기준값으로 대조할지 고른다.
//
// dist.integrity 가 있으면 그중 가장 강한 알고리즘을 쓴다. integrity 가 아예 없는
// 구버전 Package 는 dist.shasum(sha1) 으로 대조한다. verify-cache.sh 와 같은 기준이며,
// integrity 가 있는데 shasum 으로 대신하지는 않는다.
function selectReference(dist) {
  const entries = parseSri(dist.integrity);

  if (entries.length > 0) {
    const supported = entries.filter((entry) =>
      SUPPORTED_ALGORITHMS.has(entry.algorithm),
    );

    if (supported.length === 0) {
      return { error: REASON.unsupportedAlgorithm };
    }

    // 길이나 문자가 어긋난 digest 는 비교 대상이 아니다. 그대로 대조하면 손상된
    // Metadata 가 "Tarball 이 변조됨" 으로 보고된다.
    const usable = supported.filter((entry) =>
      isValidDigest(entry.algorithm, entry.digest),
    );

    if (usable.length === 0) {
      return { error: REASON.invalidIntegrity };
    }

    const strongest = selectStrongest(usable);

    return {
      kind: 'integrity',
      algorithm: strongest.algorithm,
      digests: strongest.digests,
      comparable: strongest.digests.map(normalizeDigest),
      encoding: 'base64',
    };
  }

  // 문자열은 있는데 SRI 로 읽히지 않으면 형식 오류다. 값 자체가 없는 것과 구분한다.
  if (typeof dist.integrity === 'string' && dist.integrity.trim() !== '') {
    return { error: REASON.invalidIntegrity };
  }

  if (typeof dist.shasum === 'string' && dist.shasum.trim() !== '') {
    if (!isValidShasum(dist.shasum)) {
      return { error: REASON.invalidShasum };
    }

    const shasum = dist.shasum.trim().toLowerCase();

    return {
      kind: 'shasum',
      algorithm: 'sha1',
      digests: [shasum],
      comparable: [shasum],
      encoding: 'hex',
    };
  }

  return { error: REASON.noReferenceHash };
}

function formatReference(reference) {
  return reference.kind === 'shasum'
    ? reference.digests[0]
    : formatSri(reference.algorithm, reference.digests);
}

function formatActual(reference, digest) {
  return reference.kind === 'shasum'
    ? digest
    : formatSri(reference.algorithm, [digest]);
}

// 저장된 Metadata 만 본다. Uplink 를 다시 조회하면 지금 Cache 에 있는 파일이 아니라
// 원격의 최신 Metadata 와 비교하게 된다.
function readLocalPackument(storage, packageName) {
  return new Promise((resolve, reject) => {
    try {
      storage.getPackage({
        name: packageName,
        uplinksLook: false,
        callback(error, packument) {
          if (error) {
            reject(error);
            return;
          }

          resolve(packument);
        },
      });
    } catch (error) {
      reject(error);
    }
  });
}

// Storage 밖을 가리킬 수 있는 이름을 걸러낸다. npm Package 이름은 `name` 또는
// `@scope/name` 두 형태뿐이므로, 그 밖의 경로 구분자나 상위 이동은 정상 값이 아니다.
function isSafePackageName(name) {
  if (typeof name !== 'string' || name === '' || hasNullByte(name)) {
    return false;
  }

  const segments = name.split('/');
  if (segments.length > 2) {
    return false;
  }

  if (segments.length === 2 && !segments[0].startsWith('@')) {
    return false;
  }

  return segments.every((segment) => isSafeSegment(segment));
}

function isSafeTarballName(name) {
  return isSafeSegment(name) && !name.includes('/');
}

function isSafeSegment(segment) {
  return (
    segment !== '' &&
    segment !== '.' &&
    segment !== '..' &&
    !segment.includes(String.fromCharCode(92)) &&
    !hasNullByte(segment)
  );
}

function hasNullByte(value) {
  return value.includes(String.fromCharCode(0));
}

// dist.tarball 은 URL 이다. 마지막 경로 조각만 파일명으로 쓴다.
function readTarballName(tarballUrl) {
  if (typeof tarballUrl !== 'string' || tarballUrl.trim() === '') {
    return undefined;
  }

  let pathname;
  try {
    pathname = new URL(tarballUrl).pathname;
  } catch {
    return undefined;
  }

  let filename;
  try {
    filename = decodeURIComponent(pathname.slice(pathname.lastIndexOf('/') + 1));
  } catch {
    return undefined;
  }

  return filename === '' ? undefined : filename;
}

function unverifiable(subject, reason, detail) {
  const result = { status: STATUS.unverifiable, ...subject, reason };

  if (typeof detail === 'string' && detail.trim() !== '') {
    result.detail = detail;
  }

  return result;
}

module.exports = {
  REASON,
  STATUS,
  isSafePackageName,
  isSafeTarballName,
  readLocalPackument,
  readTarballName,
  verifyTarball,
};
