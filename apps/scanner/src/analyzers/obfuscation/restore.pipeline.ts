import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve, sep } from 'node:path';
import { parse } from '@babel/parser';
import _traverse from '@babel/traverse';

import type {
  Budget,
  FileVerdict,
  RestoreLimitation,
  RestoreReason,
  RestoreResult,
  RestoredFile,
  RestoredPayload,
  RestoreStage,
  RestoreStageResult,
  UnresolvedFile,
  ValidationSnapshot,
} from './obfuscation.types';
import { detect } from './detector';
import { normalizeCode } from './normalizer';
import { restoreStrings } from './string-restorer';
import { restoreStructure } from './structure-restorer';
import {
  composeLineMappings,
  identityLineMapping,
  mapDerivedLineRange,
  payloadLineMapping,
} from './line-mapping';

const traverse = ((_traverse as unknown as { default?: typeof _traverse }).default
  ?? _traverse) as typeof _traverse;

const SIZE_RATIO_MAX = 20;
const PARSE_OPTIONS = { sourceType: 'unambiguous', errorRecovery: false } as const;

export interface RestoreOptions {
  extractedPath: string;
  outputRoot: string;
  targets: FileVerdict[];
  budget: Budget;
  signal?: AbortSignal;
}

export async function runRestorePipeline(options: RestoreOptions): Promise<RestoreResult> {
  const startedAt = Date.now();
  const { extractedPath, outputRoot, targets, budget } = options;
  const restored: RestoredFile[] = [];
  const unresolved: UnresolvedFile[] = [];
  let budgetExceeded = false;

  for (const target of targets) {
    if (options.signal?.aborted === true || Date.now() - startedAt > budget.totalRestoreTimeoutMs) {
      budgetExceeded = true;
      unresolved.push({
        path: target.path,
        status: 'FAILED',
        reason: 'BUDGET_EXCEEDED',
        limitations: ['BUDGET_EXCEEDED'],
        stageResults: [],
        durationMs: 0,
      });
      continue;
    }

    const fileStartedAt = Date.now();
    const sourcePath = join(extractedPath, target.path);
    let original: string;
    try {
      original = await fs.readFile(sourcePath, 'utf8');
    } catch {
      unresolved.push({
        path: target.path,
        status: 'FAILED',
        reason: 'SOURCE_READ_FAILED',
        limitations: [],
        stageResults: [],
        detail: 'read failed',
        durationMs: Date.now() - fileStartedAt,
      });
      continue;
    }

    let current = original;
    let lineMapping = identityLineMapping(target.path, original);
    const appliedStages: RestoreStage[] = [];
    const stageResults: RestoreStageResult[] = [];
    const payloads: Array<{ code: string; sourceLine: number | null; originalSourceLine: number | null; transform: 'EVAL_PROMOTE' }> = [];

    if (target.structuralCandidate) {
      const structure = await restoreStructure(current, budget.perFileTimeoutMs);
      stageResults.push({
        stage: 'STRUCTURE',
        applied: structure.status === 'COMPLETED' && structure.code !== undefined,
        status: structure.status,
        changed: structure.status === 'COMPLETED' && structure.code !== undefined,
        ...(structure.diagnostics === undefined ? {} : { metadata: structure.diagnostics }),
        ...(structure.reason === undefined ? {} : { reason: structure.reason }),
      });
      if (structure.status === 'COMPLETED' && structure.code !== undefined) {
        if (structure.lineMapping !== undefined) {
          lineMapping = composeLineMappings(
            { ...structure.lineMapping, sourcePath: target.path, derivedPath: target.path },
            lineMapping,
          );
        }
        current = structure.code;
        appliedStages.push('STRUCTURE');
      }
    } else {
      stageResults.push({
        stage: 'STRUCTURE',
        applied: false,
        status: 'SKIPPED',
        changed: false,
        reason: 'NOT_APPLICABLE',
      });
    }

    try {
      const strings = restoreStrings(current);
      stageResults.push({
        stage: 'STRING',
        applied: strings.changed,
        status: strings.changed ? 'COMPLETED' : 'NO_CHANGE',
        changed: strings.changed,
        metadata: {
          rounds: strings.rounds,
          transformations: strings.transformations,
          payloadCount: strings.payloads.length,
          payloads: strings.payloads.map((payload, index) => ({
            index,
            transform: payload.transform,
            sourceLine: payload.sourceLine,
            decodedLength: Buffer.byteLength(payload.code, 'utf8'),
            sha256: createHash('sha256').update(payload.code, 'utf8').digest('hex'),
          })),
        },
      });
      if (strings.changed) {
        const sourceMappingBeforeStringRestore = lineMapping;
        lineMapping = composeLineMappings(
          { ...strings.lineMapping, sourcePath: target.path, derivedPath: target.path },
          lineMapping,
        );
        current = strings.code;
        appliedStages.push('STRING');
        payloads.push(...strings.payloads.map((payload) => ({
          ...payload,
          originalSourceLine: payload.sourceLine === null
            ? null
            : mapDerivedLineRange(
              sourceMappingBeforeStringRestore,
              target.path,
              payload.sourceLine,
              payload.sourceLine,
            ).derivedFrom.startLine ?? null,
        })));
      }
    } catch (error) {
      stageResults.push({
        stage: 'STRING',
        applied: false,
        status: 'FAILED',
        changed: false,
        reason: 'PARSE_FAILED',
        detail: String((error as Error).message).slice(0, 160),
      });
    }

    try {
      const normalized = normalizeCode(current);
      stageResults.push({
        stage: 'NORMALIZE',
        applied: normalized.changed,
        status: normalized.changed ? 'COMPLETED' : 'NO_CHANGE',
        changed: normalized.changed,
        metadata: { memberAccessNormalized: normalized.memberAccessNormalized },
      });
      if (normalized.changed) {
        lineMapping = composeLineMappings(
          { ...normalized.lineMapping, sourcePath: target.path, derivedPath: target.path },
          lineMapping,
        );
        current = normalized.code;
        appliedStages.push('NORMALIZE');
      }
    } catch (error) {
      stageResults.push({
        stage: 'NORMALIZE',
        applied: false,
        status: 'FAILED',
        changed: false,
        reason: 'PARSE_FAILED',
        detail: String((error as Error).message).slice(0, 160),
      });
    }

    const meaningfulStages = appliedStages.filter((stage) => stage !== 'NORMALIZE');
    const failedStage = stageResults.find((stage) => (
      stage.status === 'FAILED' || stage.status === 'UNAVAILABLE'
    ));
    const validation = validateRestore(original, current, target);
    const limitations = collectLimitations(stageResults, target, validation);
    if (lineMapping.status === 'UNMAPPED') limitations.push('LINE_MAPPING_UNMAPPED');

    if (meaningfulStages.length === 0) {
      unresolved.push({
        path: target.path,
        status: failedStage === undefined ? 'UNRESOLVED' : 'FAILED',
        reason: failedStage === undefined
          ? (validation.restored.signals.includes('DYNAMIC_EVAL')
            ? 'DYNAMIC_DECODE_UNRESOLVED'
            : 'NO_SUPPORTED_TRANSFORM')
          : stageReason(failedStage),
        limitations,
        stageResults,
        validation,
        ...(failedStage?.detail === undefined ? {} : { detail: failedStage.detail }),
        durationMs: Date.now() - fileStartedAt,
      });
      continue;
    }

    if (!validation.restored.parse.valid) {
      unresolved.push({
        path: target.path,
        status: 'FAILED',
        reason: 'PARSE_FAILED',
        limitations,
        stageResults,
        validation,
        ...(validation.restored.parse.reason === undefined
          ? {}
          : { detail: validation.restored.parse.reason }),
        durationMs: Date.now() - fileStartedAt,
      });
      continue;
    }

    if (current.trim().length === 0 || validation.byteRatio > SIZE_RATIO_MAX) {
      unresolved.push({
        path: target.path,
        status: 'FAILED',
        reason: 'VERIFY_FAILED',
        limitations,
        stageResults,
        validation,
        detail: `restored output size ratio ${validation.byteRatio.toFixed(2)} out of range`,
        durationMs: Date.now() - fileStartedAt,
      });
      continue;
    }

    const outputPath = safeJoin(outputRoot, target.path);
    if (outputPath === null) {
      unresolved.push({
        path: target.path,
        status: 'FAILED',
        reason: 'OUTPUT_PATH_INVALID',
        limitations,
        stageResults,
        validation,
        detail: 'output path escapes root',
        durationMs: Date.now() - fileStartedAt,
      });
      continue;
    }

    const restoredPayloads: RestoredPayload[] = [];
    try {
      await fs.mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
      await fs.chmod(dirname(outputPath), 0o700);
      await fs.writeFile(outputPath, current, { encoding: 'utf8', mode: 0o600 });
      await fs.chmod(outputPath, 0o600);
      for (const [index, payload] of payloads.entries()) {
        const payloadPath = `${outputPath}.payload-${index + 1}.js`;
        await fs.writeFile(payloadPath, payload.code, { encoding: 'utf8', mode: 0o600 });
        await fs.chmod(payloadPath, 0o600);
        restoredPayloads.push({
          outputPath: payloadPath,
          sourceLine: payload.sourceLine,
          transform: payload.transform,
          lineMapping: payloadLineMapping(target.path, `${target.path}.payload-${index + 1}.js`, payload.originalSourceLine, payload.code),
        });
      }
    } catch (error) {
      unresolved.push({
        path: target.path,
        status: 'FAILED',
        reason: 'OUTPUT_WRITE_FAILED',
        limitations,
        stageResults,
        validation,
        detail: String((error as Error).message).slice(0, 160),
        durationMs: Date.now() - fileStartedAt,
      });
      continue;
    }

    const unresolvedLimitation = limitations.includes('DYNAMIC_DECODE_UNRESOLVED');
    restored.push({
      path: target.path,
      outputPath,
      status: failedStage === undefined && !unresolvedLimitation ? 'RESTORED' : 'PARTIAL_RESTORED',
      ...(failedStage === undefined && !unresolvedLimitation
        ? {}
        : { reason: failedStage === undefined ? 'DYNAMIC_DECODE_UNRESOLVED' : 'PARTIAL_STAGE_FAILURE' as const }),
      limitations,
      stageResults,
      appliedStages,
      payloads: restoredPayloads,
      originalBytes: validation.original.bytes,
      restoredBytes: validation.restored.bytes,
      verifyAfter: {
        score: validation.restored.score,
        hexIdRatio: validation.restored.hexIdRatio,
      },
      validation,
      lineMapping: {
        ...lineMapping,
        sourcePath: target.path,
        derivedPath: target.path,
      },
      durationMs: Date.now() - fileStartedAt,
    });
  }

  return { outputRoot, restored, unresolved, durationMs: Date.now() - startedAt, budgetExceeded };
}

export function validateRestore(
  original: string,
  restoredCode: string,
  target: FileVerdict,
): ValidationSnapshot {
  const originalDetection = detect(target.path, original, {
    executionPath: target.executionPath,
    riskCapabilityRuleIds: target.riskCapabilityRuleIds,
  });
  const restoredDetection = detect(target.path, restoredCode, {
    executionPath: target.executionPath,
    riskCapabilityRuleIds: target.riskCapabilityRuleIds,
  });
  const originalParse = parseValidation(original);
  const restoredParse = parseValidation(restoredCode);
  const originalBytes = Buffer.byteLength(original, 'utf8');
  const restoredBytes = Buffer.byteLength(restoredCode, 'utf8');
  const originalIdentifiers = astIdentifierMetrics(original, originalParse.valid);
  const restoredIdentifiers = astIdentifierMetrics(restoredCode, restoredParse.valid);
  const originalSignals = originalDetection.signals;
  const restoredSignals = restoredDetection.signals;
  const beforeCapabilities = [...new Set(target.riskCapabilityRuleIds)].sort();

  return {
    original: {
      parse: originalParse,
      bytes: originalBytes,
      identifierCount: originalIdentifiers.identifierCount,
      hexIdentifierCount: originalIdentifiers.hexIdentifierCount,
      hexIdRatio: originalDetection.features.hexIdRatio,
      score: originalDetection.score,
      signals: originalSignals,
    },
    restored: {
      parse: restoredParse,
      bytes: restoredBytes,
      identifierCount: restoredIdentifiers.identifierCount,
      hexIdentifierCount: restoredIdentifiers.hexIdentifierCount,
      hexIdRatio: restoredDetection.features.hexIdRatio,
      score: restoredDetection.score,
      signals: restoredSignals,
    },
    byteDelta: restoredBytes - originalBytes,
    byteRatio: restoredBytes / Math.max(originalBytes, 1),
    identifierDelta: restoredIdentifiers.identifierCount - originalIdentifiers.identifierCount,
    hexIdentifierDelta: restoredIdentifiers.hexIdentifierCount - originalIdentifiers.hexIdentifierCount,
    scoreDelta: restoredDetection.score - originalDetection.score,
    addedSignals: restoredSignals.filter((signal) => !originalSignals.includes(signal)),
    removedSignals: originalSignals.filter((signal) => !restoredSignals.includes(signal)),
    capability: {
      before: beforeCapabilities,
      after: null,
      status: beforeCapabilities.length === 0 ? 'NOT_APPLICABLE' : 'NOT_VERIFIED',
      preserved: [],
      lost: [],
      discovered: [],
      comparisons: [],
      limitations: beforeCapabilities.length === 0 ? [] : ['RISK_CAPABILITY_NOT_REANALYZED'],
    },
  };
}

function parseValidation(source: string): { valid: true } | { valid: false; reason: string } {
  try {
    parse(source, PARSE_OPTIONS);
    return { valid: true };
  } catch (error) {
    return { valid: false, reason: String((error as Error).message).slice(0, 160) };
  }
}

function astIdentifierMetrics(
  source: string,
  parseValid: boolean,
): { identifierCount: number; hexIdentifierCount: number } {
  if (!parseValid) return { identifierCount: 0, hexIdentifierCount: 0 };
  const ast = parse(source, PARSE_OPTIONS);
  let identifierCount = 0;
  let hexIdentifierCount = 0;
  traverse(ast, {
    Identifier(path) {
      identifierCount += 1;
      if (/^_0x[0-9a-f]{4,}$/u.test(path.node.name)) hexIdentifierCount += 1;
    },
  });
  return { identifierCount, hexIdentifierCount };
}

function collectLimitations(
  stageResults: RestoreStageResult[],
  target: FileVerdict,
  validation: ValidationSnapshot,
): RestoreLimitation[] {
  const limitations: RestoreLimitation[] = [];
  const add = (limitation: RestoreLimitation) => {
    if (!limitations.includes(limitation)) limitations.push(limitation);
  };

  if (!validation.original.parse.valid) add('ORIGINAL_PARSE_FAILED');
  for (const stage of stageResults) {
    if (stage.status !== 'FAILED' && stage.status !== 'UNAVAILABLE') continue;
    if (stageReason(stage) === 'TOOL_TIMEOUT') add('TOOL_TIMEOUT');
    if (stage.stage === 'STRUCTURE') add('STRUCTURE_STAGE_FAILED');
    if (stage.stage === 'STRING') add('STRING_STAGE_FAILED');
    if (stage.stage === 'NORMALIZE') add('NORMALIZE_STAGE_FAILED');
  }
  const dynamicWasUnresolved = validation.original.signals.includes('DYNAMIC_EVAL')
    && validation.restored.signals.includes('DYNAMIC_EVAL');
  if (dynamicWasUnresolved) add('DYNAMIC_DECODE_UNRESOLVED');
  const meaningfulStageApplied = stageResults.some((stage) => (
    stage.stage !== 'NORMALIZE' && stage.applied
  ));
  if (!meaningfulStageApplied) add('NO_SUPPORTED_TRANSFORM');
  if (validation.scoreDelta > 0) add('SCORE_INCREASED');
  if (validation.capability.status === 'NOT_VERIFIED') add('RISK_CAPABILITY_NOT_REANALYZED');
  return limitations;
}

function stageReason(stage: RestoreStageResult): RestoreReason {
  if (stage.status === 'UNAVAILABLE') return 'TOOL_UNAVAILABLE';
  if (/timeout/iu.test(stage.reason ?? '')) return 'TOOL_TIMEOUT';
  if (stage.reason === 'PARSE_FAILED') return 'PARSE_FAILED';
  return 'TOOL_FAILED';
}

function safeJoin(root: string, relativePath: string): string | null {
  const full = resolve(root, relativePath);
  const base = resolve(root);
  return full === base || full.startsWith(base + sep) ? full : null;
}
