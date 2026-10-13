'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  CheckBusyError,
  createCheckRunner,
  summarize,
} = require('../src/check-runner');

const target = (packageName, version = '1.0.0') => ({ packageName, version });

// 거부가 빠지면 두 번째 실행이 첫 실행을 기다리며 멈춘다. 멈춘 채 Test 가 취소되지
// 않고 바로 실패하도록, 짧게 기다려 그때까지의 결과를 돌려준다.
function settleWithin(promise, ms) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve('still running'), ms);
  });
  return Promise.race([
    promise.then(() => 'resolved', (error) => error),
    timeout,
  ]).finally(() => clearTimeout(timer));
}

test('verifies targets one at a time in the requested order', async () => {
  let active = 0;
  let maxActive = 0;
  const seen = [];
  const storage = { marker: 'storage' };
  const runner = createCheckRunner({
    storage,
    verify: async (receivedStorage, received) => {
      assert.equal(receivedStorage, storage);
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setImmediate(resolve));
      seen.push(received.packageName);
      active -= 1;
      return { status: 'PASS', ...received };
    },
  });

  const results = await runner.run([target('a'), target('b'), target('c')]);

  assert.deepEqual(seen, ['a', 'b', 'c']);
  assert.equal(maxActive, 1);
  assert.deepEqual(results.map((result) => result.packageName), ['a', 'b', 'c']);
});

test('refuses a second run while one is in progress', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const runner = createCheckRunner({
    verify: async (_storage, received) => {
      calls += 1;
      await gate;
      return { status: 'PASS', ...received };
    },
  });

  const first = runner.run([target('a')]);
  assert.equal(runner.isRunning(), true);

  const outcome = await settleWithin(runner.run([target('b')]), 100);
  assert.ok(outcome instanceof CheckBusyError, `second run was ${String(outcome)}`);
  // 거부된 실행은 해싱을 시작하지 않는다.
  assert.equal(calls, 1);

  release();
  await first;
  assert.equal(runner.isRunning(), false);
});

test('releases the running state after a successful run', async () => {
  const runner = createCheckRunner({
    verify: async (_storage, received) => ({ status: 'PASS', ...received }),
  });

  await runner.run([target('a')]);
  await runner.run([target('b')]);

  assert.equal(runner.isRunning(), false);
});

test('releases the running state when verification throws', async () => {
  const runner = createCheckRunner({
    verify: async () => {
      throw new Error('storage exploded');
    },
  });

  await assert.rejects(runner.run([target('a')]), /storage exploded/);
  assert.equal(runner.isRunning(), false);
  // 다음 실행은 Busy 가 아니라 다시 검사를 시도해야 한다.
  await assert.rejects(runner.run([target('a')]), /storage exploded/);
});

test('summarizes results by status', () => {
  assert.deepEqual(
    summarize([
      { status: 'PASS' },
      { status: 'FAIL' },
      { status: 'UNVERIFIABLE' },
      { status: 'UNVERIFIABLE' },
    ]),
    { total: 4, pass: 1, fail: 1, unverifiable: 2 },
  );
  assert.deepEqual(summarize([]), { total: 0, pass: 0, fail: 0, unverifiable: 0 });
});
