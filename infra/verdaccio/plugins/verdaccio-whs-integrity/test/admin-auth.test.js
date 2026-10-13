'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  DEFAULT_ALLOWED_USERS,
  authorizeAdmin,
  resolveAllowedUsers,
} = require('../src/admin-auth');

test('allows only admin when nothing is configured', () => {
  assert.equal(resolveAllowedUsers(undefined), DEFAULT_ALLOWED_USERS);
  assert.deepEqual([...DEFAULT_ALLOWED_USERS], ['admin']);
});

test('falls back to admin only and warns on an invalid list', () => {
  for (const value of [[], 'admin', [''], [42], null, {}]) {
    const warnings = [];
    const users = resolveAllowedUsers(value, { warn: (message) => warnings.push(message) });

    assert.deepEqual([...users], ['admin'], JSON.stringify(value));
    assert.equal(warnings.length, 1, JSON.stringify(value));
  }
});

test('keeps the valid names of a configured list', () => {
  assert.deepEqual(
    [...resolveAllowedUsers(['admin', ' ops ', 'admin', ''])],
    ['admin', 'ops'],
  );
});

test('answers 401 when nobody is logged in', () => {
  assert.equal(authorizeAdmin({}).status, 401);
  // Verdaccio 가 미로그인 요청에 넣어주는 모양이다.
  assert.equal(
    authorizeAdmin({ remote_user: { groups: ['$all', '$anonymous'] } }).status,
    401,
  );
  assert.equal(authorizeAdmin({ remote_user: { name: '' } }).status, 401);
});

test('answers 403 for logged in accounts that are not allowed', () => {
  for (const name of ['whs-ci', 'developer']) {
    const result = authorizeAdmin({ remote_user: { name } });

    assert.equal(result.status, 403);
    assert.equal(result.name, name);
  }
});

test('accepts an allowed account', () => {
  assert.deepEqual(authorizeAdmin({ remote_user: { name: 'admin' } }), {
    status: 200,
    name: 'admin',
  });
  assert.equal(
    authorizeAdmin({ remote_user: { name: 'ops' } }, ['admin', 'ops']).status,
    200,
  );
});
