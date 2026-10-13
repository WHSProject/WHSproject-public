'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  ApprovalRequestError,
  validateApprovalRequest,
} = require('../src/approval-request');

test('validates and normalizes an approval request', () => {
  const result = validateApprovalRequest({
    requestId: ' req-123 ',
    packages: [
      {
        packageName: ' express ',
        version: ' 5.2.1 ',
        integrity: ' sha512-approved ',
      },
    ],
  });

  assert.deepEqual(result, {
    requestId: 'req-123',
    packages: [
      {
        packageName: 'express',
        version: '5.2.1',
        integrity: 'sha512-approved',
      },
    ],
  });
});

test('rejects an empty package list', () => {
  assert.throws(
    () => validateApprovalRequest({ requestId: 'req-123', packages: [] }),
    ApprovalRequestError,
  );
});

test('rejects an artifact with a missing identity field', () => {
  assert.throws(
    () =>
      validateApprovalRequest({
        requestId: 'req-123',
        packages: [{ packageName: 'express', version: '5.2.1' }],
      }),
    /integrity must be a non-empty string/,
  );
});

test('rejects a null integrity', () => {
  assert.throws(
    () =>
      validateApprovalRequest({
        requestId: 'req-123',
        packages: [{ packageName: 'express', version: '5.2.1', integrity: null }],
      }),
    /integrity must be a non-empty string/,
  );
});
