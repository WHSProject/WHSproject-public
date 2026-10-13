import { realpath, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildGuardDogArgs,
  classifyGuardDogStderr,
  GuardDogAnalyzer,
} from '../src/analyzers/guarddog/guarddog.analyzer';
import type { GuardDogProcessRunnerPort } from '../src/analyzers/guarddog/guarddog-process.runner';
import type {
  GuardDogAnalyzerInput,
  GuardDogAnalyzerOptions,
  GuardDogParsedOutput,
  GuardDogProcessRequest,
  GuardDogProcessResult,
} from '../src/analyzers/guarddog/guarddog.types';
import { ScannerErrorCode } from '../src/domain/scanner-error-code';

function output(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    package: 'local-package',
    issues: 0,
    errors: {},
    results: {},
    risk_score: {
      score: 0,
      label: 'no_risks_detected',
      findings_count: 0,
      score_breakdown: {},
    },
    risks: [],
    ...overrides,
  });
}

function processResult(
  overrides: Partial<GuardDogProcessResult> = {},
): GuardDogProcessResult {
  return {
    exitCode: 0,
    signal: null,
    stdout: output(),
    stderr: '',
    startedAt: '2026-08-26T00:00:00.000Z',
    completedAt: '2026-08-26T00:00:00.010Z',
    durationMs: 10,
    timedOut: false,
    outputLimitExceeded: false,
    command: ['guarddog'],
    terminationErrors: [],
    ...overrides,
  };
}

function runnerReturning(
  overrides: Partial<GuardDogProcessResult> = {},
): jest.Mocked<GuardDogProcessRunnerPort> {
  const run = jest.fn<
    Promise<GuardDogProcessResult>,
    [GuardDogProcessRequest]
  >(async (request) => processResult({
    command: [request.executable, ...request.args],
    ...overrides,
  }));
  return { run };
}

function options(
  workspaceRoot: string,
  overrides: Partial<GuardDogAnalyzerOptions> = {},
): GuardDogAnalyzerOptions {
  return {
    executable: 'guarddog',
    toolVersion: '3.1.0',
    workspaceRoot,
    timeoutMs: 60_000,
    killGraceMs: 3_000,
    sandboxMode: 'REQUIRED',
    maxOutputBytes: 10_485_760,
    ...overrides,
  };
}

function input(scanId: string, extractedPath: string): GuardDogAnalyzerInput {
  return {
    context: {
      requestId: 'request-1',
      scanId,
      package: { name: 'fixture', version: '1.0.0' },
      artifact: {
        tarballPath: '/not-used/artifact.tgz',
        extractedPath,
        hash: 'sha512-fixture',
      },
      metadata: {
        registryMetadata: {},
        packageJson: { name: 'fixture', version: '1.0.0' },
      },
    },
  };
}

describe('GuardDogAnalyzer', () => {
  let testDirectory: string;
  let workspaceRoot: string;
  let extractedPath: string;
  const scanId = 'scan-1';

  beforeEach(async () => {
    testDirectory = await mkdtemp(join(tmpdir(), 'guarddog-analyzer-'));
    workspaceRoot = join(testDirectory, 'workspace');
    extractedPath = join(workspaceRoot, scanId, 'extracted');
    await mkdir(extractedPath, { recursive: true });
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await rm(testDirectory, { recursive: true, force: true });
  });

  describe('options', () => {
    it('accepts valid options during analyzer construction', () => {
      expect(() => new GuardDogAnalyzer(options(workspaceRoot))).not.toThrow();
    });

    it.each([
      ['executable', { executable: '' }],
      ['toolVersion', { toolVersion: '   ' }],
      ['workspaceRoot', { workspaceRoot: '' }],
    ] as const)('rejects an invalid %s', (_name, override) => {
      expect(() => new GuardDogAnalyzer({
        ...options(workspaceRoot),
        ...override,
      })).toThrow(/non-empty string/u);
    });

    it.each([
      ['timeoutMs', 0],
      ['killGraceMs', -1],
      ['maxOutputBytes', 1.5],
      ['timeoutMs', Number.MAX_SAFE_INTEGER + 1],
    ] as const)('rejects invalid numeric option %s=%s', (name, value) => {
      expect(() => new GuardDogAnalyzer({
        ...options(workspaceRoot),
        [name]: value,
      })).toThrow(/positive safe integer/u);
    });

    it('rejects an unsupported sandbox mode', () => {
      expect(() => new GuardDogAnalyzer(options(workspaceRoot, {
        sandboxMode: 'UNKNOWN' as never,
      }))).toThrow(/sandboxMode/u);
    });

    it('rejects rules and excludeRules even when both arrays are empty', () => {
      expect(() => new GuardDogAnalyzer(options(workspaceRoot, {
        rules: [],
        excludeRules: [],
      }))).toThrow(/cannot be used together/u);
    });

    it.each([
      [{ rules: [''] }],
      [{ rules: ['   '] }],
      [{ excludeRules: ['valid', ''] }],
    ])('rejects an invalid rule ID', (override) => {
      expect(() => new GuardDogAnalyzer(options(workspaceRoot, override))).toThrow(
        /invalid rule ID/u,
      );
    });
  });

  describe('command construction', () => {
    it('builds the required base arguments in order', () => {
      expect(buildGuardDogArgs('/canonical/extracted', {
        sandboxMode: 'REQUIRED',
      })).toEqual([
        'npm',
        'scan',
        '/canonical/extracted',
        '--output-format=json',
      ]);
    });

    it('adds --no-sandbox only for DISABLED mode', () => {
      expect(buildGuardDogArgs('/canonical/extracted', {
        sandboxMode: 'DISABLED',
      })).toContain('--no-sandbox');
      expect(buildGuardDogArgs('/canonical/extracted', {
        sandboxMode: 'REQUIRED',
      })).not.toContain('--no-sandbox');
    });

    it('repeats rules and exclude-rules arguments without forbidden options', () => {
      expect(buildGuardDogArgs('/canonical/extracted', {
        sandboxMode: 'REQUIRED',
        rules: ['capability-one', 'threat-two'],
      })).toEqual([
        'npm',
        'scan',
        '/canonical/extracted',
        '--output-format=json',
        '--rules',
        'capability-one',
        '--rules',
        'threat-two',
      ]);
      const excluded = buildGuardDogArgs('/canonical/extracted', {
        sandboxMode: 'REQUIRED',
        excludeRules: ['capability-one', 'threat-two'],
      });
      expect(excluded).toEqual([
        'npm',
        'scan',
        '/canonical/extracted',
        '--output-format=json',
        '--exclude-rules',
        'capability-one',
        '--exclude-rules',
        'threat-two',
      ]);
      expect(excluded).not.toContain('--exit-non-zero-on-finding');
      expect(excluded).not.toContain('--metadata');
    });
  });

  describe('workspace validation', () => {
    it('passes only the canonical extracted directory to the runner', async () => {
      const runner = runnerReturning();
      const analyzer = new GuardDogAnalyzer(options(workspaceRoot), {
        processRunner: runner,
      });

      await analyzer.analyzeResult(input(scanId, extractedPath));

      expect(runner.run).toHaveBeenCalledWith(expect.objectContaining({
        args: [
          'npm',
          'scan',
          await realpath(extractedPath),
          '--output-format=json',
        ],
      }));
    });

    it('복원본 전용 경로를 GuardDog 재검사에 허용한다', async () => {
      const derivedPath = join(workspaceRoot, scanId, 'derived', 'obfuscation');
      await mkdir(derivedPath, { recursive: true });
      const runner = runnerReturning();
      const analyzer = new GuardDogAnalyzer(options(workspaceRoot), { processRunner: runner });

      const result = await analyzer.analyzeResult(input(scanId, derivedPath));

      expect(result.status).toBe('SUCCESS');
      expect(runner.run).toHaveBeenCalledWith(expect.objectContaining({
        args: expect.arrayContaining([await realpath(derivedPath)]),
      }));
    });

    it('accepts a workspace alias based on realpath canonicalization', async () => {
      const aliasRoot = join(testDirectory, 'workspace-alias');
      await symlink(workspaceRoot, aliasRoot, 'dir');
      const runner = runnerReturning();
      const analyzer = new GuardDogAnalyzer(options(aliasRoot), {
        processRunner: runner,
      });

      const result = await analyzer.analyzeResult(input(
        scanId,
        join(aliasRoot, scanId, 'extracted'),
      ));

      expect(result.status).toBe('SUCCESS');
      expect(runner.run).toHaveBeenCalledWith(expect.objectContaining({
        args: expect.arrayContaining([await realpath(extractedPath)]),
      }));
    });

    it('handles /tmp-style operating-system aliases using realpath', async () => {
      const aliasedWorkspace = await mkdtemp(join('/tmp', 'guarddog-path-alias-'));
      const aliasedExtracted = join(aliasedWorkspace, scanId, 'extracted');
      await mkdir(aliasedExtracted, { recursive: true });
      const runner = runnerReturning();
      const analyzer = new GuardDogAnalyzer(options(aliasedWorkspace), {
        processRunner: runner,
      });

      try {
        const result = await analyzer.analyzeResult(input(scanId, aliasedExtracted));

        expect(result.status).toBe('SUCCESS');
        expect(runner.run).toHaveBeenCalledWith(expect.objectContaining({
          args: expect.arrayContaining([await realpath(aliasedExtracted)]),
        }));
      } finally {
        await rm(aliasedWorkspace, { recursive: true, force: true });
      }
    });

    it('rejects a missing workspace root without invoking the runner', async () => {
      const runner = runnerReturning();
      const analyzer = new GuardDogAnalyzer(options(join(testDirectory, 'missing')), {
        processRunner: runner,
      });

      const result = await analyzer.analyzeResult(input(scanId, extractedPath));

      expect(result.status).toBe('FAILED');
      expect(result.errors[0]?.message).toBe('GuardDog workspace root is unavailable');
      expect(runner.run).not.toHaveBeenCalled();
    });

    it('rejects a missing scan workspace', async () => {
      const runner = runnerReturning();
      const analyzer = new GuardDogAnalyzer(options(workspaceRoot), {
        processRunner: runner,
      });

      const result = await analyzer.analyzeResult(input('missing-scan', extractedPath));

      expect(result.status).toBe('FAILED');
      expect(result.errors[0]?.message).toBe('GuardDog scan workspace is unavailable');
      expect(runner.run).not.toHaveBeenCalled();
    });

    it('rejects an extracted path from another scan workspace', async () => {
      const otherExtracted = join(workspaceRoot, 'scan-2', 'extracted');
      await mkdir(otherExtracted, { recursive: true });
      const runner = runnerReturning();
      const analyzer = new GuardDogAnalyzer(options(workspaceRoot), {
        processRunner: runner,
      });

      const result = await analyzer.analyzeResult(input(scanId, otherExtracted));

      expect(result.status).toBe('FAILED');
      expect(result.errors[0]?.message).toContain('outside the scan workspace');
      expect(runner.run).not.toHaveBeenCalled();
    });

    it('rejects a scan workspace symlink to another scan ID', async () => {
      const otherExtracted = join(workspaceRoot, 'scan-2', 'extracted');
      await mkdir(otherExtracted, { recursive: true });
      await rm(join(workspaceRoot, scanId), { recursive: true });
      await symlink(join(workspaceRoot, 'scan-2'), join(workspaceRoot, scanId), 'dir');
      const runner = runnerReturning();
      const analyzer = new GuardDogAnalyzer(options(workspaceRoot), {
        processRunner: runner,
      });

      const result = await analyzer.analyzeResult(input(scanId, otherExtracted));

      expect(result.status).toBe('FAILED');
      expect(result.errors[0]?.message).toContain('does not match the scan ID');
      expect(runner.run).not.toHaveBeenCalled();
    });

    it('rejects a missing extracted target', async () => {
      const runner = runnerReturning();
      const analyzer = new GuardDogAnalyzer(options(workspaceRoot), {
        processRunner: runner,
      });

      const result = await analyzer.analyzeResult(input(
        scanId,
        join(workspaceRoot, scanId, 'missing'),
      ));

      expect(result.status).toBe('FAILED');
      expect(result.errors[0]?.message).toBe('GuardDog extracted directory is unavailable');
    });

    it('rejects an extracted target that is a file', async () => {
      await rm(extractedPath, { recursive: true });
      await writeFile(extractedPath, 'not a directory');
      const analyzer = new GuardDogAnalyzer(options(workspaceRoot), {
        processRunner: runnerReturning(),
      });

      const result = await analyzer.analyzeResult(input(scanId, extractedPath));

      expect(result.status).toBe('FAILED');
      expect(result.errors[0]?.message).toBe('GuardDog extracted directory is unavailable');
    });

    it('rejects a symlink that escapes the scan workspace', async () => {
      const outside = join(testDirectory, 'outside');
      await mkdir(outside);
      await rm(extractedPath, { recursive: true });
      await symlink(outside, extractedPath, 'dir');
      const runner = runnerReturning();
      const analyzer = new GuardDogAnalyzer(options(workspaceRoot), {
        processRunner: runner,
      });

      const result = await analyzer.analyzeResult(input(scanId, extractedPath));

      expect(result.status).toBe('FAILED');
      expect(result.errors[0]?.message).toContain('outside the scan workspace');
      expect(runner.run).not.toHaveBeenCalled();
    });

    it('rejects a direct target outside the workspace root', async () => {
      const outside = join(testDirectory, 'outside-direct');
      await mkdir(outside);
      const runner = runnerReturning();
      const analyzer = new GuardDogAnalyzer(options(workspaceRoot), {
        processRunner: runner,
      });

      const result = await analyzer.analyzeResult(input(scanId, outside));

      expect(result.status).toBe('FAILED');
      expect(result.errors[0]?.message).toContain('outside the scan workspace');
      expect(runner.run).not.toHaveBeenCalled();
    });

    it('rejects a different directory inside the same scan workspace', async () => {
      const otherDirectory = join(workspaceRoot, scanId, 'other');
      await mkdir(otherDirectory);
      const analyzer = new GuardDogAnalyzer(options(workspaceRoot), {
        processRunner: runnerReturning(),
      });

      const result = await analyzer.analyzeResult(input(scanId, otherDirectory));

      expect(result.status).toBe('FAILED');
      expect(result.errors[0]?.message).toContain('does not match');
    });

    it.each(['', '.', '..', 'other/scan', 'other\\scan']) (
      'rejects unsafe scan ID %j',
      async (unsafeScanId) => {
        const runner = runnerReturning();
        const analyzer = new GuardDogAnalyzer(options(workspaceRoot), {
          processRunner: runner,
        });

        const result = await analyzer.analyzeResult(input(unsafeScanId, extractedPath));

        expect(result.status).toBe('FAILED');
        expect(result.errors[0]?.message).toBe('GuardDog input scan ID is invalid');
        expect(runner.run).not.toHaveBeenCalled();
      },
    );
  });

  describe('status and result conversion', () => {
    it('keeps SUCCESS for the observed non-fatal cache refresh warnings', async () => {
      const stderr = [
        "Network error: HTTPSConnectionPool(host='github.com', port=443): Max retries exceeded with url: /LeoDog896/npm-rank/releases/download/latest/raw.json (Caused by NameResolutionError(\"HTTPSConnection(host='github.com', port=443): Failed to resolve 'github.com' ([Errno -3] Temporary failure in name resolution)\"))",
        'Failed to download new cache data from https://github.com/LeoDog896/npm-rank/releases/download/latest/raw.json',
        "Network error: HTTPSConnectionPool(host='hugovk.github.io', port=443): Max retries exceeded with url: /top-pypi-packages/top-pypi-packages.min.json (Caused by NameResolutionError(\"HTTPSConnection(host='hugovk.github.io', port=443): Failed to resolve 'hugovk.github.io' ([Errno -3] Temporary failure in name resolution)\"))",
        'Failed to download new cache data from https://hugovk.github.io/top-pypi-packages/top-pypi-packages.min.json',
        "Network error: HTTPSConnectionPool(host='packages.ecosyste.ms', port=443): Max retries exceeded with url: /api/v1/registries/rubygems.org/package_names?critical=true&per_page=1000 (Caused by NameResolutionError(\"HTTPSConnection(host='packages.ecosyste.ms', port=443): Failed to resolve 'packages.ecosyste.ms' ([Errno -3] Temporary failure in name resolution)\"))",
        'Failed to download new cache data from https://packages.ecosyste.ms/api/v1/registries/rubygems.org/package_names?critical=true&per_page=1000',
      ].join('\n');
      expect(classifyGuardDogStderr(stderr, 'REQUIRED')).toBe('KNOWN_CACHE_WARNING');

      const analyzer = new GuardDogAnalyzer(options(workspaceRoot), {
        processRunner: runnerReturning({ stderr }),
      });

      const result = await analyzer.analyzeResult(input(scanId, extractedPath));

      expect(result.status).toBe('SUCCESS');
      expect(result.errors).toEqual([]);
      expect(JSON.stringify(result)).not.toContain('github.com');
    });

    it('classifies the expected DISABLED sandbox warning without degrading status', () => {
      expect(classifyGuardDogStderr(
        'WARNING: Scanning without kernel-level sandbox protection.',
        'DISABLED',
      )).toBe('KNOWN_SANDBOX_WARNING');
      expect(classifyGuardDogStderr(
        'WARNING: Scanning without kernel-level sandbox protection.',
        'REQUIRED',
      )).toBe('UNKNOWN');
      expect(classifyGuardDogStderr([
        'Failed to download new cache data from https://github.com/LeoDog896/npm-rank/releases/download/latest/raw.json',
        'WARNING: Scanning without kernel-level sandbox protection.',
      ].join('\n'), 'DISABLED')).toBe('KNOWN_CACHE_WARNING');
    });

    it('marks unknown stderr as PARTIAL without retaining its contents', async () => {
      const analyzer = new GuardDogAnalyzer(options(workspaceRoot), {
        processRunner: runnerReturning({ stderr: 'unexpected internal warning: secret-value' }),
      });

      const result = await analyzer.analyzeResult(input(scanId, extractedPath));

      expect(result.status).toBe('PARTIAL');
      expect(result.errors).toEqual([{
        code: ScannerErrorCode.INTERNAL_ERROR,
        stage: 'ANALYZER:GUARDDOG',
        analyzer: 'guarddog',
        message: 'GuardDog emitted an unclassified stderr warning',
        retryable: false,
      }]);
      expect(JSON.stringify(result)).not.toContain('secret-value');
    });

    it('returns SUCCESS for a valid no-finding result', async () => {
      const analyzer = new GuardDogAnalyzer(options(workspaceRoot), {
        processRunner: runnerReturning(),
      });

      const result = await analyzer.analyzeResult(input(scanId, extractedPath));

      expect(result).toMatchObject({
        requestId: 'request-1',
        scanId,
        analyzer: 'guarddog',
        analyzerVersion: '0.1.0',
        status: 'SUCCESS',
        findings: [],
        errors: [],
        guarddog: {
          tool: { name: 'guarddog', version: '3.1.0' },
          issues: 0,
          risks: [],
          toolAssessment: { score: 0, label: 'no_risks_detected' },
          execution: {
            exitCode: 0,
            jsonParsed: true,
            timedOut: false,
            outputLimitExceeded: false,
            sandboxMode: 'REQUIRED',
          },
        },
      });
    });

    it('returns SUCCESS with parsed findings', async () => {
      const stdout = output({
        issues: 1,
        results: {
          'capability-network-outbound': [{
            location: 'package/index.js:4',
            message: 'Static network capability',
          }],
        },
      });
      const analyzer = new GuardDogAnalyzer(options(workspaceRoot), {
        processRunner: runnerReturning({ stdout }),
      });

      const result = await analyzer.analyzeResult(input(scanId, extractedPath));

      expect(result.status).toBe('SUCCESS');
      expect(result.findings[0]).toMatchObject({
        findingId: 'guarddog:capability-network-outbound:0',
        type: 'CAPABILITY',
      });
      expect(result.guarddog.issues).toBe(1);
    });

    it('returns PARTIAL and safe ScanErrors for GuardDog reported errors', async () => {
      const stdout = output({
        errors: {
          'threat-broken': `failed under ${workspaceRoot}/scan-1/extracted`,
        },
        results: {
          'capability-network-outbound': [{ message: 'Static finding' }],
        },
      });
      const analyzer = new GuardDogAnalyzer(options(workspaceRoot), {
        processRunner: runnerReturning({ stdout }),
      });

      const result = await analyzer.analyzeResult(input(scanId, extractedPath));

      expect(result.status).toBe('PARTIAL');
      expect(result.findings).toHaveLength(1);
      expect(result.errors).toEqual([{
        code: ScannerErrorCode.INTERNAL_ERROR,
        stage: 'ANALYZER:GUARDDOG',
        analyzer: 'guarddog',
        message: 'GuardDog reported an error for "threat-broken"',
        retryable: false,
      }]);
      expect(JSON.stringify(result.errors)).not.toContain(workspaceRoot);
      expect(JSON.stringify(result.errors)).not.toContain('secret stderr');
    });

    it('returns PARTIAL for Parser warnings without promoting every warning to ScanError', async () => {
      const analyzer = new GuardDogAnalyzer(options(workspaceRoot), {
        processRunner: runnerReturning({
          stdout: output({ results: { 'threat-unknown-shape': 42 } }),
        }),
      });

      const result = await analyzer.analyzeResult(input(scanId, extractedPath));

      expect(result.status).toBe('PARTIAL');
      expect(result.errors).toEqual([]);
    });

    it.each([
      [
        'timeout',
        { timedOut: true, signal: 'SIGTERM' as NodeJS.Signals },
        'TIMEOUT',
        'GuardDog execution timed out',
      ],
      [
        'spawn failure',
        { processError: { code: 'ENOENT', message: 'sensitive spawn error' } },
        'FAILED',
        'GuardDog process failed to start',
      ],
      [
        'output limit',
        { outputLimitExceeded: true },
        'FAILED',
        'GuardDog output exceeded the configured byte limit',
      ],
      [
        'non-zero exit',
        { exitCode: 2 },
        'FAILED',
        'GuardDog process exited unsuccessfully',
      ],
      [
        'empty stdout',
        { stdout: '   ' },
        'FAILED',
        'GuardDog returned empty output',
      ],
      [
        'invalid JSON',
        { stdout: '{invalid' },
        'FAILED',
        'GuardDog returned invalid JSON output',
      ],
    ] as const)('maps %s without throwing', async (_name, override, status, message) => {
      const analyzer = new GuardDogAnalyzer(options(workspaceRoot), {
        processRunner: runnerReturning(override),
      });

      const resultPromise = analyzer.analyzeResult(input(scanId, extractedPath));

      await expect(resultPromise).resolves.toMatchObject({
        status,
        findings: [],
        errors: [{
          code: ScannerErrorCode.INTERNAL_ERROR,
          stage: 'ANALYZER:GUARDDOG',
          analyzer: 'guarddog',
          message,
          retryable: false,
        }],
      });
    });

    it.each([
      [{ timedOut: true }, 'TIMEOUT'],
      [{ outputLimitExceeded: true }, 'FAILED'],
      [{ exitCode: 2 }, 'FAILED'],
    ] as const)('does not parse unusable process output %#', async (override, expectedStatus) => {
      const parseOutput = jest.fn<GuardDogParsedOutput, [string]>();
      const analyzer = new GuardDogAnalyzer(options(workspaceRoot), {
        processRunner: runnerReturning({
          stdout: output({ results: { 'capability-network': [{}] } }),
          ...override,
        }),
        parseOutput,
      });

      const result = await analyzer.analyzeResult(input(scanId, extractedPath));

      expect(result.status).toBe(expectedStatus);
      expect(parseOutput).not.toHaveBeenCalled();
      expect(result.findings).toEqual([]);
    });

    it('converts an unexpected runner rejection to FAILED', async () => {
      const processRunner: GuardDogProcessRunnerPort = {
        run: jest.fn().mockRejectedValue(new Error(`secret ${workspaceRoot}`)),
      };
      const analyzer = new GuardDogAnalyzer(options(workspaceRoot), { processRunner });

      await expect(analyzer.analyzeResult(input(scanId, extractedPath))).resolves.toMatchObject({
        status: 'FAILED',
        errors: [{ message: 'GuardDog process runner failed unexpectedly' }],
      });
    });

    it('does not expose process streams or raw-result reference fields', async () => {
      const analyzer = new GuardDogAnalyzer(options(workspaceRoot), {
        processRunner: runnerReturning({
          stdout: output({
            results: { 'capability-network': [{ message: 'finding' }] },
          }),
          stderr: 'private warning',
        }),
      });

      const result = await analyzer.analyzeResult(input(scanId, extractedPath));
      const resultKeys = collectKeys(result);

      expect(resultKeys).not.toContain('stdout');
      expect(resultKeys).not.toContain('stderr');
      expect(resultKeys).not.toContain('stdoutRef');
      expect(resultKeys).not.toContain('stderrRef');
      expect(resultKeys).not.toContain('rawResultRef');
      expect(JSON.stringify(result)).not.toContain('private warning');
    });

    it('does not convert GuardDog assessment into a policy decision', async () => {
      const analyzer = new GuardDogAnalyzer(options(workspaceRoot), {
        processRunner: runnerReturning({
          stdout: output({
            risk_score: {
              score: 99,
              label: 'high_risk',
              findings_count: 3,
              score_breakdown: { correlated: 99 },
            },
          }),
        }),
      });

      const result = await analyzer.analyzeResult(input(scanId, extractedPath));

      expect(result.guarddog.toolAssessment).toMatchObject({
        score: 99,
        label: 'high_risk',
      });
      expect(result).not.toHaveProperty('decision');
      expect(result).not.toHaveProperty('policy');
    });
  });
});

function collectKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(collectKeys);
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, child]) => [key, ...collectKeys(child)]);
}
