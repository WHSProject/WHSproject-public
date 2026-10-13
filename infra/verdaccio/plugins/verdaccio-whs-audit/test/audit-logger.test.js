'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  AUDIT_LOG_MESSAGE,
  createAuditLogger,
  levelOf,
} = require('../src/audit-logger');

function createRecordingLogger() {
  const calls = [];

  return {
    calls,
    info(event, message) {
      calls.push({ level: 'info', event, message });
    },
    warn(event, message) {
      calls.push({ level: 'warn', event, message });
    },
  };
}

test('sends successful events to info and failed events to warn', () => {
  assert.equal(levelOf({ result: 'success' }), 'info');
  assert.equal(levelOf({ result: 'failure' }), 'warn');
});

test('falls back to info for an event without a usable result', () => {
  assert.equal(levelOf({}), 'info');
  assert.equal(levelOf(undefined), 'info');
});

test('writes the event and the label through the chosen level', () => {
  const logger = createRecordingLogger();
  const auditLogger = createAuditLogger({ logger });

  auditLogger.record({ eventType: 'audit', result: 'success' });
  auditLogger.record({ eventType: 'audit', result: 'failure' });

  assert.deepEqual(
    logger.calls.map((call) => [call.level, call.message]),
    [
      ['info', AUDIT_LOG_MESSAGE],
      ['warn', AUDIT_LOG_MESSAGE],
    ],
  );
  assert.equal(logger.calls[0].event.eventType, 'audit');
});

test('swallows a logger failure so the registry request keeps going', () => {
  const auditLogger = createAuditLogger({
    logger: {
      info() {
        throw new Error('logger is broken');
      },
      warn() {
        throw new Error('logger is broken');
      },
    },
  });

  assert.doesNotThrow(() => auditLogger.record({ result: 'success' }));
  assert.doesNotThrow(() => auditLogger.record({ result: 'failure' }));
});

test('tolerates a logger without the level it needs', () => {
  const auditLogger = createAuditLogger({ logger: {} });

  assert.doesNotThrow(() => auditLogger.record({ result: 'failure' }));
});

test('uses the injected clock so tests stay deterministic', () => {
  const fixedNowMs = Date.UTC(2026, 0, 2, 3, 4, 5);
  const auditLogger = createAuditLogger({
    logger: createRecordingLogger(),
    now: () => fixedNowMs,
  });

  assert.equal(auditLogger.now(), fixedNowMs);
});
