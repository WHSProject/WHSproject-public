import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import {
  GuardDogProcessRunner,
  guardDogEnvironment,
  type GuardDogProcessGroupKill,
  type GuardDogSpawn,
} from '../src/analyzers/guarddog/guarddog-process.runner';
import type { GuardDogProcessRequest } from '../src/analyzers/guarddog/guarddog.types';

interface MockChild extends EventEmitter {
  pid: number | undefined;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: jest.Mock<boolean, [NodeJS.Signals?]>;
  unref: jest.Mock;
}

function childProcess(pid: number | null = 321): MockChild {
  return Object.assign(new EventEmitter(), {
    pid: pid ?? undefined,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: jest.fn(() => true),
    unref: jest.fn(),
  });
}

function request(overrides: Partial<GuardDogProcessRequest> = {}): GuardDogProcessRequest {
  return {
    executable: 'guarddog',
    args: ['npm', 'scan', '/canonical/extracted', '--output-format=json'],
    timeoutMs: 1_000,
    killGraceMs: 3_000,
    maxOutputBytes: 1024,
    ...overrides,
  };
}

function runnerWith(
  child: MockChild,
  killProcessGroup: GuardDogProcessGroupKill = jest.fn(),
): { runner: GuardDogProcessRunner; spawn: jest.MockedFunction<GuardDogSpawn> } {
  const spawn = jest.fn<
    ReturnType<GuardDogSpawn>,
    Parameters<GuardDogSpawn>
  >(() => child as unknown as ChildProcess);
  return {
    runner: new GuardDogProcessRunner({ spawn, killProcessGroup }),
    spawn,
  };
}

describe('GuardDogProcessRunner', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('spawns GuardDog with isolated arguments and captures both streams', async () => {
    const child = childProcess();
    const { runner, spawn } = runnerWith(child);
    const resultPromise = runner.run(request());

    child.stdout.write(Buffer.from('{"ok":true}'));
    child.stderr.write(Buffer.from('warning'));
    child.emit('close', 0, null);
    const result = await resultPromise;

    expect(spawn).toHaveBeenCalledWith(
      'guarddog',
      ['npm', 'scan', '/canonical/extracted', '--output-format=json'],
      {
        shell: false,
        detached: true,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: expect.any(Object),
      },
    );
    expect(child.unref).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      exitCode: 0,
      signal: null,
      stdout: '{"ok":true}',
      stderr: 'warning',
      timedOut: false,
      outputLimitExceeded: false,
      command: [
        'guarddog',
        'npm',
        'scan',
        '/canonical/extracted',
        '--output-format=json',
      ],
      terminationErrors: [],
    });
    expect(result.startedAt).toEqual(expect.any(String));
    expect(result.completedAt).toEqual(expect.any(String));
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('passes only the explicit environment allowlist to the child', () => {
    expect(guardDogEnvironment({
      PATH: '/bin', LANG: 'C', OPENAI_API_KEY: 'secret', AWS_SECRET_ACCESS_KEY: 'secret',
    })).toEqual({ PATH: '/bin', LANG: 'C' });
  });

  it('preserves a non-zero exit as process data', async () => {
    const child = childProcess();
    const { runner } = runnerWith(child);
    const resultPromise = runner.run(request());

    child.emit('close', 2, null);

    await expect(resultPromise).resolves.toMatchObject({
      exitCode: 2,
      timedOut: false,
      outputLimitExceeded: false,
    });
  });

  it('terminates the GuardDog process group when the package signal is aborted', async () => {
    const child = childProcess();
    const killProcessGroup = jest.fn();
    const { runner } = runnerWith(child, killProcessGroup);
    const controller = new AbortController();
    const resultPromise = runner.run(request({ signal: controller.signal }));

    controller.abort();
    child.emit('close', null, 'SIGTERM');

    await expect(resultPromise).resolves.toMatchObject({ timedOut: true });
    expect(killProcessGroup).toHaveBeenCalledWith(321, 'SIGTERM');
  });

  it('captures an emitted ENOENT without rejecting', async () => {
    const child = childProcess();
    const { runner } = runnerWith(child);
    const resultPromise = runner.run(request());
    const error = Object.assign(new Error('spawn guarddog ENOENT'), { code: 'ENOENT' });

    child.emit('error', error);

    await expect(resultPromise).resolves.toMatchObject({
      exitCode: null,
      processError: { code: 'ENOENT', message: 'spawn guarddog ENOENT' },
    });
  });

  it('captures a synchronous spawn failure without rejecting', async () => {
    const spawn = jest.fn<
      ReturnType<GuardDogSpawn>,
      Parameters<GuardDogSpawn>
    >(() => {
      throw Object.assign(new Error('spawn failed'), { code: 'EACCES' });
    });
    const runner = new GuardDogProcessRunner({ spawn });

    await expect(runner.run(request())).resolves.toMatchObject({
      exitCode: null,
      stdout: '',
      stderr: '',
      processError: { code: 'EACCES', message: 'spawn failed' },
    });
  });

  it('allows maxOutputBytes independently for stdout and stderr', async () => {
    const child = childProcess();
    const { runner } = runnerWith(child);
    const resultPromise = runner.run(request({ maxOutputBytes: 4 }));

    child.stdout.write(Buffer.from('1234'));
    child.stderr.write(Buffer.from('abcd'));
    child.emit('close', 0, null);
    const result = await resultPromise;

    expect(result.stdout).toBe('1234');
    expect(result.stderr).toBe('abcd');
    expect(result.outputLimitExceeded).toBe(false);
  });

  it.each([
    ['stdout', 'stdout'],
    ['stderr', 'stderr'],
  ] as const)('limits %s by Buffer bytes and starts termination', async (_name, streamName) => {
    const child = childProcess();
    const killProcessGroup = jest.fn();
    const { runner } = runnerWith(child, killProcessGroup);
    const resultPromise = runner.run(request({ maxOutputBytes: 4 }));

    child[streamName].write(Buffer.from('12345'));
    child.emit('close', null, 'SIGTERM');
    const result = await resultPromise;

    expect(result.outputLimitExceeded).toBe(true);
    expect(Buffer.byteLength(result[streamName])).toBe(4);
    expect(killProcessGroup).toHaveBeenCalledWith(321, 'SIGTERM');
  });

  it('counts multibyte output using bytes instead of JavaScript string length', async () => {
    const child = childProcess();
    const killProcessGroup = jest.fn();
    const { runner } = runnerWith(child, killProcessGroup);
    const resultPromise = runner.run(request({ maxOutputBytes: 5 }));

    expect('가나').toHaveLength(2);
    expect(Buffer.byteLength('가나')).toBe(6);
    child.stdout.write(Buffer.from('가나'));
    child.emit('close', null, 'SIGTERM');
    const result = await resultPromise;

    expect(result.outputLimitExceeded).toBe(true);
    expect(killProcessGroup).toHaveBeenCalledWith(321, 'SIGTERM');
  });

  it('sends SIGTERM to the process group on timeout', async () => {
    jest.useFakeTimers();
    const child = childProcess();
    const killProcessGroup = jest.fn();
    const { runner } = runnerWith(child, killProcessGroup);
    const resultPromise = runner.run(request({ timeoutMs: 10 }));

    jest.advanceTimersByTime(10);
    expect(killProcessGroup).toHaveBeenCalledWith(321, 'SIGTERM');
    child.emit('close', null, 'SIGTERM');

    await expect(resultPromise).resolves.toMatchObject({
      timedOut: true,
      signal: 'SIGTERM',
    });
  });

  it('does not send SIGKILL when close occurs during the grace period', async () => {
    jest.useFakeTimers();
    const child = childProcess();
    const killProcessGroup = jest.fn();
    const { runner } = runnerWith(child, killProcessGroup);
    const resultPromise = runner.run(request({ timeoutMs: 10, killGraceMs: 3_000 }));

    jest.advanceTimersByTime(10);
    jest.advanceTimersByTime(2_999);
    child.emit('close', null, 'SIGTERM');
    jest.advanceTimersByTime(1);
    await resultPromise;

    expect(killProcessGroup).toHaveBeenCalledTimes(1);
    expect(killProcessGroup).not.toHaveBeenCalledWith(321, 'SIGKILL');
  });

  it('sends SIGKILL after killGraceMs when close has not occurred', async () => {
    jest.useFakeTimers();
    const child = childProcess();
    const killProcessGroup = jest.fn();
    const { runner } = runnerWith(child, killProcessGroup);
    const resultPromise = runner.run(request({ timeoutMs: 10, killGraceMs: 3_000 }));

    jest.advanceTimersByTime(10);
    jest.advanceTimersByTime(3_000);
    expect(killProcessGroup).toHaveBeenNthCalledWith(1, 321, 'SIGTERM');
    expect(killProcessGroup).toHaveBeenNthCalledWith(2, 321, 'SIGKILL');
    child.emit('close', null, 'SIGKILL');

    await expect(resultPromise).resolves.toMatchObject({ timedOut: true });
  });

  it('falls back to child.kill when no PID is available', async () => {
    jest.useFakeTimers();
    const child = childProcess(null);
    const killProcessGroup = jest.fn();
    const { runner } = runnerWith(child, killProcessGroup);
    const resultPromise = runner.run(request({ timeoutMs: 10 }));

    jest.advanceTimersByTime(10);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(killProcessGroup).not.toHaveBeenCalled();
    child.emit('close', null, 'SIGTERM');
    await resultPromise;
  });

  it('treats ESRCH as a normal process exit race', async () => {
    jest.useFakeTimers();
    const child = childProcess();
    const killProcessGroup = jest.fn(() => {
      throw Object.assign(new Error('missing'), { code: 'ESRCH' });
    });
    const { runner } = runnerWith(child, killProcessGroup);
    const resultPromise = runner.run(request({ timeoutMs: 10 }));

    jest.advanceTimersByTime(10);
    child.emit('close', null, 'SIGTERM');
    const result = await resultPromise;

    expect(result.terminationErrors).toEqual([]);
  });

  it('preserves non-ESRCH signal failures as internal process data', async () => {
    jest.useFakeTimers();
    const child = childProcess();
    const killProcessGroup = jest.fn(() => {
      throw Object.assign(new Error('not permitted'), { code: 'EPERM' });
    });
    const { runner } = runnerWith(child, killProcessGroup);
    const resultPromise = runner.run(request({ timeoutMs: 10 }));

    jest.advanceTimersByTime(10);
    child.emit('close', null, 'SIGTERM');
    const result = await resultPromise;

    expect(result.terminationErrors).toEqual([{
      signal: 'SIGTERM',
      message: 'Unable to signal GuardDog process group with SIGTERM',
    }]);
  });

  it('settles once when error and close both occur and clears timers', async () => {
    jest.useFakeTimers();
    const child = childProcess();
    const { runner } = runnerWith(child);
    const resultPromise = runner.run(request());

    child.emit('error', Object.assign(new Error('missing'), { code: 'ENOENT' }));
    child.emit('close', 127, null);
    const result = await resultPromise;

    expect(result.processError?.code).toBe('ENOENT');
    expect(result.exitCode).toBeNull();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('clears the timeout timer after a normal close', async () => {
    jest.useFakeTimers();
    const child = childProcess();
    const { runner } = runnerWith(child);
    const resultPromise = runner.run(request());

    child.emit('close', 0, null);
    await resultPromise;

    expect(jest.getTimerCount()).toBe(0);
  });
});
