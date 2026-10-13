'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { classifyRequest } = require('../src/request-classifier');

function request(method, path) {
  return { method, path };
}

test('classifies the npm login request', () => {
  // npm CLI 가 Basic Header 와 함께 보내는 실제 로그인 경로.
  assert.deepEqual(
    classifyRequest(request('PUT', '/-/user/org.couchdb.user:admin')),
    { action: 'login', actor: 'admin' },
  );
});

test('classifies the revision form of the login request', () => {
  assert.deepEqual(
    classifyRequest(
      request('PUT', '/-/user/org.couchdb.user:admin/-rev/1-abc'),
    ),
    { action: 'login', actor: 'admin' },
  );
});

test('skips the user document read that only fetches a revision', () => {
  assert.equal(
    classifyRequest(request('GET', '/-/user/org.couchdb.user:admin')),
    undefined,
  );
  assert.equal(
    classifyRequest(request('HEAD', '/-/user/org.couchdb.user:admin')),
    undefined,
  );
});

test('ignores user paths that are not a document write', () => {
  assert.equal(classifyRequest(request('PUT', '/-/user')), undefined);
  assert.equal(
    classifyRequest(request('PUT', '/-/user/org.couchdb.user:admin/-rev')),
    undefined,
  );
});

test('omits the actor when the user document has an unexpected shape', () => {
  assert.deepEqual(classifyRequest(request('PUT', '/-/user/admin')), {
    action: 'login',
    actor: undefined,
  });
});

test('classifies a package publish', () => {
  assert.deepEqual(classifyRequest(request('PUT', '/is-number')), {
    action: 'publish',
    packageName: 'is-number',
  });
});

test('classifies a scoped publish in both path forms', () => {
  assert.deepEqual(classifyRequest(request('PUT', '/@whs/example')), {
    action: 'publish',
    packageName: '@whs/example',
  });
  assert.deepEqual(classifyRequest(request('PUT', '/@whs%2Fexample')), {
    action: 'publish',
    packageName: '@whs/example',
  });
});

test('classifies the unpublish request shapes', () => {
  // Version 단위 Unpublish 의 Metadata 수정.
  assert.deepEqual(classifyRequest(request('PUT', '/@whs%2Fexample/-rev/3-abc')), {
    action: 'unpublish',
    packageName: '@whs/example',
  });
  // Package 전체 삭제.
  assert.deepEqual(classifyRequest(request('DELETE', '/is-number/-rev/3-abc')), {
    action: 'unpublish',
    packageName: 'is-number',
  });
  // Tarball 삭제.
  assert.deepEqual(
    classifyRequest(
      request('DELETE', '/is-number/-/is-number-7.0.0.tgz/-rev/3-abc'),
    ),
    { action: 'unpublish', packageName: 'is-number' },
  );
});

test('ignores read requests on the same paths', () => {
  assert.equal(classifyRequest(request('GET', '/is-number')), undefined);
  assert.equal(classifyRequest(request('HEAD', '/is-number')), undefined);
  assert.equal(classifyRequest(request('GET', '/is-number/7.0.0')), undefined);
  assert.equal(
    classifyRequest(request('GET', '/is-number/-/is-number-7.0.0.tgz')),
    undefined,
  );
  assert.equal(
    classifyRequest(request('HEAD', '/@whs%2Fexample/-/example-1.0.0.tgz')),
    undefined,
  );
});

test('ignores health checks and internal endpoints', () => {
  assert.equal(classifyRequest(request('GET', '/-/ping')), undefined);
  assert.equal(classifyRequest(request('POST', '/-/whs/approvals')), undefined);
  assert.equal(classifyRequest(request('GET', '/-/whs/approvals')), undefined);
  assert.equal(classifyRequest(request('GET', '/')), undefined);
});

test('does not mistake similar paths for a publish or unpublish', () => {
  // 버전 경로에 대한 쓰기는 Publish 형식이 아니다.
  assert.equal(classifyRequest(request('PUT', '/is-number/7.0.0')), undefined);
  // dist-tag 경로는 이번 범위가 아니다.
  assert.equal(
    classifyRequest(request('PUT', '/-/package/is-number/dist-tags/latest')),
    undefined,
  );
  // -rev 가 아닌 세그먼트가 낀 경로.
  assert.equal(
    classifyRequest(request('DELETE', '/is-number/-notrev/3-abc')),
    undefined,
  );
  // Scope 만 있고 이름이 없는 경로.
  assert.equal(classifyRequest(request('PUT', '/@whs')), undefined);
  assert.equal(classifyRequest(request('PUT', '/@whs/')), undefined);
});

test('reads the path even when only url is available', () => {
  assert.deepEqual(
    classifyRequest({ method: 'PUT', url: '/@whs%2Fexample?write=true' }),
    { action: 'publish', packageName: '@whs/example' },
  );
});

test('ignores a request whose path cannot be decoded', () => {
  assert.equal(classifyRequest(request('PUT', '/%E0%A4%A')), undefined);
});

test('ignores a request without a usable method', () => {
  assert.equal(classifyRequest({ path: '/is-number' }), undefined);
  assert.equal(classifyRequest(undefined), undefined);
});
