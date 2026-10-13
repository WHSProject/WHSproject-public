'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  CheckRequestError,
  validateCheckRequest,
} = require('../src/check-request');

test('returns the requested targets in order', () => {
  assert.deepEqual(
    validateCheckRequest({
      packages: [
        { packageName: 'is-odd', version: '3.0.1' },
        { packageName: '@whs/example', version: '1.0.0' },
      ],
    }),
    [
      { packageName: 'is-odd', version: '3.0.1' },
      { packageName: '@whs/example', version: '1.0.0' },
    ],
  );
});

test('checks a package and version only once per request', () => {
  assert.deepEqual(
    validateCheckRequest({
      packages: [
        { packageName: 'is-odd', version: '3.0.1' },
        { packageName: 'is-odd', version: '3.0.1' },
        { packageName: 'is-odd', version: '3.0.0' },
      ],
    }),
    [
      { packageName: 'is-odd', version: '3.0.1' },
      { packageName: 'is-odd', version: '3.0.0' },
    ],
  );
});

test('drops fields other than the package name and version', () => {
  assert.deepEqual(
    validateCheckRequest({
      packages: [{ packageName: 'is-odd', version: '3.0.1', integrity: 'sha512-x' }],
    }),
    [{ packageName: 'is-odd', version: '3.0.1' }],
  );
});

test('rejects a body that is not a JSON object', () => {
  for (const body of [undefined, null, [], 'packages', 42]) {
    assert.throws(() => validateCheckRequest(body), CheckRequestError);
  }
});

test('rejects an empty or missing package list', () => {
  for (const body of [{}, { packages: [] }, { packages: 'is-odd' }]) {
    assert.throws(() => validateCheckRequest(body), CheckRequestError);
  }
});

test('rejects entries with missing or empty fields', () => {
  const invalid = [
    null,
    'is-odd',
    {},
    { packageName: 'is-odd' },
    { version: '3.0.1' },
    { packageName: '', version: '3.0.1' },
    { packageName: 'is-odd', version: '' },
    { packageName: 42, version: '3.0.1' },
  ];

  for (const entry of invalid) {
    assert.throws(
      () => validateCheckRequest({ packages: [entry] }),
      CheckRequestError,
      JSON.stringify(entry),
    );
  }
});

test('rejects package names that could leave the storage root', () => {
  for (const packageName of ['../etc', 'a/b/c', 'scope/name', '@scope/../x', '..']) {
    assert.throws(
      () => validateCheckRequest({ packages: [{ packageName, version: '1.0.0' }] }),
      CheckRequestError,
      packageName,
    );
  }
});

test('does not echo the rejected value in the error message', () => {
  const secret = 'value-sent-by-the-caller';

  assert.throws(
    () => validateCheckRequest({ packages: [{ packageName: `../${secret}`, version: '1' }] }),
    (error) => error instanceof CheckRequestError && !error.message.includes(secret),
  );
});
