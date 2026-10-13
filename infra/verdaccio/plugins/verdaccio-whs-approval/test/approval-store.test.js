'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  ApprovalConflictError,
  ApprovalStore,
  findConflictingIntegrity,
  isExpired,
  resolveTtlSeconds,
  DEFAULT_TTL_SECONDS,
  MAX_TTL_SECONDS,
} = require('../src/approval-store');

const artifact = {
  packageName: 'express',
  version: '5.2.1',
  integrity: 'sha512-approved',
  filename: 'express-5.2.1.tgz',
};

// 실제 시간이 흐르기를 기다리지 않도록 고정 시각을 주입한다.
const olderVersion = {
  packageName: 'express',
  version: '5.1.0',
  integrity: 'sha512-older',
  filename: 'express-5.1.0.tgz',
};

const FIXED_NOW_MS = Date.UTC(2026, 0, 2, 3, 4, 5);
const FIXED_NOW_ISO = '2026-01-02T03:04:05.000Z';

function createStore(options = {}) {
  return new ApprovalStore({ now: () => FIXED_NOW_MS, ...options });
}

const quietLogger = { warn() {} };

test('stores and matches the exact artifact identity', () => {
  const store = createStore();
  store.register([artifact]);

  assert.equal(store.has(artifact), true);
  assert.equal(store.has({ ...artifact, version: '5.2.0' }), false);
  assert.equal(store.has({ ...artifact, integrity: 'sha512-other' }), false);
});

test('registering the same artifact is idempotent', () => {
  const store = createStore();
  store.register([artifact, artifact]);

  assert.equal(store.size, 1);
});

test('finds approvals by package and tarball filename', () => {
  const store = createStore();
  store.register([
    artifact,
    {
      packageName: 'express',
      version: '5.1.0',
      integrity: 'sha512-older',
      filename: 'express-5.1.0.tgz',
    },
  ]);

  assert.equal(store.findByPackage('express').length, 2);
  assert.equal(store.findByPackage('lodash').length, 0);
  assert.deepEqual(store.findByTarball('express', 'express-5.2.1.tgz'), [
    {
      ...artifact,
      registeredAt: FIXED_NOW_ISO,
      expiresAt: '2026-01-02T04:04:05.000Z',
    },
  ]);
  assert.deepEqual(
    store.findByTarball('express', 'express-4.0.0.tgz'),
    [],
  );
});

test('clear removes all in-memory approvals', () => {
  const store = createStore();
  store.register([artifact]);
  store.clear();

  assert.equal(store.size, 0);
  assert.equal(store.has(artifact), false);
});

test('stores the registration time of an approval', () => {
  const store = createStore();
  store.register([artifact]);

  const [stored] = store.findByPackage('express');
  assert.equal(stored.registeredAt, FIXED_NOW_ISO);
});

test('stores the expiry derived from the configured ttl', () => {
  const store = createStore({ ttlSeconds: 120 });
  store.register([artifact]);

  const [stored] = store.findByPackage('express');
  assert.equal(stored.expiresAt, '2026-01-02T03:06:05.000Z');
  assert.equal(
    Date.parse(stored.expiresAt) - Date.parse(stored.registeredAt),
    120 * 1000,
  );
});

test('applies the default ttl when none is configured', () => {
  const store = createStore();
  store.register([artifact]);

  const [stored] = store.findByPackage('express');
  assert.equal(store.ttlSeconds, DEFAULT_TTL_SECONDS);
  assert.equal(
    Date.parse(stored.expiresAt) - Date.parse(stored.registeredAt),
    DEFAULT_TTL_SECONDS * 1000,
  );
});

test('keeps the existing artifact fields alongside the timestamps', () => {
  const store = createStore();
  store.register([artifact]);

  const [stored] = store.findByPackage('express');
  assert.equal(stored.packageName, artifact.packageName);
  assert.equal(stored.version, artifact.version);
  assert.equal(stored.integrity, artifact.integrity);
  assert.equal(stored.filename, artifact.filename);
});

test('keeps the approval key on packageName, version and integrity', () => {
  assert.equal(
    ApprovalStore.keyOf({
      ...artifact,
      registeredAt: FIXED_NOW_ISO,
      expiresAt: '2026-01-02T04:04:05.000Z',
    }),
    ApprovalStore.keyOf(artifact),
  );
});

test('gives one batch a single registration time', () => {
  let call = 0;
  const store = new ApprovalStore({
    ttlSeconds: 60,
    // 등록 도중 시각이 흘러도 기준 시각은 한 번만 읽어야 한다.
    now: () => FIXED_NOW_MS + call++ * 1000,
  });

  store.register([
    artifact,
    olderVersion,
  ]);

  // 조회도 만료 판정을 위해 시각을 읽으므로, 등록이 소비한 횟수만 따로 센다.
  assert.equal(call, 1);

  const [first, second] = store.findByPackage('express');
  assert.equal(first.registeredAt, second.registeredAt);
  assert.equal(first.expiresAt, second.expiresAt);
});

test('resolves a configured ttl and the default when it is absent', () => {
  assert.equal(resolveTtlSeconds(120, quietLogger), 120);
  assert.equal(resolveTtlSeconds(undefined, quietLogger), DEFAULT_TTL_SECONDS);
  assert.equal(resolveTtlSeconds(null, quietLogger), DEFAULT_TTL_SECONDS);
});

test('falls back to the default ttl for invalid configuration', () => {
  for (const value of [0, -1, 1.5, Number.NaN, '3600', {}, true, Infinity]) {
    assert.equal(
      resolveTtlSeconds(value, quietLogger),
      DEFAULT_TTL_SECONDS,
      `expected the default for ${String(value)}`,
    );
  }
});

test('rejects a ttl that cannot be represented as a date', () => {
  assert.equal(
    resolveTtlSeconds(MAX_TTL_SECONDS + 1, quietLogger),
    DEFAULT_TTL_SECONDS,
  );

  const store = createStore({ ttlSeconds: MAX_TTL_SECONDS });
  store.register([artifact]);

  const [stored] = store.findByPackage('express');
  assert.notEqual(stored.expiresAt, 'Invalid Date');
});

test('logs the ignored value when the ttl configuration is invalid', () => {
  let context;
  resolveTtlSeconds(-1, {
    warn(logContext) {
      context = logContext;
    },
  });

  assert.deepEqual(context, {
    configuredTtlSeconds: -1,
    appliedTtlSeconds: DEFAULT_TTL_SECONDS,
  });
});

// ---------------------------------------------------------------------------
// 만료 처리
// ---------------------------------------------------------------------------

const TTL_SECONDS = 60;
const EXPIRES_AT_MS = FIXED_NOW_MS + TTL_SECONDS * 1000;

// 등록 시각은 고정해 두고, 이후 조회 시각만 옮겨 가며 만료를 검증한다.
function createStoreAt(clock) {
  const store = new ApprovalStore({
    ttlSeconds: TTL_SECONDS,
    now: () => clock.nowMs,
  });
  clock.nowMs = FIXED_NOW_MS;

  return store;
}

test('keeps an approval valid until the moment before it expires', () => {
  const clock = {};
  const store = createStoreAt(clock);
  store.register([artifact]);

  clock.nowMs = EXPIRES_AT_MS - 1;

  assert.equal(store.has(artifact), true);
  assert.equal(store.findByPackage('express').length, 1);
  assert.equal(store.size, 1);
});

test('treats an approval as expired once the clock reaches expiresAt', () => {
  const clock = {};
  const store = createStoreAt(clock);
  store.register([artifact]);

  clock.nowMs = EXPIRES_AT_MS;

  assert.equal(store.has(artifact), false);
});

test('treats an approval as expired after expiresAt', () => {
  const clock = {};
  const store = createStoreAt(clock);
  store.register([artifact]);

  clock.nowMs = EXPIRES_AT_MS + 1;

  assert.equal(store.has(artifact), false);
});

test('removes an expired approval from memory when has is called', () => {
  const clock = {};
  const store = createStoreAt(clock);
  store.register([artifact]);

  clock.nowMs = EXPIRES_AT_MS;
  store.has(artifact);

  // 만료 판정과 무관하게 실제로 지워졌는지 본다.
  assert.equal(store.artifacts.size, 0);
});

test('leaves an unknown artifact untouched', () => {
  const clock = {};
  const store = createStoreAt(clock);
  store.register([artifact]);

  assert.equal(store.has({ ...artifact, version: '9.9.9' }), false);
  assert.equal(store.artifacts.size, 1);
});

test('findByPackage returns only active approvals and drops expired ones', () => {
  const clock = {};
  const store = createStoreAt(clock);
  store.register([artifact]);

  // 두 번째 승인은 더 늦게 등록해 만료 시각을 뒤로 민다.
  clock.nowMs = FIXED_NOW_MS + 30 * 1000;
  store.register([olderVersion]);

  clock.nowMs = EXPIRES_AT_MS;
  const active = store.findByPackage('express');

  assert.deepEqual(
    active.map((entry) => entry.version),
    ['5.1.0'],
  );
  assert.equal(store.artifacts.size, 1);
});

test('findByPackage returns an empty list when every approval expired', () => {
  const clock = {};
  const store = createStoreAt(clock);
  store.register([artifact]);

  clock.nowMs = EXPIRES_AT_MS;

  assert.deepEqual(store.findByPackage('express'), []);
  assert.equal(store.artifacts.size, 0);
});

test('findByPackage keeps approvals of other packages', () => {
  const clock = {};
  const store = createStoreAt(clock);
  store.register([artifact]);

  clock.nowMs = FIXED_NOW_MS + 30 * 1000;
  store.register([
    {
      packageName: 'lodash',
      version: '4.17.21',
      integrity: 'sha512-lodash',
      filename: 'lodash-4.17.21.tgz',
    },
  ]);

  clock.nowMs = EXPIRES_AT_MS;
  store.findByPackage('express');

  // express 만 정리되고 lodash 는 남는다.
  assert.equal(store.artifacts.size, 1);
  assert.equal(store.findByPackage('lodash').length, 1);
});

test('findByTarball returns only active approvals and drops expired ones', () => {
  const clock = {};
  const store = createStoreAt(clock);
  store.register([artifact]);

  // 같은 파일·같은 integrity 를 가리키는 다른 Version 은 충돌이 아니다.
  clock.nowMs = FIXED_NOW_MS + 30 * 1000;
  store.register([{ ...artifact, version: '5.2.0' }]);

  clock.nowMs = EXPIRES_AT_MS;
  const active = store.findByTarball('express', 'express-5.2.1.tgz');

  assert.deepEqual(
    active.map((entry) => entry.version),
    ['5.2.0'],
  );
  assert.equal(store.artifacts.size, 1);
});

test('findByTarball returns an empty list when every approval expired', () => {
  const clock = {};
  const store = createStoreAt(clock);
  store.register([artifact]);

  clock.nowMs = EXPIRES_AT_MS;

  assert.deepEqual(store.findByTarball('express', 'express-5.2.1.tgz'), []);
  assert.equal(store.artifacts.size, 0);
});

test('size counts only active approvals and purges the rest', () => {
  const clock = {};
  const store = createStoreAt(clock);
  store.register([artifact]);

  clock.nowMs = FIXED_NOW_MS + 30 * 1000;
  store.register([olderVersion]);

  clock.nowMs = EXPIRES_AT_MS;

  assert.equal(store.size, 1);
  assert.equal(store.artifacts.size, 1);
});

test('size drops to zero once every approval expired', () => {
  const clock = {};
  const store = createStoreAt(clock);
  store.register([artifact, olderVersion]);

  assert.equal(store.size, 2);

  clock.nowMs = EXPIRES_AT_MS;

  assert.equal(store.size, 0);
  assert.equal(store.artifacts.size, 0);
});

test('re-registering an expired approval stores fresh timestamps', () => {
  const clock = {};
  const store = createStoreAt(clock);
  store.register([artifact]);

  clock.nowMs = EXPIRES_AT_MS;
  assert.equal(store.has(artifact), false);

  store.register([artifact]);

  const [stored] = store.findByPackage('express');
  assert.equal(stored.registeredAt, new Date(EXPIRES_AT_MS).toISOString());
  assert.equal(
    stored.expiresAt,
    new Date(EXPIRES_AT_MS + TTL_SECONDS * 1000).toISOString(),
  );
  assert.equal(store.has(artifact), true);
  assert.equal(store.size, 1);
});

test('treats an approval without a readable expiry as expired', () => {
  const store = createStore();
  // register 를 거치면 항상 채워지는 값이라 직접 넣어 확인한다.
  store.artifacts.set(ApprovalStore.keyOf(artifact), { ...artifact });

  assert.equal(store.has(artifact), false);
  assert.equal(store.findByPackage('express').length, 0);
});

test('isExpired uses expiresAt as the first expired moment', () => {
  const approval = { expiresAt: FIXED_NOW_ISO };

  assert.equal(isExpired(approval, FIXED_NOW_MS - 1), false);
  assert.equal(isExpired(approval, FIXED_NOW_MS), true);
  assert.equal(isExpired(approval, FIXED_NOW_MS + 1), true);
  assert.equal(isExpired({}, FIXED_NOW_MS), true);
});

test('purges expired approvals of other packages when a new one is registered', () => {
  const clock = {};
  const store = createStoreAt(clock);
  store.register([artifact]);

  clock.nowMs = EXPIRES_AT_MS;
  store.register([
    {
      packageName: 'lodash',
      version: '4.17.21',
      integrity: 'sha512-lodash',
      filename: 'lodash-4.17.21.tgz',
    },
  ]);

  // express 를 조회하지 않았는데도 등록 시점에 정리된다.
  assert.equal(store.artifacts.size, 1);
  assert.equal(store.findByPackage('express').length, 0);
});

test('reads the clock once when registering a batch', () => {
  let call = 0;
  const store = new ApprovalStore({
    ttlSeconds: TTL_SECONDS,
    now: () => {
      call += 1;
      return FIXED_NOW_MS;
    },
  });

  // 만료 정리와 시각 계산이 같은 기준 시각을 쓴다.
  store.register([artifact]);

  assert.equal(call, 1);
});

// ---------------------------------------------------------------------------
// Integrity 충돌 (#191)
// ---------------------------------------------------------------------------

// 같은 파일을 가리키지만 integrity 가 다른 승인.
const conflicting = { ...artifact, version: '5.3.0', integrity: 'sha512-other' };

test('rejects a new approval that reuses a filename with a different integrity', () => {
  const store = createStore();
  store.register([artifact]);

  assert.throws(
    () => store.register([conflicting]),
    (error) =>
      error instanceof ApprovalConflictError &&
      /conflicting integrity for tarball: express\/express-5\.2\.1\.tgz/.test(
        error.message,
      ),
  );
});

test('keeps the existing approval untouched when a conflict is rejected', () => {
  const store = createStore();
  store.register([artifact]);
  const [before] = store.findByPackage('express');

  assert.throws(() => store.register([conflicting]), ApprovalConflictError);

  const active = store.findByPackage('express');
  assert.equal(active.length, 1);
  assert.equal(active[0].integrity, artifact.integrity);
  assert.equal(active[0].registeredAt, before.registeredAt);
  assert.equal(active[0].expiresAt, before.expiresAt);
});

test('registers nothing when one package of a batch conflicts', () => {
  const store = createStore();
  store.register([artifact]);

  assert.throws(
    () =>
      store.register([
        {
          packageName: 'lodash',
          version: '4.17.21',
          integrity: 'sha512-lodash',
          filename: 'lodash-4.17.21.tgz',
        },
        conflicting,
      ]),
    ApprovalConflictError,
  );

  // 충돌하지 않는 lodash 도 등록되지 않는다.
  assert.equal(store.findByPackage('lodash').length, 0);
  assert.equal(store.size, 1);
});

test('rejects a conflict inside a single request body', () => {
  const store = createStore();

  assert.throws(
    () => store.register([artifact, conflicting]),
    ApprovalConflictError,
  );

  assert.equal(store.size, 0);
});

test('allows the same file and integrity across different versions', () => {
  const store = createStore();

  store.register([artifact, { ...artifact, version: '5.2.0' }]);

  assert.equal(store.size, 2);
  assert.equal(store.findByTarball('express', 'express-5.2.1.tgz').length, 2);
});

test('allows the same filename under a different package', () => {
  const store = createStore();
  store.register([artifact]);

  store.register([
    {
      packageName: 'express-legacy',
      version: '5.2.1',
      integrity: 'sha512-other',
      filename: 'express-5.2.1.tgz',
    },
  ]);

  assert.equal(store.size, 2);
});

test('allows a different filename under the same package', () => {
  const store = createStore();
  store.register([artifact]);

  store.register([olderVersion]);

  assert.equal(store.size, 2);
});

test('allows re-registering the identical approval', () => {
  const store = createStore();
  store.register([artifact]);
  store.register([artifact]);

  assert.equal(store.size, 1);
});

test('ignores an expired approval when checking for conflicts', () => {
  const clock = {};
  const store = createStoreAt(clock);
  store.register([artifact]);

  clock.nowMs = EXPIRES_AT_MS;
  store.register([conflicting]);

  const active = store.findByPackage('express');
  assert.equal(active.length, 1);
  assert.equal(active[0].integrity, conflicting.integrity);
  assert.equal(active[0].registeredAt, new Date(EXPIRES_AT_MS).toISOString());
});

test('findConflictingIntegrity looks only inside the given batch', () => {
  assert.equal(findConflictingIntegrity([artifact, olderVersion]), undefined);
  assert.equal(
    findConflictingIntegrity([artifact, { ...artifact, version: '5.2.0' }]),
    undefined,
  );

  const conflict = findConflictingIntegrity([artifact, conflicting]);
  assert.equal(conflict.artifact.version, conflicting.version);
  assert.equal(conflict.conflictsWith.version, artifact.version);
});

test('findIntegrityConflict reports the conflicting pair without throwing', () => {
  const store = createStore();
  store.register([artifact]);

  assert.equal(store.findIntegrityConflict([olderVersion]), undefined);

  const conflict = store.findIntegrityConflict([conflicting]);
  assert.equal(conflict.artifact.integrity, conflicting.integrity);
  assert.equal(conflict.conflictsWith.integrity, artifact.integrity);
});

test('listActive returns active approvals and removes expired entries', () => {
  const clock = {};
  const store = createStoreAt(clock);
  store.register([artifact]);

  assert.equal(store.listActive().length, 1);
  clock.nowMs = EXPIRES_AT_MS;
  assert.deepEqual(store.listActive(), []);
  assert.equal(store.size, 0);
});

test('revokeByPackageVersion removes every matching active approval', () => {
  const store = createStore();
  store.register([
    artifact,
    { ...artifact, integrity: 'sha512-second', filename: 'express-alt.tgz' },
    olderVersion,
  ]);

  assert.equal(store.revokeByPackageVersion('express', '5.2.1'), 2);
  assert.equal(store.findByPackage('express').length, 1);
  assert.equal(store.findByPackage('express')[0].version, olderVersion.version);
});

test('revokeByPackageVersion ignores expired and unrelated approvals', () => {
  const clock = {};
  const store = createStoreAt(clock);
  store.register([artifact, { ...olderVersion, packageName: 'lodash' }]);
  clock.nowMs = EXPIRES_AT_MS;

  assert.equal(store.revokeByPackageVersion('express', '5.2.1'), 0);
  assert.equal(store.size, 0);
});
