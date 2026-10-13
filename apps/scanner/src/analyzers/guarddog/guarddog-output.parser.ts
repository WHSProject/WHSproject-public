import { posix, win32 } from 'node:path';

import type { FindingLocation } from '../../domain/analysis.types';
import {
  GuardDogOutputParserError,
  type GuardDogFinding,
  type GuardDogFindingData,
  type GuardDogFindingType,
  type GuardDogParsedOutput,
  type GuardDogParserWarning,
  type GuardDogRawOutput,
  type GuardDogRawRisk,
  type GuardDogReportedError,
  type GuardDogRiskLabel,
  type GuardDogSourceFindingRaw,
  type GuardDogToolAssessment,
} from './guarddog.types';

const RISK_LABELS = new Set<GuardDogRiskLabel>([
  'no_risks_detected',
  'low',
  'suspicious',
  'high_risk',
]);

export function parseGuardDogOutput(stdout: string): GuardDogParsedOutput {
  if (stdout.trim() === '') {
    throw new GuardDogOutputParserError(
      'EMPTY_OUTPUT',
      'GuardDog returned empty stdout',
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout) as unknown;
  } catch {
    throw new GuardDogOutputParserError(
      'INVALID_JSON',
      'GuardDog stdout is not valid JSON',
    );
  }

  const rawOutput = asRecord(parsed);
  if (rawOutput === undefined) {
    throw new GuardDogOutputParserError(
      'INVALID_TOP_LEVEL',
      'GuardDog JSON must be an object',
    );
  }

  const results = requireRecord(rawOutput.results, 'INVALID_RESULTS', 'results');
  const errors = requireRecord(rawOutput.errors, 'INVALID_ERRORS', 'errors');
  if (!Array.isArray(rawOutput.risks)) {
    throw new GuardDogOutputParserError(
      'INVALID_RISKS',
      'GuardDog JSON risks must be an array',
    );
  }
  const riskScore = requireRecord(
    rawOutput.risk_score,
    'INVALID_RISK_SCORE',
    'risk_score',
  );

  const warnings: GuardDogParserWarning[] = [];
  const findings = parseFindings(results, warnings);
  const reportedErrors = parseReportedErrors(errors, warnings);
  const risks = parseRisks(rawOutput.risks, warnings);
  const toolAssessment = parseToolAssessment(riskScore);

  return {
    package: (rawOutput as GuardDogRawOutput).package,
    issues: (rawOutput as GuardDogRawOutput).issues,
    findings,
    reportedErrors,
    warnings,
    risks,
    toolAssessment,
    hasRuleInterpretationFailures: warnings.some(({ kind }) =>
      kind === 'UNSUPPORTED_RULE_RESULT' || kind === 'INVALID_FINDING'),
  };
}

function parseFindings(
  results: Record<string, unknown>,
  warnings: GuardDogParserWarning[],
): GuardDogFinding[] {
  return Object.keys(results)
    .sort()
    .flatMap((ruleId) => parseRuleResult(ruleId, results[ruleId], warnings));
}

function parseRuleResult(
  ruleId: string,
  value: unknown,
  warnings: GuardDogParserWarning[],
): GuardDogFinding[] {
  if (ruleId.length === 0) {
    warnings.push({
      kind: 'UNSUPPORTED_RULE_RESULT',
      ruleId,
      message: 'GuardDog returned an empty rule ID',
    });
    return [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((candidate, occurrenceIndex) => {
      const rawFinding = asRecord(candidate);
      if (rawFinding === undefined) {
        warnings.push({
          kind: 'INVALID_FINDING',
          ruleId,
          occurrenceIndex,
          message: `GuardDog rule "${safeRuleName(ruleId)}" returned a non-object finding`,
        });
        return [];
      }
      return [toFinding(ruleId, occurrenceIndex, rawFinding)];
    });
  }

  const record = asRecord(value);
  if (record !== undefined && Object.keys(record).length === 0) return [];

  warnings.push({
    kind: 'UNSUPPORTED_RULE_RESULT',
    ruleId,
    message: `GuardDog rule "${safeRuleName(ruleId)}" returned an unsupported result shape`,
  });
  return [];
}

function toFinding(
  ruleId: string,
  occurrenceIndex: number,
  rawFinding: GuardDogSourceFindingRaw,
): GuardDogFinding {
  const data: GuardDogFindingData = {
    guarddog: {
      resultRuleId: ruleId,
      rawResult: rawFinding,
    },
  };
  if (typeof rawFinding.identifies === 'string') data.identifies = rawFinding.identifies;
  if (typeof rawFinding.code === 'string') data.code = rawFinding.code;
  if (typeof rawFinding.match === 'string') data.match = rawFinding.match;

  const location = parseLocation(rawFinding.location);
  const parsedMessage = typeof rawFinding.message === 'string'
    ? safeMessage(rawFinding.message)
    : '';
  return {
    findingId: `guarddog:${ruleId}:${occurrenceIndex}`,
    ruleId,
    type: classifyRule(ruleId),
    message: parsedMessage !== ''
      ? parsedMessage
      : `GuardDog rule "${safeRuleName(ruleId)}" reported a static finding`,
    ...(location === undefined ? {} : { location }),
    data,
  };
}

function classifyRule(ruleId: string): GuardDogFindingType {
  if (ruleId.startsWith('capability-')) return 'CAPABILITY';
  if (ruleId.startsWith('threat-')) return 'THREAT_INDICATOR';
  return 'UNKNOWN';
}

function parseLocation(value: unknown): FindingLocation | undefined {
  if (typeof value !== 'string') return undefined;

  const match = /^(.*):([1-9]\d*)$/u.exec(value);
  if (match === null) return undefined;
  const rawPath = match[1];
  const rawLine = match[2];
  if (rawPath === undefined || rawPath.length === 0 || rawLine === undefined) {
    return undefined;
  }

  const startLine = Number(rawLine);
  if (!Number.isSafeInteger(startLine) || startLine <= 0) return undefined;
  if (
    /[\u0000-\u001f\u007f]/u.test(rawPath)
    || posix.isAbsolute(rawPath)
    || win32.isAbsolute(rawPath)
  ) {
    return undefined;
  }
  if (rawPath.split(/[\\/]+/u).includes('..')) return undefined;

  return {
    type: 'SOURCE_FILE',
    path: rawPath.replace(/\\/gu, '/'),
    startLine,
  };
}

function parseReportedErrors(
  errors: Record<string, unknown>,
  warnings: GuardDogParserWarning[],
): GuardDogReportedError[] {
  return Object.keys(errors).sort().map((ruleOrStage) => {
    const value = errors[ruleOrStage];
    if (typeof value === 'string') {
      const message = safeMessage(value);
      if (message !== '') return { ruleOrStage, message };
    }

    warnings.push({
      kind: 'INVALID_REPORTED_ERROR',
      ruleId: ruleOrStage,
      message: `GuardDog error "${safeRuleName(ruleOrStage)}" did not contain a string message`,
    });
    return {
      ruleOrStage,
      message: `GuardDog reported an error for "${safeRuleName(ruleOrStage)}"`,
    };
  });
}

function parseRisks(
  values: unknown[],
  warnings: GuardDogParserWarning[],
): GuardDogRawRisk[] {
  return values.flatMap((value, riskIndex) => {
    const risk = asRecord(value);
    if (risk !== undefined) return [risk];

    warnings.push({
      kind: 'INVALID_RISK',
      riskIndex,
      message: `GuardDog risk at index ${riskIndex} is not an object`,
    });
    return [];
  });
}

function parseToolAssessment(
  riskScore: Record<string, unknown>,
): GuardDogToolAssessment {
  if (typeof riskScore.score !== 'number' || !Number.isFinite(riskScore.score)) {
    throw invalidRiskScore('score must be a finite number');
  }
  if (!isRiskLabel(riskScore.label)) {
    throw invalidRiskScore('label is not supported');
  }
  if (
    !Number.isSafeInteger(riskScore.findings_count)
    || (riskScore.findings_count as number) < 0
  ) {
    throw invalidRiskScore('findings_count must be a non-negative safe integer');
  }
  const scoreBreakdown = asRecord(riskScore.score_breakdown);
  if (scoreBreakdown === undefined) {
    throw invalidRiskScore('score_breakdown must be an object');
  }

  return {
    score: riskScore.score,
    label: riskScore.label,
    findingsCount: riskScore.findings_count as number,
    scoreBreakdown,
    raw: riskScore,
  };
}

function requireRecord(
  value: unknown,
  kind: 'INVALID_RESULTS' | 'INVALID_ERRORS' | 'INVALID_RISK_SCORE',
  field: string,
): Record<string, unknown> {
  const record = asRecord(value);
  if (record === undefined) {
    throw new GuardDogOutputParserError(
      kind,
      `GuardDog JSON ${field} must be an object`,
    );
  }
  return record;
}

function invalidRiskScore(detail: string): GuardDogOutputParserError {
  return new GuardDogOutputParserError(
    'INVALID_RISK_SCORE',
    `GuardDog JSON risk_score ${detail}`,
  );
}

function isRiskLabel(value: unknown): value is GuardDogRiskLabel {
  return typeof value === 'string' && RISK_LABELS.has(value as GuardDogRiskLabel);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function safeRuleName(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/gu, '?');
}

function safeMessage(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/gu, ' ').trim();
}
