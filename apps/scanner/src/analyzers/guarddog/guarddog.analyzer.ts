import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import type { ScanError } from '../../domain/analysis.types';
import { ScannerErrorCode } from '../../domain/scanner-error-code';
import type { Analyzer, AnalyzerContext } from '../analyzer.contract';
import { parseGuardDogOutput } from './guarddog-output.parser';
import {
  GuardDogOutputParserError,
  type GuardDogAnalyzerInput,
  type GuardDogAnalyzerOptions,
  type GuardDogAnalyzerResult,
  type GuardDogParsedOutput,
  type GuardDogProcessExecution,
  type GuardDogProcessResult,
} from './guarddog.types';
import {
  GuardDogProcessRunner,
  type GuardDogProcessRunnerPort,
} from './guarddog-process.runner';

export const GUARDDOG_ANALYZER_VERSION = '0.1.0';

export interface GuardDogAnalyzerDependencies {
  processRunner?: GuardDogProcessRunnerPort;
  externalProcessRunner?: GuardDogProcessRunnerPort;
  parseOutput?: (stdout: string) => GuardDogParsedOutput;
  now?: () => Date;
}

export type GuardDogStderrClassification =
  | 'EMPTY'
  | 'KNOWN_CACHE_WARNING'
  | 'KNOWN_SANDBOX_WARNING'
  | 'UNKNOWN';

export class GuardDogAnalyzer implements Analyzer<
  GuardDogAnalyzerInput,
  GuardDogAnalyzerResult
> {
  readonly name = 'guarddog';
  readonly version = GUARDDOG_ANALYZER_VERSION;

  private readonly options: GuardDogAnalyzerOptions;
  private readonly processRunner: GuardDogProcessRunnerPort;
  private readonly externalProcessRunner?: GuardDogProcessRunnerPort;
  private readonly parseOutput: (stdout: string) => GuardDogParsedOutput;
  private readonly now: () => Date;

  constructor(
    options: GuardDogAnalyzerOptions,
    dependencies: GuardDogAnalyzerDependencies = {},
  ) {
    validateOptions(options);
    this.options = {
      ...options,
      ...(options.rules === undefined ? {} : { rules: [...options.rules] }),
      ...(options.excludeRules === undefined
        ? {}
        : { excludeRules: [...options.excludeRules] }),
    };
    this.processRunner = dependencies.processRunner ?? new GuardDogProcessRunner();
    this.externalProcessRunner = dependencies.externalProcessRunner;
    this.parseOutput = dependencies.parseOutput ?? parseGuardDogOutput;
    this.now = dependencies.now ?? (() => new Date());
  }

  async analyzeResult(
    input: GuardDogAnalyzerInput,
    context: AnalyzerContext,
    signal?: AbortSignal,
  ): Promise<GuardDogAnalyzerResult>;
  async analyzeResult(
    input: GuardDogAnalyzerInput,
    signal?: AbortSignal,
  ): Promise<GuardDogAnalyzerResult>;
  async analyzeResult(
    input: GuardDogAnalyzerInput,
    contextOrSignal?: AnalyzerContext | AbortSignal,
    signal?: AbortSignal,
  ): Promise<GuardDogAnalyzerResult> {
    // Keep the pre-contract two-argument API working for existing callers.
    const analysisSignal = isAbortSignal(contextOrSignal)
      ? contextOrSignal
      : signal;
    const analysisStarted = this.now();
    let canonicalExtractedPath: string;

    try {
      const boundary = input.artifactBoundary ?? { mode: 'SCANNER_WORKSPACE' };
      if (boundary.mode === 'EXTERNAL_READ_ONLY_ARTIFACT'
        && input.networkIsolation?.mode !== 'VERIFIED_NETWORK_NONE') {
        throw new GuardDogInputPathError(
          'GuardDog external artifact analysis requires verified network isolation',
        );
      }
      canonicalExtractedPath = boundary.mode === 'SCANNER_WORKSPACE'
        ? await validateExtractedPath(
          this.options.workspaceRoot,
          input.context.scanId,
          input.context.artifact.extractedPath,
        )
        : await validateExternalReadOnlyPath(
          boundary.allowedArtifactRoot,
          input.context.artifact.extractedPath,
        );
    } catch (error) {
      return this.failureResult(
        input,
        analysisStarted,
        emptyProcessExecution(this.options.sandboxMode),
        safePathError(error),
      );
    }

    const args = buildGuardDogArgs(canonicalExtractedPath, this.options);
    let processResult: GuardDogProcessResult;
    try {
      const external = input.artifactBoundary?.mode === 'EXTERNAL_READ_ONLY_ARTIFACT';
      const runner = external ? this.externalProcessRunner : this.processRunner;
      if (runner === undefined) {
        throw new Error('External GuardDog process runner is unavailable');
      }
      processResult = await runner.run({
        executable: this.options.executable,
        args,
        timeoutMs: this.options.timeoutMs,
        killGraceMs: this.options.killGraceMs,
        maxOutputBytes: this.options.maxOutputBytes,
        signal: analysisSignal,
        ...(external ? {
          externalArtifact: {
            packageRoot: canonicalExtractedPath,
            containerPackageRoot: '/analysis/package',
          },
        } : {}),
      });
    } catch {
      return this.failureResult(
        input,
        analysisStarted,
        {
          ...emptyProcessExecution(this.options.sandboxMode),
          command: [this.options.executable, ...args],
        },
        'GuardDog process runner failed unexpectedly',
      );
    }

    const processExecution = toProcessExecution(
      processResult,
      this.options.sandboxMode,
      false,
    );
    const terminationErrors = processResult.terminationErrors.map(({ signal }) =>
      this.scanError(`GuardDog process termination failed for ${signal}`));

    if (processResult.timedOut) {
      return this.failureResult(
        input,
        analysisStarted,
        processExecution,
        'GuardDog execution timed out',
        'TIMEOUT',
        terminationErrors,
      );
    }
    if (processResult.processError !== undefined) {
      return this.failureResult(
        input,
        analysisStarted,
        processExecution,
        'GuardDog process failed to start',
        'FAILED',
        terminationErrors,
      );
    }
    if (processResult.outputLimitExceeded) {
      return this.failureResult(
        input,
        analysisStarted,
        processExecution,
        'GuardDog output exceeded the configured byte limit',
        'FAILED',
        terminationErrors,
      );
    }
    if (processResult.exitCode !== 0) {
      return this.failureResult(
        input,
        analysisStarted,
        processExecution,
        'GuardDog process exited unsuccessfully',
        'FAILED',
        terminationErrors,
      );
    }
    if (processResult.stdout.trim() === '') {
      return this.failureResult(
        input,
        analysisStarted,
        processExecution,
        'GuardDog returned empty output',
        'FAILED',
        terminationErrors,
      );
    }

    let parsed: GuardDogParsedOutput;
    try {
      parsed = this.parseOutput(processResult.stdout);
    } catch (error) {
      return this.failureResult(
        input,
        analysisStarted,
        processExecution,
        parserFailureMessage(error),
        'FAILED',
        terminationErrors,
      );
    }

    const errors = [
      ...parsed.reportedErrors.map(({ ruleOrStage }) => this.scanError(
        `GuardDog reported an error for "${safeIdentifier(ruleOrStage)}"`,
      )),
      ...terminationErrors,
    ];
    const stderrClassification = classifyGuardDogStderr(
      processResult.stderr,
      this.options.sandboxMode,
    );
    if (stderrClassification === 'UNKNOWN') {
      errors.push(this.scanError('GuardDog emitted an unclassified stderr warning'));
    }
    const status = parsed.reportedErrors.length > 0
      || parsed.warnings.length > 0
      || stderrClassification === 'UNKNOWN'
      ? 'PARTIAL'
      : 'SUCCESS';

    return {
      requestId: input.context.requestId,
      scanId: input.context.scanId,
      analyzer: this.name,
      analyzerVersion: this.version,
      status,
      findings: parsed.findings,
      errors,
      execution: executionTiming(analysisStarted, this.now()),
      guarddog: {
        tool: {
          name: 'guarddog',
          version: this.options.toolVersion,
        },
        issues: parsed.issues,
        risks: parsed.risks,
        toolAssessment: parsed.toolAssessment,
        execution: {
          ...processExecution,
          jsonParsed: true,
        },
      },
    };
  }

  private failureResult(
    input: GuardDogAnalyzerInput,
    started: Date,
    processExecution: GuardDogProcessExecution,
    message: string,
    status: 'FAILED' | 'TIMEOUT' = 'FAILED',
    additionalErrors: ScanError[] = [],
  ): GuardDogAnalyzerResult {
    return {
      requestId: input.context.requestId,
      scanId: input.context.scanId,
      analyzer: this.name,
      analyzerVersion: this.version,
      status,
      findings: [],
      errors: [this.scanError(message), ...additionalErrors],
      execution: executionTiming(started, this.now()),
      guarddog: {
        tool: {
          name: 'guarddog',
          version: this.options.toolVersion,
        },
        risks: [],
        execution: processExecution,
      },
    };
  }

  private scanError(message: string): ScanError {
    return {
      code: ScannerErrorCode.INTERNAL_ERROR,
      stage: 'ANALYZER:GUARDDOG',
      analyzer: this.name,
      message,
      retryable: false,
    };
  }
}

export function buildGuardDogArgs(
  canonicalExtractedPath: string,
  options: Pick<
    GuardDogAnalyzerOptions,
    'sandboxMode' | 'rules' | 'excludeRules'
  >,
): string[] {
  const args = [
    'npm',
    'scan',
    canonicalExtractedPath,
    '--output-format=json',
  ];
  if (options.sandboxMode === 'DISABLED') args.push('--no-sandbox');
  for (const ruleId of options.rules ?? []) args.push('--rules', ruleId);
  for (const ruleId of options.excludeRules ?? []) {
    args.push('--exclude-rules', ruleId);
  }
  return args;
}

/**
 * Classifies only stderr forms observed from GuardDog 3.1.0. The raw stream is
 * deliberately not returned so diagnostics cannot leak paths, URLs, or secrets.
 */
export function classifyGuardDogStderr(
  stderr: string,
  sandboxMode: GuardDogAnalyzerOptions['sandboxMode'],
): GuardDogStderrClassification {
  const lines = stderr
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return 'EMPTY';

  const sandboxWarning = 'WARNING: Scanning without kernel-level sandbox protection.';
  const hasSandboxWarning = sandboxMode === 'DISABLED'
    && lines.some((line) => line === sandboxWarning);
  const hasCacheWarning = lines.some(isKnownCacheWarning);
  if (lines.every((line) => isKnownCacheWarning(line)
    || (sandboxMode === 'DISABLED' && line === sandboxWarning))) {
    if (hasCacheWarning) return 'KNOWN_CACHE_WARNING';
    if (hasSandboxWarning) return 'KNOWN_SANDBOX_WARNING';
  }
  return 'UNKNOWN';
}

const KNOWN_CACHE_NETWORK_ERROR = /^Network error: HTTPSConnectionPool\(host='(?:github\.com|hugovk\.github\.io|packages\.ecosyste\.ms)', port=\d+\): Max retries exceeded with url: \/.+ \(caused by .+\)$/iu;
const KNOWN_CACHE_DOWNLOAD_ERROR = /^Failed to download new cache data from https:\/\/(?:github\.com\/LeoDog896\/npm-rank\/releases\/download\/latest\/raw\.json|hugovk\.github\.io\/top-pypi-packages\/top-pypi-packages\.min\.json|packages\.ecosyste\.ms\/api\/v1\/registries\/rubygems\.org\/package_names\?critical=true&per_page=1000)$/u;

function isKnownCacheWarning(line: string): boolean {
  return KNOWN_CACHE_NETWORK_ERROR.test(line) || KNOWN_CACHE_DOWNLOAD_ERROR.test(line);
}

async function validateExtractedPath(
  workspaceRoot: string,
  scanId: string,
  extractedPath: string,
): Promise<string> {
  if (!isSafePathSegment(scanId)) {
    throw new GuardDogInputPathError('GuardDog input scan ID is invalid');
  }

  const canonicalRoot = await canonicalDirectory(
    workspaceRoot,
    'GuardDog workspace root is unavailable',
  );
  const scanWorkspaceCandidate = resolve(canonicalRoot, scanId);
  const canonicalScanWorkspace = await canonicalDirectory(
    scanWorkspaceCandidate,
    'GuardDog scan workspace is unavailable',
  );
  if (canonicalScanWorkspace !== scanWorkspaceCandidate) {
    throw new GuardDogInputPathError('GuardDog scan workspace does not match the scan ID');
  }
  if (!isStrictlyWithin(canonicalRoot, canonicalScanWorkspace)) {
    throw new GuardDogInputPathError('GuardDog scan workspace is outside the workspace root');
  }

  const canonicalTarget = await canonicalDirectory(
    extractedPath,
    'GuardDog extracted directory is unavailable',
  );
  if (!isStrictlyWithin(canonicalScanWorkspace, canonicalTarget)) {
    throw new GuardDogInputPathError('GuardDog extracted directory is outside the scan workspace');
  }

  const allowedTargets = [
    resolve(canonicalScanWorkspace, 'extracted'),
    resolve(canonicalScanWorkspace, 'derived', 'obfuscation'),
  ];
  const matchesAllowedTarget = await Promise.all(allowedTargets.map(async (target) => {
    try {
      return canonicalTarget === await realpath(target);
    } catch {
      return false;
    }
  }));
  if (!matchesAllowedTarget.includes(true)) {
    throw new GuardDogInputPathError('GuardDog extracted directory does not match the scan workspace');
  }
  return canonicalTarget;
}

async function validateExternalReadOnlyPath(
  allowedArtifactRoot: string,
  extractedPath: string,
): Promise<string> {
  const canonicalRoot = await canonicalDirectory(
    allowedArtifactRoot,
    'GuardDog external artifact root is unavailable',
  );
  const canonicalTarget = await canonicalDirectory(
    extractedPath,
    'GuardDog external package directory is unavailable',
  );
  if (canonicalTarget !== canonicalRoot && !isStrictlyWithin(canonicalRoot, canonicalTarget)) {
    throw new GuardDogInputPathError('GuardDog external package directory is outside the allowed root');
  }
  return canonicalTarget;
}

async function canonicalDirectory(path: string, failureMessage: string): Promise<string> {
  try {
    const canonicalPath = await realpath(path);
    const pathStat = await stat(canonicalPath);
    if (!pathStat.isDirectory()) throw new Error('not a directory');
    return canonicalPath;
  } catch {
    throw new GuardDogInputPathError(failureMessage);
  }
}

function isSafePathSegment(value: string): boolean {
  return (
    value.length > 0
    && value !== '.'
    && value !== '..'
    && !value.includes('/')
    && !value.includes('\\')
    && !value.includes('\0')
  );
}

function isStrictlyWithin(parent: string, target: string): boolean {
  const relativePath = relative(parent, target);
  return (
    relativePath !== ''
    && relativePath !== '..'
    && !relativePath.startsWith(`..${sep}`)
    && !isAbsolute(relativePath)
  );
}

function validateOptions(options: GuardDogAnalyzerOptions): void {
  for (const [name, value] of [
    ['executable', options.executable],
    ['toolVersion', options.toolVersion],
    ['workspaceRoot', options.workspaceRoot],
  ] as const) {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(`GuardDog ${name} must be a non-empty string`);
    }
  }
  for (const [name, value] of [
    ['timeoutMs', options.timeoutMs],
    ['killGraceMs', options.killGraceMs],
    ['maxOutputBytes', options.maxOutputBytes],
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`GuardDog ${name} must be a positive safe integer`);
    }
  }
  if (options.sandboxMode !== 'REQUIRED' && options.sandboxMode !== 'DISABLED') {
    throw new Error('GuardDog sandboxMode is invalid');
  }
  if (options.rules !== undefined && options.excludeRules !== undefined) {
    throw new Error('GuardDog rules and excludeRules cannot be used together');
  }
  validateRules(options.rules, 'rules');
  validateRules(options.excludeRules, 'excludeRules');
}

function validateRules(
  rules: readonly string[] | undefined,
  optionName: string,
): void {
  if (rules === undefined) return;
  if (!Array.isArray(rules)) throw new Error(`GuardDog ${optionName} must be an array`);
  if (rules.some((ruleId) => typeof ruleId !== 'string' || ruleId.trim() === '')) {
    throw new Error(`GuardDog ${optionName} contains an invalid rule ID`);
  }
}

function toProcessExecution(
  result: GuardDogProcessResult,
  sandboxMode: GuardDogAnalyzerOptions['sandboxMode'],
  jsonParsed: boolean,
): GuardDogProcessExecution {
  return {
    command: [...result.command],
    exitCode: result.exitCode,
    signal: result.signal,
    jsonParsed,
    timedOut: result.timedOut,
    outputLimitExceeded: result.outputLimitExceeded,
    sandboxMode,
  };
}

function emptyProcessExecution(
  sandboxMode: GuardDogAnalyzerOptions['sandboxMode'],
): GuardDogProcessExecution {
  return {
    command: [],
    exitCode: null,
    signal: null,
    jsonParsed: false,
    timedOut: false,
    outputLimitExceeded: false,
    sandboxMode,
  };
}

function executionTiming(started: Date, completed: Date): {
  startedAt: string;
  completedAt: string;
  durationMs: number;
} {
  return {
    startedAt: started.toISOString(),
    completedAt: completed.toISOString(),
    durationMs: Math.max(0, completed.getTime() - started.getTime()),
  };
}

function isAbortSignal(value: AnalyzerContext | AbortSignal | undefined): value is AbortSignal {
  return value !== undefined
    && typeof value === 'object'
    && 'aborted' in value
    && typeof value.aborted === 'boolean';
}

function parserFailureMessage(error: unknown): string {
  if (!(error instanceof GuardDogOutputParserError)) {
    return 'GuardDog output could not be interpreted';
  }
  if (error.kind === 'EMPTY_OUTPUT') return 'GuardDog returned empty output';
  if (error.kind === 'INVALID_JSON') return 'GuardDog returned invalid JSON output';
  return 'GuardDog output did not match the required JSON structure';
}

function safeIdentifier(value: string): string {
  const sanitized = value
    .replace(/[^A-Za-z0-9_.:-]/gu, '?')
    .slice(0, 128);
  return sanitized === '' ? 'unknown' : sanitized;
}

function safePathError(error: unknown): string {
  return error instanceof GuardDogInputPathError
    ? error.message
    : 'GuardDog input path validation failed';
}

class GuardDogInputPathError extends Error {}
