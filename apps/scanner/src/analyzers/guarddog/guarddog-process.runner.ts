import {
  spawn as nodeSpawn,
  type ChildProcess,
  type SpawnOptions,
} from 'node:child_process';

import type {
  GuardDogProcessRequest,
  GuardDogProcessResult,
  GuardDogTerminationError,
} from './guarddog.types';

export type GuardDogSpawn = (
  executable: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export type GuardDogProcessGroupKill = (
  pid: number,
  signal: NodeJS.Signals,
) => void;

export interface GuardDogProcessRunnerDependencies {
  spawn?: GuardDogSpawn;
  killProcessGroup?: GuardDogProcessGroupKill;
  now?: () => Date;
}

export interface GuardDogProcessRunnerPort {
  run(request: GuardDogProcessRequest): Promise<GuardDogProcessResult>;
}

export class GuardDogProcessRunner implements GuardDogProcessRunnerPort {
  private readonly spawn: GuardDogSpawn;
  private readonly killProcessGroup: GuardDogProcessGroupKill;
  private readonly now: () => Date;

  constructor(dependencies: GuardDogProcessRunnerDependencies = {}) {
    this.spawn = dependencies.spawn ?? nodeSpawn;
    this.killProcessGroup = dependencies.killProcessGroup
      ?? ((pid, signal) => process.kill(-pid, signal));
    this.now = dependencies.now ?? (() => new Date());
  }

  run(request: GuardDogProcessRequest): Promise<GuardDogProcessResult> {
    const started = this.now();
    const command = [request.executable, ...request.args];

    return new Promise((resolve) => {
      let child: ChildProcess;
      try {
        child = this.spawn(request.executable, request.args, {
          shell: false,
          detached: true,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: guardDogEnvironment(process.env),
        });
      } catch (error) {
        const completed = this.now();
        resolve({
          exitCode: null,
          signal: null,
          stdout: '',
          stderr: '',
          startedAt: started.toISOString(),
          completedAt: completed.toISOString(),
          durationMs: elapsedMilliseconds(started, completed),
          timedOut: false,
          outputLimitExceeded: false,
          command,
          processError: processError(error),
          terminationErrors: [],
        });
        return;
      }

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      const terminationErrors: GuardDogTerminationError[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;
      let timedOut = false;
      let outputLimitExceeded = false;
      let terminationStarted = false;
      let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      let abortHandler: (() => void) | undefined;

      const clearTimers = (): void => {
        if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
        if (killTimer !== undefined) clearTimeout(killTimer);
      };

      const finish = (
        exitCode: number | null,
        signal: NodeJS.Signals | null,
        error?: unknown,
      ): void => {
        if (settled) return;
        settled = true;
        clearTimers();
        if (abortHandler !== undefined) {
          request.signal?.removeEventListener('abort', abortHandler);
        }
        const completed = this.now();
        resolve({
          exitCode,
          signal,
          stdout: Buffer.concat(stdoutChunks, stdoutBytes).toString('utf8'),
          stderr: Buffer.concat(stderrChunks, stderrBytes).toString('utf8'),
          startedAt: started.toISOString(),
          completedAt: completed.toISOString(),
          durationMs: elapsedMilliseconds(started, completed),
          timedOut,
          outputLimitExceeded,
          command,
          ...(error === undefined ? {} : { processError: processError(error) }),
          terminationErrors,
        });
      };

      const sendSignal = (signal: NodeJS.Signals): void => {
        try {
          if (child.pid === undefined || child.pid <= 0) {
            child.kill(signal);
          } else {
            this.killProcessGroup(child.pid, signal);
          }
        } catch (error) {
          if (hasErrorCode(error, 'ESRCH')) return;
          terminationErrors.push({
            signal,
            message: `Unable to signal GuardDog process group with ${signal}`,
          });
        }
      };

      const beginTermination = (): void => {
        if (terminationStarted || settled) return;
        terminationStarted = true;
        if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
        sendSignal('SIGTERM');
        if (settled) return;
        killTimer = setTimeout(() => {
          if (settled) return;
          sendSignal('SIGKILL');
        }, request.killGraceMs);
      };

      abortHandler = (): void => {
        if (settled) return;
        timedOut = true;
        beginTermination();
      };
      request.signal?.addEventListener('abort', abortHandler, { once: true });
      if (request.signal?.aborted === true) abortHandler();

      const collect = (
        chunk: Buffer | string,
        chunks: Buffer[],
        currentBytes: number,
      ): number => {
        // Each stream retains at most maxOutputBytes independently, so the two
        // retained buffers together are bounded by twice that configured limit.
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const remaining = request.maxOutputBytes - currentBytes;
        if (remaining > 0) {
          const retained = buffer.length > remaining
            ? Buffer.from(buffer.subarray(0, remaining))
            : buffer;
          chunks.push(retained);
          currentBytes += retained.length;
        }
        if (buffer.length > remaining) {
          outputLimitExceeded = true;
          beginTermination();
        }
        return currentBytes;
      };

      child.stdout?.on('data', (chunk: Buffer | string) => {
        stdoutBytes = collect(chunk, stdoutChunks, stdoutBytes);
      });
      child.stderr?.on('data', (chunk: Buffer | string) => {
        stderrBytes = collect(chunk, stderrChunks, stderrBytes);
      });
      child.once('error', (error: Error) => finish(null, null, error));
      child.once('close', (exitCode: number | null, signal: NodeJS.Signals | null) => {
        finish(exitCode, signal);
      });

      timeoutTimer = setTimeout(() => {
        if (settled || terminationStarted) return;
        timedOut = true;
        beginTermination();
      }, request.timeoutMs);
    });
  }
}

export const GUARDDOG_ENVIRONMENT_ALLOWLIST_VERSION = '1.0.0';
export const GUARDDOG_ENVIRONMENT_ALLOWLIST = Object.freeze([
  'PATH',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
] as const);

export function guardDogEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of GUARDDOG_ENVIRONMENT_ALLOWLIST) {
    const value = source[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

function elapsedMilliseconds(started: Date, completed: Date): number {
  return Math.max(0, completed.getTime() - started.getTime());
}

function processError(error: unknown): { code?: string; message: string } {
  const message = error instanceof Error ? error.message : 'GuardDog process failed';
  if (
    typeof error === 'object'
    && error !== null
    && 'code' in error
    && typeof error.code === 'string'
  ) {
    return { code: error.code, message };
  }
  return { message };
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === code
  );
}
