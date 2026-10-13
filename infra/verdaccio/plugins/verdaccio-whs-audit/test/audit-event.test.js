'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildAuditEvent,
  reasonOf,
  resultOf,
} = require('../src/audit-event');

// 실제 시간이 흐르기를 기다리지 않도록 고정 시각을 넘긴다.
const FIXED_NOW_MS = Date.UTC(2026, 0, 2, 3, 4, 5);
const FIXED_NOW_ISO = '2026-01-02T03:04:05.000Z';

test('always includes the required fields', () => {
  const event = buildAuditEvent(
    { action: 'login', result: 'success' },
    FIXED_NOW_MS,
  );

  assert.deepEqual(event, {
    eventType: 'audit',
    timestamp: FIXED_NOW_ISO,
    action: 'login',
    result: 'success',
  });
});

test('marks every event with the audit type', () => {
  const event = buildAuditEvent(
    { action: 'publish', result: 'failure' },
    FIXED_NOW_MS,
  );

  assert.equal(event.eventType, 'audit');
});

test('writes the timestamp as an ISO 8601 string in UTC', () => {
  const event = buildAuditEvent(
    { action: 'login', result: 'success' },
    FIXED_NOW_MS,
  );

  assert.equal(event.timestamp, FIXED_NOW_ISO);
  assert.equal(new Date(event.timestamp).toISOString(), event.timestamp);
});

test('keeps optional fields only when they carry a value', () => {
  const event = buildAuditEvent(
    {
      action: 'publish',
      result: 'success',
      packageName: '@whs/example',
      statusCode: 201,
      actor: undefined,
      actorRole: null,
      sourceIp: '',
      version: '   ',
    },
    FIXED_NOW_MS,
  );

  assert.equal(event.packageName, '@whs/example');
  assert.equal(event.statusCode, 201);
  assert.equal('actor' in event, false);
  assert.equal('actorRole' in event, false);
  assert.equal('sourceIp' in event, false);
  assert.equal('version' in event, false);
});

test('drops fields that are not on the allowlist', () => {
  const event = buildAuditEvent(
    {
      action: 'login',
      result: 'failure',
      password: 'hunter2',
      authorization: 'Bearer token-value',
      cookie: 'session=abc',
      headers: { authorization: 'Bearer token-value' },
      body: { _attachments: {} },
      secret: 'service-token',
    },
    FIXED_NOW_MS,
  );

  const serialized = JSON.stringify(event);
  for (const leaked of [
    'password',
    'hunter2',
    'authorization',
    'Bearer',
    'cookie',
    'session',
    'headers',
    'body',
    '_attachments',
    'secret',
    'service-token',
  ]) {
    assert.equal(
      serialized.includes(leaked),
      false,
      `${leaked} 이(가) Audit Event 에 남았다`,
    );
  }
});

test('rejects values that are not plain strings or finite numbers', () => {
  const event = buildAuditEvent(
    {
      action: 'publish',
      result: 'success',
      actor: { name: 'admin' },
      packageName: ['@whs/example'],
      statusCode: Number.NaN,
      reason: Infinity,
    },
    FIXED_NOW_MS,
  );

  assert.deepEqual(Object.keys(event), [
    'eventType',
    'timestamp',
    'action',
    'result',
  ]);
});

test('treats only 2xx responses as success', () => {
  assert.equal(resultOf(200), 'success');
  assert.equal(resultOf(201), 'success');
  assert.equal(resultOf(299), 'success');
  assert.equal(resultOf(199), 'failure');
  assert.equal(resultOf(401), 'failure');
  assert.equal(resultOf(500), 'failure');
});

test('derives a short reason from the status code', () => {
  assert.equal(reasonOf(200), undefined);
  assert.equal(reasonOf(401), 'unauthorized');
  assert.equal(reasonOf(403), 'forbidden');
  assert.equal(reasonOf(404), 'not_found');
  assert.equal(reasonOf(409), 'conflict');
  assert.equal(reasonOf(422), 'client_error');
  assert.equal(reasonOf(503), 'server_error');
});
