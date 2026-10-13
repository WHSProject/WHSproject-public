'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');

const { createAuditLogger } = require('../src/audit-logger');
const {
  isExpectedMiss,
  observeStorage,
  packageNameFromUrl,
  reasonOfError,
} = require('../src/storage-observer');

function createRecordingLogger() {
  const entries = [];
  const record = (level) => (payload, message) => {
    entries.push({ level, payload, message });
  };
  return { entries, info: record('info'), warn: record('warn'), error: record('error') };
}

// 저장소 Plugin 과 Uplink 에서 Verdaccio 가 실제로 부르는 부분만 흉내 낸다.
function createStorage({ packageError, tarballStream, metadataError, fetchStream } = {}) {
  const calls = { readPackage: 0, readTarball: 0, getRemoteMetadata: 0, fetchTarball: 0 };

  const packageStorage = {
    readPackage(name, callback) {
      calls.readPackage += 1;
      callback(packageError ?? null, { name });
    },
    readTarball(filename) {
      calls.readTarball += 1;
      return tarballStream;
    },
  };

  const uplink = {
    getRemoteMetadata(name, options, callback) {
      calls.getRemoteMetadata += 1;
      callback(metadataError ?? null, { name }, null);
    },
    fetchTarball(url) {
      calls.fetchTarball += 1;
      return fetchStream;
    },
  };

  return {
    calls,
    packageStorage,
    uplink,
    storage: {
      localStorage: {
        storagePlugin: {
          constructor: { name: 'LocalDatabase' },
          getPackageStorage() {
            return packageStorage;
          },
        },
      },
      uplinks: { npmjs: uplink },
    },
  };
}

function setup(options = {}) {
  const logger = createRecordingLogger();
  const auditLogger = createAuditLogger({ logger, now: () => 1700000000000 });
  const fake = createStorage(options);
  const result = observeStorage({ storage: fake.storage, auditLogger, logger });
  const events = () => logger.entries
    .filter((entry) => entry.payload && entry.payload.eventType === 'audit')
    .map((entry) => ({ level: entry.level, event: entry.payload }));

  return { ...fake, logger, events, result };
}

test('records a storage.error when the package storage callback fails', async () => {
  const failure = Object.assign(new Error('EACCES: permission denied, open /verdaccio/storage/data/x'), {
    code: 'EACCES',
  });
  const { storage, events } = setup({ packageError: failure });

  await new Promise((resolve) => {
    storage.localStorage.storagePlugin.getPackageStorage('is-odd').readPackage('package.json', (error) => {
      assert.equal(error, failure);
      resolve();
    });
  });

  assert.deepEqual(events(), [{
    level: 'warn',
    event: {
      eventType: 'audit',
      timestamp: '2023-11-14T22:13:20.000Z',
      action: 'storage.error',
      result: 'failure',
      packageName: 'is-odd',
      reason: 'permission_denied',
      operation: 'readPackage',
    },
  }]);
});

test('keeps the original callback values and call count', async () => {
  const { storage, calls } = setup();

  const value = await new Promise((resolve) => {
    storage.localStorage.storagePlugin.getPackageStorage('is-odd').readPackage('package.json', (error, pkg) => {
      assert.equal(error, null);
      resolve(pkg);
    });
  });

  assert.deepEqual(value, { name: 'package.json' });
  assert.equal(calls.readPackage, 1);
});

test('ignores an expected miss so normal cache misses stay out of the log', async () => {
  for (const miss of [
    Object.assign(new Error('no such file'), { code: 'ENOENT' }),
    Object.assign(new Error('not found'), { status: 404 }),
    Object.assign(new Error('The specified key does not exist.'), { name: 'NoSuchKey' }),
  ]) {
    const { storage, events } = setup({ packageError: miss });
    await new Promise((resolve) => {
      storage.localStorage.storagePlugin.getPackageStorage('is-odd').readPackage('package.json', () => resolve());
    });
    assert.deepEqual(events(), [], String(miss.code ?? miss.name ?? miss.status));
  }
});

test('records a stream failure without consuming the stream', async () => {
  const stream = new EventEmitter();
  const { storage, events } = setup({ tarballStream: stream });

  const returned = storage.localStorage.storagePlugin
    .getPackageStorage('is-odd')
    .readTarball('is-odd-3.0.1.tgz');
  assert.equal(returned, stream);

  // Verdaccio 가 붙이는 Listener 도 그대로 받아야 한다.
  let received = null;
  returned.on('error', (error) => { received = error; });
  stream.emit('error', Object.assign(new Error('disk gone'), { code: 'EIO' }));

  assert.equal(received.code, 'EIO');
  assert.equal(events().length, 1);
  assert.equal(events()[0].event.action, 'storage.error');
  assert.equal(events()[0].event.operation, 'readTarball');
});

test('records an uplink.error with the uplink and package name', async () => {
  const failure = Object.assign(new Error('connect ETIMEDOUT 1.2.3.4:443'), { code: 'ETIMEDOUT' });
  const { storage, events } = setup({ metadataError: failure });

  await new Promise((resolve) => {
    storage.uplinks.npmjs.getRemoteMetadata('is-odd', {}, () => resolve());
  });

  assert.deepEqual(events(), [{
    level: 'warn',
    event: {
      eventType: 'audit',
      timestamp: '2023-11-14T22:13:20.000Z',
      action: 'uplink.error',
      result: 'failure',
      packageName: 'is-odd',
      reason: 'timeout',
      operation: 'getRemoteMetadata',
      uplink: 'npmjs',
    },
  }]);
});

test('keeps the upstream status code that Verdaccio wraps in a 500', async () => {
  // Verdaccio 는 2xx 가 아닌 Uplink 응답을 500 내부 오류로 감싸고 실제 코드를
  // remoteStatus 에 담는다(up-storage.js 실측). 이걸 보지 않으면 503 이 500 으로 뭉개진다.
  const wrapped = Object.assign(new Error('bad status code: 503'), {
    status: 500,
    remoteStatus: 503,
  });
  const { storage, events } = setup({ metadataError: wrapped });

  await new Promise((resolve) => {
    storage.uplinks.npmjs.getRemoteMetadata('is-odd', {}, () => resolve());
  });

  assert.equal(events()[0].event.statusCode, 503);
  assert.equal(events()[0].event.reason, 'server_error');
});

test('classifies a wrapped upstream 429 as a client error, not a server error', async () => {
  const wrapped = Object.assign(new Error('bad status code: 429'), {
    status: 500,
    remoteStatus: 429,
  });
  const { storage, events } = setup({ metadataError: wrapped });

  await new Promise((resolve) => {
    storage.uplinks.npmjs.getRemoteMetadata('is-odd', {}, () => resolve());
  });

  assert.equal(events()[0].event.statusCode, 429);
  assert.equal(events()[0].event.reason, 'client_error');
});

test('keeps the original getRemoteMetadata result on success', async () => {
  const { storage, calls } = setup();

  const value = await new Promise((resolve) => {
    storage.uplinks.npmjs.getRemoteMetadata('is-odd', {}, (error, body) => {
      assert.equal(error, null);
      resolve(body);
    });
  });

  assert.deepEqual(value, { name: 'is-odd' });
  assert.equal(calls.getRemoteMetadata, 1);
});

test('takes the package name from the tarball URL on an uplink stream failure', () => {
  const stream = new EventEmitter();
  const { storage, events } = setup({ fetchStream: stream });

  storage.uplinks.npmjs.fetchTarball('https://registry.npmjs.org/@whs%2fexample/-/example-1.0.0.tgz');
  stream.emit('error', Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));

  assert.equal(events().length, 1);
  assert.deepEqual(events()[0].event, {
    eventType: 'audit',
    timestamp: '2023-11-14T22:13:20.000Z',
    action: 'uplink.error',
    result: 'failure',
    packageName: '@whs/example',
    reason: 'connection_failed',
    operation: 'fetchTarball',
    uplink: 'npmjs',
  });
});

test('never logs the error message, stack or path', async () => {
  const failure = Object.assign(
    new Error('EACCES: permission denied, open /verdaccio/storage/secret/htpasswd'),
    { code: 'EACCES' },
  );
  const { storage, logger } = setup({ packageError: failure });

  await new Promise((resolve) => {
    storage.localStorage.storagePlugin.getPackageStorage('is-odd').readPackage('package.json', () => resolve());
  });

  const logged = JSON.stringify(logger.entries);
  assert.equal(logged.includes('permission denied'), false);
  assert.equal(logged.includes('htpasswd'), false);
  assert.equal(logged.includes('storage/secret'), false);
});

test('records only once when the storage is observed twice', async () => {
  const logger = createRecordingLogger();
  const auditLogger = createAuditLogger({ logger, now: () => 1700000000000 });
  const failure = Object.assign(new Error('boom'), { code: 'EACCES' });
  const fake = createStorage({ packageError: failure });

  observeStorage({ storage: fake.storage, auditLogger, logger });
  observeStorage({ storage: fake.storage, auditLogger, logger });

  await new Promise((resolve) => {
    fake.storage.localStorage.storagePlugin.getPackageStorage('is-odd').readPackage('package.json', () => resolve());
  });
  await new Promise((resolve) => {
    fake.storage.uplinks.npmjs.getRemoteMetadata('is-odd', {}, () => resolve());
  });

  const audits = logger.entries.filter((entry) => entry.payload?.eventType === 'audit');
  assert.equal(audits.length, 1);
});

test('warns and stays off when the storage shape is not what it expects', () => {
  const logger = createRecordingLogger();
  const auditLogger = createAuditLogger({ logger, now: () => 1700000000000 });

  const result = observeStorage({ storage: {}, auditLogger, logger });

  assert.deepEqual(result, { storageObserved: false, uplinkCount: 0 });
  const messages = logger.entries.map((entry) => entry.message).join(" ");
  assert.equal(messages.includes('storage.error events are disabled'), true);
  assert.equal(messages.includes('uplink.error events are disabled'), true);
});

test('classifies errors into a fixed set of reasons', () => {
  const cases = [
    [{ code: 'EACCES' }, 'permission_denied'],
    [{ name: 'AccessDenied' }, 'access_denied'],
    [{ $metadata: { httpStatusCode: 403 } }, 'access_denied'],
    [{ status: 401 }, 'unauthorized'],
    [{ code: 'ETIMEDOUT' }, 'timeout'],
    [{ code: 'ECONNREFUSED' }, 'connection_failed'],
    [{ code: 'ENOSPC' }, 'no_space'],
    [{ code: 'EROFS' }, 'read_only'],
    [{ statusCode: 503 }, 'server_error'],
    [{ statusCode: 429 }, 'client_error'],
    [{}, 'unknown_error'],
  ];

  for (const [error, expected] of cases) {
    assert.equal(reasonOfError(error), expected, JSON.stringify(error));
  }
});

test('treats only real misses as expected', () => {
  assert.equal(isExpectedMiss({ code: 'ENOENT' }), true);
  assert.equal(isExpectedMiss({ status: 404 }), true);
  assert.equal(isExpectedMiss({ code: 'EACCES' }), false);
  assert.equal(isExpectedMiss({ statusCode: 500 }), false);
});

test('reads a package name from a tarball URL or gives up', () => {
  assert.equal(
    packageNameFromUrl('https://registry.npmjs.org/is-odd/-/is-odd-3.0.1.tgz'),
    'is-odd',
  );
  assert.equal(
    packageNameFromUrl('https://registry.npmjs.org/@whs%2fexample/-/example-1.0.0.tgz'),
    '@whs/example',
  );
  assert.equal(packageNameFromUrl('not a url'), undefined);
  assert.equal(packageNameFromUrl(undefined), undefined);
  assert.equal(packageNameFromUrl('https://registry.npmjs.org/-/is-odd.tgz'), undefined);
  // 잘못 인코딩된 경로는 이름만 생략한다. 예외를 던지면 Tarball 요청이 깨진다.
  assert.equal(packageNameFromUrl('https://registry.npmjs.org/bad%ZZ/-/bad-1.0.0.tgz'), undefined);
  assert.equal(packageNameFromUrl('https://registry.npmjs.org/%E0%A4%A/-/x-1.0.0.tgz'), undefined);
});

test('does not break the tarball request when the URL is badly encoded', () => {
  const stream = new EventEmitter();
  const { storage, events, calls } = setup({ fetchStream: stream });

  const returned = storage.uplinks.npmjs.fetchTarball('https://registry.npmjs.org/bad%ZZ/-/bad-1.0.0.tgz');

  assert.equal(returned, stream);
  assert.equal(calls.fetchTarball, 1);

  stream.emit('error', Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));

  // Event 는 남기되 Package 이름만 생략한다.
  assert.equal(events().length, 1);
  assert.equal(events()[0].event.packageName, undefined);
  assert.equal(events()[0].event.reason, 'connection_failed');
});
