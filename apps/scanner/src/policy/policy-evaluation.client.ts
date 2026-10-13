import { Injectable } from '@nestjs/common';

import { loadScannerEnvironment, type ScannerEnvironment } from '../config/scanner-environment';
import { ScannerErrorCode } from '../domain/scanner-error-code';
import type { OsvFeedResult } from '../osv/osv-feed.types';
import type { AgentAnalysisSummary } from '../llm-agent/output.contract';

export interface PolicyEvaluationRequest {
  requestId: string;
  scanStatus: 'COMPLETED' | 'PARTIAL' | 'FAILED' | 'TIMEOUT';
  scanId: string;
  subject: {
    ecosystem: 'npm';
    packageName: string;
    packageVersion: string;
    artifactHash: string;
    integrity: string;
  };
  evidences: unknown[];
  osvFeed: OsvFeedResult;
  agentAnalysisSummary?: AgentAnalysisSummary;
}

export class PolicyEvaluationError extends Error {
  public readonly code: ScannerErrorCode;

  constructor(
    message: string,
    public readonly statusCode: number | null,
    public readonly retryable: boolean,
    code: ScannerErrorCode,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.code = code;
    this.name = 'PolicyEvaluationError';
  }
}

@Injectable()
export class PolicyEvaluationClient {
  constructor(
    private readonly environment: ScannerEnvironment = loadScannerEnvironment(),
  ) {}

  async evaluate(request: PolicyEvaluationRequest): Promise<void> {
    let response: Response;
    try {
      response = await globalThis.fetch(
        `${this.environment.POLICY_URL.replace(/\/+$/u, '')}/internal/v1/evaluations`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(request),
          signal: AbortSignal.timeout(this.environment.POLICY_TIMEOUT_MS),
        },
      );
    } catch (error) {
      if (isTimeoutError(error)) {
        throw new PolicyEvaluationError(
          'Policy Evaluation request timed out',
          null,
          true,
          ScannerErrorCode.POLICY_EVALUATION_TIMEOUT,
          error,
        );
      }
      throw new PolicyEvaluationError(
        'Policy Evaluation request failed',
        null,
        true,
        ScannerErrorCode.POLICY_EVALUATION_FAILED,
        error,
      );
    }

    if (!response.ok) {
      throw new PolicyEvaluationError(
        `Policy Evaluation request failed with HTTP ${response.status}`,
        response.status,
        response.status >= 500,
        ScannerErrorCode.POLICY_EVALUATION_FAILED,
      );
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      throw new PolicyEvaluationError(
        'Policy Evaluation response was not valid JSON',
        response.status,
        false,
        ScannerErrorCode.POLICY_EVALUATION_FAILED,
        error,
      );
    }

    if (!isSuccessfulPersistence(body)) {
      throw new PolicyEvaluationError(
        'Policy Evaluation response did not confirm persistence',
        response.status,
        false,
        ScannerErrorCode.POLICY_EVALUATION_FAILED,
      );
    }
  }
}

function isTimeoutError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'name' in error
    && error.name === 'TimeoutError';
}

function isSuccessfulPersistence(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  const persistence = (value as Record<string, unknown>).persistence;
  if (
    typeof persistence !== 'object'
    || persistence === null
    || Array.isArray(persistence)
  ) {
    return false;
  }

  const persistenceRecord = persistence as Record<string, unknown>;
  return persistenceRecord.saved === true
    && (persistenceRecord.status === 'SAVED'
      || persistenceRecord.status === 'ALREADY_EXISTS');
}
