'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const createWhsIntegrityMiddleware = require('..');

const ENDPOINT = '/-/whs/integrity/checks';
const ADMIN = { name: 'admin', groups: ['admin', '$all', '$authenticated'] };
const ANONYMOUS = { groups: ['$all', '$anonymous', '@all', '@anonymous'] };
const STORAGE = { marker: 'storage' };
const JWT = 'jwt-value-that-must-not-be-logged';

// 거부가 빠지면 두 번째 실행이 첫 실행을 기다리며 멈춘다. 멈춘 채 Test 가 취소되지
// 않고 바로 실패하도록, 짧게 기다려 그때까지의 결과를 돌려준다.
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

  return {
    entries,
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
  };
}

function register({ config = { endpoint: ENDPOINT }, verify, logger } = {}) {
  let handler;
  let path;
  const plugin = createWhsIntegrityMiddleware(config, {
    logger: logger ?? createLogger(),
    verify: verify ?? (async (_storage, target) => ({ status: 'PASS', ...target })),
  });
  plugin.register_middlewares(
    {
      post(routePath, routeHandler) {
        path = routePath;
        handler = routeHandler;
      },
    },
    undefined,
    STORAGE,
  );

  return { handler, path, plugin };
}

function checkRequest({ user = ADMIN, packages = [{ packageName: 'is-odd', version: '3.0.1' }] } = {}) {
  return {
    remote_user: user,
    headers: { authorization: `Bearer ${JWT}` },
    body: { packages },
  };
}

test('exports a Verdaccio plugin factory and keeps the verification helpers', () => {
  assert.equal(typeof createWhsIntegrityMiddleware, 'function');
  assert.equal(typeof createWhsIntegrityMiddleware.verifyTarball, 'function');
  assert.equal(typeof createWhsIntegrityMiddleware.parseSri, 'function');
});

test('registers the check endpoint from config', () => {
  const { path, handler } = register();

  assert.equal(path, ENDPOINT);
  assert.equal(typeof handler, 'function');
});

test('disables the API and warns when no endpoint is configured', () => {
  const logger = createLogger();
  const { handler } = register({ config: {}, logger });

  assert.equal(handler, undefined);
  assert.equal(
    logger.entries.some((entry) =>
      entry.level === 'warn' && String(entry.payload).includes('endpoint is not configured')),
    true,
  );
});

test('rejects an anonymous request before reading the body or storage', async () => {
  let verified = 0;
  const { handler } = register({
    verify: async () => {
      verified += 1;
      return { status: 'PASS' };
    },
  });
  const request = { remote_user: ANONYMOUS, headers: {} };
  Object.defineProperty(request, 'body', {
    get() {
      assert.fail('an unauthenticated request body must not be read');
    },
  });
  const response = createResponse();

  await handler(request, response);

  assert.equal(response.statusCode, 401);
  assert.deepEqual(response.body, { error: 'authentication required' });
  assert.equal(verified, 0);
});

test('rejects logged in accounts other than admin', async () => {
  for (const name of ['whs-ci', 'developer']) {
    let verified = 0;
    const { handler } = register({
      verify: async () => {
        verified += 1;
        return { status: 'PASS' };
      },
    });
    const response = createResponse();

    await handler(checkRequest({ user: { name } }), response);

    assert.equal(response.statusCode, 403, name);
    assert.deepEqual(response.body, { error: 'admin permission required' });
    assert.equal(verified, 0, name);
  }
});

test('rejects an invalid request body from admin', async () => {
  const { handler } = register();
  const response = createResponse();

  await handler(checkRequest({ packages: [] }), response);

  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.body, { error: 'packages must be a non-empty array' });
});

test('rejects invalid JSON sent as a raw stream', async () => {
  const { handler } = register();
  const response = createResponse();
  const request = {
    remote_user: ADMIN,
    headers: {},
    async *[Symbol.asyncIterator]() {
      yield '{not json';
    },
  };

  await handler(request, response);

  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.body, { error: 'request body must contain valid JSON' });
});

test('runs the check for admin and returns the results in order', async () => {
  const received = [];
  const { handler } = register({
    verify: async (storage, target) => {
      received.push({ storage, target });
      return target.packageName === 'bad'
        ? { status: 'FAIL', ...target, reason: 'INTEGRITY_MISMATCH' }
        : { status: 'PASS', ...target };
    },
  });
  const response = createResponse();

  await handler(checkRequest({
    packages: [
      { packageName: 'good', version: '1.0.0' },
      { packageName: 'bad', version: '1.0.0' },
      { packageName: 'good', version: '1.0.0' },
    ],
  }), response);

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, {
    status: 'COMPLETED',
    count: 2,
    results: [
      { status: 'PASS', packageName: 'good', version: '1.0.0' },
      { status: 'FAIL', packageName: 'bad', version: '1.0.0', reason: 'INTEGRITY_MISMATCH' },
    ],
  });
  // FAIL 이 섞여도 요청 자체는 성공이다.
  assert.equal(received.length, 2);
  assert.equal(received[0].storage, STORAGE);
});

test('answers 409 while another check is running', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { handler } = register({
    verify: async (_storage, target) => {
      await gate;
      return { status: 'PASS', ...target };
    },
  });

  const firstResponse = createResponse();
  const first = handler(checkRequest(), firstResponse);
  // 첫 요청이 본문을 읽고 검사를 시작할 때까지 한 번 넘긴다.
  await new Promise((resolve) => setImmediate(resolve));

  const secondResponse = createResponse();
  try {
    await settleWithin(handler(checkRequest(), secondResponse), 100);

    assert.equal(secondResponse.statusCode, 409);
    assert.deepEqual(secondResponse.body, { error: 'integrity check already running' });
  } finally {
    release();
  }

  await first;
  assert.equal(firstResponse.statusCode, 200);
});

test('logs the account and counts but never the credential or hashes', async () => {
  const logger = createLogger();
  const { handler } = register({
    logger,
    verify: async (_storage, target) => ({
      status: 'PASS',
      ...target,
      expected: 'sha512-expected-hash-value',
      actual: 'sha512-expected-hash-value',
    }),
  });
  const response = createResponse();

  await handler(checkRequest(), response);
  await handler(checkRequest({ user: { name: 'developer' } }), createResponse());

  const logged = JSON.stringify(logger.entries);
  assert.equal(logged.includes(JWT), false);
  assert.equal(logged.includes('sha512-expected-hash-value'), false);

  const finished = logger.entries.find((entry) => entry.level === 'info');
  assert.deepEqual(finished.payload, {
    user: 'admin',
    source: 'manual',
    total: 1,
    pass: 1,
    fail: 0,
    unverifiable: 0,
  });

  const rejected = logger.entries.find(
    (entry) => entry.level === 'warn' && typeof entry.payload === 'object',
  );
  assert.deepEqual(rejected.payload, { user: 'developer', statusCode: 403 });
});

test('keeps answering when every logger method throws', async () => {
  const broken = {
    info() { throw new Error('logger down'); },
    warn() { throw new Error('logger down'); },
    error() { throw new Error('logger down'); },
  };
  const { handler } = register({ logger: broken });

  const accepted = createResponse();
  await handler(checkRequest(), accepted);
  assert.equal(accepted.statusCode, 200);

  const rejected = createResponse();
  await handler(checkRequest({ user: ANONYMOUS }), rejected);
  assert.equal(rejected.statusCode, 401);
});

test('honors a configured list of allowed accounts', async () => {
  const { handler } = register({
    config: { endpoint: ENDPOINT, allowed_users: ['ops'] },
  });

  const asAdmin = createResponse();
  await handler(checkRequest(), asAdmin);
  assert.equal(asAdmin.statusCode, 403);

  const asOps = createResponse();
  await handler(checkRequest({ user: { name: 'ops' } }), asOps);
  assert.equal(asOps.statusCode, 200);
});

test('logs each problem of a manual check without hashes or details', async () => {
  const logger = createLogger();
  const { handler } = register({
    logger,
    verify: async (_storage, target) => (target.packageName === 'is-odd'
      ? {
          status: 'FAIL',
          ...target,
          reason: 'INTEGRITY_MISMATCH',
          expected: 'sha512-expected-hash-value',
          actual: 'sha512-actual-hash-value',
          detail: 'must not be logged',
        }
      : { status: 'PASS', ...target, expected: 'sha512-expected-hash-value' }),
  });
  const response = createResponse();

  await handler(checkRequest({
    packages: [
      { packageName: 'is-odd', version: '3.0.1' },
      { packageName: 'is-even', version: '1.0.0' },
    ],
  }), response);

  // 관리자에게 가는 응답에는 Hash 가 그대로 있다.
  assert.equal(response.body.results[0].expected, 'sha512-expected-hash-value');

  // PASS 는 남기지 않고, 문제 항목만 요청한 계정과 함께 남긴다.
  const problems = logger.entries
    .filter((entry) => entry.message?.includes('integrity check problem'))
    .map((entry) => ({ level: entry.level, payload: entry.payload }));
  assert.deepEqual(problems, [{
    level: 'warn',
    payload: {
      user: 'admin',
      source: 'manual',
      status: 'FAIL',
      packageName: 'is-odd',
      version: '3.0.1',
      reason: 'INTEGRITY_MISMATCH',
    },
  }]);

  const logged = JSON.stringify(logger.entries);
  assert.equal(logged.includes('sha512-'), false);
  assert.equal(logged.includes('must not be logged'), false);

  // 문제가 있으면 요약도 warn 으로 올라간다.
  const finished = logger.entries.find((entry) => entry.message?.includes('integrity check finished'));
  assert.equal(finished.level, 'warn');
});

test('keeps the manual summary at info when every target passes', async () => {
  const logger = createLogger();
  const { handler } = register({ logger });

  await handler(checkRequest(), createResponse());

  const finished = logger.entries.find((entry) => entry.message?.includes('integrity check finished'));
  assert.equal(finished.level, 'info');
  assert.equal(
    logger.entries.some((entry) => entry.message?.includes('integrity check problem')),
    false,
  );
});
