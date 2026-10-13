'use strict';

const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const test = require('node:test');

const createWhsApprovalMiddleware = require('..');
const { ApprovalStore } = require('../src/approval-store');
const { createRegistryGuard } = require('../src/registry-guard');
const { createAuditLogger } = require('../../shared/audit');

const FIXED_NOW_MS = Date.UTC(2026, 0, 2, 3, 4, 5);
const AUDIT_MESSAGE = '[verdaccio-whs-audit] audit event';
const TEST_SERVICE_TOKEN = 'test-only-service-token';
process.env.WHS_APPROVAL_SERVICE_TOKEN = TEST_SERVICE_TOKEN;
const approved = {
  packageName: 'is-number',
  version: '7.0.0',
  integrity: 'sha512-approved',
  filename: 'is-number-7.0.0.tgz',
};

// 세 API 모두 서비스 인증을 요구한다.
function authHeaders() {
  return { authorization: `Bearer ${TEST_SERVICE_TOKEN}` };
}

function createRecordingLogger({ throwOnAudit = false } = {}) {
  const entries = [];

  const record = (level) => (event, message) => {
    if (throwOnAudit && message === AUDIT_MESSAGE) {
      throw new Error('audit sink unavailable');
    }
    entries.push({ level, event, message });
  };

  return {
    entries,
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
  };
}

function auditEvents(logger, action) {
  return logger.entries
    .filter((entry) => entry.message === AUDIT_MESSAGE)
    .map((entry) => ({ ...entry.event, level: entry.level }))
    .filter((event) => action === undefined || event.action === action);
}

function createResponse() {
  return {
    statusCode: 200,
    body: undefined,
    locals: {},
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    send(body) {
      this.body = body;
      return this;
    },
    removeHeader() {},
  };
}

function createStorage({
  version = '7.0.0',
  integrity = approved.integrity,
  filename = 'is-number-7.0.0.tgz',
  tarballError,
} = {}) {
  return {
    getPackage({ name, callback }) {
      callback(null, {
        name,
        versions: {
          [version]: {
            version,
            dist: {
              integrity,
              tarball: `https://registry.npmjs.org/${name}/-/${filename}`,
            },
          },
        },
      });
    },
    getTarball() {
      if (tarballError !== undefined) {
        return Readable.from(
          (async function* fail() {
            throw tarballError;
          })(),
        );
      }
      return Readable.from(['tarball']);
    },
    async hasLocalTarball() {
      return tarballError === undefined;
    },
  };
}

function registerPlugin({ logger, storage = createStorage(), now } = {}) {
  let approvalHandler;
  let guard;
  const plugin = createWhsApprovalMiddleware(
    { endpoint: '/-/whs/approvals', approval_ttl_seconds: 60 },
    { logger, now },
  );
  plugin.register_middlewares(
    {
      post(_path, handler) {
        approvalHandler = (request, response) => {
          request.headers = {
            ...request.headers,
            authorization: `Bearer ${TEST_SERVICE_TOKEN}`,
          };
          return handler(request, response);
        };
      },
      use(handler) {
        guard = handler;
      },
    },
    undefined,
    storage,
  );
  return { approvalHandler, guard, plugin };
}

function approvalRequest(overrides = {}) {
  return {
    body: {
      requestId: 'req-approval',
      packages: [
        {
          packageName: 'is-number',
          version: '7.0.0',
          integrity: approved.integrity,
          ...overrides,
        },
      ],
    },
  };
}

test('records one approval.registered event for one successful API request', async () => {
  const logger = createRecordingLogger();
  const { approvalHandler } = registerPlugin({
    logger,
    now: () => FIXED_NOW_MS,
  });
  const response = createResponse();

  await approvalHandler(approvalRequest(), response);

  assert.equal(response.statusCode, 200);
  assert.deepEqual(auditEvents(logger, 'approval.registered'), [
    {
      eventType: 'audit',
      timestamp: new Date(FIXED_NOW_MS).toISOString(),
      action: 'approval.registered',
      result: 'success',
      requestId: 'req-approval',
      level: 'info',
    },
  ]);
});

test('records safe approval.rejected reasons for invalid, mismatched, and cache failures', async () => {
  const cases = [
    {
      request: { body: { requestId: 'req-invalid', packages: [] } },
      storage: createStorage(),
      reason: 'invalid_request',
      statusCode: 400,
    },
    {
      request: approvalRequest(),
      storage: createStorage({ version: '6.0.0' }),
      reason: 'version_not_found',
      statusCode: 403,
    },
    {
      request: approvalRequest(),
      storage: createStorage({ integrity: 'sha512-current' }),
      reason: 'metadata_integrity_mismatch',
      statusCode: 403,
    },
    {
      request: approvalRequest(),
      storage: createStorage({ tarballError: new Error('secret upstream detail') }),
      reason: 'package_preparation_failed',
      statusCode: 500,
    },
  ];

  for (const current of cases) {
    const logger = createRecordingLogger();
    const { approvalHandler } = registerPlugin({
      logger,
      storage: current.storage,
    });
    const response = createResponse();

    await approvalHandler(current.request, response);

    const [event] = auditEvents(logger, 'approval.rejected');
    assert.equal(response.statusCode, current.statusCode);
    assert.equal(event.result, 'failure');
    assert.equal(event.level, 'warn');
    assert.equal(event.reason, current.reason);
    assert.equal(JSON.stringify(event).includes('secret upstream detail'), false);
  }
});

test('records integrity.conflict without writing either integrity value', async () => {
  const logger = createRecordingLogger();
  const storage = createStorage({
    version: '8.0.0',
    integrity: 'sha512-new-secret',
  });
  const { approvalHandler, plugin } = registerPlugin({ logger, storage });
  plugin.approvals.register([approved]);
  const response = createResponse();

  await approvalHandler(
    approvalRequest({ version: '8.0.0', integrity: 'sha512-new-secret' }),
    response,
  );

  const [event] = auditEvents(logger, 'integrity.conflict');
  assert.equal(response.statusCode, 403);
  assert.equal(event.packageName, 'is-number');
  assert.equal(event.version, '8.0.0');
  assert.equal(event.reason, 'integrity_conflict');
  assert.equal(JSON.stringify(event).includes('sha512-'), false);
});

test('records the conflicting package and version for a multi-package request', async () => {
  const logger = createRecordingLogger();
  const storage = createStorage({
    version: '8.0.0',
    integrity: 'sha512-new-secret',
  });
  const { approvalHandler, plugin } = registerPlugin({ logger, storage });
  plugin.approvals.register([approved]);
  const response = createResponse();

  await approvalHandler({
    body: {
      requestId: 'req-multi-conflict',
      packages: [
        {
          packageName: 'other-package',
          version: '8.0.0',
          integrity: 'sha512-new-secret',
        },
        {
          packageName: approved.packageName,
          version: '8.0.0',
          integrity: 'sha512-new-secret',
        },
      ],
    },
  }, response);

  const [event] = auditEvents(logger, 'integrity.conflict');
  assert.equal(response.statusCode, 403);
  assert.equal(event.packageName, approved.packageName);
  assert.equal(event.version, '8.0.0');
  assert.equal(event.requestId, 'req-multi-conflict');
});

test('records every revoke attempt including the ones that change nothing', () => {
  const logger = createRecordingLogger();
  let deleteHandler;
  const plugin = registerPlugin({ logger }).plugin;
  plugin.register_middlewares(
    { post() {}, get() {}, delete(_path, handler) { deleteHandler = handler; } },
    undefined,
    createStorage(),
  );
  plugin.approvals.register([approved]);

  deleteHandler({
    headers: { ...authHeaders(), 'x-request-id': 'req-revoke' },
    query: { packageName: approved.packageName, version: approved.version },
  }, createResponse());

  // 이미 없는 대상도 남긴다. 인증 전이라 탐색 시도일 수 있다.
  deleteHandler({
    headers: authHeaders(),
    query: { packageName: 'never-approved', version: '1.0.0' },
  }, createResponse());

  // Query 가 잘못된 요청도 남긴다. 읽힌 쪽만 기록된다.
  deleteHandler({ headers: authHeaders(), query: { packageName: 'half' } }, createResponse());

  const events = auditEvents(logger, 'approval.revoked');
  assert.equal(events.length, 3);

  assert.equal(events[0].result, 'success');
  assert.equal(events[0].level, 'info');
  assert.equal(events[0].packageName, approved.packageName);
  assert.equal(events[0].version, approved.version);
  assert.equal(events[0].requestId, 'req-revoke');
  assert.equal(events[0].statusCode, 200);
  assert.equal('reason' in events[0], false);

  assert.equal(events[1].result, 'failure');
  assert.equal(events[1].level, 'warn');
  assert.equal(events[1].reason, 'approval_not_found');
  assert.equal(events[1].statusCode, 404);
  assert.equal('requestId' in events[1], false);

  assert.equal(events[2].result, 'failure');
  assert.equal(events[2].reason, 'invalid_request');
  assert.equal(events[2].statusCode, 400);
  assert.equal(events[2].packageName, 'half');
  assert.equal('version' in events[2], false);
});

test('records each approval only when TTL cleanup actually removes it', () => {
  const clock = { nowMs: FIXED_NOW_MS };
  const expired = [];
  const store = new ApprovalStore({
    ttlSeconds: 60,
    now: () => clock.nowMs,
    onExpired: (artifact) => expired.push(artifact),
  });
  const second = { ...approved, packageName: 'second' };
  const third = { ...approved, packageName: 'third' };
  store.register([approved, second, third]);
  clock.nowMs += 60 * 1000;

  store.has(approved);
  store.findByPackage('second');
  store.register([{ ...approved, packageName: 'fresh' }]);
  store.findByPackage('second');

  assert.deepEqual(
    expired.map((artifact) => artifact.packageName).sort(),
    ['is-number', 'second', 'third'],
  );
});

test('records approval.expired with fields from the stored artifact', () => {
  const clock = { nowMs: FIXED_NOW_MS };
  const logger = createRecordingLogger();
  const { plugin } = registerPlugin({
    logger,
    now: () => clock.nowMs,
  });
  plugin.approvals.register([approved]);
  clock.nowMs += 60 * 1000;

  plugin.approvals.findByPackage(approved.packageName);
  plugin.approvals.findByPackage(approved.packageName);

  assert.deepEqual(auditEvents(logger, 'approval.expired'), [
    {
      eventType: 'audit',
      timestamp: new Date(clock.nowMs).toISOString(),
      action: 'approval.expired',
      result: 'failure',
      packageName: approved.packageName,
      version: approved.version,
      reason: 'ttl_expired',
      level: 'warn',
    },
  ]);
});

function createGuard({ approvals = new ApprovalStore(), storage = createStorage(), logger }) {
  const auditLogger = createAuditLogger({ logger, now: () => FIXED_NOW_MS });
  return createRegistryGuard({ approvals, storage, logger, auditLogger });
}

async function runGuard(guard, request) {
  const response = createResponse();
  let continued = false;
  await guard(request, response, () => {
    continued = true;
  });
  return { response, continued };
}

test('records blocked version and tarball requests and propagates x-request-id', async () => {
  const logger = createRecordingLogger();
  const guard = createGuard({ logger });

  await runGuard(guard, {
    method: 'GET',
    path: '/is-number/7.0.0',
    headers: { 'x-request-id': 'req-version' },
  });
  await runGuard(guard, {
    method: 'GET',
    path: '/is-number/-/is-number-7.0.0.tgz',
    headers: {},
  });

  const events = auditEvents(logger, 'guard.blocked');
  assert.equal(events.length, 2);
  assert.equal(events[0].requestId, 'req-version');
  assert.equal(events[0].version, '7.0.0');
  assert.equal(events[0].reason, 'version_not_approved');
  assert.equal('requestId' in events[1], false);
  assert.equal(events[1].reason, 'tarball_not_approved');
});

test('records current metadata integrity mismatch as guard.blocked', async () => {
  const logger = createRecordingLogger();
  const approvals = new ApprovalStore();
  approvals.register([approved]);
  const guard = createGuard({
    approvals,
    storage: createStorage({ integrity: 'sha512-changed' }),
    logger,
  });

  const { response } = await runGuard(guard, {
    method: 'GET',
    path: '/is-number/-/is-number-7.0.0.tgz',
    headers: { 'x-request-id': 'req-mismatch' },
  });

  const [event] = auditEvents(logger, 'guard.blocked');
  assert.equal(response.statusCode, 403);
  assert.equal(event.reason, 'metadata_integrity_mismatch');
  assert.equal(event.packageName, 'is-number');
  assert.equal(event.version, '7.0.0');
});

test('records a version removed from current metadata as version_not_found', async () => {
  const logger = createRecordingLogger();
  const approvals = new ApprovalStore();
  approvals.register([approved]);
  const guard = createGuard({
    approvals,
    storage: createStorage({ version: '6.0.0' }),
    logger,
  });

  const { response } = await runGuard(guard, {
    method: 'GET',
    path: '/is-number/-/is-number-7.0.0.tgz',
    headers: { 'x-request-id': 'req-version-removed' },
  });

  const [event] = auditEvents(logger, 'guard.blocked');
  assert.equal(response.statusCode, 403);
  assert.equal(event.reason, 'version_not_found');
  assert.equal(event.packageName, 'is-number');
  assert.equal(event.version, '7.0.0');
  assert.equal(event.requestId, 'req-version-removed');
});

test('records a changed version metadata response as guard.blocked', async () => {
  const logger = createRecordingLogger();
  const approvals = new ApprovalStore();
  approvals.register([approved]);
  const guard = createGuard({ approvals, logger });

  const { response, continued } = await runGuard(guard, {
    method: 'GET',
    path: '/is-number/7.0.0',
    headers: { 'x-request-id': 'req-version-mismatch' },
  });
  response.send({
    version: '7.0.0',
    dist: { integrity: 'sha512-changed' },
  });

  const [event] = auditEvents(logger, 'guard.blocked');
  assert.equal(continued, true);
  assert.equal(response.statusCode, 403);
  assert.equal(event.reason, 'metadata_integrity_mismatch');
  assert.equal(event.requestId, 'req-version-mismatch');
});

test('records a version mismatch separately from an integrity mismatch', async () => {
  const logger = createRecordingLogger();
  const approvals = new ApprovalStore();
  approvals.register([approved]);
  const guard = createGuard({ approvals, logger });

  const { response, continued } = await runGuard(guard, {
    method: 'GET',
    path: '/is-number/7.0.0',
    headers: { 'x-request-id': 'req-version-body-mismatch' },
  });
  response.send({
    version: '6.0.0',
    dist: { integrity: approved.integrity },
  });

  const [event] = auditEvents(logger, 'guard.blocked');
  assert.equal(continued, true);
  assert.equal(response.statusCode, 403);
  assert.equal(event.reason, 'metadata_version_mismatch');
  assert.equal(event.requestId, 'req-version-body-mismatch');
});

test('records expiry and blocking when approval expires during metadata lookup', async () => {
  const clock = { nowMs: FIXED_NOW_MS };
  const logger = createRecordingLogger();
  const approvals = new ApprovalStore({
    ttlSeconds: 60,
    now: () => clock.nowMs,
    onExpired: (artifact, nowMs) =>
      createAuditLogger({ logger, now: () => clock.nowMs }).recordFields(
        {
          action: 'approval.expired',
          result: 'failure',
          packageName: artifact.packageName,
          version: artifact.version,
          reason: 'ttl_expired',
        },
        nowMs,
      ),
  });
  approvals.register([approved]);
  const storage = createStorage();
  const originalGetPackage = storage.getPackage;
  storage.getPackage = (options) => {
    clock.nowMs += 60 * 1000;
    originalGetPackage(options);
  };
  const guard = createRegistryGuard({
    approvals,
    storage,
    logger,
    auditLogger: createAuditLogger({ logger, now: () => clock.nowMs }),
  });

  const { response } = await runGuard(guard, {
    method: 'GET',
    path: '/is-number/-/is-number-7.0.0.tgz',
  });

  assert.equal(response.statusCode, 403);
  assert.equal(auditEvents(logger, 'approval.expired').length, 1);
  assert.equal(auditEvents(logger, 'guard.blocked').length, 1);
});

test('does not audit allowed metadata, version, or tarball requests', async () => {
  const logger = createRecordingLogger();
  const approvals = new ApprovalStore();
  approvals.register([approved]);
  const guard = createGuard({ approvals, logger });

  const metadata = await runGuard(guard, { method: 'GET', path: '/is-number' });
  const version = await runGuard(guard, {
    method: 'GET',
    path: '/is-number/7.0.0',
  });
  version.response.send({
    version: '7.0.0',
    dist: { integrity: approved.integrity },
  });
  await runGuard(guard, {
    method: 'GET',
    path: '/is-number/-/is-number-7.0.0.tgz',
  });

  assert.equal(metadata.continued, true);
  assert.equal(auditEvents(logger).length, 0);
});

test('keeps approval and guard behavior when the audit sink throws', async () => {
  const logger = createRecordingLogger({ throwOnAudit: true });
  const { approvalHandler, guard, plugin } = registerPlugin({ logger });
  const registered = createResponse();

  await approvalHandler(approvalRequest(), registered);
  const blocked = await runGuard(guard, {
    method: 'GET',
    path: '/is-number/6.0.0',
  });

  assert.equal(registered.statusCode, 200);
  assert.equal(plugin.approvals.size, 1);
  assert.equal(blocked.response.statusCode, 403);
});

test('keeps approval behavior when every logger method throws', async () => {
  const throwingLogger = {
    info() {
      throw new Error('logger unavailable');
    },
    warn() {
      throw new Error('logger unavailable');
    },
    error() {
      throw new Error('logger unavailable');
    },
  };
  const { approvalHandler, plugin } = registerPlugin({ logger: throwingLogger });
  const response = createResponse();
  const rejected = createResponse();

  await approvalHandler(approvalRequest(), response);
  await approvalHandler({ body: { requestId: 'bad', packages: [] } }, rejected);

  assert.equal(response.statusCode, 200);
  assert.equal(rejected.statusCode, 400);
  assert.equal(plugin.approvals.size, 1);
});

test('audit events never contain credentials, bodies, or integrity values', async () => {
  const logger = createRecordingLogger();
  const { approvalHandler } = registerPlugin({ logger });
  const request = approvalRequest();
  request.headers = {
    authorization: 'Bearer secret-jwt',
    cookie: 'session=secret-cookie',
    authorization: 'Bearer secret-service-token',
  };

  await approvalHandler(request, createResponse());

  const serialized = JSON.stringify(auditEvents(logger));
  for (const secret of [
    'secret-jwt',
    'secret-cookie',
    'secret-service-token',
    approved.integrity,
    'packages',
  ]) {
    assert.equal(serialized.includes(secret), false);
  }
});
