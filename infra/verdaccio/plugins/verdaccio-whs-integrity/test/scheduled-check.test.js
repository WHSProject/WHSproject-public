'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const createWhsIntegrityMiddleware = require('..');

const ENDPOINT = '/-/whs/integrity/checks';
const ADMIN = { name: 'admin', groups: ['admin', '$all', '$authenticated'] };

// 멈춘 채 Test 가 취소되지 않고 바로 실패하도록, 짧게 기다려 그때까지의 결과를 돌려준다.
function settleWithin(promise, ms) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve('still running'), ms);
  });
  return Promise.race([
    promise.then(() => 'resolved', (error) => error),
    timeout,
  ]).finally(() => clearTimeout(timer));
}

function createResponse() {
  return {
    statusCode: undefined,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

function createLogger() {
  const entries = [];
  const record = (level) => (payload, message) => {
    entries.push({ level, payload, message });
  };
  return { entries, info: record('info'), warn: record('warn'), error: record('error') };
}

function createTimers() {
  const timers = {
    intervals: [],
    setInterval(fn, ms) {
      const handle = { fn, ms, unref() {} };
      timers.intervals.push(handle);
      return handle;
    },
    clearInterval() {},
  };
  return timers;
}

function checkRequest() {
  return {
    remote_user: ADMIN,
    headers: {},
    body: { packages: [{ packageName: 'is-odd', version: '3.0.1' }] },
  };
}

// Verdaccio 기본 로컬 저장소 Plugin 과 같은 Class 이름을 쓴다.
class LocalDatabase {
  constructor(names) {
    this.names = names;
  }

  search(onPackage, onEnd) {
    (async () => {
      for (const name of this.names) {
        await new Promise((resolve) => onPackage({ name }, resolve));
      }
      onEnd(null);
    })();
  }
}

// 캐시된 is-odd 3.0.1 과 @whs/example 1.0.0 이 있고, is-odd 3.0.0 은 Metadata 에만 있다.
function createCachedStorage() {
  const tarballOf = (name, version) =>
    `https://registry.npmjs.org/${name}/-/${name.split('/').pop()}-${version}.tgz`;
  const packuments = {
    'is-odd': {
      versions: {
        '3.0.0': { dist: { tarball: tarballOf('is-odd', '3.0.0') } },
        '3.0.1': { dist: { tarball: tarballOf('is-odd', '3.0.1') } },
      },
    },
    '@whs/example': {
      versions: { '1.0.0': { dist: { tarball: tarballOf('@whs/example', '1.0.0') } } },
    },
  };
  const stored = new Set(['is-odd/is-odd-3.0.1.tgz', '@whs/example/example-1.0.0.tgz']);

  return {
    localStorage: { storagePlugin: new LocalDatabase(Object.keys(packuments)) },
    getPackage({ name, callback }) {
      callback(null, packuments[name]);
    },
    async hasLocalTarball(name, file) {
      return stored.has(`${name}/${file}`);
    },
  };
}

function registerScheduled({
  config = { endpoint: ENDPOINT, check_interval_seconds: 3600 },
  storage = createCachedStorage(),
  verify = async (_storage, target) => ({ status: 'PASS', ...target }),
  logger = createLogger(),
  timers = createTimers(),
} = {}) {
  let handler;
  const plugin = createWhsIntegrityMiddleware(config, { logger, verify, timers });
  plugin.register_middlewares(
    {
      post(_path, routeHandler) {
        handler = routeHandler;
      },
    },
    undefined,
    storage,
  );
  return { plugin, handler, logger, timers };
}

function messages(logger, level) {
  return logger.entries
    .filter((entry) => entry.level === level)
    .map((entry) => (typeof entry.payload === 'string' ? entry.payload : entry.message));
}

test('schedules nothing when no interval is configured', () => {
  const { timers, plugin } = registerScheduled({ config: { endpoint: ENDPOINT } });

  assert.equal(timers.intervals.length, 0);
  assert.equal(plugin.scheduler, undefined);
});

test('warns and stays off for an interval it cannot use', () => {
  const { timers, logger } = registerScheduled({
    config: { endpoint: ENDPOINT, check_interval_seconds: 30 },
  });

  assert.equal(timers.intervals.length, 0);
  assert.equal(
    messages(logger, 'warn').some((text) => text.includes('check_interval_seconds')),
    true,
  );
});

test('warns and stays off when cached packages cannot be listed', () => {
  const { timers, logger, handler } = registerScheduled({ storage: {} });

  assert.equal(timers.intervals.length, 0);
  assert.equal(
    messages(logger, 'warn').some((text) => text.includes('cannot list cached packages')),
    true,
  );
  // 수동 검사 API 는 그대로 열려 있다.
  assert.equal(typeof handler, 'function');
});

test('runs the scheduled check even when the manual API is not configured', () => {
  const { timers, handler } = registerScheduled({
    config: { check_interval_seconds: 3600 },
  });

  assert.equal(handler, undefined);
  assert.equal(timers.intervals.length, 1);
});

test('waits one interval before the first scheduled check', () => {
  let verified = 0;
  const { timers } = registerScheduled({
    verify: async () => {
      verified += 1;
      return { status: 'PASS' };
    },
  });

  assert.equal(timers.intervals.length, 1);
  assert.equal(timers.intervals[0].ms, 3600 * 1000);
  assert.equal(verified, 0);
});

test('checks only stored versions and logs counts and problems without hashes', async () => {
  const checked = [];
  const { plugin, logger } = registerScheduled({
    verify: async (_storage, target) => {
      checked.push(`${target.packageName}@${target.version}`);
      return target.packageName === 'is-odd'
        ? {
            status: 'FAIL',
            ...target,
            reason: 'INTEGRITY_MISMATCH',
            expected: 'sha512-expected-hash-value',
            actual: 'sha512-actual-hash-value',
            detail: 'must not be logged',
          }
        : { status: 'PASS', ...target, expected: 'sha512-expected-hash-value' };
    },
  });

  await plugin.scheduler.tick();

  // Metadata 에만 있는 is-odd 3.0.0 은 검사하지 않는다.
  assert.deepEqual(checked, ['@whs/example@1.0.0', 'is-odd@3.0.1']);

  const finished = logger.entries.find(
    (entry) => entry.message?.includes('scheduled check finished'),
  );
  // 문제가 있으면 요약도 warn 으로 올라간다.
  assert.equal(finished.level, 'warn');
  assert.deepEqual(finished.payload, {
    source: 'scheduled',
    packages: 2,
    unreadablePackages: 0,
    skippedPackages: 0,
    total: 2,
    pass: 1,
    fail: 1,
    unverifiable: 0,
  });

  const problem = logger.entries.find(
    (entry) => entry.level === 'warn' && entry.message?.includes('integrity check problem'),
  );
  assert.deepEqual(problem.payload, {
    source: 'scheduled',
    status: 'FAIL',
    packageName: 'is-odd',
    version: '3.0.1',
    reason: 'INTEGRITY_MISMATCH',
  });

  const logged = JSON.stringify(logger.entries);
  assert.equal(logged.includes('sha512-'), false);
  assert.equal(logged.includes('must not be logged'), false);
});

test('skips a scheduled check while a manual check is running', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let verified = 0;
  const { plugin, handler, logger } = registerScheduled({
    verify: async (_storage, target) => {
      verified += 1;
      await gate;
      return { status: 'PASS', ...target };
    },
  });

  const manual = handler(checkRequest(), createResponse());
  await new Promise((resolve) => setImmediate(resolve));

  try {
    await settleWithin(plugin.scheduler.tick(), 100);

    assert.equal(verified, 1);
    assert.equal(
      messages(logger, 'info').some((text) => text.includes('scheduled check skipped')),
      true,
    );
  } finally {
    release();
  }

  await manual;
});

test('answers 409 to a manual check while a scheduled check runs', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let started = false;
  const { plugin, handler } = registerScheduled({
    verify: async (_storage, target) => {
      started = true;
      await gate;
      return { status: 'PASS', ...target };
    },
  });

  const scheduled = plugin.scheduler.tick();
  // 목록을 뽑고 첫 해싱에 들어갈 때까지 넘긴다.
  for (let i = 0; i < 20 && !started; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(started, true);

  const response = createResponse();
  try {
    await settleWithin(handler(checkRequest(), response), 100);

    assert.equal(response.statusCode, 409);
  } finally {
    release();
  }

  await scheduled;
});

test('logs a failed listing and leaves the next check free to run', async () => {
  const storage = createCachedStorage();
  storage.localStorage.storagePlugin.search = (_onPackage, onEnd) => onEnd(new Error('disk gone'));
  const { plugin, logger, handler } = registerScheduled({ storage });

  await plugin.scheduler.tick();

  assert.equal(
    messages(logger, 'error').some((text) => text.includes('failed to list cached packages')),
    true,
  );

  const response = createResponse();
  await handler(checkRequest(), response);
  assert.equal(response.statusCode, 200);
});

test('warns and stays off on a storage plugin whose listing misses cached packages', () => {
  class S3Database {
    search(_onPackage, onEnd) {
      onEnd(null);
    }
  }
  const storage = createCachedStorage();
  storage.localStorage.storagePlugin = new S3Database();
  const { timers, logger, handler } = registerScheduled({ storage });

  assert.equal(timers.intervals.length, 0);
  const warned = logger.entries.find(
    (entry) => entry.level === 'warn' && entry.message?.includes('cannot list cached packages'),
  );
  assert.deepEqual(warned.payload, { storagePlugin: 'S3Database' });
  // 수동 검사 API 는 저장소와 상관없이 열려 있다.
  assert.equal(typeof handler, 'function');
});

test('names the cache lister when the scheduled check is enabled', () => {
  const { logger } = registerScheduled();

  const enabled = logger.entries.find((entry) => entry.message?.includes('scheduled check enabled'));
  assert.deepEqual(enabled.payload, { intervalSeconds: 3600, cacheLister: 'local-storage' });
});

test('turns the scheduled check on for the S3 storage plugin that can list its bucket', () => {
  // verdaccio-aws-s3-storage 의 Class 이름과 목록 조회에 쓰는 속성만 흉내 낸다.
  class S3Database {
    constructor() {
      this.config = { bucket: 'whs-cache', keyPrefix: 'verdaccio/' };
      this.s3 = { send: async () => ({ Contents: [] }) };
    }

    search(_onPackage, onEnd) {
      onEnd(null);
    }
  }
  const storage = createCachedStorage();
  storage.localStorage.storagePlugin = new S3Database();
  const { timers, logger } = registerScheduled({ storage });

  assert.equal(timers.intervals.length, 1);
  const enabled = logger.entries.find((entry) => entry.message?.includes('scheduled check enabled'));
  assert.deepEqual(enabled.payload, { intervalSeconds: 3600, cacheLister: 'aws-s3-storage' });
});
