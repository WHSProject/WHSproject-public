'use strict';

const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const test = require('node:test');

const {
  ApprovalConflictError,
  ApprovalStore,
} = require('../src/approval-store');
const {
  ApprovalMismatchError,
  PackagePreparationError,
  preparePackages,
} = require('../src/package-preparer');

const artifact = {
  packageName: 'is-number',
  version: '7.0.0',
  integrity: 'sha512-approved',
};

function createStorage({
  version = artifact.version,
  integrity = artifact.integrity,
  tarballError,
  cached = true,
  // 준비를 시작하기 전에 이미 Cache 에 있는지. 기본값은 최초 등록 상황이다.
  cachedBefore = false,
  cachedAfterChecks,
} = {}) {
  const calls = {
    metadata: [],
    tarballs: [],
    cacheChecks: [],
  };

  return {
    calls,
    getPackage({ name, uplinksLook, req, callback }) {
      calls.metadata.push({ name, uplinksLook, req });
      callback(null, {
        name,
        versions: {
          [version]: {
            name,
            version,
            dist: {
              integrity,
              tarball: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`,
            },
          },
        },
      });
    },
    getTarball(packageName, filename) {
      calls.tarballs.push({ packageName, filename });
      if (tarballError !== undefined) {
        return Readable.from(
          (async function* streamFailure() {
            throw tarballError;
          })(),
        );
      }

      return Readable.from(['tarball']);
    },
    async hasLocalTarball(packageName, filename) {
      calls.cacheChecks.push({ packageName, filename });
      // 내려받기 전의 확인은 사전 Cache 확인이다.
      if (calls.tarballs.length === 0) {
        return cachedBefore;
      }
      if (cachedAfterChecks !== undefined) {
        return calls.cacheChecks.length >= cachedAfterChecks;
      }
      return cached;
    },
  };
}

test('fetches metadata and stores the approved tarball before completing', async () => {
  const storage = createStorage();
  const request = { headers: { authorization: 'Bearer token' } };

  const prepared = await preparePackages([artifact], storage, request);

  assert.deepEqual(storage.calls.metadata, [
    { name: 'is-number', uplinksLook: true, req: request },
  ]);
  assert.deepEqual(storage.calls.tarballs, [
    { packageName: 'is-number', filename: 'is-number-7.0.0.tgz' },
  ]);
  // 준비 전 사전 확인 1회, 저장 확인 1회.
  assert.deepEqual(storage.calls.cacheChecks, [
    { packageName: 'is-number', filename: 'is-number-7.0.0.tgz' },
    { packageName: 'is-number', filename: 'is-number-7.0.0.tgz' },
  ]);
  assert.deepEqual(prepared, [
    { ...artifact, filename: 'is-number-7.0.0.tgz' },
  ]);
});

test('fetches package metadata only once when multiple approved versions share a package', async () => {
  const secondArtifact = {
    packageName: artifact.packageName,
    version: '6.0.0',
    integrity: 'sha512-second',
  };
  const calls = { metadata: 0, tarballs: [] };
  const storage = {
    getPackage({ name, callback }) {
      calls.metadata += 1;
      callback(null, {
        name,
        versions: {
          '7.0.0': {
            dist: {
              integrity: 'sha512-approved',
              tarball: 'https://registry.npmjs.org/is-number/-/is-number-7.0.0.tgz',
            },
          },
          '6.0.0': {
            dist: {
              integrity: 'sha512-second',
              tarball: 'https://registry.npmjs.org/is-number/-/is-number-6.0.0.tgz',
            },
          },
        },
      });
    },
    getTarball(packageName, filename) {
      calls.tarballs.push({ packageName, filename });
      return Readable.from(['tarball']);
    },
    async hasLocalTarball(_packageName, filename) {
      return calls.tarballs.some((call) => call.filename === filename);
    },
  };

  await preparePackages([artifact, secondArtifact], storage, {});

  assert.equal(calls.metadata, 1);
  assert.equal(calls.tarballs.length, 2);
});

test('rejects an approved version that is absent from metadata', async () => {
  const storage = createStorage({ version: '6.0.0' });

  await assert.rejects(
    preparePackages([artifact], storage, {}),
    ApprovalMismatchError,
  );
  assert.equal(storage.calls.tarballs.length, 0);
});

test('rejects metadata whose integrity differs from the approval', async () => {
  const storage = createStorage({ integrity: 'sha512-different' });

  await assert.rejects(
    preparePackages([artifact], storage, {}),
    ApprovalMismatchError,
  );
  assert.equal(storage.calls.tarballs.length, 0);
});

test('rejects when downloading the tarball fails', async () => {
  const storage = createStorage({ tarballError: new Error('uplink unavailable') });

  await assert.rejects(
    preparePackages([artifact], storage, {}),
    PackagePreparationError,
  );
});

test('allows cache visibility delayed beyond the previous 500ms limit', async () => {
  const storage = createStorage({ cachedAfterChecks: 21 });

  await preparePackages([artifact], storage, {});

  assert.equal(storage.calls.cacheChecks.length, 21);
});

test('rejects when the downloaded tarball is not present in local cache', async () => {
  const storage = createStorage({ cached: false });

  await assert.rejects(
    preparePackages([artifact], storage, {}),
    /tarball was not stored in cache/,
  );
});

test('skips the download when the tarball is already cached', async () => {
  const storage = createStorage({ cachedBefore: true });

  const prepared = await preparePackages([artifact], storage, {});

  assert.deepEqual(storage.calls.tarballs, []);
  assert.deepEqual(storage.calls.cacheChecks, [
    { packageName: 'is-number', filename: 'is-number-7.0.0.tgz' },
  ]);
  assert.deepEqual(prepared, [
    { ...artifact, filename: 'is-number-7.0.0.tgz' },
  ]);
});

test('verifies metadata again even when the tarball is cached', async () => {
  const storage = createStorage({
    cachedBefore: true,
    integrity: 'sha512-different',
  });

  await assert.rejects(
    preparePackages([artifact], storage, {}),
    ApprovalMismatchError,
  );
  assert.deepEqual(storage.calls.cacheChecks, []);
});

test('prepares the tarball again when the cache is gone', async () => {
  const storage = createStorage({ cachedBefore: false });

  await preparePackages([artifact], storage, {});

  assert.deepEqual(storage.calls.tarballs, [
    { packageName: 'is-number', filename: 'is-number-7.0.0.tgz' },
  ]);
});

test('downloads the tarball when the cache check itself fails', async () => {
  const storage = createStorage();
  const cacheChecks = [];
  storage.hasLocalTarball = async (packageName, filename) => {
    cacheChecks.push({ packageName, filename });
    if (cacheChecks.length === 1) {
      throw new Error('storage unavailable');
    }
    return true;
  };

  await preparePackages([artifact], storage, {});

  // Cache 여부를 확인하지 못했다면 건너뛰지 않고 다시 준비한다.
  assert.equal(storage.calls.tarballs.length, 1);
});

// 동시 요청이 겹치도록 다운로드를 잠시 붙잡아 두는 Storage.
function createSlowStorage({ tarballError, delayMs = 10 } = {}) {
  const storage = createStorage({ tarballError });
  const originalGetTarball = storage.getTarball.bind(storage);

  storage.getTarball = (packageName, filename) => {
    const stream = originalGetTarball(packageName, filename);
    return Readable.from(
      (async function* slowStream() {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        yield* stream;
      })(),
    );
  };

  return storage;
}

test('downloads a tarball once when the same approval is prepared concurrently', async () => {
  const storage = createSlowStorage();
  const pending = new Map();

  await Promise.all([
    preparePackages([artifact], storage, {}, pending),
    preparePackages([artifact], storage, {}, pending),
  ]);

  assert.equal(storage.calls.tarballs.length, 1);
  assert.equal(pending.size, 0);
});

test('shares the failure with every request waiting on the same preparation', async () => {
  const storage = createSlowStorage({
    tarballError: new Error('uplink unavailable'),
  });
  const pending = new Map();

  const results = await Promise.allSettled([
    preparePackages([artifact], storage, {}, pending),
    preparePackages([artifact], storage, {}, pending),
  ]);

  assert.deepEqual(
    results.map((result) => result.status),
    ['rejected', 'rejected'],
  );
  assert.equal(storage.calls.tarballs.length, 1);
  assert.equal(pending.size, 0);
});

test('prepares again after an earlier preparation has settled', async () => {
  const storage = createSlowStorage();
  const pending = new Map();

  await preparePackages([artifact], storage, {}, pending);
  await preparePackages([artifact], storage, {}, pending);

  // 두 번째 요청은 진행 중인 작업이 없으므로 Cache 를 다시 확인하고 다운로드를 생략한다.
  assert.equal(storage.calls.tarballs.length, 1);
  assert.equal(pending.size, 0);
});

// 두 Version 의 dist.tarball 이 같은 파일을 가리키는 비정상 Metadata.
function createCollidingStorage({ delayMs = 10 } = {}) {
  const calls = { tarballs: [] };

  return {
    calls,
    getPackage({ name, callback }) {
      callback(null, {
        name,
        versions: {
          '1.0.0': {
            dist: {
              integrity: 'sha512-AAA',
              tarball: `https://registry.npmjs.org/${name}/-/${name}.tgz`,
            },
          },
          '2.0.0': {
            dist: {
              integrity: 'sha512-BBB',
              tarball: `https://registry.npmjs.org/${name}/-/${name}.tgz`,
            },
          },
        },
      });
    },
    getTarball(packageName, filename) {
      calls.tarballs.push({ packageName, filename });
      return Readable.from(
        (async function* slowStream() {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          yield 'tarball';
        })(),
      );
    },
    async hasLocalTarball() {
      return calls.tarballs.length > 0;
    },
  };
}

test('rejects a concurrent approval that expects a different integrity for the same file', async () => {
  const storage = createCollidingStorage();
  const pending = new Map();
  const first = { packageName: 'example', version: '1.0.0', integrity: 'sha512-AAA' };
  const second = { packageName: 'example', version: '2.0.0', integrity: 'sha512-BBB' };

  const results = await Promise.allSettled([
    preparePackages([first], storage, {}, pending),
    preparePackages([second], storage, {}, pending),
  ]);

  const rejected = results.filter((result) => result.status === 'rejected');
  assert.equal(rejected.length, 1);
  assert.ok(rejected[0].reason instanceof ApprovalConflictError);
  assert.match(rejected[0].reason.message, /conflicting integrity/);
  assert.equal(storage.calls.tarballs.length, 1);
  assert.equal(pending.size, 0);
});

test('still shares the download when the pending integrity matches', async () => {
  const storage = createSlowStorage();
  const pending = new Map();

  const results = await Promise.allSettled([
    preparePackages([artifact], storage, {}, pending),
    preparePackages([artifact], storage, {}, pending),
  ]);

  assert.deepEqual(
    results.map((result) => result.status),
    ['fulfilled', 'fulfilled'],
  );
  assert.equal(storage.calls.tarballs.length, 1);
});

// ---------------------------------------------------------------------------
// Integrity 충돌 (#191)
// ---------------------------------------------------------------------------

// 두 Version 이 같은 파일을 가리키는 Metadata.
function createSharedFilenameStorage() {
  const calls = { metadata: [], tarballs: [] };

  return {
    calls,
    getPackage({ name, callback }) {
      calls.metadata.push({ name });
      callback(null, {
        name,
        versions: {
          '1.0.0': {
            dist: {
              integrity: 'sha512-AAA',
              tarball: `https://registry.npmjs.org/${name}/-/${name}.tgz`,
            },
          },
          '2.0.0': {
            dist: {
              integrity: 'sha512-BBB',
              tarball: `https://registry.npmjs.org/${name}/-/${name}.tgz`,
            },
          },
        },
      });
    },
    getTarball(packageName, filename) {
      calls.tarballs.push({ packageName, filename });
      return Readable.from(['tarball']);
    },
    async hasLocalTarball() {
      return calls.tarballs.length > 0;
    },
  };
}

const conflictingPair = [
  { packageName: 'example', version: '1.0.0', integrity: 'sha512-AAA' },
  { packageName: 'example', version: '2.0.0', integrity: 'sha512-BBB' },
];

test('rejects a request body that reuses a filename with a different integrity', async () => {
  const storage = createSharedFilenameStorage();

  await assert.rejects(
    preparePackages(conflictingPair, storage, {}),
    ApprovalConflictError,
  );

  // 충돌을 먼저 보므로 Tarball 준비는 시작되지 않는다.
  assert.equal(storage.calls.tarballs.length, 0);
});

test('rejects before caching when the batch conflicts with a stored approval', async () => {
  const storage = createSharedFilenameStorage();
  const approvals = new ApprovalStore();
  approvals.register([
    { ...conflictingPair[0], filename: 'example.tgz' },
  ]);

  await assert.rejects(
    preparePackages([conflictingPair[1]], storage, {}, new Map(), approvals),
    ApprovalConflictError,
  );

  assert.equal(storage.calls.tarballs.length, 0);
  assert.equal(approvals.size, 1);
});

test('prepares normally when the stored approval has the same integrity', async () => {
  const storage = createSharedFilenameStorage();
  const approvals = new ApprovalStore();
  approvals.register([
    { ...conflictingPair[0], filename: 'example.tgz' },
  ]);

  const prepared = await preparePackages(
    [conflictingPair[0]],
    storage,
    {},
    new Map(),
    approvals,
  );

  assert.deepEqual(
    prepared.map((entry) => entry.filename),
    ['example.tgz'],
  );
});

test('skips caching for every package when one of them conflicts', async () => {
  const storage = createSharedFilenameStorage();
  const approvals = new ApprovalStore();
  approvals.register([
    { ...conflictingPair[0], filename: 'example.tgz' },
  ]);

  await assert.rejects(
    preparePackages(
      [{ packageName: 'example', version: '1.0.0', integrity: 'sha512-AAA' }, conflictingPair[1]],
      storage,
      {},
      new Map(),
      approvals,
    ),
    ApprovalConflictError,
  );

  // 충돌하지 않는 Artifact 의 Tarball 도 내려받지 않는다.
  assert.equal(storage.calls.tarballs.length, 0);
});
