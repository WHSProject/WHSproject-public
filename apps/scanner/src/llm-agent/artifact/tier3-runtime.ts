import type { AgentAnalysisTarget } from '../agent.contract';
import type { LlmAgentEnvironment } from '../../config/scanner-environment';
import type { AnalysisContext } from '../../domain/analysis.types';
import { projectPackageContext } from '../llm-agent-input-builder.service';
import { toPackageContextV0_3, type AgentInputV0_3BuildResult, type AgentInputV0_3Context, type AgentInputV0_3Policy, type AgentInputV0_3Builder } from './agent-input-v0_3.builder';
import type { AgentAnalysisResultV0_3, AgentCodeRequestRecordV0_3, LlmAgentRunnerService } from '../agent-runner.service';
import { agentSummary, type LlmAssessmentEvidence, type LlmEvidenceConversionFailure, type LlmEvidenceAdapter } from '../llm-evidence.adapter';
import type { AgentAnalysisSummary, AgentFailureReason } from '../output.contract';
import { RuntimeArtifactResolver, originalArtifactDescriptor } from './runtime-artifact-resolver';
import {
  ANALYSIS_TARGETS,
  FOCUS_BEHAVIORS,
  type FocusBehavior,
  type PackageContextV0_3,
  type Tier3ExecutionInput,
} from './agent-analysis-input.contract';
import type { ArtifactResolver, ValidatedAgentAnalysisPlan, ValidatedPlanningTarget } from './artifact.contract';
import type { Tier2Handoff } from './tier2-handoff.contract';
import type { StaticFilterResult } from '../../application/planning/static-filter.types';
import type { ContextCheckProvider, ContextCheckRecord } from '../context-check/context-check.contract';
import { runContextCheck } from '../context-check/context-check.service';

const BEHAVIOR_RULES: ReadonlyArray<readonly [FocusBehavior, RegExp]> = [
  ['PROCESS_EXECUTION', /process|child[_-]?process|exec|spawn|shell|command/u],
  ['NETWORK_EGRESS', /network|http|https|dns|socket|request|fetch|connect|outbound/u],
  ['FILE_READ', /file[_-]?read|readfile|read[_-]?stream|fs\.(?:read|open|stat)/u],
  ['FILE_WRITE', /file[_-]?write|writefile|write[_-]?stream|fs\.(?:write|append|mkdir)/u],
  ['ENVIRONMENT_ACCESS', /environment|process\.env|env[_-]?read|serialize[_-]?environment/u],
  ['CREDENTIAL_ACCESS', /credential|sensitive|passwd|password|secret|token|api[_-]?key/u],
  ['SYSTEM_INFO', /system[_-]?(?:info|information)|sysinfo|hostname|platform|arch|userinfo/u],
  ['DYNAMIC_EXECUTION', /dynamic|eval|function\s*constructor|obfuscat|decode|vm\./u],
  ['REMOTE_DOWNLOAD', /download|remote|curl|wget|fetch|http[_-]?download/u],
];

function searchableValues(handoff: Tier2Handoff): string[] {
  return [
    ...handoff.findings.flatMap((finding) => [finding.ruleId, finding.description, finding.rawMatch ?? '']),
    ...handoff.atomicEvidences.flatMap((evidence) => [
      evidence.signal.id, evidence.signal.type, evidence.signal.category, evidence.assertion.summary,
    ]),
    ...(handoff.capabilityPreservation === undefined ? [] : [
      handoff.capabilityPreservation.status,
      ...handoff.capabilityPreservation.files.flatMap((file) => [
        ...file.validation.before,
        ...(file.validation.after ?? []),
        ...file.validation.lost,
        ...(file.validation.discovered ?? []),
        ...(file.validation.limitations ?? []),
      ]),
    ]),
  ].map((value) => value.toLowerCase());
}

function focusBehaviors(handoff: Tier2Handoff): FocusBehavior[] {
  const values = searchableValues(handoff);
  return FOCUS_BEHAVIORS.filter((behavior) => BEHAVIOR_RULES.find(([candidate]) => candidate === behavior)?.[1].test(values.join('\n')) === true);
}

function lineRange(...ranges: Array<{ startLine?: number; endLine?: number }>): ValidatedPlanningTarget['preferredRange'] {
  const lines = ranges.flatMap(({ startLine, endLine }) => {
    if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine) || startLine === undefined || endLine === undefined || startLine < 1 || endLine < startLine) return [];
    return [startLine, endLine];
  });
  if (lines.length === 0) return undefined;
  return { startLine: Math.min(...lines.filter((_, index) => index % 2 === 0)), endLine: Math.max(...lines.filter((_, index) => index % 2 === 1)) };
}

function analysisTargets(behaviors: readonly FocusBehavior[], packageContext: PackageContextV0_3): AgentAnalysisTarget[] {
  const has = (behavior: FocusBehavior) => behaviors.includes(behavior);
  const targets: AgentAnalysisTarget[] = [];
  if ((has('ENVIRONMENT_ACCESS') || has('CREDENTIAL_ACCESS')) && has('NETWORK_EGRESS')) targets.push('ENV_OR_SENSITIVE_FILE_TO_NETWORK');
  if (has('REMOTE_DOWNLOAD') && has('FILE_WRITE') && has('PROCESS_EXECUTION')) targets.push('NETWORK_DOWNLOAD_TO_FILE_WRITE_TO_PROCESS_EXECUTION');
  if (packageContext.lifecycleScripts.length > 0 && has('PROCESS_EXECUTION')) targets.push('LIFECYCLE_TO_PROCESS_EXECUTION');
  return ANALYSIS_TARGETS.filter((target) => targets.includes(target));
}

function buildTargets(handoff: Tier2Handoff): ValidatedPlanningTarget[] {
  const keys = new Set([
    ...handoff.findingBindings.map((binding) => `${binding.artifactId}\u0000${binding.filePath}`),
    ...handoff.evidenceBindings.map((binding) => `${binding.artifactId}\u0000${binding.filePath}`),
  ]);
  return [...keys].sort().map((key, index) => {
    const separator = key.indexOf('\u0000');
    const artifactId = key.slice(0, separator);
    const filePath = key.slice(separator + 1);
    const findingBindings = handoff.findingBindings.filter((binding) => binding.artifactId === artifactId && binding.filePath === filePath);
    const evidenceBindings = handoff.evidenceBindings.filter((binding) => binding.artifactId === artifactId && binding.filePath === filePath);
    const preferredRange = lineRange(...findingBindings, ...evidenceBindings);
    const artifact = handoff.artifact.artifactId === artifactId ? handoff.artifact : undefined;
    return {
      targetId: `tier3-target-${String(index + 1).padStart(3, '0')}`,
      artifactId,
      filePath,
      ...(preferredRange === undefined ? {} : { preferredRange }),
      priority: findingBindings.length > 0 ? 'HIGH' : 'MEDIUM',
      findingRefs: findingBindings.map((binding) => binding.findingId),
      evidenceRefs: evidenceBindings.map((binding) => binding.evidenceId),
      reasonCodes: [
        findingBindings.length > 0 ? 'TIER2_FINDING' : 'TIER2_EVIDENCE',
        ...(artifact?.lineageStatus === 'UNMAPPED' ? ['NO_LINE_MAPPING'] : []),
      ],
    } satisfies ValidatedPlanningTarget;
  });
}

export function buildValidatedTier3Plan(handoff: Tier2Handoff, packageContext: PackageContextV0_3, resolver: ArtifactResolver): ValidatedAgentAnalysisPlan {
  const targets = buildTargets(handoff).filter((target) => resolver.describe(target.artifactId) !== undefined);
  const behaviors = focusBehaviors(handoff);
  const limitations = [...new Set(handoff.limitations.map((item) => item.code))];
  if (handoff.artifact.lineageStatus === 'UNMAPPED') limitations.push('NO_LINE_MAPPING_FOR_DEOBFUSCATED_ARTIFACT');
  limitations.push('TIER3_SHADOW_ONLY');
  const shouldExecute = targets.length > 0;
  return {
    planId: `tier3-plan:${handoff.artifact.artifactId}`,
    shouldExecute,
    analysisMode: 'ORIGINAL_AND_DEOBFUSCATED',
    targets: shouldExecute ? targets : [],
    focusBehaviors: shouldExecute ? behaviors : [],
    analysisTargets: shouldExecute ? analysisTargets(behaviors, packageContext) : [],
    limitations: [...new Set(limitations)],
    validation: { status: 'VALIDATED' },
  };
}

export function buildTier3ExecutionInput(handoff: Tier2Handoff, packageContext: PackageContextV0_3, resolver: ArtifactResolver): Tier3ExecutionInput {
  return {
    validatedPlan: buildValidatedTier3Plan(handoff, packageContext, resolver),
    artifacts: resolver,
    findings: handoff.findings.map((finding) => structuredClone(finding)),
    atomicEvidences: structuredClone(handoff.atomicEvidences),
    bindings: {
      findingBindings: handoff.findingBindings.map((binding) => ({ ...binding })),
      evidenceBindings: handoff.evidenceBindings.map((binding) => ({ ...binding })),
    },
    packageContext: structuredClone(packageContext),
    ...(handoff.capabilityPreservation === undefined ? {} : {
      capabilityPreservation: structuredClone(handoff.capabilityPreservation),
    }),
  };
}

export interface Tier3ShadowResult {
  status: 'COMPLETED' | 'PARTIAL' | 'FAILED' | 'TIMEOUT' | 'SKIPPED';
  triggerReason: string;
  summary?: AgentAnalysisSummary;
  generatedEvidenceCount: number;
  conversionFailures: LlmEvidenceConversionFailure[];
  initialSliceCount: number;
  runtimeSliceCount: number;
  codeRequests: AgentCodeRequestRecordV0_3[];
  limitations: string[];
  failureReason?: string;
  /** Present only when the context check is enabled. */
  contextCheck?: ContextCheckRecord;
}

export interface Tier3ShadowDependencies {
  inputBuilder?: AgentInputV0_3Builder;
  runner?: LlmAgentRunnerService;
  evidenceAdapter?: LlmEvidenceAdapter;
  contextCheckProvider?: ContextCheckProvider;
}

export type Tier3ExecutionFailureStage = 'DEPENDENCY' | 'INPUT_BUILD' | 'RUNNER' | 'EVIDENCE_CONVERSION';

/**
 * Operational projection of one V0.3 run. It is not merged into ScanResult yet.
 * `inputFindingIds` describes the supplied scope, `assessedFindingIds` the
 * Validator-processed Assessments, and `citedFindingIds` only returned Evidence.
 */
export interface Tier3OperationalResult {
  evidences: LlmAssessmentEvidence[];
  summary: AgentAnalysisSummary;
  inputFindingIds: string[];
  assessedFindingIds: string[];
  citedFindingIds: string[];
  conversionFailures: LlmEvidenceConversionFailure[];
  initialSliceCount: number;
  runtimeSliceCount: number;
  codeRequests: AgentCodeRequestRecordV0_3[];
  limitations: string[];
  executionFailure?: { stage: Tier3ExecutionFailureStage; reason: AgentFailureReason };
  /** Present only when the context check is enabled. */
  contextCheck?: ContextCheckRecord;
}

export interface ExecuteTier3V0_3Options {
  execution: Tier3ExecutionInput;
  context: AgentInputV0_3Context;
  settings: LlmAgentEnvironment;
  dependencies: Tier3ShadowDependencies;
  triggerReason: string;
  /** Static filter result of the scan; its diagnostics tell the context check which contexts each Finding group needs. */
  staticFilter?: Pick<StaticFilterResult, 'diagnostics'>;
  signal?: AbortSignal;
}

export function skippedTier3Shadow(
  triggerReason: string,
  limitations: readonly string[] = [],
): Tier3ShadowResult {
  return {
    status: 'SKIPPED', triggerReason, generatedEvidenceCount: 0, conversionFailures: [],
    initialSliceCount: 0, runtimeSliceCount: 0, codeRequests: [], limitations: [...limitations],
  };
}

function policy(settings: LlmAgentEnvironment): AgentInputV0_3Policy {
  return {
    codeSlices: {
      maxInitialSlices: settings.LLM_AGENT_MAX_INITIAL_SLICES,
      maxLinesPerSlice: settings.LLM_AGENT_MAX_LINES_PER_SLICE,
      maxInitialCodeLines: settings.LLM_AGENT_MAX_INITIAL_CODE_LINES,
      maxTotalCodeLines: settings.LLM_AGENT_MAX_TOTAL_CODE_LINES,
      maxFileSizeBytes: settings.LLM_AGENT_MAX_FILE_SIZE_BYTES,
    },
    maxToolCalls: settings.LLM_AGENT_MAX_TOOL_CALLS,
    maxAdditionalCodeRequests: settings.LLM_AGENT_MAX_ADDITIONAL_CODE_REQUESTS,
  };
}

function unique(values: readonly string[]): string[] { return [...new Set(values)]; }

function terminalSummary(
  status: 'FAILED' | 'TIMEOUT' | 'SKIPPED',
  triggerReason: string,
  limitations: readonly string[],
  failureReason?: AgentFailureReason,
): AgentAnalysisSummary {
  return {
    status, assessmentCount: 0, verifiedAssessmentCount: 0, generatedEvidenceCount: 0,
    rejectedAssessmentCount: 0, limitations: unique(limitations), triggerReason,
    ...(failureReason === undefined ? {} : { failureReason }),
  };
}

function terminalOperationalResult(
  execution: Tier3ExecutionInput,
  summary: AgentAnalysisSummary,
  executionFailure?: Tier3OperationalResult['executionFailure'],
): Tier3OperationalResult {
  return {
    evidences: [], summary,
    inputFindingIds: unique(execution.findings.map(({ findingId }) => findingId)),
    assessedFindingIds: [], citedFindingIds: [], conversionFailures: [],
    initialSliceCount: 0, runtimeSliceCount: 0, codeRequests: [],
    limitations: unique([...execution.validatedPlan.limitations, ...summary.limitations]),
    ...(executionFailure === undefined ? {} : { executionFailure }),
  };
}

/**
 * Runs one prepared V0.3 input and returns only Validator-approved Evidence.
 * This function does not mutate/merge Scanner Evidence and does not route Policy.
 */
export async function executeTier3V0_3(options: ExecuteTier3V0_3Options): Promise<Tier3OperationalResult> {
  const { execution, context, settings, dependencies, triggerReason, staticFilter, signal } = options;
  if (!settings.LLM_AGENT_ENABLED || settings.LLM_AGENT_TRIGGER_MODE === 'DISABLED') {
    return terminalOperationalResult(execution, terminalSummary('SKIPPED', triggerReason, ['AGENT_DISABLED']));
  }
  if (!execution.validatedPlan.shouldExecute) {
    return terminalOperationalResult(execution, terminalSummary('SKIPPED', triggerReason, execution.validatedPlan.limitations));
  }
  if (!dependencies.inputBuilder || !dependencies.runner || !dependencies.evidenceAdapter) {
    const reason: AgentFailureReason = 'INTERNAL_ERROR';
    return terminalOperationalResult(
      execution,
      terminalSummary('FAILED', triggerReason, ['TIER3_SERVICES_UNAVAILABLE'], reason),
      { stage: 'DEPENDENCY', reason },
    );
  }

  let built: AgentInputV0_3BuildResult;
  let contextCheck: ContextCheckRecord | undefined;
  try {
    signal?.throwIfAborted();
    const { inputBuilder } = dependencies;
    const inputPolicy = policy(settings);
    // The context check sits between the Slice Builder and the Agent: it may append directly linked code as INITIAL slices.
    const checked = await runContextCheck({
      enabled: settings.LLM_AGENT_CONTEXT_CHECK_ENABLED,
      provider: dependencies.contextCheckProvider,
      execution,
      built: await inputBuilder.build(execution, context, inputPolicy, signal),
      rebuild: (expanded, supplement) => inputBuilder.build(expanded, context, { ...inputPolicy, supplement }, signal),
      policy: inputPolicy.codeSlices,
      recheck: settings.LLM_AGENT_CONTEXT_RECHECK_ENABLED,
      ...(staticFilter === undefined ? {} : { staticFilter }),
      signal,
    });
    built = checked.built;
    if (checked.record.status !== 'DISABLED') contextCheck = checked.record;
  } catch {
    const reason: AgentFailureReason = signal?.aborted === true ? 'TIMEOUT' : 'INPUT_BUILD_FAILED';
    return terminalOperationalResult(
      execution,
      terminalSummary(reason === 'TIMEOUT' ? 'TIMEOUT' : 'FAILED', triggerReason, [reason], reason),
      { stage: 'INPUT_BUILD', reason },
    );
  }

  const inputFindingIds = unique(built.input.findings.map(({ findingId }) => findingId));
  let result: AgentAnalysisResultV0_3;
  try {
    result = await dependencies.runner.executeV0_3(built.input, { resolver: execution.artifacts, registry: built.registry, signal });
  } catch {
    const reason: AgentFailureReason = signal?.aborted === true ? 'TIMEOUT' : 'INTERNAL_ERROR';
    const terminal = terminalOperationalResult(
      execution,
      terminalSummary(reason === 'TIMEOUT' ? 'TIMEOUT' : 'FAILED', triggerReason, [reason], reason),
      { stage: 'RUNNER', reason },
    );
    return { ...terminal, inputFindingIds, initialSliceCount: built.input.initialCodeSlices.length, ...(contextCheck === undefined ? {} : { contextCheck }) };
  }

  let conversionFailures: LlmEvidenceConversionFailure[];
  let evidences: LlmAssessmentEvidence[];
  let executionFailure: Tier3OperationalResult['executionFailure'];
  try {
    const conversion = dependencies.evidenceAdapter.toEvidencesV0_3(built.input, result, execution.artifacts);
    conversionFailures = conversion.failures;
    evidences = conversion.evidences;
  } catch {
    conversionFailures = (result.validated?.assessments ?? [])
      .filter(({ status }) => status === 'VERIFIED')
      .map(({ assessment }) => ({ assessmentId: assessment.id, reason: 'EVIDENCE_CONVERSION_FAILED' as const }));
    evidences = [];
    executionFailure = { stage: 'EVIDENCE_CONVERSION', reason: 'INTERNAL_ERROR' };
  }
  const conversion = { evidences, failures: conversionFailures };
  let summary = agentSummary(result, conversion, triggerReason);
  if (executionFailure !== undefined && summary.status === 'COMPLETED') {
    summary = { ...summary, status: 'PARTIAL', limitations: unique([...summary.limitations, 'LLM Evidence conversion failed']) };
  }
  const assessedFindingIds = unique((result.validated?.assessments ?? []).flatMap(({ assessment }) => assessment.findingIds ?? []));
  const citedFindingIds = unique(evidences.flatMap(({ relatedFindingIds }) => relatedFindingIds));
  const initialSliceCount = built.input.initialCodeSlices.length;
  return {
    evidences, summary, inputFindingIds, assessedFindingIds, citedFindingIds, conversionFailures,
    initialSliceCount, runtimeSliceCount: Math.max(0, result.slices.length - initialSliceCount), codeRequests: [...result.codeRequests],
    limitations: unique([...execution.validatedPlan.limitations, ...result.limitations, ...summary.limitations]),
    ...(executionFailure === undefined
      ? (result.failureReason === undefined ? {} : { executionFailure: { stage: 'RUNNER' as const, reason: result.failureReason } })
      : { executionFailure }),
    ...(contextCheck === undefined ? {} : { contextCheck }),
  };
}

export function toTier3ShadowResult(result: Tier3OperationalResult): Tier3ShadowResult {
  return {
    status: result.summary.status,
    triggerReason: result.summary.triggerReason ?? 'TIER2_HANDOFF',
    summary: result.summary,
    generatedEvidenceCount: result.evidences.length,
    conversionFailures: result.conversionFailures,
    initialSliceCount: result.initialSliceCount,
    runtimeSliceCount: result.runtimeSliceCount,
    codeRequests: [...result.codeRequests],
    limitations: result.limitations,
    ...(result.summary.failureReason === undefined ? {} : { failureReason: result.summary.failureReason }),
    ...(result.contextCheck === undefined ? {} : { contextCheck: result.contextCheck }),
  };
}

function failedTier3(reason: string, limitations: string[] = []): Tier3ShadowResult {
  return {
    status: reason === 'TIMEOUT' ? 'TIMEOUT' : 'FAILED', triggerReason: 'TIER2_HANDOFF', generatedEvidenceCount: 0,
    conversionFailures: [], initialSliceCount: 0, runtimeSliceCount: 0, codeRequests: [],
    limitations: [...limitations, reason], failureReason: reason,
  };
}

/** Runs V0.3 as a Shadow analysis; it never returns evidence to Policy. */
export async function executeTier3Shadow(
  context: AnalysisContext,
  handoff: Tier2Handoff | undefined,
  settings: LlmAgentEnvironment,
  dependencies: Tier3ShadowDependencies,
  originalContentSha256?: string,
  signal?: AbortSignal,
): Promise<Tier3ShadowResult> {
  if (!settings.LLM_AGENT_ENABLED || settings.LLM_AGENT_TRIGGER_MODE === 'DISABLED') return skippedTier3Shadow('AGENT_DISABLED');
  if (handoff === undefined) return skippedTier3Shadow('NO_TIER2_HANDOFF');
  if (!dependencies.inputBuilder || !dependencies.runner || !dependencies.evidenceAdapter) return failedTier3('TIER3_SERVICES_UNAVAILABLE');

  try {
    signal?.throwIfAborted();
    const resolver = new RuntimeArtifactResolver([
      {
        descriptor: originalArtifactDescriptor(context.artifact.hash, originalContentSha256 ?? context.artifact.hash),
        root: context.artifact.extractedPath,
      },
      { descriptor: handoff.artifact, root: handoff.artifactRoot },
    ]);
    const packageContext = projectPackageContext(context.metadata.packageJson);
    const execution = buildTier3ExecutionInput(handoff, toPackageContextV0_3(packageContext), resolver);
    if (!execution.validatedPlan.shouldExecute) return skippedTier3Shadow('NO_TIER2_TARGETS', execution.validatedPlan.limitations);
    return toTier3ShadowResult(await executeTier3V0_3({
      execution,
      context: {
        scanId: context.scanId,
        packageName: context.package.name,
        packageVersion: context.package.version,
        archiveSha256: context.artifact.hash,
      },
      settings,
      dependencies,
      triggerReason: 'TIER2_HANDOFF',
      signal,
    }));
  } catch (error) {
    const timeout = signal?.aborted === true;
    return failedTier3(timeout ? 'TIMEOUT' : 'TIER3_RUNTIME_FAILED');
  }
}
