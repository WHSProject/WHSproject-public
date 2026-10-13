'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const createWhsAuditMiddleware = require('..');

const FIXED_NOW_MS = Date.UTC(2026, 0, 2, 3, 4, 5);
const FIXED_NOW_ISO = '2026-01-02T03:04:05.000Z';

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

// 응답 종료 Event 를 직접 발생시켜 statusCode 확정 시점을 재현한다.
function createResponse(statusCode = 200) {
  const listeners = new Map();

  return {
    statusCode,
    once(event, listener) {
      if (!listeners.has(event)) {
        listeners.set(event, []);
      }
      listeners.get(event).push(listener);
      return this;
    },
    emit(event) {
      for (const listener of listeners.get(event) ?? []) {
        listener();
      }
    },
  };
}

function createPlugin({ logger, config = {} } = {}) {
  let middleware;
  const app = {
    use(handler) {
      middleware = handler;
    },
  };
  const plugin = createWhsAuditMiddleware(config, {
    logger: logger ?? createRecordingLogger(),
    now: () => FIXED_NOW_MS,
  });
  plugin.register_middlewares(app);

  return { plugin, middleware, app };
}

// 요청을 흘려보내고 응답 종료까지 재현한다.
function run(middleware, request, response, event = 'finish') {
  let continued = false;
  middleware(request, response, () => {
    continued = true;
  });
  response.emit(event);

  return continued;
}

function auditEntries(logger) {
  return logger.entries.filter((entry) => entry.payload?.eventType === 'audit');
}

function auditEvents(logger) {
  return auditEntries(logger).map((entry) => entry.payload);
}

test('loads through the CommonJS factory used by Verdaccio', () => {
  const plugin = createWhsAuditMiddleware({}, { logger: createRecordingLogger() });

  assert.equal(typeof plugin.register_middlewares, 'function');
});

test('records a successful login', () => {
  const logger = createRecordingLogger();
  const { middleware } = createPlugin({ logger });
  const response = createResponse(201);

  const continued = run(
    middleware,
    {
      method: 'PUT',
      path: '/-/user/org.couchdb.user:admin/-rev/1-abc',
      headers: { 'x-request-id': 'req-login' },
      ip: '10.0.0.7',
    },
    response,
  );

  assert.equal(continued, true);
  assert.deepEqual(auditEvents(logger), [
    {
      eventType: 'audit',
      timestamp: FIXED_NOW_ISO,
      action: 'login',
      result: 'success',
      requestId: 'req-login',
      actor: 'admin',
      sourceIp: '10.0.0.7',
      statusCode: 201,
    },
  ]);
});

test('records a failed login with a short reason', () => {
  const logger = createRecordingLogger();
  const { middleware } = createPlugin({ logger });

  run(
    middleware,
    {
      method: 'PUT',
      path: '/-/user/org.couchdb.user:admin/-rev/1-abc',
      headers: {},
    },
    createResponse(401),
  );

  const [event] = auditEvents(logger);
  assert.equal(event.result, 'failure');
  assert.equal(event.statusCode, 401);
  assert.equal(event.reason, 'unauthorized');
});

test('records publish success and failure', () => {
  const logger = createRecordingLogger();
  const { middleware } = createPlugin({ logger });

  run(
    middleware,
    {
      method: 'PUT',
      path: '/@whs%2Fexample',
      headers: {},
      remote_user: { name: 'whs-ci' },
    },
    createResponse(201),
  );
  run(
    middleware,
    { method: 'PUT', path: '/is-number', headers: {} },
    createResponse(403),
  );

  const events = auditEvents(logger);
  assert.equal(events.length, 2);
  assert.deepEqual(
    { ...events[0] },
    {
      eventType: 'audit',
      timestamp: FIXED_NOW_ISO,
      action: 'publish',
      result: 'success',
      actor: 'whs-ci',
      packageName: '@whs/example',
      statusCode: 201,
    },
  );
  assert.equal(events[1].action, 'publish');
  assert.equal(events[1].result, 'failure');
  assert.equal(events[1].reason, 'forbidden');
  assert.equal(events[1].packageName, 'is-number');
});

test('records unpublish success and failure', () => {
  const logger = createRecordingLogger();
  const { middleware } = createPlugin({ logger });

  run(
    middleware,
    {
      method: 'DELETE',
      path: '/@whs%2Fexample/-rev/3-abc',
      headers: {},
      remote_user: { name: 'admin' },
    },
    createResponse(201),
  );
  run(
    middleware,
    {
      method: 'DELETE',
      path: '/is-number/-rev/3-abc',
      headers: {},
      remote_user: { name: 'whs-ci' },
    },
    createResponse(403),
  );

  const events = auditEvents(logger);
  assert.deepEqual(
    events.map((event) => [event.action, event.result, event.actor]),
    [
      ['unpublish', 'success', 'admin'],
      ['unpublish', 'failure', 'whs-ci'],
    ],
  );
});

test('omits requestId when the header is absent', () => {
  const logger = createRecordingLogger();
  const { middleware } = createPlugin({ logger });

  run(
    middleware,
    { method: 'PUT', path: '/is-number', headers: {} },
    createResponse(201),
  );

  const [event] = auditEvents(logger);
  assert.equal('requestId' in event, false);
});

test('omits the actor and role when they cannot be determined', () => {
  const logger = createRecordingLogger();
  const { middleware } = createPlugin({ logger });

  run(
    middleware,
    { method: 'PUT', path: '/is-number', headers: {} },
    createResponse(403),
  );

  const [event] = auditEvents(logger);
  assert.equal('actor' in event, false);
  assert.equal('actorRole' in event, false);
});

test('falls back to the socket address when request.ip is absent', () => {
  const logger = createRecordingLogger();
  const { middleware } = createPlugin({ logger });

  run(
    middleware,
    {
      method: 'PUT',
      path: '/is-number',
      headers: {},
      socket: { remoteAddress: '172.28.0.6' },
    },
    createResponse(201),
  );

  const [event] = auditEvents(logger);
  assert.equal(event.sourceIp, '172.28.0.6');
});

test('records one event per request even when finish and close both fire', () => {
  const logger = createRecordingLogger();
  const { middleware } = createPlugin({ logger });
  const response = createResponse(201);

  middleware(
    { method: 'PUT', path: '/is-number', headers: {} },
    response,
    () => {},
  );
  response.emit('finish');
  response.emit('close');

  assert.equal(auditEvents(logger).length, 1);
});

test('does not report an aborted request as a success', () => {
  const logger = createRecordingLogger();
  const { middleware } = createPlugin({ logger });

  // 응답을 보내지 못한 채 연결이 끊기면 statusCode 는 기본값 200 으로 남아 있다.
  run(
    middleware,
    { method: 'PUT', path: '/is-number', headers: {} },
    createResponse(200),
    'close',
  );

  const [event] = auditEvents(logger);
  assert.equal(event.result, 'failure');
  assert.equal(event.reason, 'client_disconnected');
  assert.equal('statusCode' in event, false);
});

test('keeps the status code when the response completes before close', () => {
  const logger = createRecordingLogger();
  const { middleware } = createPlugin({ logger });
  const response = createResponse(201);

  middleware(
    { method: 'PUT', path: '/is-number', headers: {} },
    response,
    () => {},
  );
  response.emit('finish');
  response.emit('close');

  const [event] = auditEvents(logger);
  assert.equal(event.result, 'success');
  assert.equal(event.statusCode, 201);
});

test('records a login through the real npm login path', () => {
  const logger = createRecordingLogger();
  const { middleware } = createPlugin({ logger });

  run(
    middleware,
    {
      method: 'PUT',
      path: '/-/user/org.couchdb.user:admin',
      headers: { authorization: 'Basic YWRtaW46aHVudGVyMg==' },
      ip: '10.0.0.7',
    },
    createResponse(201),
  );

  const [event] = auditEvents(logger);
  assert.equal(event.action, 'login');
  assert.equal(event.result, 'success');
  assert.equal(event.actor, 'admin');
  assert.equal(event.statusCode, 201);
});

test('ignores metadata and tarball requests', () => {
  const logger = createRecordingLogger();
  const { middleware } = createPlugin({ logger });

  for (const path of [
    '/is-number',
    '/is-number/7.0.0',
    '/is-number/-/is-number-7.0.0.tgz',
    '/-/ping',
  ]) {
    run(middleware, { method: 'GET', path, headers: {} }, createResponse(200));
  }

  assert.deepEqual(auditEvents(logger), []);
});

test('attaches no listener to requests that are not audited', () => {
  const { middleware } = createPlugin();
  let listenerCount = 0;
  const response = {
    statusCode: 200,
    once() {
      listenerCount += 1;
      return this;
    },
    emit() {},
  };

  middleware(
    { method: 'GET', path: '/is-number', headers: {} },
    response,
    () => {},
  );

  assert.equal(listenerCount, 0);
});

test('registers no middleware when the plugin is disabled', () => {
  const logger = createRecordingLogger();
  const { middleware } = createPlugin({ logger, config: { enabled: false } });

  assert.equal(middleware, undefined);
  assert.ok(logger.entries.some((entry) => entry.level === 'warn'));
});

test('keeps serving the request when the logger throws', () => {
  const { middleware } = createPlugin({
    logger: {
      info() {
        throw new Error('logger is broken');
      },
      warn() {},
      error() {},
    },
  });
  const response = createResponse(201);

  const continued = run(
    middleware,
    { method: 'PUT', path: '/is-number', headers: {} },
    response,
  );

  assert.equal(continued, true);
  assert.equal(response.statusCode, 201);
});

test('never writes credentials or request bodies into the log', () => {
  const logger = createRecordingLogger();
  const { middleware } = createPlugin({ logger });

  run(
    middleware,
    {
      method: 'PUT',
      path: '/-/user/org.couchdb.user:admin/-rev/1-abc',
      headers: {
        authorization: 'Basic YWRtaW46aHVudGVyMg==',
        cookie: 'session=secret-cookie-value',
        'x-request-id': 'req-secret',
      },
      body: { name: 'admin', password: 'hunter2' },
      remote_user: { name: 'admin', token: 'jwt-token-value' },
    },
    createResponse(201),
  );

  const [entry] = auditEntries(logger);
  const serialized = JSON.stringify(entry);

  for (const leaked of [
    'password',
    'hunter2',
    'authorization',
    'Basic',
    'YWRtaW46aHVudGVyMg==',
    'cookie',
    'secret-cookie-value',
    'jwt-token-value',
    'body',
  ]) {
    assert.equal(
      serialized.includes(leaked),
      false,
      `${leaked} 이(가) 로그에 남았다`,
    );
  }

  // 남아야 하는 값은 그대로 남는다.
  assert.equal(entry.payload.actor, 'admin');
  assert.equal(entry.payload.requestId, 'req-secret');
});

// ---------------------------------------------------------------------------
// 로그 Level
// ---------------------------------------------------------------------------

test('writes successful events at info and failed events at warn', () => {
  const logger = createRecordingLogger();
  const { middleware } = createPlugin({ logger });

  run(
    middleware,
    { method: 'PUT', path: '/is-number', headers: {} },
    createResponse(201),
  );
  run(
    middleware,
    { method: 'PUT', path: '/is-number', headers: {} },
    createResponse(403),
  );

  assert.deepEqual(
    auditEntries(logger).map((entry) => [entry.level, entry.payload.result]),
    [
      ['info', 'success'],
      ['warn', 'failure'],
    ],
  );
});

test('writes an aborted request at warn', () => {
  const logger = createRecordingLogger();
  const { middleware } = createPlugin({ logger });

  run(
    middleware,
    { method: 'PUT', path: '/is-number', headers: {} },
    createResponse(200),
    'close',
  );

  const [entry] = auditEntries(logger);
  assert.equal(entry.level, 'warn');
});
