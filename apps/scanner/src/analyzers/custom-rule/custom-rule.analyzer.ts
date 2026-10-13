import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import type {
  AnalyzerResult,
  Finding,
  ScanError,
} from '../../domain/analysis.types';
import { ScannerErrorCode } from '../../domain/scanner-error-code';
import type { Analyzer, AnalyzerContext } from '../analyzer.contract';
import {
  analyzeP0StaticFlows,
  P0_RULE_IDS,
  type P0RelationDraft,
} from './custom-rule-p0-static';

const SIGNAL_RULE_IDS = {
  sensitiveFile: 'custom.signal.sensitive-file-access',
  process: 'custom.signal.process-access',
  env: 'custom.signal.environment-access',
  network: 'custom.signal.network-access',
} as const;

const OBSERVATION_RULE_IDS = {
  lifecycleProcess: 'custom.lifecycle-process-coexistence',
  envNetwork: 'custom.env-network-coexistence',
  sensitiveFileNetwork: 'custom.sensitive-file-network-coexistence',
  ...P0_RULE_IDS,
} as const;

export const CUSTOM_RULE_ANALYZER_VERSION = '0.2.0';

export type CustomRuleObservationRuleId =
  (typeof OBSERVATION_RULE_IDS)[keyof typeof OBSERVATION_RULE_IDS];

export interface CustomRuleAnalyzerInput {
  extractedPath: string;
  packageJson: unknown;
}

export interface CustomRuleAnalyzerOptions {
  semgrepBin: string;
  ruleConfigPath: string;
  timeoutMs: number;
  ruleVersion?: string;
}

export interface CustomRuleLocation {
  type: 'SOURCE_FILE' | 'METADATA';
  path?: string;
  startLine?: number;
  startColumn?: number;
  endLine?: number;
  endColumn?: number;
  jsonPointer?: string;
}

/** Legacy observation shape retained for the existing analyzer API. */
export interface CustomRuleObservation {
  ruleId: CustomRuleObservationRuleId;
  ruleVersion?: string;
  type: 'CAPABILITY_PATTERN' | 'CO_OCCURRENCE_SIGNAL';
  message: string;
  locations: CustomRuleLocation[];
  observationKey?: string;
  data: {
    interpretation: 'STATIC_PATTERN' | 'CO_OCCURRENCE_ONLY';
    signalRuleIds: string[];
    doesNotProve: string;
    actionHint?: string;
    sourceType?: string;
    sinkType?: string;
    executionContext?: 'PREINSTALL' | 'INSTALL' | 'POSTINSTALL' | 'PREPARE' | 'RUNTIME' | 'UNKNOWN';
    evidenceKind?: string;
    analysisLevel?: 'PATTERN' | 'CO_OCCURRENCE' | 'DATA_FLOW' | 'EXECUTION_PATH';
    limitations?: string[];
    reviewStatus?: 'PENDING';
    confidence?: 'LOW' | 'MEDIUM' | 'HIGH';
  };
}

export interface CustomRuleRelationCandidate {
  relationId: string;
  relationType: P0RelationDraft['relationType'];
  sourceFindingIds: string[];
  sinkFindingIds: string[];
  evidenceKind: P0RelationDraft['evidenceKind'];
  analysisLevel: P0RelationDraft['analysisLevel'];
  executionContext: P0RelationDraft['executionContext'];
  status: 'CANDIDATE';
  provenance: {
    source: 'CUSTOM_STATIC_RULE';
    analyzer: 'custom-rule';
    analyzerVersion: string;
    ruleVersion?: string;
  };
  locations: {
    sources: CustomRuleLocation[];
    sinks: CustomRuleLocation[];
  };
  limitations: string[];
}

export interface CustomRuleToolError {
  code: 'ANALYZER_FAILED' | 'ANALYZER_TIMEOUT';
  phase: 'SPAWN' | 'TIMEOUT' | 'OUTPUT_PARSE' | 'SEMGREP';
  message: string;
}

export interface CustomRuleRawResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  outputLimitExceeded?: boolean;
  failureReasonCode?: string;
}

export interface CustomRuleAnalysisResult {
  status: 'SUCCESS' | 'PARTIAL' | 'FAILED' | 'TIMEOUT';
  observations: CustomRuleObservation[];
  relationCandidates: CustomRuleRelationCandidate[];
  errors: CustomRuleToolError[];
  rawResult: CustomRuleRawResult;
}

export type CustomRuleFinding = Finding<Record<string, unknown>>;
export interface CustomRuleAnalyzerResult extends AnalyzerResult<CustomRuleFinding> {
  rawResult?: CustomRuleRawResult;
  relationCandidates: CustomRuleRelationCandidate[];
}

interface SemgrepSignal {
  ruleId: string;
  path: string;
  startLine?: number;
  startColumn?: number;
  endLine?: number;
  endColumn?: number;
  message?: string;
}

export interface CustomRuleProcessCapture extends CustomRuleRawResult {
  spawnError?: Error;
  timedOut: boolean;
  outputLimitExceeded?: boolean;
}

export interface CustomRuleProcessRequest {
  executable: string;
  args: readonly string[];
  packageRoot: string;
  ruleConfigPath: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface CustomRuleProcessRunnerPort {
  run(request: CustomRuleProcessRequest): Promise<CustomRuleProcessCapture>;
}

@Injectable()
export class CustomRuleAnalyzer implements Analyzer<
  CustomRuleAnalyzerInput,
  CustomRuleAnalyzerResult
> {
  readonly name = 'custom-rule';
  readonly version = CUSTOM_RULE_ANALYZER_VERSION;

  constructor(
    private readonly options: CustomRuleAnalyzerOptions,
    private readonly processRunner?: CustomRuleProcessRunnerPort,
  ) {
    if (options.semgrepBin.length === 0 || options.ruleConfigPath.length === 0) {
      throw new Error('Semgrep executable and rule configuration are required');
    }
    if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) {
      throw new Error('Semgrep timeout must be a positive integer');
    }
  }

  async analyze(
    input: CustomRuleAnalyzerInput,
    signal?: AbortSignal,
  ): Promise<CustomRuleAnalysisResult> {
    const packageJson = asRecord(input.packageJson);
    const lifecyclePointers = getLifecyclePointers(packageJson);
    const capture = this.processRunner === undefined
      ? await this.runSemgrep(input.extractedPath, signal)
      : await this.processRunner.run({
        executable: this.options.semgrepBin,
        args: ['--json', '--config', this.options.ruleConfigPath, input.extractedPath],
        packageRoot: input.extractedPath,
        ruleConfigPath: this.options.ruleConfigPath,
        timeoutMs: this.options.timeoutMs,
        ...(signal === undefined ? {} : { signal }),
      });
    const errors: CustomRuleToolError[] = [];

    if (capture.timedOut) {
      errors.push({
        code: 'ANALYZER_TIMEOUT',
        phase: 'TIMEOUT',
        message: 'Semgrep execution exceeded the injected timeout',
      });
    }
    if (capture.spawnError !== undefined) {
      errors.push({
        code: 'ANALYZER_FAILED',
        phase: 'SPAWN',
        message: capture.spawnError.message,
      });
    }
    if (capture.failureReasonCode !== undefined && !capture.timedOut && capture.spawnError === undefined) {
      errors.push({
        code: 'ANALYZER_FAILED', phase: 'SEMGREP', message: capture.failureReasonCode,
      });
    }

    const parsed = capture.stdout.trim() === ''
      && (capture.spawnError !== undefined || capture.timedOut)
      ? { signals: [], errors: [] }
      : this.parseSemgrepOutput(capture.stdout);
    if (parsed.error !== undefined) errors.push(parsed.error);
    errors.push(...this.parseSemgrepErrors(parsed.errors));

    const p0 = await analyzeP0StaticFlows(input.extractedPath, input.packageJson);
    const observations = [
      ...this.createObservations(parsed.signals, lifecyclePointers),
      ...p0.observations.map((observation): CustomRuleObservation => ({
        ruleId: observation.ruleId,
        ...(this.options.ruleVersion === undefined
          ? {}
          : { ruleVersion: this.options.ruleVersion }),
        type: 'CAPABILITY_PATTERN',
        message: observation.message,
        locations: observation.locations,
        observationKey: observation.key,
        data: observation.data,
      })),
    ];
    const relationCandidates = this.createRelationCandidates(observations, p0.relations);
    const status = this.getStatus(capture, parsed, observations, errors);

    return {
      status,
      observations,
      relationCandidates,
      errors,
      rawResult: {
        stdout: capture.stdout,
        stderr: capture.stderr,
        exitCode: capture.exitCode,
        signal: capture.signal,
        ...(capture.outputLimitExceeded === undefined ? {} : { outputLimitExceeded: capture.outputLimitExceeded }),
        ...(capture.failureReasonCode === undefined ? {} : { failureReasonCode: capture.failureReasonCode }),
      },
    };
  }

  /**
   * Adapts the existing Semgrep analysis result to the shared analyzer result
   * contract without changing the legacy result returned by analyze().
   */
  async analyzeResult(
    input: CustomRuleAnalyzerInput,
    context: AnalyzerContext,
    signal?: AbortSignal,
  ): Promise<CustomRuleAnalyzerResult> {
    const result = await this.analyze(input, signal);

    return {
      requestId: context.requestId,
      scanId: context.scanId,
      analyzer: this.name,
      analyzerVersion: this.version,
      status: result.status,
      findings: result.observations.map((observation, index) => ({
        findingId: `${this.name}:${observation.ruleId}:${index}`,
        ruleId: observation.ruleId,
        type: observation.type,
        message: observation.message,
        location: observation.locations[0],
        data: {
          ...observation.data,
          locations: observation.locations,
          provenance: {
            source: 'CUSTOM_STATIC_RULE',
            analyzer: this.name,
            analyzerVersion: this.version,
            ...(observation.ruleVersion === undefined
              ? {}
              : { ruleVersion: observation.ruleVersion }),
          },
          limitations: observation.data.limitations ?? [observation.data.doesNotProve],
          reviewStatus: observation.data.reviewStatus ?? 'PENDING',
          confidence: observation.data.confidence ?? 'MEDIUM',
          ...(observation.ruleVersion === undefined
            ? {}
            : { ruleVersion: observation.ruleVersion }),
        },
      })),
      errors: result.errors.map((error) => this.toScanError(error)),
      rawResult: result.rawResult,
      relationCandidates: result.relationCandidates,
    };
  }

  private createRelationCandidates(
    observations: CustomRuleObservation[],
    drafts: P0RelationDraft[],
  ): CustomRuleRelationCandidate[] {
    const findingByKey = new Map<string, { id: string; locations: CustomRuleLocation[] }>();
    observations.forEach((observation, index) => {
      if (observation.observationKey !== undefined) {
        findingByKey.set(observation.observationKey, {
          id: `${this.name}:${observation.ruleId}:${index}`,
          locations: observation.locations,
        });
      }
    });

    const candidates = new Map<string, CustomRuleRelationCandidate>();
    for (const draft of drafts) {
      const sources = draft.sourceKeys.flatMap((key) => {
        const value = findingByKey.get(key);
        return value === undefined ? [] : [value];
      });
      const sinks = draft.sinkKeys.flatMap((key) => {
        const value = findingByKey.get(key);
        return value === undefined ? [] : [value];
      });
      if (sources.length !== draft.sourceKeys.length || sinks.length !== draft.sinkKeys.length) continue;
      const sourceFindingIds = [...new Set(sources.map(({ id }) => id))].sort();
      const sinkFindingIds = [...new Set(sinks.map(({ id }) => id))].sort();
      const tuple = `${draft.relationType}:${sourceFindingIds.join(',')}:${sinkFindingIds.join(',')}`;
      const relationId = `custom-relation:${createHash('sha256').update(tuple).digest('hex').slice(0, 16)}`;
      candidates.set(tuple, {
        relationId,
        relationType: draft.relationType,
        sourceFindingIds,
        sinkFindingIds,
        evidenceKind: draft.evidenceKind,
        analysisLevel: draft.analysisLevel,
        executionContext: draft.executionContext,
        status: 'CANDIDATE',
        provenance: {
          source: 'CUSTOM_STATIC_RULE',
          analyzer: 'custom-rule',
          analyzerVersion: this.version,
          ...(this.options.ruleVersion === undefined
            ? {}
            : { ruleVersion: this.options.ruleVersion }),
        },
        locations: {
          sources: sources.flatMap(({ locations }) => locations),
          sinks: sinks.flatMap(({ locations }) => locations),
        },
        limitations: [...draft.limitations],
      });
    }
    return [...candidates.values()].sort((left, right) => left.relationId.localeCompare(right.relationId));
  }

  private toScanError(error: CustomRuleToolError): ScanError {
    return {
      code: ScannerErrorCode.INTERNAL_ERROR,
      stage: `ANALYZER:${error.phase}`,
      analyzer: this.name,
      message: error.message,
      retryable: error.code === 'ANALYZER_TIMEOUT',
    };
  }

  private runSemgrep(
    extractedPath: string,
    signal?: AbortSignal,
  ): Promise<CustomRuleProcessCapture> {
    return new Promise((resolve) => {
      const child = spawn(
        this.options.semgrepBin,
        ['--json', '--config', this.options.ruleConfigPath, extractedPath],
        { shell: false, windowsHide: true },
      );
      let stdout = '';
      let stderr = '';
      let settled = false;
      let timedOut = false;
      let terminationStarted = false;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      let timeoutTimer: ReturnType<typeof setTimeout> | undefined;

      const finish = (capture: CustomRuleProcessCapture): void => {
        if (settled) return;
        settled = true;
        if (killTimer !== undefined) clearTimeout(killTimer);
        if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
        signal?.removeEventListener('abort', abortHandler);
        resolve(capture);
      };

      const beginTermination = (): void => {
        if (settled || terminationStarted) return;
        terminationStarted = true;
        timedOut = true;
        child.kill('SIGTERM');
        if (!settled) {
          killTimer = setTimeout(() => {
            if (!settled) child.kill('SIGKILL');
          }, 100);
        }
      };

      const abortHandler = (): void => beginTermination();

      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => { stdout += chunk; });
      child.stderr?.on('data', (chunk: string) => { stderr += chunk; });
      child.once('error', (error: Error) => finish({
        stdout,
        stderr,
        exitCode: null,
        signal: null,
        spawnError: error,
        timedOut,
      }));
      child.once('close', (exitCode: number | null, signal: NodeJS.Signals | null) => finish({
        stdout,
        stderr,
        exitCode,
        signal,
        timedOut,
      }));

      signal?.addEventListener('abort', abortHandler, { once: true });

      timeoutTimer = setTimeout(() => {
        beginTermination();
      }, this.options.timeoutMs);
    });
  }

  private parseSemgrepOutput(stdout: string): {
    signals: SemgrepSignal[];
    errors: unknown[];
    error?: CustomRuleToolError;
  } {
    if (stdout.trim() === '') {
      return { signals: [], errors: [], error: {
        code: 'ANALYZER_FAILED',
        phase: 'OUTPUT_PARSE',
        message: 'Semgrep returned empty stdout',
      } };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout) as unknown;
    } catch {
      return { signals: [], errors: [], error: {
        code: 'ANALYZER_FAILED',
        phase: 'OUTPUT_PARSE',
        message: 'Semgrep stdout is not valid JSON',
      } };
    }

    const result = asRecord(parsed);
    if (result === undefined || !Array.isArray(result.results)) {
      return { signals: [], errors: [], error: {
        code: 'ANALYZER_FAILED',
        phase: 'OUTPUT_PARSE',
        message: 'Semgrep JSON does not contain a results array',
      } };
    }

    return {
      signals: result.results.flatMap((value) => this.parseSignal(value)),
      errors: Array.isArray(result.errors) ? result.errors : [],
    };
  }

  private parseSignal(value: unknown): SemgrepSignal[] {
    const result = asRecord(value);
    const extra = asRecord(result?.extra);
    const start = asRecord(result?.start);
    const end = asRecord(result?.end);
    const ruleId = typeof result?.check_id === 'string' ? result.check_id : undefined;
    const path = typeof result?.path === 'string' ? result.path : undefined;
    if (ruleId === undefined || path === undefined || !this.isSignalRule(ruleId)) return [];

    return [{
      ruleId,
      path,
      startLine: numberValue(start?.line),
      startColumn: numberValue(start?.column),
      endLine: numberValue(end?.line),
      endColumn: numberValue(end?.column),
      message: typeof extra?.message === 'string' ? extra.message : undefined,
    }];
  }

  private parseSemgrepErrors(values: unknown[]): CustomRuleToolError[] {
    return values.map((value) => {
      const record = asRecord(value);
      const message = record?.message;
      return {
        code: 'ANALYZER_FAILED' as const,
        phase: 'SEMGREP' as const,
        message: typeof value === 'string'
          ? value
          : typeof message === 'string' ? message : 'Semgrep reported an error',
      };
    });
  }

  private createObservations(
    signals: SemgrepSignal[],
    lifecyclePointers: string[],
  ): CustomRuleObservation[] {
    const sensitive = signals.filter(({ ruleId }) => ruleId === SIGNAL_RULE_IDS.sensitiveFile);
    const processes = signals.filter(({ ruleId }) => ruleId === SIGNAL_RULE_IDS.process);
    const environments = signals.filter(({ ruleId }) => ruleId === SIGNAL_RULE_IDS.env);
    const networks = signals.filter(({ ruleId }) => ruleId === SIGNAL_RULE_IDS.network);
    const observations: CustomRuleObservation[] = sensitive.map((signal) => this.observation(
      OBSERVATION_RULE_IDS.sensitiveFile,
      'CAPABILITY_PATTERN',
      'Sensitive file access pattern observed; this is a static capability signal only.',
      [this.sourceLocation(signal)],
      [signal.ruleId],
      'This does not prove sensitive data was read or disclosed.',
    ));

    if (lifecyclePointers.length > 0 && processes.length > 0) {
      for (const process of processes) {
        observations.push(this.observation(
          OBSERVATION_RULE_IDS.lifecycleProcess,
          'CO_OCCURRENCE_SIGNAL',
          'A lifecycle script and a process API pattern coexist in the analyzed package.',
          [
            ...lifecyclePointers.map((jsonPointer) => ({ type: 'METADATA' as const, jsonPointer })),
            this.sourceLocation(process),
          ],
          [process.ruleId],
          'This does not prove that a process was executed by the lifecycle script.',
        ));
      }
    }

    if (environments.length > 0 && networks.length > 0) {
      observations.push(this.observation(
        OBSERVATION_RULE_IDS.envNetwork,
        'CO_OCCURRENCE_SIGNAL',
        'Environment access and network access patterns coexist in the analyzed source.',
        [...environments, ...networks].map((signal) => this.sourceLocation(signal)),
        [...new Set([...environments, ...networks].map(({ ruleId }) => ruleId))],
        'This does not prove that an environment value was sent over the network.',
      ));
    }

    if (sensitive.length > 0 && networks.length > 0) {
      observations.push(this.observation(
        OBSERVATION_RULE_IDS.sensitiveFileNetwork,
        'CO_OCCURRENCE_SIGNAL',
        'Sensitive file access and network access patterns coexist in the analyzed source.',
        [...sensitive, ...networks].map((signal) => this.sourceLocation(signal)),
        [...new Set([...sensitive, ...networks].map(({ ruleId }) => ruleId))],
        'This does not prove that sensitive file contents were sent over the network.',
      ));
    }

    return observations;
  }

  private observation(
    ruleId: CustomRuleObservationRuleId,
    type: CustomRuleObservation['type'],
    message: string,
    locations: CustomRuleLocation[],
    signalRuleIds: string[],
    doesNotProve: string,
  ): CustomRuleObservation {
    return {
      ruleId,
      ...(this.options.ruleVersion === undefined
        ? {}
        : { ruleVersion: this.options.ruleVersion }),
      type,
      message,
      locations,
      data: {
        interpretation: type === 'CAPABILITY_PATTERN' ? 'STATIC_PATTERN' : 'CO_OCCURRENCE_ONLY',
        signalRuleIds,
        doesNotProve,
      },
    };
  }

  private sourceLocation(signal: SemgrepSignal): CustomRuleLocation {
    return {
      type: 'SOURCE_FILE',
      path: signal.path,
      startLine: signal.startLine,
      startColumn: signal.startColumn,
      endLine: signal.endLine,
      endColumn: signal.endColumn,
    };
  }

  private getStatus(
    capture: CustomRuleProcessCapture,
    parsed: { signals: SemgrepSignal[]; errors: unknown[]; error?: CustomRuleToolError },
    observations: CustomRuleObservation[],
    errors: CustomRuleToolError[],
  ): CustomRuleAnalysisResult['status'] {
    if (capture.timedOut) return 'TIMEOUT';
    if (observations.length > 0 && errors.length > 0) return 'PARTIAL';
    if (errors.length > 0 || capture.spawnError !== undefined || capture.exitCode !== 0) return 'FAILED';
    if (parsed.signals.length === 0 && capture.exitCode === 0) return 'SUCCESS';
    return 'SUCCESS';
  }

  private isSignalRule(ruleId: string): boolean {
    return Object.values(SIGNAL_RULE_IDS).includes(ruleId as (typeof SIGNAL_RULE_IDS)[keyof typeof SIGNAL_RULE_IDS]);
  }
}

function getLifecyclePointers(packageJson: Record<string, unknown> | undefined): string[] {
  const scripts = asRecord(packageJson?.scripts);
  if (scripts === undefined) return [];
  return ['preinstall', 'install', 'postinstall', 'prepare']
    .filter((script) => Object.prototype.hasOwnProperty.call(scripts, script))
    .map((script) => `/scripts/${script}`);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}
