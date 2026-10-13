'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  SERVICE_TOKEN_ENV,
  UNAUTHORIZED_RESPONSE,
  configuredServiceToken,
  isAuthorizedServiceRequest,
  protectApprovalHandler,
  readServiceToken,
} = require('../../shared/service-auth');

const TOKEN = 'test-only-service-token';

// Authorization: Bearer <token> 형태로 보낸다.
function bearer(token) {
  return { authorization: `Bearer ${token}` };
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

test('reads the configured token only when it is a non-empty string', () => {
  assert.equal(configuredServiceToken({ [SERVICE_TOKEN_ENV]: TOKEN }), TOKEN);
  assert.equal(configuredServiceToken({ [SERVICE_TOKEN_ENV]: '' }), undefined);
  assert.equal(configuredServiceToken({}), undefined);
});

test('trims a configured token that arrived with surrounding whitespace', () => {
  // Secret 을 파일로 주입하면 끝에 개행이 붙는 경우가 있다.
  assert.equal(configuredServiceToken({ [SERVICE_TOKEN_ENV]: `${TOKEN}
` }), TOKEN);
  assert.equal(configuredServiceToken({ [SERVICE_TOKEN_ENV]: `  ${TOKEN}  ` }), TOKEN);
  assert.equal(configuredServiceToken({ [SERVICE_TOKEN_ENV]: '   ' }), undefined);
});

test('records one audit event for an unauthorized request without the token', async () => {
  const events = [];
  const handler = protectApprovalHandler(
    () => assert.fail('handler must not run'),
    {
      expectedToken: TOKEN,
      auditLogger: { recordFields: (fields) => events.push(fields) },
    },
  );

  await handler(
    { headers: { ...bearer('wrong'), 'x-request-id': 'req-probe' } },
    createResponse(),
  );

  assert.deepEqual(events, [{
    action: 'service_auth.rejected',
    result: 'failure',
    requestId: 'req-probe',
    statusCode: 401,
    reason: 'invalid_service_token',
  }]);
  assert.equal(JSON.stringify(events).includes(TOKEN), false);
  assert.equal(JSON.stringify(events).includes('wrong'), false);
});

test('audit sink failures do not change an unauthorized response', async () => {
  const handler = protectApprovalHandler(
    () => assert.fail('handler must not run'),
    {
      expectedToken: TOKEN,
      auditLogger: { recordFields() { throw new Error('audit sink down'); } },
    },
  );
  const response = createResponse();

  await handler({ headers: {} }, response);

  assert.equal(response.statusCode, 401);
  assert.deepEqual(response.body, UNAUTHORIZED_RESPONSE);
});

test('reads the bearer credential from a single Authorization header', () => {
  assert.equal(readServiceToken({ headers: bearer(TOKEN) }), TOKEN);
  assert.equal(readServiceToken({ headers: { authorization: 'Bearer ' } }), undefined);
  assert.equal(readServiceToken({ headers: { authorization: [`Bearer ${TOKEN}`] } }), undefined);
});

test('accepts the bearer scheme in any case and ignores surrounding spaces', () => {
  assert.equal(readServiceToken({ headers: { authorization: `bearer ${TOKEN}` } }), TOKEN);
  assert.equal(readServiceToken({ headers: { authorization: `BEARER ${TOKEN}` } }), TOKEN);
  assert.equal(readServiceToken({ headers: { authorization: `Bearer  ${TOKEN} ` } }), TOKEN);
});

test('rejects an Authorization header that is not a bearer credential', () => {
  // Basic 자격증명을 Token 으로 읽으면 npm Client 의 로그인 Header 가
  // Approval API 인증으로 흘러든다.
  assert.equal(readServiceToken({ headers: { authorization: `Basic ${TOKEN}` } }), undefined);
  assert.equal(readServiceToken({ headers: { authorization: TOKEN } }), undefined);
  assert.equal(readServiceToken({ headers: { authorization: 'Bearer' } }), undefined);
});

test('authorizes only an exact token and safely rejects different lengths', () => {
  assert.equal(isAuthorizedServiceRequest({
    headers: bearer(TOKEN),
  }, TOKEN), true);
  assert.equal(isAuthorizedServiceRequest({
    headers: bearer(`${TOKEN}-longer`),
  }, TOKEN), false);
  assert.equal(isAuthorizedServiceRequest({
    headers: bearer('short'),
  }, TOKEN), false);
});

test('fails closed when the configured token or request header is missing', () => {
  assert.equal(isAuthorizedServiceRequest({ headers: {} }, TOKEN), false);
  assert.equal(isAuthorizedServiceRequest({
    headers: bearer(TOKEN),
  }, undefined), false);
});

test('returns the same fixed 401 response without invoking the protected handler', async () => {
  let invoked = false;
  const handler = protectApprovalHandler(() => {
    invoked = true;
  }, { expectedToken: TOKEN });

  for (const request of [
    { headers: {} },
    { headers: { authorization: 'Bearer ' } },
    { headers: bearer('wrong') },
  ]) {
    const response = createResponse();
    await handler(request, response);
    assert.equal(response.statusCode, 401);
    assert.deepEqual(response.body, UNAUTHORIZED_RESPONSE);
  }

  assert.equal(invoked, false);
});

test('invokes the protected handler when the token matches', async () => {
  let invoked = false;
  const handler = protectApprovalHandler(() => {
    invoked = true;
  }, { expectedToken: TOKEN });
  const response = createResponse();

  await handler({ headers: bearer(TOKEN) }, response);

  assert.equal(invoked, true);
  assert.equal(response.statusCode, undefined);
});

test('logger failures do not change an unauthorized response', async () => {
  const handler = protectApprovalHandler(() => {
    assert.fail('protected handler must not run');
  }, {
    expectedToken: TOKEN,
    logger: {
      warn() {
        throw new Error('logger unavailable');
      },
    },
  });
  const response = createResponse();

  await handler({ headers: {} }, response);

  assert.equal(response.statusCode, 401);
  assert.deepEqual(response.body, UNAUTHORIZED_RESPONSE);
});

test('unauthorized logs do not expose provided or configured tokens', async () => {
  const entries = [];
  const providedToken = 'different-test-token';
  const handler = protectApprovalHandler(() => {
    assert.fail('protected handler must not run');
  }, {
    expectedToken: TOKEN,
    logger: {
      warn(...args) {
        entries.push(args);
      },
    },
  });

  await handler({
    headers: bearer(providedToken),
    body: { secret: TOKEN },
  }, createResponse());

  const serialized = JSON.stringify(entries);
  assert.equal(serialized.includes(TOKEN), false);
  assert.equal(serialized.includes(providedToken), false);
  assert.equal(serialized.includes('secret'), false);
});
