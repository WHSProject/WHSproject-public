'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  CacheListingUnavailableError,
  canListCachedPackages,
  listCachedTargets,
  packageNameFromKey,
} = require('../src/cache-targets');

function baseName(name) {
  return name.split('/').pop();
}

function packument(name, versions) {
  return {
    name,
    versions: Object.fromEntries(versions.map((version) => [version, {
      version,
      dist: {
        integrity: 'sha512-reference',
        tarball: `https://registry.npmjs.org/${name}/-/${baseName(name)}-${version}.tgz`,
      },
    }])),
  };
}

// Verdaccio 기본 로컬 저장소 Plugin 과 같은 Class 이름을 쓴다. 저장소 종류를 이 이름으로
// 가리므로 Test 도 같은 이름이어야 한다.
class LocalDatabase {
  constructor(names = [], searchError) {
    this.names = names;
    this.searchError = searchError;
  }

  search(onPackage, onEnd) {
    (async () => {
      for (const name of this.names) {
        await new Promise((resolve) => onPackage({ name, path: '/storage', time: 1 }, resolve));
      }
      onEnd(this.searchError ?? null);
    })();
  }
}

// Verdaccio Storage 와 Storage Plugin 의 필요한 부분만 흉내 낸다.
function createStorage({
  names = [],
  packuments = {},
  present = [],
  searchError,
  metadataErrors = [],
  presenceErrors = [],
  withSearch = true,
} = {}) {
  const calls = { getPackage: [], hasLocalTarball: [] };
  const storagePlugin = withSearch ? new LocalDatabase(names, searchError) : {};

  return {
    calls,
    localStorage: { storagePlugin },
    getPackage({ name, uplinksLook, callback }) {
      calls.getPackage.push({ name, uplinksLook });
      if (metadataErrors.includes(name)) {
        callback(new Error('broken metadata'));
        return;
      }
      callback(null, packuments[name]);
    },
    async hasLocalTarball(name, file) {
      const key = `${name}/${file}`;
      calls.hasLocalTarball.push(key);
      if (presenceErrors.includes(key)) {
        throw new Error('stat failed');
      }
      return present.includes(key);
    },
  };
}

test('reports that listing is unavailable when the storage plugin has no search', async () => {
  for (const storage of [undefined, {}, { localStorage: {} }, createStorage({ withSearch: false })]) {
    assert.equal(canListCachedPackages(storage), false);
    await assert.rejects(listCachedTargets(storage), CacheListingUnavailableError);
  }
  assert.equal(canListCachedPackages(createStorage()), true);
});

test('returns only versions whose tarball is stored, including scoped packages', async () => {
  const storage = createStorage({
    names: ['is-odd', '@whs/example', 'is-odd'],
    packuments: {
      'is-odd': packument('is-odd', ['3.0.0', '3.0.1']),
      '@whs/example': packument('@whs/example', ['1.0.0']),
    },
    present: ['is-odd/is-odd-3.0.1.tgz', '@whs/example/example-1.0.0.tgz'],
  });

  const listing = await listCachedTargets(storage);

  assert.deepEqual(listing, {
    targets: [
      { packageName: '@whs/example', version: '1.0.0' },
      { packageName: 'is-odd', version: '3.0.1' },
    ],
    packages: 2,
    unreadable: 0,
    skipped: 0,
  });
});

test('reads metadata once per package from local storage only', async () => {
  const storage = createStorage({
    names: ['is-odd'],
    packuments: { 'is-odd': packument('is-odd', ['3.0.0', '3.0.1', '3.0.2']) },
    present: ['is-odd/is-odd-3.0.1.tgz'],
  });

  await listCachedTargets(storage);

  // Uplink 를 다시 조회하면 저장된 파일이 아니라 원격의 최신 Metadata 를 보게 된다.
  assert.deepEqual(storage.calls.getPackage, [{ name: 'is-odd', uplinksLook: false }]);
  assert.equal(storage.calls.hasLocalTarball.length, 3);
});

test('skips unsafe package names without touching storage', async () => {
  const storage = createStorage({ names: ['../etc', 'a/b/c'] });

  const listing = await listCachedTargets(storage);

  assert.deepEqual(listing.targets, []);
  assert.equal(listing.skipped, 2);
  assert.deepEqual(storage.calls.getPackage, []);
});

test('skips versions whose tarball name is unknown or unsafe', async () => {
  const storage = createStorage({
    names: ['odd'],
    packuments: {
      odd: {
        name: 'odd',
        versions: {
          '1.0.0': { version: '1.0.0', dist: {} },
          '2.0.0': {
            version: '2.0.0',
            dist: { tarball: 'https://registry.npmjs.org/odd/-/..%2Fsecret.tgz' },
          },
        },
      },
    },
  });

  const listing = await listCachedTargets(storage);

  assert.deepEqual(listing.targets, []);
  // 경로 구분자가 나오는 파일명은 Storage 에 넘기지 않는다.
  assert.deepEqual(storage.calls.hasLocalTarball, []);
});

test('counts unreadable metadata and keeps going', async () => {
  const storage = createStorage({
    names: ['broken', 'is-odd', 'empty'],
    packuments: {
      'is-odd': packument('is-odd', ['3.0.1']),
      empty: { name: 'empty' },
    },
    metadataErrors: ['broken'],
    present: ['is-odd/is-odd-3.0.1.tgz'],
  });

  const listing = await listCachedTargets(storage);

  assert.deepEqual(listing.targets, [{ packageName: 'is-odd', version: '3.0.1' }]);
  assert.equal(listing.unreadable, 2);
});

test('keeps a version whose tarball presence cannot be checked', async () => {
  const storage = createStorage({
    names: ['is-odd'],
    packuments: { 'is-odd': packument('is-odd', ['3.0.1']) },
    presenceErrors: ['is-odd/is-odd-3.0.1.tgz'],
  });

  const listing = await listCachedTargets(storage);

  // verifyTarball 이 TARBALL_PRESENCE_UNKNOWN 으로 보고하도록 대상에 남긴다.
  assert.deepEqual(listing.targets, [{ packageName: 'is-odd', version: '3.0.1' }]);
});

test('rejects when the storage search fails', async () => {
  const storage = createStorage({ names: ['is-odd'], searchError: new Error('disk gone') });

  await assert.rejects(listCachedTargets(storage), /disk gone/);
});

test('refuses a storage plugin whose search only returns published packages', async () => {
  // S3 Storage Plugin 은 search 가 있지만 publish 목록만 돈다. search 가 있다는 것만으로
  // 쓰면 캐시를 빼고 일부만 검사한다. 버킷을 조회할 S3 client 와 bucket 이 없으면
  // 목록을 만들 수 없으므로 거부한다.
  let searched = 0;
  class S3Database {
    search(_onPackage, onEnd) {
      searched += 1;
      onEnd(null);
    }
  }
  const storage = { localStorage: { storagePlugin: new S3Database() } };

  assert.equal(canListCachedPackages(storage), false);
  await assert.rejects(
    listCachedTargets(storage),
    (error) => error instanceof CacheListingUnavailableError && error.message.includes('S3Database'),
  );
  assert.equal(searched, 0);
});

// verdaccio-aws-s3-storage 의 S3Database 와 같은 Class 이름과 속성(s3, config)만 흉내 낸다.
// search 는 publish 목록만 돌리므로 쓰이면 안 된다.
class S3Database {
  constructor({ bucket = 'whs-cache', keyPrefix = 'verdaccio/', pages = [[]], sendError } = {}) {
    this.config = { bucket, keyPrefix };
    this.sent = [];
    this.searched = 0;
    this.s3 = {
      send: async (command) => {
        this.sent.push(command.input);
        if (sendError) {
          throw sendError;
        }
        const index = this.sent.length - 1;
        const keys = pages[index] ?? [];
        const last = index >= pages.length - 1;
        return {
          Contents: keys.map((Key) => ({ Key })),
          IsTruncated: !last,
          NextContinuationToken: last ? undefined : `token-${index + 1}`,
        };
      },
    };
  }

  search(_onPackage, onEnd) {
    this.searched += 1;
    onEnd(null);
  }
}

class FakeListObjectsV2Command {
  constructor(input) {
    this.input = input;
  }
}

const withFakeSdk = { loadListCommand: () => FakeListObjectsV2Command };

function createS3Storage(plugin, options = {}) {
  const storage = createStorage(options);
  storage.localStorage.storagePlugin = plugin;
  return storage;
}

test('lists cached packages on S3 from metadata keys in the bucket', async () => {
  const plugin = new S3Database({
    pages: [[
      'verdaccio/verdaccio-s3-db.json',
      'verdaccio/is-odd/package.json',
      'verdaccio/is-odd/is-odd-3.0.1.tgz',
      'verdaccio/@whs/example/package.json',
      'verdaccio/@whs/example/example-1.0.0.tgz',
    ]],
  });
  const storage = createS3Storage(plugin, {
    packuments: {
      'is-odd': packument('is-odd', ['3.0.0', '3.0.1']),
      '@whs/example': packument('@whs/example', ['1.0.0']),
    },
    present: ['is-odd/is-odd-3.0.1.tgz', '@whs/example/example-1.0.0.tgz'],
  });

  assert.equal(canListCachedPackages(storage), true);
  const listing = await listCachedTargets(storage, withFakeSdk);

  assert.deepEqual(listing, {
    targets: [
      { packageName: '@whs/example', version: '1.0.0' },
      { packageName: 'is-odd', version: '3.0.1' },
    ],
    packages: 2,
    unreadable: 0,
    skipped: 0,
  });
  assert.deepEqual(plugin.sent, [{
    Bucket: 'whs-cache',
    Prefix: 'verdaccio/',
    MaxKeys: 1000,
    ContinuationToken: undefined,
  }]);
  // publish 목록만 돌려주는 search 는 쓰지 않는다.
  assert.equal(plugin.searched, 0);
});

test('follows every page of the bucket listing', async () => {
  const plugin = new S3Database({
    pages: [
      ['verdaccio/a/package.json'],
      ['verdaccio/b/package.json'],
      ['verdaccio/c/package.json'],
    ],
  });
  const storage = createS3Storage(plugin, {
    packuments: {
      a: packument('a', ['1.0.0']),
      b: packument('b', ['1.0.0']),
      c: packument('c', ['1.0.0']),
    },
    present: ['a/a-1.0.0.tgz', 'b/b-1.0.0.tgz', 'c/c-1.0.0.tgz'],
  });

  const listing = await listCachedTargets(storage, withFakeSdk);

  assert.equal(listing.packages, 3);
  assert.deepEqual(
    plugin.sent.map((input) => input.ContinuationToken),
    [undefined, 'token-1', 'token-2'],
  );
});

test('ignores keys outside the prefix and still checks names found in the bucket', async () => {
  const plugin = new S3Database({
    keyPrefix: '',
    pages: [[
      'package.json',
      'is-odd/package.json',
      'is-odd/package.json.tmp',
      '../etc/package.json',
    ]],
  });
  const storage = createS3Storage(plugin, {
    packuments: { 'is-odd': packument('is-odd', ['3.0.1']) },
    present: ['is-odd/is-odd-3.0.1.tgz'],
  });

  const listing = await listCachedTargets(storage, withFakeSdk);

  assert.deepEqual(listing.targets, [{ packageName: 'is-odd', version: '3.0.1' }]);
  // 버킷에서 온 이름도 로컬 저장소와 같은 기준으로 걸러 Storage 에 넘기지 않는다.
  assert.equal(listing.skipped, 1);
  assert.deepEqual(storage.calls.getPackage, [{ name: 'is-odd', uplinksLook: false }]);
});

test('reports a failed bucket listing instead of an empty result', async () => {
  const plugin = new S3Database({ sendError: new Error('AccessDenied') });
  const storage = createS3Storage(plugin);

  await assert.rejects(listCachedTargets(storage, withFakeSdk), /AccessDenied/);
});

test('refuses an S3 storage plugin without a bucket', async () => {
  const storage = createS3Storage(new S3Database({ bucket: '' }));

  assert.equal(canListCachedPackages(storage), false);
  await assert.rejects(listCachedTargets(storage, withFakeSdk), CacheListingUnavailableError);
});

test('extracts package names only from metadata keys under the prefix', () => {
  assert.equal(packageNameFromKey('verdaccio/is-odd/package.json', 'verdaccio/'), 'is-odd');
  assert.equal(packageNameFromKey('verdaccio/@whs/a/package.json', 'verdaccio/'), '@whs/a');
  assert.equal(packageNameFromKey('other/is-odd/package.json', 'verdaccio/'), undefined);
  assert.equal(packageNameFromKey('verdaccio/is-odd/is-odd-1.0.0.tgz', 'verdaccio/'), undefined);
  assert.equal(packageNameFromKey('verdaccio//package.json', 'verdaccio/'), undefined);
  assert.equal(packageNameFromKey(undefined, 'verdaccio/'), undefined);
});
