'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  MAX_INTERVAL_SECONDS,
  MIN_INTERVAL_SECONDS,
  resolveIntervalSeconds,
  startScheduler,
} = require('../src/scheduler');

function createTimers() {
  const timers = {
    intervals: [],
    cleared: [],
    unrefCalls: 0,
    setInterval(fn, ms) {
      const handle = {
        fn,
        ms,
        unref() {
          timers.unrefCalls += 1;
        },
      };
      timers.intervals.push(handle);
      return handle;
    },
    clearInterval(handle) {
      timers.cleared.push(handle);
    },
  };
  return timers;
}

test('stays off without a warning when the interval is not set or turned off', () => {
  for (const value of [undefined, null, false, 0]) {
    const warnings = [];
    assert.equal(resolveIntervalSeconds(value, { warn: (message) => warnings.push(message) }), null);
    assert.deepEqual(warnings, [], String(value));
  }
});

test('accepts whole seconds within the allowed range', () => {
  assert.equal(resolveIntervalSeconds(MIN_INTERVAL_SECONDS), MIN_INTERVAL_SECONDS);
  assert.equal(resolveIntervalSeconds(3600), 3600);
  assert.equal(resolveIntervalSeconds(MAX_INTERVAL_SECONDS), MAX_INTERVAL_SECONDS);
});

test('warns and stays off for an interval it cannot use', () => {
  const invalid = [30, MIN_INTERVAL_SECONDS - 1, 90.5, '3600', -60, MAX_INTERVAL_SECONDS + 1, Number.NaN, true];

  for (const value of invalid) {
    const warnings = [];
    assert.equal(
      resolveIntervalSeconds(value, { warn: (message) => warnings.push(message) }),
      null,
      String(value),
    );
    assert.equal(warnings.length, 1, String(value));
  }
});

test('waits one interval before the first run and does not hold the process open', () => {
  const timers = createTimers();
  let runs = 0;

  startScheduler({
    intervalSeconds: 600,
    runOnce: async () => {
      runs += 1;
    },
    timers,
  });

  assert.equal(timers.intervals.length, 1);
  assert.equal(timers.intervals[0].ms, 600 * 1000);
  assert.equal(timers.unrefCalls, 1);
  // 기동 직후에는 실행하지 않는다.
  assert.equal(runs, 0);
});

test('runs on every tick of the timer', async () => {
  const timers = createTimers();
  let runs = 0;
  const scheduler = startScheduler({
    intervalSeconds: 60,
    runOnce: async () => {
      runs += 1;
    },
    timers,
  });

  timers.intervals[0].fn();
  await scheduler.tick();

  assert.equal(runs, 2);
});

test('logs a crashed run and keeps the timer alive', async () => {
  const timers = createTimers();
  const errors = [];
  const scheduler = startScheduler({
    intervalSeconds: 60,
    runOnce: async () => {
      throw new Error('run exploded');
    },
    logger: { error: (payload, message) => errors.push({ payload, message }) },
    timers,
  });

  await scheduler.tick();

  assert.equal(errors.length, 1);
  assert.equal(errors[0].payload.err.message, 'run exploded');
  assert.deepEqual(timers.cleared, []);
});

test('stops the timer on request', () => {
  const timers = createTimers();
  const scheduler = startScheduler({ intervalSeconds: 60, runOnce: async () => {}, timers });

  scheduler.stop();

  assert.deepEqual(timers.cleared, [timers.intervals[0]]);
});
