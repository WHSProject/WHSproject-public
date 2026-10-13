'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const test = require('node:test');

const { REASON, STATUS, verifyTarball } = require('../src/verify-tarball');

const TARBALL = Buffer.from('is-number-7.0.0 tarball bytes');
const TAMPERED = Buffer.from('is-number-7.0.0 tarball bytez');

function sriOf(buffer, algorithm = 'sha512') {
  return `${algorithm}-${crypto.createHash(algorithm).update(buffer).digest('base64')}`;
}

function shasumOf(buffer) {
  return crypto.createHash('sha1').update(buffer).digest('hex');
}

// Verdaccio Storage API 의 필요한 부분만 흉내 낸다.
function createStorage({
  packageName = 'is-number',
  version = '7.0.0',
  filename = 'is-number-7.0.0.tgz',
  dist,
  contents = TARBALL,
  packument,
  metadataError,
  tarballMissing = false,
  tarballError,
  hasLocalTarballError,
} = {}) {
  const calls = { getPackage: [], getTarball: [], hasLocalTarball: [] };

  const resolvedPackument =
    packument !== undefined
      ? packument
      : {
          name: packageName,
          versions: {
            [version]: {
              version,
              dist: dist ?? {
                integrity: sriOf(contents),
                tarball: `https://registry.npmjs.org/${packageName}/-/${filename}`,
              },
            },
          },
        };

  return {
    calls,
    getPackage(options) {
      calls.getPackage.push({
        name: options.name,
        uplinksLook: options.uplinksLook,
      });

      if (metadataError !== undefined) {
        options.callback(metadataError);
        return;
      }

      options.callback(null, resolvedPackument);
    },
    getTarball(name, file) {
      calls.getTarball.push({ name, file });

      if (tarballError !== undefined) {
        return Readable.from(
          (async function* failingStream() {
            throw tarballError;
          })(),
        );
      }

      return Readable.from([contents]);
    },
    async hasLocalTarball(name, file) {
      calls.hasLocalTarball.push({ name, file });

      if (hasLocalTarballError !== undefined) {
        throw hasLocalTarballError;
      }

      return !tarballMissing;
    },
  };
}

const target = { packageName: 'is-number', version: '7.0.0' };

// ---------------------------------------------------------------------------
// 정상 동작
// ---------------------------------------------------------------------------

test('passes when the stored tarball matches the metadata integrity', async () => {
  const storage = createStorage();

  const result = await verifyTarball(storage, target);

  assert.equal(result.status, STATUS.pass);
  assert.equal(result.packageName, 'is-number');
  assert.equal(result.version, '7.0.0');
  assert.equal(result.filename, 'is-number-7.0.0.tgz');
  assert.equal(result.algorithm, 'sha512');
  assert.equal(result.expected, sriOf(TARBALL));
  assert.equal(result.actual, sriOf(TARBALL));
  assert.equal('reason' in result, false);
});

test('verifies a scoped package', async () => {
  const storage = createStorage({
    packageName: '@whs/example',
    version: '1.0.0',
    filename: 'example-1.0.0.tgz',
  });

  const result = await verifyTarball(storage, {
    packageName: '@whs/example',
    version: '1.0.0',
  });

  assert.equal(result.status, STATUS.pass);
  assert.equal(result.filename, 'example-1.0.0.tgz');
  assert.deepEqual(storage.calls.getTarball, [
    { name: '@whs/example', file: 'example-1.0.0.tgz' },
  ]);
});

test('reads the strongest algorithm when several are listed', async () => {
  const storage = createStorage({
    dist: {
      integrity: `sha256-${crypto
        .createHash('sha256')
        .update(TARBALL)
        .digest('base64')} ${sriOf(TARBALL)}`,
      tarball: 'https://registry.npmjs.org/is-number/-/is-number-7.0.0.tgz',
    },
  });

  const result = await verifyTarball(storage, target);

  assert.equal(result.status, STATUS.pass);
  assert.equal(result.algorithm, 'sha512');
});

test('accepts any digest of the chosen algorithm', async () => {
  const storage = createStorage({
    dist: {
      integrity: `sha512-AAAA ${sriOf(TARBALL)}`,
      tarball: 'https://registry.npmjs.org/is-number/-/is-number-7.0.0.tgz',
    },
  });

  const result = await verifyTarball(storage, target);

  assert.equal(result.status, STATUS.pass);
});

test('accepts a correct digest that was written without base64 padding', async () => {
  // 같은 해시라도 padding 유무로 문자열이 달라진다. Node 는 언제나 padding 을 붙이므로,
  // 표기만 다른 값을 불일치로 판정하면 정상 Tarball 이 변조된 것처럼 보고된다.
  const unpadded = sriOf(TARBALL).replace(/=+$/, '');
  assert.notEqual(unpadded, sriOf(TARBALL));

  const storage = createStorage({
    dist: {
      integrity: unpadded,
      tarball: 'https://registry.npmjs.org/is-number/-/is-number-7.0.0.tgz',
    },
  });

  const result = await verifyTarball(storage, target);

  assert.equal(result.status, STATUS.pass);
  // 보고에는 Metadata 에 적힌 원문을 그대로 남긴다.
  assert.equal(result.expected, unpadded);
});

test('falls back to shasum only when integrity is absent', async () => {
  const storage = createStorage({
    dist: {
      shasum: shasumOf(TARBALL),
      tarball: 'https://registry.npmjs.org/is-number/-/is-number-7.0.0.tgz',
    },
  });

  const result = await verifyTarball(storage, target);

  assert.equal(result.status, STATUS.pass);
  assert.equal(result.algorithm, 'sha1');
  assert.equal(result.expected, shasumOf(TARBALL));
});

test('reads the stored metadata instead of asking the uplink', async () => {
  const storage = createStorage();

  await verifyTarball(storage, target);

  assert.deepEqual(storage.calls.getPackage, [
    { name: 'is-number', uplinksLook: false },
  ]);
});

// ---------------------------------------------------------------------------
// 불일치
// ---------------------------------------------------------------------------

test('fails when the stored tarball was changed', async () => {
  const storage = createStorage({
    dist: {
      integrity: sriOf(TARBALL),
      tarball: 'https://registry.npmjs.org/is-number/-/is-number-7.0.0.tgz',
    },
    contents: TAMPERED,
  });

  const result = await verifyTarball(storage, target);

  assert.equal(result.status, STATUS.fail);
  assert.equal(result.reason, REASON.integrityMismatch);
  assert.equal(result.expected, sriOf(TARBALL));
  assert.equal(result.actual, sriOf(TAMPERED));
  assert.notEqual(result.expected, result.actual);
});

test('fails on a shasum mismatch with its own reason', async () => {
  const storage = createStorage({
    dist: {
      shasum: shasumOf(TARBALL),
      tarball: 'https://registry.npmjs.org/is-number/-/is-number-7.0.0.tgz',
    },
    contents: TAMPERED,
  });

  const result = await verifyTarball(storage, target);

  assert.equal(result.status, STATUS.fail);
  assert.equal(result.reason, REASON.shasumMismatch);
});

// ---------------------------------------------------------------------------
// 검증 불가
// ---------------------------------------------------------------------------

test('reports unreadable metadata', async () => {
  const storage = createStorage({ metadataError: new Error('no such package') });

  const result = await verifyTarball(storage, target);

  assert.equal(result.status, STATUS.unverifiable);
  assert.equal(result.reason, REASON.metadataUnreadable);
  assert.equal(result.detail, 'no such package');
});

test('reports a version that is not in the metadata', async () => {
  const storage = createStorage({ version: '6.0.0' });

  const result = await verifyTarball(storage, target);

  assert.equal(result.status, STATUS.unverifiable);
  assert.equal(result.reason, REASON.versionNotFound);
});

test('reports metadata without any reference hash', async () => {
  const storage = createStorage({
    dist: {
      tarball: 'https://registry.npmjs.org/is-number/-/is-number-7.0.0.tgz',
    },
  });

  const result = await verifyTarball(storage, target);

  assert.equal(result.status, STATUS.unverifiable);
  assert.equal(result.reason, REASON.noReferenceHash);
});

test('reports an integrity value that is not in SRI shape', async () => {
  const storage = createStorage({
    dist: {
      // 구분자가 없어 <alg>-<digest> 로 읽히지 않는다.
      integrity: 'garbagevalue',
      tarball: 'https://registry.npmjs.org/is-number/-/is-number-7.0.0.tgz',
    },
  });

  const result = await verifyTarball(storage, target);

  assert.equal(result.status, STATUS.unverifiable);
  assert.equal(result.reason, REASON.invalidIntegrity);
});

test('reports an algorithm that is not supported', async () => {
  const storage = createStorage({
    dist: {
      integrity: 'md5-abcdef',
      tarball: 'https://registry.npmjs.org/is-number/-/is-number-7.0.0.tgz',
    },
  });

  const result = await verifyTarball(storage, target);

  assert.equal(result.status, STATUS.unverifiable);
  assert.equal(result.reason, REASON.unsupportedAlgorithm);
});

test('reports metadata without a usable tarball name', async () => {
  const storage = createStorage({
    dist: { integrity: sriOf(TARBALL), tarball: 'not a url' },
  });

  const result = await verifyTarball(storage, target);

  assert.equal(result.status, STATUS.unverifiable);
  assert.equal(result.reason, REASON.tarballNameUnknown);
});

test('reports a tarball that is not stored locally', async () => {
  const storage = createStorage({ tarballMissing: true });

  const result = await verifyTarball(storage, target);

  assert.equal(result.status, STATUS.unverifiable);
  assert.equal(result.reason, REASON.tarballNotFound);
  // 없는 파일을 읽으려 시도하지 않는다. 읽으면 Uplink 에서 내려받게 된다.
  assert.deepEqual(storage.calls.getTarball, []);
});

test('reports a tarball that cannot be read', async () => {
  const storage = createStorage({ tarballError: new Error('disk error') });

  const result = await verifyTarball(storage, target);

  assert.equal(result.status, STATUS.unverifiable);
  assert.equal(result.reason, REASON.tarballUnreadable);
  assert.equal(result.detail, 'disk error');
});

test('reports a storage that throws instead of calling back', async () => {
  const storage = createStorage();
  storage.getPackage = () => {
    throw new Error('storage is down');
  };

  const result = await verifyTarball(storage, target);

  assert.equal(result.status, STATUS.unverifiable);
  assert.equal(result.reason, REASON.metadataUnreadable);
});

// ---------------------------------------------------------------------------
// 처리 방식
// ---------------------------------------------------------------------------

test('rejects a package name that could escape the storage root', async () => {
  const storage = createStorage();

  for (const packageName of [
    '../../etc',
    'a/../../b',
    '@scope/../../etc',
    'a/b/c',
    String.fromCharCode(46, 46),
    'evil' + String.fromCharCode(92) + 'path',
    'nul' + String.fromCharCode(0) + 'byte',
    '',
  ]) {
    const result = await verifyTarball(storage, { packageName, version: '1.0.0' });

    assert.equal(
      result.status,
      STATUS.unverifiable,
      `${packageName} 이(가) 통과했다`,
    );
    assert.equal(result.reason, REASON.unsafePackageName);
  }

  // Storage 를 건드리지도 않는다.
  assert.deepEqual(storage.calls.getPackage, []);
  assert.deepEqual(storage.calls.getTarball, []);
});

test('accepts the package name shapes npm actually uses', async () => {
  for (const packageName of ['is-number', '@whs/example']) {
    const storage = createStorage({ packageName, filename: 'pkg-1.0.0.tgz', version: '1.0.0' });

    const result = await verifyTarball(storage, { packageName, version: '1.0.0' });

    assert.equal(result.status, STATUS.pass, `${packageName} 이(가) 막혔다`);
  }
});

test('rejects a tarball name that decodes into a path', async () => {
  // Uplink 가 준 dist.tarball 에 %2F 가 들어 있으면 Decode 후 경로가 된다.
  const storage = createStorage({
    dist: {
      integrity: sriOf(TARBALL),
      tarball: 'https://registry.npmjs.org/is-number/-/..%2F..%2Fetc%2Fpasswd',
    },
  });

  const result = await verifyTarball(storage, target);

  assert.equal(result.status, STATUS.unverifiable);
  assert.equal(result.reason, REASON.unsafeTarballName);
  // 위험한 이름으로 Storage 를 부르지 않는다.
  assert.deepEqual(storage.calls.hasLocalTarball, []);
  assert.deepEqual(storage.calls.getTarball, []);
});

test('rejects a dot segment that URL parsing resolves away', async () => {
  // URL 은 %2E%2E 를 `..` 로 정규화하고 경로에서 지운다. 그래서 파일명이 비고,
  // 이름을 얻지 못한 것으로 처리된다. 어느 쪽이든 Storage 를 부르지 않는다.
  const storage = createStorage({
    dist: {
      integrity: sriOf(TARBALL),
      tarball: 'https://registry.npmjs.org/is-number/-/%2E%2E',
    },
  });

  const result = await verifyTarball(storage, target);

  assert.equal(result.status, STATUS.unverifiable);
  assert.equal(result.reason, REASON.tarballNameUnknown);
  assert.deepEqual(storage.calls.getTarball, []);
});

test('reports a storage that cannot answer whether the tarball exists', async () => {
  const storage = createStorage({
    hasLocalTarballError: new Error('storage unavailable'),
  });

  const result = await verifyTarball(storage, target);

  assert.equal(result.status, STATUS.unverifiable);
  // "없다" 가 아니라 "모른다" 로 남겨야 검사에서 빠진 대상을 찾을 수 있다.
  assert.equal(result.reason, REASON.tarballPresenceUnknown);
  assert.equal(result.detail, 'storage unavailable');
});

test('reports an integrity digest whose length does not match the algorithm', async () => {
  const storage = createStorage({
    dist: {
      integrity: 'sha512-c2hvcnQ=',
      tarball: 'https://registry.npmjs.org/is-number/-/is-number-7.0.0.tgz',
    },
  });

  const result = await verifyTarball(storage, target);

  // 손상된 Metadata 를 "Tarball 이 변조됨" 으로 보고하면 안 된다.
  assert.equal(result.status, STATUS.unverifiable);
  assert.equal(result.reason, REASON.invalidIntegrity);
});

test('reports an integrity digest that is not base64', async () => {
  const storage = createStorage({
    dist: {
      integrity: 'sha512-!!!!not base64!!!!',
      tarball: 'https://registry.npmjs.org/is-number/-/is-number-7.0.0.tgz',
    },
  });

  const result = await verifyTarball(storage, target);

  assert.equal(result.status, STATUS.unverifiable);
  assert.equal(result.reason, REASON.invalidIntegrity);
});

test('reports a shasum that is not a sha1 hex digest', async () => {
  const storage = createStorage({
    dist: {
      shasum: 'not-a-sha1',
      tarball: 'https://registry.npmjs.org/is-number/-/is-number-7.0.0.tgz',
    },
  });

  const result = await verifyTarball(storage, target);

  assert.equal(result.status, STATUS.unverifiable);
  assert.equal(result.reason, REASON.invalidShasum);
});

test('only reads through the storage api', async () => {
  const storage = createStorage();
  for (const name of ['removePackage', 'removeTarball', 'addPackage', 'updateVersions']) {
    storage[name] = () => {
      throw new Error(`${name} must not be called`);
    };
  }

  const result = await verifyTarball(storage, target);

  assert.equal(result.status, STATUS.pass);
  assert.deepEqual(Object.keys(storage.calls).sort(), [
    'getPackage',
    'getTarball',
    'hasLocalTarball',
  ]);
});

test('never rejects, so one bad target cannot break a batch', async () => {
  const broken = createStorage({ metadataError: new Error('boom') });
  const missing = createStorage({ tarballMissing: true });
  const good = createStorage();

  const results = await Promise.all([
    verifyTarball(broken, target),
    verifyTarball(missing, target),
    verifyTarball(good, target),
  ]);

  assert.deepEqual(
    results.map((result) => result.status),
    [STATUS.unverifiable, STATUS.unverifiable, STATUS.pass],
  );
});
