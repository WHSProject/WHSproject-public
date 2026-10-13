'use strict';

const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const test = require('node:test');

const createWhsApprovalMiddleware = require('..');
const { DEFAULT_TTL_SECONDS } = require('../src/approval-store');

const TEST_SERVICE_TOKEN = 'test-only-service-token';
process.env.WHS_APPROVAL_SERVICE_TOKEN = TEST_SERVICE_TOKEN;

const quietLogger = {
  info() {},
  warn() {},
  error() {},
};

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

function withServiceAuthentication(handler) {
  return (request, response) => {
    request.headers = {
      ...request.headers,
      authorization: `Bearer ${TEST_SERVICE_TOKEN}`,
    };
    return handler(request, response);
  };
}

function createStorage({
  integrity = 'sha512-approved',
  tarballError,
  // 준비를 시작하기 전에 이미 Cache 에 있는지. 기본값은 최초 등록 상황이다.
  cachedBefore = false,
} = {}) {
  const tarballCalls = [];

  return {
    tarballCalls,
    getPackage({ name, callback }) {
      callback(null, {
        name,
        versions: {
          '5.2.1': {
            name,
            version: '5.2.1',
            dist: {
              integrity,
              tarball: `https://registry.npmjs.org/${name}/-/${name}-5.2.1.tgz`,
            },
          },
        },
      });
    },
    getTarball(packageName, filename) {
      tarballCalls.push({ packageName, filename });
      if (tarballError !== undefined) {
        return Readable.from(
          (async function* streamFailure() {
            throw tarballError;
          })(),
        );
      }

      return Readable.from(['tarball']);
    },
    async hasLocalTarball() {
      // 내려받기 전의 확인은 사전 Cache 확인이다.
      return tarballCalls.length === 0 ? cachedBefore : true;
    },
  };
}

test('loads through the CommonJS factory used by Verdaccio', () => {
  const plugin = createWhsApprovalMiddleware(
    { endpoint: '/-/whs/approvals' },
    { logger: quietLogger },
  );

  assert.equal(typeof plugin.register_middlewares, 'function');
});

test('keeps the approval API and skips the guard when guard_enabled is false', () => {
  let routeRegistered = false;
  let guardRegistered = false;
  const app = {
    post(path) {
      assert.equal(path, '/-/whs/approvals');
      routeRegistered = true;
    },
    use() {
      guardRegistered = true;
    },
  };
  const plugin = createWhsApprovalMiddleware(
    { endpoint: '/-/whs/approvals', guard_enabled: false },
    { logger: quietLogger },
  );

  plugin.register_middlewares(app, undefined, createStorage());

  assert.equal(routeRegistered, true);
  assert.equal(guardRegistered, false);
});

test('registers the guard by default', () => {
  let guardRegistered = false;
  const app = {
    post() {},
    use(handler) {
      assert.equal(typeof handler, 'function');
      guardRegistered = true;
    },
  };
  const plugin = createWhsApprovalMiddleware(
    { endpoint: '/-/whs/approvals' },
    { logger: quietLogger },
  );

  plugin.register_middlewares(app, undefined, createStorage());

  assert.equal(guardRegistered, true);
});

test('lists active approvals without exposing integrity or filename', () => {
  let getHandler;
  const plugin = createWhsApprovalMiddleware(
    { endpoint: '/-/whs/approvals' },
    { logger: quietLogger, now: () => Date.UTC(2026, 8, 10, 12, 0, 0) },
  );
  plugin.register_middlewares(
    {
      post() {},
      get(path, handler) {
        assert.equal(path, '/-/whs/approvals');
        getHandler = handler;
      },
      delete() {},
    },
    undefined,
    createStorage(),
  );
  plugin.approvals.register([{
    packageName: '@whs/internal',
    version: '1.0.0',
    integrity: 'sha512-secret-integrity',
    filename: 'internal-1.0.0.tgz',
  }]);

  const response = createResponse();
  getHandler({ headers: authHeaders() }, response);

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.status, 'OK');
  assert.equal(response.body.count, 1);
  assert.deepEqual(Object.keys(response.body.approvals[0]), [
    'packageName',
    'version',
    'registeredAt',
    'expiresAt',
  ]);
  assert.equal(JSON.stringify(response.body).includes('sha512-secret-integrity'), false);
  assert.equal(JSON.stringify(response.body).includes('internal-1.0.0.tgz'), false);
});

test('revokes a package version and blocks it in the guard immediately', async () => {
  let deleteHandler;
  let guard;
  const plugin = createWhsApprovalMiddleware(
    { endpoint: '/-/whs/approvals' },
    { logger: quietLogger },
  );
  plugin.register_middlewares(
    {
      post() {},
      get() {},
      delete(path, handler) {
        assert.equal(path, '/-/whs/approvals');
        deleteHandler = handler;
      },
      use(handler) {
        guard = handler;
      },
    },
    undefined,
    createStorage(),
  );
  plugin.approvals.register([{
    packageName: '@whs/internal',
    version: '1.0.0',
    integrity: 'sha512-approved',
    filename: 'internal-1.0.0.tgz',
  }]);

  const revoked = createResponse();
  deleteHandler({
    headers: authHeaders(),
    query: { packageName: '@whs/internal', version: '1.0.0' },
  }, revoked);

  // 제거된 개수는 응답에 넣지 않는다. 성공 여부는 200 / 404 로만 알린다.
  assert.deepEqual(revoked.body, {
    status: 'REVOKED',
    packageName: '@whs/internal',
    version: '1.0.0',
  });

  const blocked = createResponse();
  await guard(
    { method: 'GET', path: '/@whs/internal/1.0.0', headers: {} },
    blocked,
    () => assert.fail('revoked approval must not reach the registry'),
  );
  assert.equal(blocked.statusCode, 403);
});

test('warns when one version had more than one active approval', () => {
  // Integrity 충돌 차단은 같은 Package + 파일명만 본다. 파일명까지 다르면
  // 한 Version 에 Approval 이 여럿 남을 수 있고, 그건 정상 상태가 아니다.
  let deleteHandler;
  const logger = createRecordingLogger();
  const plugin = createWhsApprovalMiddleware(
    { endpoint: '/-/whs/approvals' },
    { logger },
  );
  plugin.register_middlewares(
    { post() {}, get() {}, delete(_path, handler) { deleteHandler = handler; } },
    undefined,
    createStorage(),
  );
  plugin.approvals.register([
    {
      packageName: 'express',
      version: '5.1.0',
      integrity: 'sha512-one',
      filename: 'express-5.1.0.tgz',
    },
    {
      packageName: 'express',
      version: '5.1.0',
      integrity: 'sha512-two',
      filename: 'express-5.1.0-other.tgz',
    },
  ]);

  const response = createResponse();
  deleteHandler({
    headers: authHeaders(),
    query: { packageName: 'express', version: '5.1.0' },
  }, response);

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, {
    status: 'REVOKED',
    packageName: 'express',
    version: '5.1.0',
  });
  assert.equal(plugin.approvals.size, 0);

  const warned = logger.entries.find(
    (entry) => entry.level === 'warn' && typeof entry.payload === 'object',
  );
  assert.ok(warned, '비정상 상태는 로그에 남아야 한다');
  assert.equal(warned.payload.revokedCount, 2);
});

test('validates approval revoke queries and returns 404 for an unknown target', () => {
  let deleteHandler;
  const plugin = createWhsApprovalMiddleware(
    { endpoint: '/-/whs/approvals' },
    { logger: quietLogger },
  );
  plugin.register_middlewares(
    {
      post() {},
      get() {},
      delete(_path, handler) {
        deleteHandler = handler;
      },
    },
    undefined,
    createStorage(),
  );

  const invalid = createResponse();
  deleteHandler({ headers: authHeaders(), query: { packageName: 'express' } }, invalid);
  assert.equal(invalid.statusCode, 400);

  const unknown = createResponse();
  deleteHandler({
    headers: authHeaders(),
    query: { packageName: 'express', version: '5.2.1' },
  }, unknown);
  assert.equal(unknown.statusCode, 404);
});

test('registers the configured endpoint and returns an ACK', async () => {
  let handler;
  let logContext;
  const app = {
    post(path, routeHandler) {
      assert.equal(path, '/-/whs/approvals');
      handler = withServiceAuthentication(routeHandler);
    },
  };
  const plugin = createWhsApprovalMiddleware(
    { endpoint: '/-/whs/approvals' },
    {
      logger: {
        info(context) {
          logContext = context;
        },
      },
    },
  );

  plugin.register_middlewares(app, undefined, createStorage());

  const response = createResponse();
  await handler(
    {
      body: {
        requestId: 'req-123',
        packages: [
          {
            packageName: 'express',
            version: '5.2.1',
            integrity: 'sha512-approved',
          },
        ],
      },
    },
    response,
  );

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, {
    requestId: 'req-123',
    status: 'REGISTERED',
    packageCount: 1,
  });
  assert.equal(plugin.approvals.size, 1);
  assert.deepEqual(logContext, { requestId: 'req-123', packageCount: 1 });
});

test('authenticates before reading the body or accessing package storage', async () => {
  let handler;
  let packageReads = 0;
  const app = {
    post(_path, routeHandler) {
      handler = routeHandler;
    },
  };
  const plugin = createWhsApprovalMiddleware(
    { endpoint: '/-/whs/approvals' },
    {
      logger: quietLogger,
      environment: { WHS_APPROVAL_SERVICE_TOKEN: TEST_SERVICE_TOKEN },
    },
  );
  plugin.register_middlewares(app, undefined, {
    getPackage() {
      packageReads += 1;
    },
  });
  const request = { headers: {} };
  Object.defineProperty(request, 'body', {
    get() {
      assert.fail('an unauthorized request body must not be read');
    },
  });
  const response = createResponse();

  await handler(request, response);

  assert.equal(response.statusCode, 401);
  assert.deepEqual(response.body, { error: 'unauthorized service request' });
  assert.equal(packageReads, 0);
  assert.equal(plugin.approvals.size, 0);
});

test('rejects list and revoke requests that carry no service token', async () => {
  let getHandler;
  let deleteHandler;
  const plugin = createWhsApprovalMiddleware(
    { endpoint: '/-/whs/approvals' },
    { logger: quietLogger },
  );
  plugin.register_middlewares(
    {
      post() {},
      get(_path, handler) { getHandler = handler; },
      delete(_path, handler) { deleteHandler = handler; },
    },
    undefined,
    createStorage(),
  );
  plugin.approvals.register([{
    packageName: '@whs/internal',
    version: '1.0.0',
    integrity: 'sha512-approved',
    filename: 'internal-1.0.0.tgz',
  }]);

  const listed = createResponse();
  await getHandler({ headers: {} }, listed);

  assert.equal(listed.statusCode, 401);
  assert.deepEqual(listed.body, { error: 'unauthorized service request' });
  // 승인 목록이 응답에 실리면 안 된다.
  assert.equal(JSON.stringify(listed.body).includes('@whs/internal'), false);

  const revoked = createResponse();
  await deleteHandler({
    headers: {},
    query: { packageName: '@whs/internal', version: '1.0.0' },
  }, revoked);

  assert.equal(revoked.statusCode, 401);
  assert.deepEqual(revoked.body, { error: 'unauthorized service request' });
  // 미인증 요청이 승인 상태를 바꾸지 않아야 한다.
  assert.equal(plugin.approvals.size, 1);
});

test('serves all approval APIs without a token while service auth is disabled', async () => {
  // Gateway 연동 전 임시 상태. 인증이 꺼져 있으면 기존 동작과 같아야 한다.
  let postHandler;
  let getHandler;
  let deleteHandler;
  const plugin = createWhsApprovalMiddleware(
    { endpoint: '/-/whs/approvals', service_auth_enabled: false },
    { logger: quietLogger, environment: {} },
  );
  plugin.register_middlewares(
    {
      post(_path, handler) { postHandler = handler; },
      get(_path, handler) { getHandler = handler; },
      delete(_path, handler) { deleteHandler = handler; },
    },
    undefined,
    createStorage(),
  );

  const posted = createResponse();
  await postHandler({ headers: {}, body: { requestId: 'req-open', packages: [] } }, posted);
  assert.equal(posted.statusCode, 400);

  const listed = createResponse();
  await getHandler({ headers: {} }, listed);
  assert.equal(listed.statusCode, 200);

  const revoked = createResponse();
  await deleteHandler({
    headers: {},
    query: { packageName: 'express', version: '5.1.0' },
  }, revoked);
  assert.equal(revoked.statusCode, 404);
});

test('warns that service auth is disabled instead of the missing token', () => {
  const warnings = [];
  const plugin = createWhsApprovalMiddleware(
    { endpoint: '/-/whs/approvals', service_auth_enabled: false },
    {
      logger: { ...quietLogger, warn: (message) => warnings.push(message) },
      environment: {},
    },
  );

  plugin.register_middlewares({ post() {} }, undefined, createStorage());

  const text = warnings.filter((message) => typeof message === 'string').join(' ');
  assert.equal(text.includes('service auth is disabled'), true);
  // 꺼져 있으면 Token 이 없어도 요청이 막히지 않으므로 그 경고는 틀린 안내가 된다.
  assert.equal(text.includes('WHS_APPROVAL_SERVICE_TOKEN is not set'), false);
});

test('keeps service auth on unless the setting is the boolean false', async () => {
  // 생략하거나 문자열 'false' 를 넣어도 켜진 채로 남는다. guard_enabled 와 같다.
  for (const config of [{}, { service_auth_enabled: 'false' }, { service_auth_enabled: true }]) {
    let getHandler;
    const plugin = createWhsApprovalMiddleware(
      { endpoint: '/-/whs/approvals', ...config },
      { logger: quietLogger },
    );
    plugin.register_middlewares(
      { post() {}, get(_path, handler) { getHandler = handler; }, delete() {} },
      undefined,
      createStorage(),
    );

    const response = createResponse();
    await getHandler({ headers: {} }, response);
    assert.equal(response.statusCode, 401, JSON.stringify(config));
  }
});

test('warns at startup when the service token is not configured', () => {
  // Registry 와 Healthcheck 는 정상이라, 경고가 없으면 첫 승인 등록이 실패할 때까지
  // 원인이 드러나지 않는다.
  const warnings = [];
  const plugin = createWhsApprovalMiddleware(
    { endpoint: '/-/whs/approvals' },
    {
      logger: { ...quietLogger, warn: (message) => warnings.push(message) },
      environment: {},
    },
  );

  plugin.register_middlewares({ post() {} }, undefined, createStorage());

  assert.equal(
    warnings.some((message) =>
      typeof message === 'string' &&
      message.includes('WHS_APPROVAL_SERVICE_TOKEN')),
    true,
  );
});

test('fails closed when the service token environment variable is unset', async () => {
  let handler;
  const app = {
    post(_path, routeHandler) {
      handler = routeHandler;
    },
  };
  const plugin = createWhsApprovalMiddleware(
    { endpoint: '/-/whs/approvals' },
    { logger: quietLogger, environment: {} },
  );
  plugin.register_middlewares(app, undefined, createStorage());
  const response = createResponse();

  await handler({
    headers: { authorization: `Bearer ${TEST_SERVICE_TOKEN}` },
    body: { requestId: 'must-not-run', packages: [] },
  }, response);

  assert.equal(response.statusCode, 401);
  assert.deepEqual(response.body, { error: 'unauthorized service request' });
});

test('reads an HTTP JSON stream and returns an ACK', async () => {
  let handler;
  const app = {
    post(_path, routeHandler) {
      handler = withServiceAuthentication(routeHandler);
    },
  };
  const plugin = createWhsApprovalMiddleware(
    { endpoint: '/-/whs/approvals' },
    { logger: quietLogger },
  );
  plugin.register_middlewares(app, undefined, createStorage());

  const request = Readable.from([
    JSON.stringify({
      requestId: 'req-stream',
      packages: [
        {
          packageName: 'express',
          version: '5.2.1',
          integrity: 'sha512-approved',
        },
      ],
    }),
  ]);
  const response = createResponse();

  await handler(request, response);

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.status, 'REGISTERED');
  assert.equal(plugin.approvals.size, 1);
});

test('returns 400 for malformed JSON', async () => {
  let handler;
  const app = {
    post(_path, routeHandler) {
      handler = withServiceAuthentication(routeHandler);
    },
  };
  const plugin = createWhsApprovalMiddleware({ endpoint: '/-/whs/approvals' });
  plugin.register_middlewares(app);

  const response = createResponse();
  await handler(Readable.from(['{"requestId":']), response);

  assert.equal(response.statusCode, 400);
  assert.match(response.body.error, /valid JSON/);
});

test('returns 400 for an invalid approval request', async () => {
  let handler;
  const app = {
    post(_path, routeHandler) {
      handler = withServiceAuthentication(routeHandler);
    },
  };
  const plugin = createWhsApprovalMiddleware({ endpoint: '/-/whs/approvals' });
  plugin.register_middlewares(app);

  const response = createResponse();
  await handler({ body: { requestId: 'req-123', packages: [] } }, response);

  assert.equal(response.statusCode, 400);
  assert.match(response.body.error, /packages/);
});

test('returns 403 and does not approve a package with mismatched integrity', async () => {
  let handler;
  const app = {
    post(_path, routeHandler) {
      handler = withServiceAuthentication(routeHandler);
    },
  };
  const plugin = createWhsApprovalMiddleware(
    { endpoint: '/-/whs/approvals' },
    { logger: quietLogger },
  );
  plugin.register_middlewares(
    app,
    undefined,
    createStorage({ integrity: 'sha512-different' }),
  );

  const response = createResponse();
  await handler(
    {
      body: {
        requestId: 'req-mismatch',
        packages: [
          {
            packageName: 'express',
            version: '5.2.1',
            integrity: 'sha512-approved',
          },
        ],
      },
    },
    response,
  );

  assert.equal(response.statusCode, 403);
  assert.match(response.body.error, /integrity mismatch/);
  assert.equal(plugin.approvals.size, 0);
});

test('returns 500 and does not approve a package when tarball caching fails', async () => {
  let handler;
  const app = {
    post(_path, routeHandler) {
      handler = withServiceAuthentication(routeHandler);
    },
  };
  const plugin = createWhsApprovalMiddleware(
    { endpoint: '/-/whs/approvals' },
    { logger: quietLogger },
  );
  plugin.register_middlewares(
    app,
    undefined,
    createStorage({ tarballError: new Error('uplink unavailable') }),
  );

  const response = createResponse();
  await handler(
    {
      body: {
        requestId: 'req-cache-failure',
        packages: [
          {
            packageName: 'express',
            version: '5.2.1',
            integrity: 'sha512-approved',
          },
        ],
      },
    },
    response,
  );

  assert.equal(response.statusCode, 500);
  assert.match(response.body.error, /failed to cache tarball/);
  assert.equal(plugin.approvals.size, 0);
});

test('does not register a route before the endpoint is decided', () => {
  let registered = false;
  const app = {
    post() {
      registered = true;
    },
  };
  const plugin = createWhsApprovalMiddleware({}, { logger: { warn() {} } });

  plugin.register_middlewares(app);

  assert.equal(registered, false);
});

// Gateway 요청과 Verdaccio 로그를 잇는 값은 requestId 뿐이다. 실패했을 때야말로
// 추적이 필요하므로 오류 응답 경로에서도 남는지 확인한다.
// 세 API 모두 서비스 인증을 요구한다.
function authHeaders() {
  return { authorization: `Bearer ${TEST_SERVICE_TOKEN}` };
}

function createRecordingLogger() {
  const entries = [];

  return {
    entries,
    info(payload, message) {
      entries.push({ level: 'info', payload, message });
    },
    warn(payload, message) {
      entries.push({ level: 'warn', payload, message });
    },
    error(payload, message) {
      entries.push({ level: 'error', payload, message });
    },
  };
}

test('logs requestId when an approval request is rejected as invalid', async () => {
  let handler;
  const app = {
    post(_path, routeHandler) {
      handler = withServiceAuthentication(routeHandler);
    },
  };
  const logger = createRecordingLogger();
  const plugin = createWhsApprovalMiddleware(
    { endpoint: '/-/whs/approvals' },
    { logger },
  );
  plugin.register_middlewares(app);

  const response = createResponse();
  await handler({ body: { requestId: 'req-400', packages: [] } }, response);

  assert.equal(response.statusCode, 400);
  // 기동 시 남는 설정 경고는 payload 가 문자열이다. 요청 로그만 고른다.
  const logged = logger.entries.find(
    (entry) => entry.level === 'warn' && typeof entry.payload === 'object',
  );
  assert.ok(logged, '400 응답에 로그가 남아야 한다');
  assert.equal(logged.payload.requestId, 'req-400');
});

test('logs requestId when an approval request is rejected as mismatched', async () => {
  let handler;
  const app = {
    post(_path, routeHandler) {
      handler = withServiceAuthentication(routeHandler);
    },
  };
  const logger = createRecordingLogger();
  const plugin = createWhsApprovalMiddleware(
    { endpoint: '/-/whs/approvals' },
    { logger },
  );
  plugin.register_middlewares(
    app,
    undefined,
    createStorage({ integrity: 'sha512-different' }),
  );

  const response = createResponse();
  await handler(
    {
      body: {
        requestId: 'req-403',
        packages: [
          { packageName: 'left-pad', version: '1.3.0', integrity: 'sha512-expected' },
        ],
      },
    },
    response,
  );

  assert.equal(response.statusCode, 403);
  // 기동 시 남는 설정 경고는 payload 가 문자열이다. 요청 로그만 고른다.
  const logged = logger.entries.find(
    (entry) => entry.level === 'warn' && typeof entry.payload === 'object',
  );
  assert.ok(logged, '403 응답에 로그가 남아야 한다');
  assert.equal(logged.payload.requestId, 'req-403');
});

test('keeps requestId null when the body cannot be parsed', async () => {
  let handler;
  const app = {
    post(_path, routeHandler) {
      handler = withServiceAuthentication(routeHandler);
    },
  };
  const logger = createRecordingLogger();
  const plugin = createWhsApprovalMiddleware(
    { endpoint: '/-/whs/approvals' },
    { logger },
  );
  plugin.register_middlewares(app);

  const response = createResponse();
  await handler({ body: 'not-an-object' }, response);

  assert.equal(response.statusCode, 400);
  // 기동 시 남는 설정 경고는 payload 가 문자열이다. 요청 로그만 고른다.
  const logged = logger.entries.find(
    (entry) => entry.level === 'warn' && typeof entry.payload === 'object',
  );
  assert.ok(logged, '본문이 잘못돼도 로그는 남아야 한다');
  assert.equal(logged.payload.requestId, null);
});

test('applies the configured approval ttl to registered approvals', async () => {
  let handler;
  const app = {
    post(_path, routeHandler) {
      handler = withServiceAuthentication(routeHandler);
    },
  };
  const registeredAtMs = Date.UTC(2026, 0, 2, 3, 4, 5);
  const plugin = createWhsApprovalMiddleware(
    { endpoint: '/-/whs/approvals', approval_ttl_seconds: 120 },
    { logger: quietLogger, now: () => registeredAtMs },
  );

  plugin.register_middlewares(app, undefined, createStorage());

  const response = createResponse();
  await handler(
    {
      body: {
        requestId: 'req-ttl',
        packages: [
          {
            packageName: 'express',
            version: '5.2.1',
            integrity: 'sha512-approved',
          },
        ],
      },
    },
    response,
  );

  assert.equal(response.statusCode, 200);
  // ACK 본문은 기존 Contract 그대로 유지하고 TTL 정보를 노출하지 않는다.
  assert.deepEqual(response.body, {
    requestId: 'req-ttl',
    status: 'REGISTERED',
    packageCount: 1,
  });

  const [stored] = plugin.approvals.findByPackage('express');
  assert.equal(stored.registeredAt, '2026-01-02T03:04:05.000Z');
  assert.equal(stored.expiresAt, '2026-01-02T03:06:05.000Z');
});

test('falls back to the default ttl when the configured value is invalid', () => {
  const warnings = [];
  const plugin = createWhsApprovalMiddleware(
    { endpoint: '/-/whs/approvals', approval_ttl_seconds: -1 },
    {
      logger: {
        info() {},
        warn(payload) {
          warnings.push(payload);
        },
        error() {},
      },
    },
  );

  assert.equal(plugin.approvals.ttlSeconds, DEFAULT_TTL_SECONDS);
  assert.deepEqual(warnings, [
    { configuredTtlSeconds: -1, appliedTtlSeconds: DEFAULT_TTL_SECONDS },
  ]);
});

function createApprovalHandler({ storage, now, ttlSeconds = 120 } = {}) {
  let handler;
  const app = {
    post(_path, routeHandler) {
      handler = withServiceAuthentication(routeHandler);
    },
    use() {},
  };
  const plugin = createWhsApprovalMiddleware(
    { endpoint: '/-/whs/approvals', approval_ttl_seconds: ttlSeconds },
    { logger: quietLogger, now },
  );

  plugin.register_middlewares(app, undefined, storage);

  return { plugin, handler };
}

function approvalRequest(requestId, integrity = 'sha512-approved') {
  return {
    body: {
      requestId,
      packages: [
        { packageName: 'express', version: '5.2.1', integrity },
      ],
    },
  };
}

test('refreshes the approval timestamps when the same approval is registered again', async () => {
  const storage = createStorage();
  let nowMs = Date.UTC(2026, 0, 2, 3, 4, 5);
  const { plugin, handler } = createApprovalHandler({
    storage,
    now: () => nowMs,
  });

  await handler(approvalRequest('req-first'), createResponse());
  const [first] = plugin.approvals.findByPackage('express');

  nowMs += 30 * 1000;
  const response = createResponse();
  await handler(approvalRequest('req-second'), response);
  const [second] = plugin.approvals.findByPackage('express');

  assert.equal(response.statusCode, 200);
  // 같은 packageName + version + integrity 이므로 항목은 늘지 않는다.
  assert.equal(plugin.approvals.size, 1);
  assert.equal(second.registeredAt, '2026-01-02T03:04:35.000Z');
  assert.equal(second.expiresAt, '2026-01-02T03:06:35.000Z');
  assert.notEqual(second.registeredAt, first.registeredAt);
  assert.notEqual(second.expiresAt, first.expiresAt);
});

test('reuses the cached tarball when the same approval is registered again', async () => {
  const storage = createStorage();
  const { handler } = createApprovalHandler({ storage });

  await handler(approvalRequest('req-first'), createResponse());
  assert.equal(storage.tarballCalls.length, 1);

  await handler(approvalRequest('req-second'), createResponse());
  assert.equal(storage.tarballCalls.length, 1);
});

test('keeps the existing approval when a different integrity is registered', async () => {
  const storage = createStorage();
  const { plugin, handler } = createApprovalHandler({ storage });

  await handler(approvalRequest('req-first'), createResponse());
  const response = createResponse();
  await handler(approvalRequest('req-other', 'sha512-different'), response);

  // Metadata 의 integrity 와 다르므로 등록되지 않고 기존 항목만 남는다.
  assert.equal(response.statusCode, 403);
  assert.equal(plugin.approvals.size, 1);
});

test('keeps the previous expiry when metadata no longer matches the approval', async () => {
  let integrity = 'sha512-approved';
  const storage = createStorage();
  const originalGetPackage = storage.getPackage.bind(storage);
  storage.getPackage = (options) =>
    originalGetPackage({
      ...options,
      callback(error, metadata) {
        if (error) {
          options.callback(error);
          return;
        }
        metadata.versions['5.2.1'].dist.integrity = integrity;
        options.callback(null, metadata);
      },
    });

  let nowMs = Date.UTC(2026, 0, 2, 3, 4, 5);
  const { plugin, handler } = createApprovalHandler({
    storage,
    now: () => nowMs,
  });

  await handler(approvalRequest('req-first'), createResponse());
  const [before] = plugin.approvals.findByPackage('express');

  // 승인 이후 Metadata 가 바뀌면 재등록은 실패해야 하고 기존 TTL 은 그대로여야 한다.
  integrity = 'sha512-republished';
  nowMs += 30 * 1000;
  const response = createResponse();
  await handler(approvalRequest('req-second'), response);
  const [after] = plugin.approvals.findByPackage('express');

  assert.equal(response.statusCode, 403);
  assert.equal(after.registeredAt, before.registeredAt);
  assert.equal(after.expiresAt, before.expiresAt);
});

test('keeps the previous expiry when the cache cannot be prepared again', async () => {
  const storage = createStorage();
  let nowMs = Date.UTC(2026, 0, 2, 3, 4, 5);
  const { plugin, handler } = createApprovalHandler({
    storage,
    now: () => nowMs,
  });

  await handler(approvalRequest('req-first'), createResponse());
  const [before] = plugin.approvals.findByPackage('express');

  // Cache 가 사라졌는데 다시 받아오지도 못하는 상황.
  storage.hasLocalTarball = async () => false;
  storage.getTarball = () =>
    Readable.from(
      (async function* streamFailure() {
        throw new Error('uplink unavailable');
      })(),
    );

  nowMs += 30 * 1000;
  const response = createResponse();
  await handler(approvalRequest('req-second'), response);
  const [after] = plugin.approvals.findByPackage('express');

  assert.equal(response.statusCode, 500);
  assert.equal(after.registeredAt, before.registeredAt);
  assert.equal(after.expiresAt, before.expiresAt);
});

test('downloads once when the same approval arrives concurrently', async () => {
  const storage = createStorage();
  const originalGetTarball = storage.getTarball.bind(storage);
  // 두 요청이 겹치도록 다운로드를 잠시 붙잡아 둔다.
  storage.getTarball = (packageName, filename) => {
    const stream = originalGetTarball(packageName, filename);
    return Readable.from(
      (async function* slowStream() {
        await new Promise((resolve) => setTimeout(resolve, 10));
        yield* stream;
      })(),
    );
  };

  const { plugin, handler } = createApprovalHandler({ storage });
  const first = createResponse();
  const second = createResponse();

  await Promise.all([
    handler(approvalRequest('req-a'), first),
    handler(approvalRequest('req-b'), second),
  ]);

  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);
  assert.equal(storage.tarballCalls.length, 1);
  assert.equal(plugin.approvals.size, 1);
  assert.equal(plugin.pendingTarballs.size, 0);
});

test('re-registers an expired approval and reuses the cached tarball', async () => {
  const storage = createStorage();
  let nowMs = Date.UTC(2026, 0, 2, 3, 4, 5);
  const ttlSeconds = 120;
  const { plugin, handler } = createApprovalHandler({
    storage,
    ttlSeconds,
    now: () => nowMs,
  });

  await handler(approvalRequest('req-first'), createResponse());
  assert.equal(storage.tarballCalls.length, 1);
  assert.equal(plugin.approvals.size, 1);

  // 만료 시각으로 옮기면 승인이 사라진다.
  nowMs += ttlSeconds * 1000;
  assert.equal(plugin.approvals.size, 0);

  const response = createResponse();
  await handler(approvalRequest('req-again'), response);

  assert.equal(response.statusCode, 200);
  assert.equal(plugin.approvals.size, 1);
  // Cache 가 남아 있으므로 Tarball 을 다시 내려받지 않는다.
  assert.equal(storage.tarballCalls.length, 1);

  const [stored] = plugin.approvals.findByPackage('express');
  assert.equal(stored.registeredAt, new Date(nowMs).toISOString());
  assert.equal(
    stored.expiresAt,
    new Date(nowMs + ttlSeconds * 1000).toISOString(),
  );
});

// ---------------------------------------------------------------------------
// Integrity 충돌 (#191)
// ---------------------------------------------------------------------------

// express 의 두 Version 이 같은 파일을 가리키는 Metadata.
function createSharedFilenameStorage({ cachedBefore = false } = {}) {
  const tarballCalls = [];

  return {
    tarballCalls,
    getPackage({ name, callback }) {
      callback(null, {
        name,
        versions: {
          '5.2.1': {
            dist: {
              integrity: 'sha512-approved',
              tarball: `https://registry.npmjs.org/${name}/-/${name}.tgz`,
            },
          },
          '5.3.0': {
            dist: {
              integrity: 'sha512-other',
              tarball: `https://registry.npmjs.org/${name}/-/${name}.tgz`,
            },
          },
        },
      });
    },
    getTarball(packageName, filename) {
      tarballCalls.push({ packageName, filename });
      return Readable.from(['tarball']);
    },
    async hasLocalTarball() {
      return tarballCalls.length === 0 ? cachedBefore : true;
    },
  };
}

function conflictingRequest(requestId) {
  return {
    body: {
      requestId,
      packages: [
        { packageName: 'express', version: '5.3.0', integrity: 'sha512-other' },
      ],
    },
  };
}

test('returns 403 when a new approval conflicts with a stored one', async () => {
  const storage = createSharedFilenameStorage();
  const logger = createRecordingLogger();
  let handler;
  const app = {
    post(_path, routeHandler) {
      handler = withServiceAuthentication(routeHandler);
    },
    use() {},
  };
  const plugin = createWhsApprovalMiddleware(
    { endpoint: '/-/whs/approvals' },
    { logger },
  );
  plugin.register_middlewares(app, undefined, storage);

  await handler(approvalRequest('req-first'), createResponse());
  assert.equal(plugin.approvals.size, 1);
  const downloadsAfterFirst = storage.tarballCalls.length;

  const response = createResponse();
  await handler(conflictingRequest('req-conflict'), response);

  assert.equal(response.statusCode, 403);
  assert.match(response.body.error, /conflicting integrity/);
  // 기존 승인만 남고 Tarball 도 다시 내려받지 않는다.
  assert.equal(plugin.approvals.size, 1);
  assert.equal(storage.tarballCalls.length, downloadsAfterFirst);

  const logged = logger.entries.find(
    (entry) => entry.level === 'warn' && entry.payload.requestId === 'req-conflict',
  );
  assert.ok(logged, '충돌 요청은 requestId 와 함께 기록돼야 한다');
  assert.match(logged.payload.reason, /express\/express\.tgz/);
  assert.match(logged.payload.reason, /5\.3\.0/);
  assert.equal(
    JSON.stringify(logged).includes('authorization'),
    false,
    '민감정보는 기록하지 않는다',
  );
});

test('keeps one integrity when conflicting requests race on a cached tarball', async () => {
  // Cache 가 이미 있으면 다운로드가 없어 pendingTarballs 가 비어 있다.
  const storage = createSharedFilenameStorage({ cachedBefore: true });
  const { plugin, handler } = createApprovalHandler({ storage });

  const first = createResponse();
  const second = createResponse();
  await Promise.all([
    handler(approvalRequest('req-a'), first),
    handler(conflictingRequest('req-b'), second),
  ]);

  const statuses = [first.statusCode, second.statusCode].sort();
  assert.deepEqual(statuses, [200, 403]);

  const stored = plugin.approvals.findByTarball('express', 'express.tgz');
  assert.equal(stored.length, 1);
  assert.equal(plugin.approvals.size, 1);
});
