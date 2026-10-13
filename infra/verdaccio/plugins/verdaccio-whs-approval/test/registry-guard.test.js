'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { ApprovalStore } = require('../src/approval-store');
const {
  createRegistryGuard,
  parseRegistryRequest,
} = require('../src/registry-guard');

const approved = {
  packageName: 'is-number',
  version: '7.0.0',
  integrity: 'sha512-approved',
  filename: 'is-number-7.0.0.tgz',
};

function createResponse() {
  return {
    statusCode: 200,
    body: undefined,
    headers: new Map(),
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
    removeHeader(name) {
      this.headers.delete(name.toLowerCase());
    },
  };
}

function createStorage(integrity = approved.integrity) {
  return {
    getPackage({ name, callback }) {
      callback(null, {
        name,
        'dist-tags': { latest: '7.0.0', legacy: '6.0.0' },
        versions: {
          '7.0.0': {
            version: '7.0.0',
            dist: { integrity },
          },
          '6.0.0': {
            version: '6.0.0',
            dist: { integrity: 'sha512-older' },
          },
        },
      });
    },
  };
}

test('parses GET and HEAD metadata, version, and tarball requests', () => {
  assert.deepEqual(
    parseRegistryRequest({ method: 'GET', path: '/is-number' }),
    { type: 'metadata', packageName: 'is-number' },
  );
  assert.deepEqual(
    parseRegistryRequest({ method: 'GET', path: '/@scope%2fname' }),
    { type: 'metadata', packageName: '@scope/name' },
  );
  assert.deepEqual(
    parseRegistryRequest({ method: 'GET', path: '/is-number/7.0.0' }),
    { type: 'version', packageName: 'is-number', version: '7.0.0' },
  );
  assert.deepEqual(
    parseRegistryRequest({
      method: 'HEAD',
      path: '/@scope/name/-/name-1.0.0.tgz',
    }),
    {
      type: 'tarball',
      packageName: '@scope/name',
      filename: 'name-1.0.0.tgz',
    },
  );
  assert.equal(
    parseRegistryRequest({ method: 'POST', path: '/-/whs/approvals' }),
    undefined,
  );
});

test('returns 403 before version lookup when the version is not approved', async () => {
  const approvals = new ApprovalStore();
  approvals.register([approved]);
  const guard = createRegistryGuard({ approvals, storage: createStorage() });
  const response = createResponse();
  let continued = false;

  await guard(
    { method: 'GET', path: '/is-number/6.0.0' },
    response,
    () => {
      continued = true;
    },
  );

  assert.equal(continued, false);
  assert.equal(response.statusCode, 403);
  assert.match(response.body.error, /version is not approved/);
});

test('allows only version metadata with the exact approved integrity', async () => {
  const approvals = new ApprovalStore();
  approvals.register([approved]);
  const guard = createRegistryGuard({ approvals, storage: createStorage() });

  const approvedResponse = createResponse();
  let continued = false;
  await guard(
    { method: 'GET', path: '/is-number/7.0.0' },
    approvedResponse,
    () => {
      continued = true;
    },
  );
  approvedResponse.send({
    name: 'is-number',
    version: '7.0.0',
    dist: { integrity: approved.integrity },
  });

  assert.equal(continued, true);
  assert.equal(approvedResponse.statusCode, 200);

  const mismatchedResponse = createResponse();
  await guard(
    { method: 'GET', path: '/is-number/7.0.0' },
    mismatchedResponse,
    () => {},
  );
  mismatchedResponse.send({
    name: 'is-number',
    version: '7.0.0',
    dist: { integrity: 'sha512-changed' },
  });

  assert.equal(mismatchedResponse.statusCode, 403);
  assert.match(mismatchedResponse.body.error, /version is not approved/);
});

test('applies the approval guard to HEAD requests', async () => {
  const approvals = new ApprovalStore();
  approvals.register([approved]);
  const guard = createRegistryGuard({ approvals, storage: createStorage() });

  const metadataResponse = createResponse();
  let metadataContinued = false;
  await guard(
    { method: 'HEAD', path: '/not-approved' },
    metadataResponse,
    () => {
      metadataContinued = true;
    },
  );
  assert.equal(metadataContinued, true);
  assert.equal(metadataResponse.statusCode, 200);

  const versionResponse = createResponse();
  await guard(
    { method: 'HEAD', path: '/is-number/6.0.0' },
    versionResponse,
    () => {},
  );
  assert.equal(versionResponse.statusCode, 403);

  const tarballResponse = createResponse();
  await guard(
    { method: 'HEAD', path: '/is-number/-/is-number-6.0.0.tgz' },
    tarballResponse,
    () => {},
  );
  assert.equal(tarballResponse.statusCode, 403);
});

test('allows package metadata lookup without an approval', async () => {
  const guard = createRegistryGuard({
    approvals: new ApprovalStore(),
    storage: createStorage(),
  });
  const response = createResponse();
  let continued = false;

  await guard(
    { method: 'GET', path: '/is-number' },
    response,
    () => {
      continued = true;
    },
  );

  assert.equal(continued, true);
  assert.equal(response.statusCode, 200);
});

test('allows an approved tarball and rejects an unapproved tarball', async () => {
  const approvals = new ApprovalStore();
  approvals.register([approved]);
  const guard = createRegistryGuard({ approvals, storage: createStorage() });
  const approvedResponse = createResponse();
  let continued = false;

  await guard(
    { method: 'GET', path: '/is-number/-/is-number-7.0.0.tgz' },
    approvedResponse,
    () => {
      continued = true;
    },
  );
  assert.equal(continued, true);

  const rejectedResponse = createResponse();
  await guard(
    { method: 'GET', path: '/is-number/-/is-number-6.0.0.tgz' },
    rejectedResponse,
    () => {},
  );
  assert.equal(rejectedResponse.statusCode, 403);
  assert.match(rejectedResponse.body.error, /not approved/);
});

test('uses the approval matching current metadata when a tarball filename is reused', async () => {
  const approvals = new ApprovalStore();
  approvals.register([approved]);

  // 등록 경로는 같은 파일에 다른 integrity 가 들어오는 것을 막는다(#191).
  // 그럼에도 그런 상태가 남아 있다면 Guard 가 현재 Metadata 와 맞는 쪽을 고르는지
  // 확인하기 위해, Store 에 직접 넣어 재현한다.
  const stale = { ...approved, integrity: 'sha512-previous' };
  approvals.artifacts.set(ApprovalStore.keyOf(stale), {
    ...stale,
    registeredAt: new Date(0).toISOString(),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  });

  const guard = createRegistryGuard({ approvals, storage: createStorage() });
  const response = createResponse();
  let continued = false;

  await guard(
    { method: 'GET', path: '/is-number/-/is-number-7.0.0.tgz' },
    response,
    () => {
      continued = true;
    },
  );

  assert.equal(continued, true);
  assert.equal(response.statusCode, 200);
});

// ---------------------------------------------------------------------------
// 만료된 Approval
// ---------------------------------------------------------------------------

const GUARD_TTL_SECONDS = 60;
const REGISTERED_AT_MS = Date.UTC(2026, 0, 2, 3, 4, 5);
const GUARD_EXPIRES_AT_MS = REGISTERED_AT_MS + GUARD_TTL_SECONDS * 1000;

// 등록 후 시계를 옮겨 만료 상태를 만든다.
function createExpiringApprovals(artifacts = [approved]) {
  const clock = { nowMs: REGISTERED_AT_MS };
  const approvals = new ApprovalStore({
    ttlSeconds: GUARD_TTL_SECONDS,
    now: () => clock.nowMs,
  });
  approvals.register(artifacts);

  return { approvals, clock };
}

async function runGuard(guard, request) {
  const response = createResponse();
  let continued = false;

  await guard(request, response, () => {
    continued = true;
  });

  return { response, continued };
}

test('blocks a version request whose approval expired', async () => {
  const { approvals, clock } = createExpiringApprovals();
  const guard = createRegistryGuard({ approvals, storage: createStorage() });

  clock.nowMs = GUARD_EXPIRES_AT_MS;
  const { response, continued } = await runGuard(guard, {
    method: 'GET',
    path: '/is-number/7.0.0',
  });

  assert.equal(continued, false);
  assert.equal(response.statusCode, 403);
  assert.match(response.body.error, /version is not approved/);
});

test('blocks a HEAD version request whose approval expired', async () => {
  const { approvals, clock } = createExpiringApprovals();
  const guard = createRegistryGuard({ approvals, storage: createStorage() });

  clock.nowMs = GUARD_EXPIRES_AT_MS;
  const { response, continued } = await runGuard(guard, {
    method: 'HEAD',
    path: '/is-number/7.0.0',
  });

  assert.equal(continued, false);
  assert.equal(response.statusCode, 403);
});

test('blocks a tarball request whose approval expired', async () => {
  const { approvals, clock } = createExpiringApprovals();
  const guard = createRegistryGuard({ approvals, storage: createStorage() });

  clock.nowMs = GUARD_EXPIRES_AT_MS;
  const { response, continued } = await runGuard(guard, {
    method: 'GET',
    path: '/is-number/-/is-number-7.0.0.tgz',
  });

  assert.equal(continued, false);
  assert.equal(response.statusCode, 403);
  assert.match(response.body.error, /tarball is not approved/);
});

test('blocks a HEAD tarball request whose approval expired', async () => {
  const { approvals, clock } = createExpiringApprovals();
  const guard = createRegistryGuard({ approvals, storage: createStorage() });

  clock.nowMs = GUARD_EXPIRES_AT_MS;
  const { response, continued } = await runGuard(guard, {
    method: 'HEAD',
    path: '/is-number/-/is-number-7.0.0.tgz',
  });

  assert.equal(continued, false);
  assert.equal(response.statusCode, 403);
});

test('blocks version metadata in the response filter once the approval expired', async () => {
  const { approvals, clock } = createExpiringApprovals();
  const guard = createRegistryGuard({ approvals, storage: createStorage() });

  // 통과 시점에는 유효했지만 응답을 내보내기 직전에 만료된 경우.
  clock.nowMs = GUARD_EXPIRES_AT_MS - 1;
  const { response, continued } = await runGuard(guard, {
    method: 'GET',
    path: '/is-number/7.0.0',
  });
  assert.equal(continued, true);

  clock.nowMs = GUARD_EXPIRES_AT_MS;
  response.send({
    name: 'is-number',
    version: '7.0.0',
    dist: { integrity: approved.integrity },
  });

  assert.equal(response.statusCode, 403);
  assert.match(response.body.error, /version is not approved/);
});

test('keeps allowing requests while the approval is still valid', async () => {
  const { approvals, clock } = createExpiringApprovals();
  const guard = createRegistryGuard({ approvals, storage: createStorage() });

  clock.nowMs = GUARD_EXPIRES_AT_MS - 1;

  const version = await runGuard(guard, {
    method: 'GET',
    path: '/is-number/7.0.0',
  });
  assert.equal(version.continued, true);

  const tarball = await runGuard(guard, {
    method: 'GET',
    path: '/is-number/-/is-number-7.0.0.tgz',
  });
  assert.equal(tarball.continued, true);
  assert.equal(tarball.response.statusCode, 200);
});

test('allows a new integrity for a file whose earlier approval expired', async () => {
  // 재발행으로 integrity 가 바뀐 상황. 예전 승인이 만료됐다면 충돌이 아니다.
  const { approvals, clock } = createExpiringApprovals([
    { ...approved, integrity: 'sha512-stale' },
  ]);
  const guard = createRegistryGuard({ approvals, storage: createStorage() });

  clock.nowMs = GUARD_EXPIRES_AT_MS;
  approvals.register([approved]);

  const { response, continued } = await runGuard(guard, {
    method: 'GET',
    path: '/is-number/-/is-number-7.0.0.tgz',
  });

  assert.equal(continued, true);
  assert.equal(response.statusCode, 200);
  // 만료된 예전 승인은 등록 시점에 정리됐다.
  assert.equal(approvals.size, 1);
});

test('allows a request again after the expired approval is re-registered', async () => {
  const { approvals, clock } = createExpiringApprovals();
  const guard = createRegistryGuard({ approvals, storage: createStorage() });

  clock.nowMs = GUARD_EXPIRES_AT_MS;
  const blocked = await runGuard(guard, {
    method: 'GET',
    path: '/is-number/-/is-number-7.0.0.tgz',
  });
  assert.equal(blocked.response.statusCode, 403);

  approvals.register([approved]);

  const allowed = await runGuard(guard, {
    method: 'GET',
    path: '/is-number/-/is-number-7.0.0.tgz',
  });
  assert.equal(allowed.continued, true);
  assert.equal(allowed.response.statusCode, 200);
});

// Metadata 조회를 기다리는 동안 시계를 옮겨 만료 상태를 만든다.
function createStorageExpiringDuringLookup(clock, expireAtMs) {
  return {
    getPackage({ name, callback }) {
      setImmediate(() => {
        clock.nowMs = expireAtMs;
        callback(null, {
          name,
          'dist-tags': { latest: '7.0.0' },
          versions: {
            '7.0.0': {
              version: '7.0.0',
              dist: { integrity: approved.integrity },
            },
          },
        });
      });
    },
  };
}

test('blocks a tarball whose approval expires while metadata is fetched', async () => {
  const { approvals, clock } = createExpiringApprovals();
  const guard = createRegistryGuard({
    approvals,
    storage: createStorageExpiringDuringLookup(clock, GUARD_EXPIRES_AT_MS),
  });

  // 요청이 시작될 때는 아직 유효하다.
  clock.nowMs = GUARD_EXPIRES_AT_MS - 1;
  const { response, continued } = await runGuard(guard, {
    method: 'GET',
    path: '/is-number/-/is-number-7.0.0.tgz',
  });

  assert.equal(continued, false);
  assert.equal(response.statusCode, 403);
  assert.match(response.body.error, /tarball is not approved/);
});
