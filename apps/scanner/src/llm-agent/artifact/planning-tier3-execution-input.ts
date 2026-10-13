import { isAbsolute } from 'node:path';

import type { AgentPlanningAnalyzerSnapshot, AgentPlanningInputV0_1 } from '../../application/planning/agent-planning-input.types';
import type { RestoreResult, SourceLineMapping } from '../../analyzers/obfuscation/obfuscation.types';
import { mapDerivedLineRange, mappingForPath } from '../../analyzers/obfuscation/line-mapping';
import { canonicalizeEvidencePath } from '../../analyzers/obfuscation/path-utils';
import type { AnalysisContext, Finding, FindingLocation } from '../../domain/analysis.types';
import type { AtomicEvidenceV0_1 } from '../../evidence/normalizer/evidence-normalizer.types';
import { projectPackageContext } from '../llm-agent-input-builder.service';
import { toPackageContextV0_3 } from './agent-input-v0_3.builder';
import type {
  EvidenceArtifactBinding,
  FileLocation,
  FindingArtifactBinding,
  FocusBehavior,
  PackageContextV0_3,
  Tier3ExecutionInput,
  Tier3FindingProjection,
} from './agent-analysis-input.contract';
import type { ArtifactDescriptor, ValidatedAgentAnalysisPlan, ValidatedPlanningTarget } from './artifact.contract';
import { RuntimeArtifactResolver, originalArtifactDescriptor } from './runtime-artifact-resolver';

const SHA256 = /^[a-f0-9]{64}$/u;
const DERIVED_ANALYZER_SUFFIX = '-deobfuscated';

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

export type RestoredArtifactUnavailableReason =
  | 'RESTORED_ARTIFACT_HASH_FAILED'
  | 'RESTORED_ARTIFACT_PREPARATION_FAILED'
  | 'RESTORED_ARTIFACT_UNAVAILABLE';

export interface PlanningTier3RestoredArtifact {
  readonly descriptor: ArtifactDescriptor;
  readonly root: string;
}

export interface BuildPlanningTier3ExecutionInputOptions {
  readonly planningInput: AgentPlanningInputV0_1;
  readonly context: AnalysisContext;
  /** Optional directory hash. The archive hash remains the existing fallback. */
  readonly originalContentSha256?: string;
  /** Runtime-only restored artifact data. Roots are retained only by the resolver. */
  readonly restoredArtifact?: PlanningTier3RestoredArtifact;
  readonly restoredArtifactUnavailableReason?: RestoredArtifactUnavailableReason;
}

interface IndexedFinding {
  snapshot: AgentPlanningAnalyzerSnapshot;
  finding: Finding;
  source: 'TIER1' | 'TIER2' | 'DERIVED';
}

interface BoundFinding {
  projection: Tier3FindingProjection;
  binding?: FindingArtifactBinding;
}

interface TargetAccumulator {
  artifactId: string;
  filePath: string;
  startLines: number[];
  endLines: number[];
  findingRefs: Set<string>;
  evidenceRefs: Set<string>;
  reasonCodes: Set<string>;
}

/**
 * Projects the complete Planning snapshot into the existing Tier3ExecutionInput.
 * It performs no file I/O, hashing, code execution, or LLM calls. Nested Planning
 * values are cloned where they enter the mutable Tier 3 execution contract.
 */
export function buildPlanningTier3ExecutionInput(
  options: BuildPlanningTier3ExecutionInputOptions,
): Tier3ExecutionInput {
  assertMatchingIdentity(options.planningInput, options.context);
  const originalHash = options.originalContentSha256 ?? options.context.artifact.hash;
  if (!SHA256.test(originalHash) || options.context.artifact.extractedPath.trim() === '') {
    throw new Error('Original artifact preparation failed');
  }

  const original = originalArtifactDescriptor(options.context.artifact.hash, originalHash);
  const limitations = collectInputLimitations(options.planningInput);
  const restored = validRestoredArtifact(options.restoredArtifact, original.artifactId)
    ? options.restoredArtifact
    : undefined;
  if (options.restoredArtifact !== undefined && restored === undefined) {
    limitations.push('RESTORED_ARTIFACT_PREPARATION_FAILED');
  }
  if (options.restoredArtifactUnavailableReason !== undefined) {
    limitations.push(options.restoredArtifactUnavailableReason);
  }
  if (options.planningInput.tier2.restore !== undefined
    && options.planningInput.tier2.restore.restored.length > 0
    && restored === undefined) {
    limitations.push('RESTORED_ARTIFACT_UNAVAILABLE');
  }

  const resolver = new RuntimeArtifactResolver([
    { descriptor: original, root: options.context.artifact.extractedPath },
    ...(restored === undefined ? [] : [{ descriptor: restored.descriptor, root: restored.root }]),
  ]);
  const mappings = restored?.descriptor.lineMappings
    ?? restoreMappings(options.planningInput.tier2.restore);
  const indexed = indexFindings(options.planningInput);
  const duplicateFindingIds = duplicateIds(indexed.map(({ finding }) => finding.findingId));
  // The existing Agent v0.3 contract keys bindings and target refs by findingId
  // alone. Preserve analyzer/findingId verbatim, but fail explicitly rather than
  // silently aliasing two analyzer-scoped Findings in that narrower contract.
  if (duplicateFindingIds.length > 0) {
    throw new Error(`Tier 3 input cannot represent duplicate Finding IDs: ${duplicateFindingIds.join(', ')}`);
  }

  const boundFindings = indexed.map((item) => bindFinding(
    item,
    original.artifactId,
    restored?.descriptor.artifactId,
    mappings,
    limitations,
  ));
  const findingBindings = boundFindings.flatMap(({ binding }) => binding === undefined ? [] : [binding]);
  const evidenceBindings = options.planningInput.normalization.atomicEvidences.flatMap((evidence) => bindEvidence(
    evidence,
    original.artifactId,
    restored?.descriptor.artifactId,
    mappings,
    limitations,
  ));
  const targets = buildTargets(
    boundFindings,
    findingBindings,
    evidenceBindings,
    options.planningInput.normalization.atomicEvidences,
  );
  const packageContext = toPackageContextV0_3(projectPackageContext(options.context.metadata.packageJson));
  const behaviors = focusBehaviors(boundFindings.map(({ projection }) => projection), options.planningInput.normalization.atomicEvidences);
  const plan = buildPlan(targets, behaviors, packageContext, limitations, resolver);

  return {
    validatedPlan: plan,
    artifacts: resolver,
    findings: boundFindings.map(({ projection }) => projection),
    findingAttributes: findingAttributes(indexed.map((item) => item.finding)),
    atomicEvidences: structuredClone(options.planningInput.normalization.atomicEvidences),
    bindings: {
      findingBindings: findingBindings.map((binding) => structuredClone(binding)),
      evidenceBindings: evidenceBindings.map((binding) => structuredClone(binding)),
    },
    packageContext,
    ...(options.planningInput.tier2.restore?.capabilityPreservation === undefined ? {} : {
      capabilityPreservation: structuredClone(options.planningInput.tier2.restore.capabilityPreservation),
    }),
  };
}

function assertMatchingIdentity(input: AgentPlanningInputV0_1, context: AnalysisContext): void {
  const matches = input.schemaVersion === '0.1.0'
    && input.subject.requestId === context.requestId
    && input.subject.scanId === context.scanId
    && input.subject.ecosystem === 'npm'
    && input.subject.packageName === context.package.name
    && input.subject.packageVersion === context.package.version
    && input.subject.artifactHash === context.artifact.hash;
  if (!matches) throw new Error('Planning input subject does not match AnalysisContext');
}

function validRestoredArtifact(
  artifact: PlanningTier3RestoredArtifact | undefined,
  originalArtifactId: string,
): artifact is PlanningTier3RestoredArtifact {
  if (artifact === undefined) return false;
  const { descriptor } = artifact;
  return artifact.root.trim() !== ''
    && descriptor.artifactId.trim() !== ''
    && descriptor.representation === 'DEOBFUSCATED'
    && descriptor.analysisPass === 'TIER2'
    && descriptor.derivedFromArtifactId === originalArtifactId
    && descriptor.artifactId !== originalArtifactId
    && SHA256.test(descriptor.contentSha256)
    && descriptor.lineageStatus !== 'DIRECT'
    && (descriptor.lineageStatus !== 'MAPPED' || (descriptor.lineMappings?.length ?? 0) > 0)
    && (descriptor.lineMappings ?? []).every((mapping) => (
      safePackagePath(mapping.sourcePath) !== undefined
      && safePackagePath(mapping.derivedPath) !== undefined
    ));
}

function indexFindings(input: AgentPlanningInputV0_1): IndexedFinding[] {
  return [
    ...input.tier1.analyzers.flatMap((snapshot) => snapshot.findings.map((finding) => ({ snapshot, finding, source: 'TIER1' as const }))),
    ...input.tier2.analyzer.findings.map((finding) => ({ snapshot: input.tier2.analyzer, finding, source: 'TIER2' as const })),
    ...input.tier2.derivedAnalyzers.flatMap((snapshot) => snapshot.findings.map((finding) => ({ snapshot, finding, source: 'DERIVED' as const }))),
  ];
}

function bindFinding(
  item: IndexedFinding,
  originalArtifactId: string,
  restoredArtifactId: string | undefined,
  mappings: readonly SourceLineMapping[],
  limitations: string[],
): BoundFinding {
  const source = sourceLocation(item.finding);
  const derived = item.source === 'DERIVED'
    || source?.representation === 'DEOBFUSCATED'
    || item.snapshot.analyzer.endsWith(DERIVED_ANALYZER_SUFFIX);
  const path = safePackagePath(source?.path);
  const artifactId = derived ? restoredArtifactId : originalArtifactId;
  const location = path === undefined ? null : projectLocation(path, source, derived, mappings);
  const projection: Tier3FindingProjection = {
    findingId: item.finding.findingId,
    analyzer: item.snapshot.analyzer,
    analyzerVersion: item.snapshot.analyzerVersion,
    ruleId: item.finding.ruleId,
    kind: findingKind(item.finding.type),
    description: item.finding.message,
    location,
    rawMatch: rawMatch(item.finding),
  };
  if (source?.type !== 'SOURCE_FILE') {
    limitations.push(`FINDING_CODE_BINDING_UNAVAILABLE:${item.snapshot.analyzer}:${item.finding.findingId}:NON_SOURCE_LOCATION`);
    return { projection };
  }
  if (path === undefined) {
    limitations.push(`FINDING_CODE_BINDING_UNAVAILABLE:${item.snapshot.analyzer}:${item.finding.findingId}:INVALID_PATH`);
    return { projection };
  }
  if (artifactId === undefined) {
    limitations.push(`FINDING_CODE_BINDING_UNAVAILABLE:${item.snapshot.analyzer}:${item.finding.findingId}:ARTIFACT_UNAVAILABLE`);
    return { projection };
  }
  return {
    projection,
    binding: {
      findingId: item.finding.findingId,
      artifactId,
      filePath: path,
      ...(source.startLine === undefined ? {} : { startLine: source.startLine }),
      ...(source.endLine === undefined ? {} : { endLine: source.endLine }),
      ...(location?.lineageStatus === undefined ? {} : { lineageStatus: location.lineageStatus }),
      ...(location?.derivedFrom === undefined ? {} : { derivedFrom: { ...location.derivedFrom } }),
    },
  };
}

function bindEvidence(
  evidence: AtomicEvidenceV0_1,
  originalArtifactId: string,
  restoredArtifactId: string | undefined,
  mappings: readonly SourceLineMapping[],
  limitations: string[],
): EvidenceArtifactBinding[] {
  const result: EvidenceArtifactBinding[] = [];
  for (const location of evidence.locations) {
    if (location.type !== 'SOURCE_FILE') continue;
    const derived = evidence.analysisPass === 'TIER2' || location.representation === 'DEOBFUSCATED';
    const artifactId = derived ? restoredArtifactId : originalArtifactId;
    const path = safePackagePath(location.path);
    if (path === undefined) {
      limitations.push(`EVIDENCE_CODE_BINDING_UNAVAILABLE:${evidence.evidenceId}:INVALID_PATH`);
      continue;
    }
    if (artifactId === undefined) {
      limitations.push(`EVIDENCE_CODE_BINDING_UNAVAILABLE:${evidence.evidenceId}:ARTIFACT_UNAVAILABLE`);
      continue;
    }
    const projected = projectLocation(path, location, derived, mappings);
    result.push({
      evidenceId: evidence.evidenceId,
      artifactId,
      filePath: path,
      ...(location.startLine === undefined ? {} : { startLine: location.startLine }),
      ...(location.endLine === undefined ? {} : { endLine: location.endLine }),
      ...(projected.lineageStatus === undefined ? {} : { lineageStatus: projected.lineageStatus }),
      ...(projected.derivedFrom === undefined ? {} : { derivedFrom: { ...projected.derivedFrom } }),
    });
  }
  if (result.length === 0 && evidence.locations.some(({ type }) => type === 'SOURCE_FILE')) {
    limitations.push(`EVIDENCE_CODE_BINDING_UNAVAILABLE:${evidence.evidenceId}`);
  }
  return result;
}

function buildTargets(
  findings: readonly BoundFinding[],
  findingBindings: readonly FindingArtifactBinding[],
  evidenceBindings: readonly EvidenceArtifactBinding[],
  evidences: readonly AtomicEvidenceV0_1[],
): ValidatedPlanningTarget[] {
  const targets = new Map<string, TargetAccumulator>();
  const ensure = (artifactId: string, filePath: string): TargetAccumulator => {
    const key = `${artifactId}\0${filePath}`;
    const current = targets.get(key) ?? {
      artifactId, filePath, startLines: [], endLines: [],
      findingRefs: new Set(), evidenceRefs: new Set(), reasonCodes: new Set(),
    };
    targets.set(key, current);
    return current;
  };
  for (const binding of findingBindings) {
    const target = ensure(binding.artifactId, binding.filePath);
    target.findingRefs.add(binding.findingId);
    target.reasonCodes.add('RAW_FINDING_LOCATION');
    addRange(target, binding.startLine, binding.endLine);
  }
  for (const binding of evidenceBindings) {
    const target = ensure(binding.artifactId, binding.filePath);
    target.evidenceRefs.add(binding.evidenceId);
    target.reasonCodes.add('NORMALIZED_EVIDENCE_LOCATION');
    const evidence = evidences.find(({ evidenceId }) => evidenceId === binding.evidenceId);
    for (const source of evidence?.sources ?? []) {
      const finding = findings.find((candidate) => candidate.projection.analyzer === source.analyzer
        && candidate.projection.findingId === source.rawFindingId
        && candidate.binding?.artifactId === binding.artifactId
        && candidate.binding.filePath === binding.filePath);
      if (finding !== undefined) target.findingRefs.add(finding.projection.findingId);
    }
    addRange(target, binding.startLine, binding.endLine);
  }
  return [...targets.values()]
    .sort((left, right) => left.artifactId.localeCompare(right.artifactId) || left.filePath.localeCompare(right.filePath))
    .map((target, index) => ({
      targetId: `planning-tier3-target-${String(index + 1).padStart(3, '0')}`,
      artifactId: target.artifactId,
      filePath: target.filePath,
      ...(target.startLines.length === 0 ? {} : {
        preferredRange: {
          startLine: Math.min(...target.startLines),
          endLine: Math.max(...target.endLines),
        },
      }),
      priority: target.findingRefs.size > 0 ? 'HIGH' : 'MEDIUM',
      findingRefs: [...target.findingRefs].sort(),
      evidenceRefs: [...target.evidenceRefs].sort(),
      reasonCodes: [...target.reasonCodes].sort(),
    }));
}

function addRange(target: TargetAccumulator, startLine?: number, endLine?: number): void {
  if (!Number.isSafeInteger(startLine) || startLine === undefined || startLine < 1) return;
  const effectiveEnd = endLine ?? startLine;
  if (!Number.isSafeInteger(effectiveEnd) || effectiveEnd < startLine) return;
  target.startLines.push(startLine);
  target.endLines.push(effectiveEnd);
}

function buildPlan(
  targets: ValidatedPlanningTarget[],
  behaviors: FocusBehavior[],
  packageContext: PackageContextV0_3,
  limitations: string[],
  resolver: RuntimeArtifactResolver,
): ValidatedAgentAnalysisPlan {
  const available = targets.filter(({ artifactId }) => resolver.describe(artifactId) !== undefined);
  const representations = new Set(available.map(({ artifactId }) => resolver.describe(artifactId)?.representation));
  const analysisMode = representations.has('ORIGINAL') && representations.has('DEOBFUSCATED')
    ? 'ORIGINAL_AND_DEOBFUSCATED' as const
    : representations.has('DEOBFUSCATED') ? 'DEOBFUSCATED_ONLY' as const : 'ORIGINAL_ONLY' as const;
  return {
    planId: `planning-tier3-plan:${resolver.list()[0]?.artifactId ?? 'unavailable'}`,
    shouldExecute: available.length > 0,
    analysisMode,
    targets: available,
    focusBehaviors: available.length === 0 ? [] : behaviors,
    analysisTargets: available.length === 0 ? [] : analysisTargets(behaviors, packageContext),
    limitations: [...new Set(limitations)],
    validation: { status: 'VALIDATED' },
  };
}

function focusBehaviors(
  findings: readonly Tier3FindingProjection[],
  evidences: readonly AtomicEvidenceV0_1[],
): FocusBehavior[] {
  const text = [
    ...findings.flatMap((finding) => [finding.ruleId, finding.description, finding.rawMatch ?? '']),
    ...evidences.flatMap((evidence) => [
      evidence.signal.id, evidence.signal.type, evidence.signal.category, evidence.assertion.summary,
    ]),
  ].join('\n').toLowerCase();
  return BEHAVIOR_RULES.filter(([, pattern]) => pattern.test(text)).map(([behavior]) => behavior);
}

function analysisTargets(behaviors: readonly FocusBehavior[], context: PackageContextV0_3) {
  const has = (behavior: FocusBehavior): boolean => behaviors.includes(behavior);
  return [
    ...((has('ENVIRONMENT_ACCESS') || has('CREDENTIAL_ACCESS')) && has('NETWORK_EGRESS')
      ? ['ENV_OR_SENSITIVE_FILE_TO_NETWORK' as const] : []),
    ...(has('REMOTE_DOWNLOAD') && has('FILE_WRITE') && has('PROCESS_EXECUTION')
      ? ['NETWORK_DOWNLOAD_TO_FILE_WRITE_TO_PROCESS_EXECUTION' as const] : []),
    ...(context.lifecycleScripts.length > 0 && has('PROCESS_EXECUTION')
      ? ['LIFECYCLE_TO_PROCESS_EXECUTION' as const] : []),
  ];
}

function collectInputLimitations(input: AgentPlanningInputV0_1): string[] {
  const limitations: string[] = [];
  const snapshots = [input.tier2.analyzer, ...input.tier2.derivedAnalyzers];
  for (const snapshot of snapshots) {
    if (snapshot.status !== 'SUCCESS') limitations.push(`ANALYZER_${snapshot.status}:${snapshot.analyzer}`);
    for (const error of snapshot.errors) limitations.push(`ANALYZER_ERROR:${snapshot.analyzer}:${error.code}`);
  }
  const restore = input.tier2.restore;
  if (restore?.budgetExceeded === true) limitations.push('RESTORATION_BUDGET_EXCEEDED');
  for (const file of restore?.restored ?? []) {
    const path = limitationPath(file.path);
    if (file.status === 'PARTIAL_RESTORED') limitations.push(`PARTIAL_RESTORATION:${path}`);
    if (!file.validation.original.parse.valid) limitations.push(`RESTORE_VALIDATION_ORIGINAL_PARSE_FAILED:${path}`);
    if (!file.validation.restored.parse.valid) limitations.push(`RESTORE_VALIDATION_RESTORED_PARSE_FAILED:${path}`);
    if (file.validation.capability.status === 'LOST' || file.validation.capability.status === 'NOT_VERIFIED') {
      limitations.push(`RESTORE_CAPABILITY_${file.validation.capability.status}:${path}`);
    }
    limitations.push(...file.limitations.map((code) => `RESTORATION_LIMITATION:${path}:${code}`));
    limitations.push(...(file.validation.capability.limitations ?? []).map((code) => `RESTORE_VALIDATION_LIMITATION:${path}:${code}`));
  }
  for (const file of restore?.unresolved ?? []) {
    const path = limitationPath(file.path);
    limitations.push(`RESTORATION_${file.status}:${path}:${file.reason}`);
    limitations.push(...file.limitations.map((code) => `RESTORATION_LIMITATION:${path}:${code}`));
  }
  for (const error of input.normalization.errors) limitations.push(`NORMALIZATION_ERROR:${error.code}`);
  for (const finding of input.normalization.unmappedFindings) {
    limitations.push(`NORMALIZATION_${finding.mappingStatus}:${finding.analyzerName}:${finding.findingId ?? finding.ruleId ?? 'UNKNOWN'}`);
  }
  return limitations;
}

function sourceLocation(finding: Finding): FindingLocation | undefined {
  if (finding.location !== undefined) return finding.location;
  const locations = (finding.data as Record<string, unknown>).locations;
  if (!Array.isArray(locations)) return undefined;
  return locations.find((location): location is FindingLocation => (
    typeof location === 'object' && location !== null
      && ((location as FindingLocation).type === 'SOURCE_FILE' || (location as FindingLocation).type === 'METADATA')
  ));
}

function safePackagePath(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const path = canonicalizeEvidencePath(value);
  if (isAbsolute(path) || /^[A-Za-z]:/u.test(path) || path.includes('\\')
    || path.split('/').includes('..') || path === '') return undefined;
  return path;
}

function projectLocation(
  path: string,
  location: FindingLocation | undefined,
  derived: boolean,
  mappings: readonly SourceLineMapping[],
): FileLocation {
  if (!derived) {
    return {
      file: path,
      startLine: location?.startLine ?? null,
      endLine: location?.endLine ?? null,
      lineageStatus: 'DIRECT',
    };
  }
  const mapping = mappingForPath(mappings, path);
  const lineage = mapDerivedLineRange(mapping, mapping?.sourcePath ?? path, location?.startLine, location?.endLine);
  return {
    file: path,
    startLine: location?.startLine ?? null,
    endLine: location?.endLine ?? null,
    lineageStatus: lineage.lineageStatus,
    derivedFrom: {
      file: canonicalizeEvidencePath(lineage.derivedFrom.path),
      ...(lineage.derivedFrom.startLine === undefined ? {} : { startLine: lineage.derivedFrom.startLine }),
      ...(lineage.derivedFrom.endLine === undefined ? {} : { endLine: lineage.derivedFrom.endLine }),
    },
  };
}

function restoreMappings(restore: RestoreResult | undefined): SourceLineMapping[] {
  return restore?.restored.flatMap((file) => [
    ...(file.lineMapping === undefined ? [] : [file.lineMapping]),
    ...file.payloads.flatMap(({ lineMapping }) => lineMapping === undefined ? [] : [lineMapping]),
  ]) ?? [];
}

function findingAttributes(findings: readonly Finding[]): Record<string, { sourceType?: string }> {
  const attributes: Record<string, { sourceType?: string }> = {};
  for (const finding of findings) {
    const { sourceType } = finding.data as Record<string, unknown>;
    if (typeof sourceType === 'string' && sourceType !== '') attributes[finding.findingId] = { sourceType };
  }
  return attributes;
}

function rawMatch(finding: Finding): string | null {
  const data = finding.data as Record<string, unknown>;
  return typeof data.match === 'string'
    ? data.match
    : typeof data.rawMatch === 'string' ? data.rawMatch : null;
}

function findingKind(type: string): Tier3FindingProjection['kind'] {
  if (type.startsWith('THREAT')) return 'THREAT';
  if (type.startsWith('CAPABILITY')) return 'CAPABILITY';
  return 'OTHER';
}

function duplicateIds(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) duplicates.add(id);
    seen.add(id);
  }
  return [...duplicates].sort();
}

function limitationPath(path: string): string {
  return safePackagePath(path) ?? '<invalid-path>';
}
