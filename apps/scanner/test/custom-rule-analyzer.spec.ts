import { EventEmitter } from 'node:events';
import * as childProcess from 'node:child_process';

import { CustomRuleAnalyzer } from '../src/analyzers/custom-rule/custom-rule.analyzer';

function semgrepResult(
  checkId: string,
  path = 'package/index.js',
  line = 4,
): Record<string, unknown> {
  return {
    check_id: checkId,
    path,
    start: { line, column: 1 },
    end: { line, column: 20 },
    extra: { message: 'signal' },
  };
}

function mockProcess(stdout: string, stderr = '', exitCode: number | null = 0): EventEmitter {
  const process = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter & { setEncoding: (encoding: string) => void };
    stderr: EventEmitter & { setEncoding: (encoding: string) => void };
    kill: jest.Mock;
  };
  process.stdout = Object.assign(new EventEmitter(), { setEncoding: jest.fn() });
  process.stderr = Object.assign(new EventEmitter(), { setEncoding: jest.fn() });
  process.kill = jest.fn(() => true);
  queueMicrotask(() => {
    process.stdout.emit('data', stdout);
    process.stderr.emit('data', stderr);
    process.emit('close', exitCode, null);
  });
  return process;
}

function analyzer(ruleVersion?: string): CustomRuleAnalyzer {
  return new CustomRuleAnalyzer({
    semgrepBin: 'semgrep',
    ruleConfigPath: 'apps/scanner/rules/custom-rule-analyzer.yml',
    timeoutMs: 100,
    ruleVersion,
  });
}

describe('CustomRuleAnalyzer', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('uses an injected external process runner without changing canonical Finding conversion', async () => {
    const runner = { run: jest.fn().mockResolvedValue({
      stdout: JSON.stringify({ results: [semgrepResult('custom.signal.sensitive-file-access', 'index.js', 1)], errors: [] }),
      stderr: '', exitCode: 0, signal: null, timedOut: false,
    }) };
    const external = new CustomRuleAnalyzer({
      semgrepBin: 'semgrep', ruleConfigPath: '/host/rules.yml', timeoutMs: 100, ruleVersion: 'rules-hash',
    }, runner);
    const actual = await external.analyzeResult({ extractedPath: '/host/package', packageJson: {} },
      { requestId: 'sample', scanId: 'scan' });
    expect(runner.run).toHaveBeenCalledWith(expect.objectContaining({ packageRoot: '/host/package', ruleConfigPath: '/host/rules.yml' }));
    expect(actual).toMatchObject({ status: 'SUCCESS', findings: [{
      findingId: 'custom-rule:custom.sensitive-file-access:0', ruleId: 'custom.sensitive-file-access',
      location: { type: 'SOURCE_FILE', path: 'index.js', startLine: 1 },
    }] });
  });

  it('creates a Sensitive File Access observation with source location', async () => {
    jest.spyOn(childProcess, 'spawn').mockReturnValue(mockProcess(JSON.stringify({
      results: [semgrepResult('custom.signal.sensitive-file-access')],
      errors: [],
    })) as never);

    const result = await analyzer('pending-version').analyze({ extractedPath: '/tmp/extracted', packageJson: {} });

    expect(result.status).toBe('SUCCESS');
    expect(result.observations[0]).toMatchObject({
      ruleId: 'custom.sensitive-file-access',
      type: 'CAPABILITY_PATTERN',
      ruleVersion: 'pending-version',
      locations: [{ type: 'SOURCE_FILE', path: 'package/index.js', startLine: 4 }],
    });
    expect(childProcess.spawn).toHaveBeenCalledWith(
      'semgrep',
      ['--json', '--config', 'apps/scanner/rules/custom-rule-analyzer.yml', '/tmp/extracted'],
      { shell: false, windowsHide: true },
    );
  });

  it('omits the rule version when no externally supplied version is available', async () => {
    jest.spyOn(childProcess, 'spawn').mockReturnValue(mockProcess(JSON.stringify({
      results: [semgrepResult('custom.signal.sensitive-file-access')],
      errors: [],
    })) as never);

    const result = await analyzer().analyze({ extractedPath: '/tmp/extracted', packageJson: {} });

    expect(result.observations[0]).not.toHaveProperty('ruleVersion');
  });

  it('creates a Lifecycle + Process coexistence observation without claiming execution', async () => {
    jest.spyOn(childProcess, 'spawn').mockReturnValue(mockProcess(JSON.stringify({
      results: [semgrepResult('custom.signal.process-access')],
      errors: [],
    })) as never);

    const result = await analyzer().analyze({
      extractedPath: '/tmp/extracted',
      packageJson: { scripts: { postinstall: 'node setup.js' } },
    });

    expect(result.observations[0]).toMatchObject({
      ruleId: 'custom.lifecycle-process-coexistence',
      data: {
        interpretation: 'CO_OCCURRENCE_ONLY',
        doesNotProve: expect.stringContaining('executed'),
      },
      locations: expect.arrayContaining([{ type: 'METADATA', jsonPointer: '/scripts/postinstall' }]),
    });
  });

  it('creates ENV + Network and Sensitive File + Network coexistence observations', async () => {
    jest.spyOn(childProcess, 'spawn').mockReturnValue(mockProcess(JSON.stringify({
      results: [
        semgrepResult('custom.signal.environment-access', 'package/env.js', 2),
        semgrepResult('custom.signal.sensitive-file-access', 'package/file.js', 3),
        semgrepResult('custom.signal.network-access', 'package/net.js', 5),
      ],
      errors: [],
    })) as never);

    const result = await analyzer().analyze({ extractedPath: '/tmp/extracted', packageJson: {} });

    expect(result.observations.map(({ ruleId }) => ruleId)).toEqual([
      'custom.sensitive-file-access',
      'custom.env-network-coexistence',
      'custom.sensitive-file-network-coexistence',
    ]);
    expect(result.observations[1]?.data.doesNotProve).toContain('sent');
    expect(result.observations[2]?.data.doesNotProve).toContain('sent');
  });

  it('returns no observations for normal code without signal matches', async () => {
    jest.spyOn(childProcess, 'spawn').mockReturnValue(mockProcess(JSON.stringify({
      results: [],
      errors: [],
    })) as never);

    const result = await analyzer().analyze({ extractedPath: '/tmp/extracted', packageJson: {} });

    expect(result.status).toBe('SUCCESS');
    expect(result.observations).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it('preserves raw output and reports Semgrep execution failure', async () => {
    const process = new EventEmitter();
    jest.spyOn(childProcess, 'spawn').mockReturnValue(process as never);
    queueMicrotask(() => process.emit('error', new Error('semgrep missing')));

    const result = await analyzer().analyze({ extractedPath: '/tmp/extracted', packageJson: {} });

    expect(result.status).toBe('FAILED');
    expect(result.errors).toMatchObject([{ code: 'ANALYZER_FAILED', phase: 'SPAWN' }]);
    expect(result.rawResult).toMatchObject({ stdout: '', stderr: '', exitCode: null });
  });

  it('reports timeout without inventing a new error code', async () => {
    const process = Object.assign(new EventEmitter(), { kill: jest.fn() });
    process.kill.mockImplementation(() => {
      process.emit('close', null, 'SIGTERM');
      return true;
    });
    jest.spyOn(childProcess, 'spawn').mockReturnValue(process as never);

    const result = await new CustomRuleAnalyzer({
      semgrepBin: 'semgrep',
      ruleConfigPath: 'rules.yml',
      timeoutMs: 1,
    }).analyze({ extractedPath: '/tmp/extracted', packageJson: {} });

    expect(result.status).toBe('TIMEOUT');
    expect(result.errors).toMatchObject([{ code: 'ANALYZER_TIMEOUT', phase: 'TIMEOUT' }]);
    expect(process.kill).toHaveBeenCalled();
  });

  it('terminates Semgrep when the package signal is aborted', async () => {
    const process = Object.assign(new EventEmitter(), { kill: jest.fn() });
    process.kill.mockImplementation(() => {
      process.emit('close', null, 'SIGTERM');
      return true;
    });
    jest.spyOn(childProcess, 'spawn').mockReturnValue(process as never);
    const controller = new AbortController();

    const resultPromise = analyzer().analyze(
      { extractedPath: '/tmp/extracted', packageJson: {} },
      controller.signal,
    );
    controller.abort();

    await expect(resultPromise).resolves.toMatchObject({ status: 'TIMEOUT' });
    expect(process.kill).toHaveBeenCalledTimes(1);
    expect(process.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('starts one termination sequence when package abort and analyzer timeout are adjacent', async () => {
    jest.useFakeTimers();
    const process = Object.assign(new EventEmitter(), { kill: jest.fn(() => true) });
    jest.spyOn(childProcess, 'spawn').mockReturnValue(process as never);
    const controller = new AbortController();
    const resultPromise = new CustomRuleAnalyzer({
      semgrepBin: 'semgrep',
      ruleConfigPath: 'rules.yml',
      timeoutMs: 100,
    }).analyze({ extractedPath: '/tmp/extracted', packageJson: {} }, controller.signal);

    controller.abort();
    jest.advanceTimersByTime(100);
    jest.advanceTimersByTime(100);
    expect(process.kill).toHaveBeenNthCalledWith(1, 'SIGTERM');
    expect(process.kill).toHaveBeenNthCalledWith(2, 'SIGKILL');
    expect(process.kill).toHaveBeenCalledTimes(2);

    process.emit('close', null, 'SIGTERM');
    await expect(resultPromise).resolves.toMatchObject({ status: 'TIMEOUT' });
  });

  it('preserves partial observations when Semgrep reports tool errors', async () => {
    jest.spyOn(childProcess, 'spawn').mockReturnValue(mockProcess(JSON.stringify({
      results: [
        semgrepResult('custom.signal.environment-access'),
        semgrepResult('custom.signal.network-access'),
      ],
      errors: [{ message: 'one rule failed' }],
    }), 'warning', 2) as never);

    const result = await analyzer().analyze({ extractedPath: '/tmp/extracted', packageJson: {} });

    expect(result.status).toBe('PARTIAL');
    expect(result.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        ruleId: 'custom.env-network-coexistence',
        type: 'CO_OCCURRENCE_SIGNAL',
      }),
    ]));
    expect(result.errors).toMatchObject([{ code: 'ANALYZER_FAILED', phase: 'SEMGREP' }]);
    expect(result.rawResult.stderr).toBe('warning');
  });

  it('reports malformed Semgrep JSON as analyzer failure', async () => {
    jest.spyOn(childProcess, 'spawn').mockReturnValue(mockProcess('{not-json', '', 0) as never);

    const result = await analyzer().analyze({ extractedPath: '/tmp/extracted', packageJson: {} });

    expect(result.status).toBe('FAILED');
    expect(result.errors).toMatchObject([{ code: 'ANALYZER_FAILED', phase: 'OUTPUT_PARSE' }]);
  });

  it('maps observations and tool errors to the shared AnalyzerResult contract', async () => {
    jest.spyOn(childProcess, 'spawn').mockReturnValue(mockProcess(JSON.stringify({
      results: [
        semgrepResult('custom.signal.environment-access'),
        semgrepResult('custom.signal.network-access'),
      ],
      errors: [{ message: 'rule warning' }],
    }), 'warning', 2) as never);

    const result = await analyzer('rule-v1').analyzeResult(
      {
        extractedPath: '/tmp/extracted',
        packageJson: { scripts: { postinstall: 'node setup.js' } },
      },
      { requestId: 'request-1', scanId: 'scan-1' },
    );

    expect(result).toMatchObject({
      requestId: 'request-1',
      scanId: 'scan-1',
      analyzer: 'custom-rule',
      analyzerVersion: '0.2.0',
      status: 'PARTIAL',
      errors: [{
        code: 'INTERNAL_ERROR',
        stage: 'ANALYZER:SEMGREP',
        analyzer: 'custom-rule',
        retryable: false,
      }],
      rawResult: {
        stdout: expect.any(String),
        stderr: 'warning',
        exitCode: 2,
      },
    });
    expect(result.findings).toEqual([
      expect.objectContaining({
        findingId: 'custom-rule:custom.env-network-coexistence:0',
        ruleId: 'custom.env-network-coexistence',
        type: 'CO_OCCURRENCE_SIGNAL',
        location: expect.objectContaining({
          type: 'SOURCE_FILE',
          path: 'package/index.js',
        }),
        data: expect.objectContaining({
          ruleVersion: 'rule-v1',
          locations: expect.any(Array),
          interpretation: 'CO_OCCURRENCE_ONLY',
        }),
      }),
    ]);
  });
});
