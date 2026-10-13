import type {
  AnalysisContext,
  AnalyzerResult,
} from '../../domain/analysis.types';
import type {
  CustomRuleAnalyzerResult,
  CustomRuleRelationCandidate,
} from '../../analyzers/custom-rule/custom-rule.analyzer';
import type {
  GuardDogAnalyzerResult,
  GuardDogRawRisk,
  GuardDogToolAssessment,
} from '../../analyzers/guarddog/guarddog.types';
import type { ObfuscationShadowResult } from '../../analyzers/obfuscation/obfuscation.analyzer';
import type { NormalizationResult } from '../../evidence/normalizer/evidence-normalizer.types';
import type {
  AgentPlanningAnalyzerSnapshot,
  AgentPlanningInputV0_1,
  AgentPlanningTier2Selection,
} from './agent-planning-input.types';

export interface BuildAgentPlanningInputOptions {
  readonly context: AnalysisContext;
  readonly tier1Results: readonly AnalyzerResult[];
  readonly tier2Result: ObfuscationShadowResult;
  readonly normalizationResult: NormalizationResult;
}

type GuardDogExtension = Pick<GuardDogAnalyzerResult, 'guarddog'>;
type CustomRuleExtension = Pick<CustomRuleAnalyzerResult, 'relationCandidates'>;

const GUARD_DOG_ANALYZERS = new Set([
  'guarddog',
  'guarddog-deobfuscated',
]);

const CUSTOM_RULE_ANALYZERS = new Set([
  'custom-rule',
  'custom-rule-deobfuscated',
]);

const RELATION_TYPES = new Set<string>([
  'LIFECYCLE_TO_PROCESS',
  'COLLECTION_TO_NETWORK',
  'DOWNLOAD_TO_WRITE',
  'DOWNLOAD_TO_EXECUTE',
]);

const RELATION_EVIDENCE_KINDS = new Set<string>([
  'STATIC_DATA_FLOW',
  'STATIC_EXECUTION_PATH',
]);

const RELATION_ANALYSIS_LEVELS = new Set<string>([
  'DATA_FLOW',
  'EXECUTION_PATH',
]);

const EXECUTION_CONTEXTS = new Set<string>([
  'PREINSTALL',
  'INSTALL',
  'POSTINSTALL',
  'RUNTIME',
  'UNKNOWN',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isGuardDogRisk(value: unknown): value is GuardDogRawRisk {
  return isRecord(value);
}

function isGuardDogToolAssessment(value: unknown): value is GuardDogToolAssessment {
  if (!isRecord(value)) return false;
  return typeof value.score === 'number'
    && typeof value.label === 'string'
    && ['no_risks_detected', 'low', 'suspicious', 'high_risk'].includes(value.label)
    && typeof value.findingsCount === 'number'
    && isRecord(value.scoreBreakdown)
    && isRecord(value.raw);
}

function hasGuardDogExtension(result: AnalyzerResult): result is AnalyzerResult & GuardDogExtension {
  if (!GUARD_DOG_ANALYZERS.has(result.analyzer) || !('guarddog' in result)) return false;
  const extension = result.guarddog;
  if (!isRecord(extension) || !Array.isArray(extension.risks)) return false;
  if (!extension.risks.every(isGuardDogRisk)) return false;
  return extension.toolAssessment === undefined
    || isGuardDogToolAssessment(extension.toolAssessment);
}

function isRelationLocation(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (value.type === 'SOURCE_FILE' || value.type === 'METADATA')
    && (value.path === undefined || typeof value.path === 'string')
    && (value.startLine === undefined || typeof value.startLine === 'number')
    && (value.startColumn === undefined || typeof value.startColumn === 'number')
    && (value.endLine === undefined || typeof value.endLine === 'number')
    && (value.endColumn === undefined || typeof value.endColumn === 'number')
    && (value.jsonPointer === undefined || typeof value.jsonPointer === 'string');
}

function isCustomRuleRelationCandidate(value: unknown): value is CustomRuleRelationCandidate {
  if (!isRecord(value) || !isRecord(value.provenance) || !isRecord(value.locations)) {
    return false;
  }
  return typeof value.relationId === 'string'
    && typeof value.relationType === 'string'
    && RELATION_TYPES.has(value.relationType)
    && isStringArray(value.sourceFindingIds)
    && isStringArray(value.sinkFindingIds)
    && typeof value.evidenceKind === 'string'
    && RELATION_EVIDENCE_KINDS.has(value.evidenceKind)
    && typeof value.analysisLevel === 'string'
    && RELATION_ANALYSIS_LEVELS.has(value.analysisLevel)
    && typeof value.executionContext === 'string'
    && EXECUTION_CONTEXTS.has(value.executionContext)
    && value.status === 'CANDIDATE'
    && value.provenance.source === 'CUSTOM_STATIC_RULE'
    && value.provenance.analyzer === 'custom-rule'
    && typeof value.provenance.analyzerVersion === 'string'
    && (value.provenance.ruleVersion === undefined
      || typeof value.provenance.ruleVersion === 'string')
    && Array.isArray(value.locations.sources)
    && value.locations.sources.every(isRelationLocation)
    && Array.isArray(value.locations.sinks)
    && value.locations.sinks.every(isRelationLocation)
    && isStringArray(value.limitations);
}

function hasCustomRuleExtension(result: AnalyzerResult): result is AnalyzerResult & CustomRuleExtension {
  if (!CUSTOM_RULE_ANALYZERS.has(result.analyzer) || !('relationCandidates' in result)) {
    return false;
  }
  return Array.isArray(result.relationCandidates)
    && result.relationCandidates.every(isCustomRuleRelationCandidate);
}

export function toAgentPlanningAnalyzerSnapshot(
  result: AnalyzerResult,
): AgentPlanningAnalyzerSnapshot {
  return {
    analyzer: result.analyzer,
    analyzerVersion: result.analyzerVersion,
    status: result.status,
    findings: result.findings,
    errors: result.errors,
    ...(result.execution === undefined ? {} : { execution: result.execution }),
    ...(result.rawResultRef === undefined ? {} : { rawResultRef: result.rawResultRef }),
    ...(hasGuardDogExtension(result) ? {
      guarddog: {
        risks: result.guarddog.risks,
        ...(result.guarddog.toolAssessment === undefined
          ? {}
          : { toolAssessment: result.guarddog.toolAssessment }),
      },
    } : {}),
    ...(hasCustomRuleExtension(result) ? {
      customRule: {
        relationCandidates: result.relationCandidates,
      },
    } : {}),
  };
}

function toTier2Selection(
  result: ObfuscationShadowResult,
): AgentPlanningTier2Selection | undefined {
  const isSafeFallback = result.analyzerResult.status === 'FAILED'
    && result.restore === undefined;
  if (isSafeFallback) return undefined;

  return {
    scannedFiles: result.summary.scannedFiles,
    selectedFiles: result.summary.selectedFiles,
  };
}

/**
 * Creates an internal, read-only projection. Nested Findings, restore data and
 * normalization data intentionally share references with their source objects;
 * this adapter neither deep-clones nor freezes caller-owned values.
 */
export function buildAgentPlanningInput({
  context,
  tier1Results,
  tier2Result,
  normalizationResult,
}: BuildAgentPlanningInputOptions): AgentPlanningInputV0_1 {
  const selection = toTier2Selection(tier2Result);
  return {
    schemaVersion: '0.1.0',
    subject: {
      requestId: context.requestId,
      scanId: context.scanId,
      ecosystem: 'npm',
      packageName: context.package.name,
      packageVersion: context.package.version,
      artifactHash: context.artifact.hash,
    },
    tier1: {
      analyzers: tier1Results.map(toAgentPlanningAnalyzerSnapshot),
    },
    tier2: {
      analyzer: toAgentPlanningAnalyzerSnapshot(tier2Result.analyzerResult),
      derivedAnalyzers: tier2Result.derivedAnalyzerResults.map(toAgentPlanningAnalyzerSnapshot),
      ...(tier2Result.restore === undefined ? {} : { restore: tier2Result.restore }),
      ...(selection === undefined ? {} : { selection }),
    },
    normalization: normalizationResult,
  };
}
