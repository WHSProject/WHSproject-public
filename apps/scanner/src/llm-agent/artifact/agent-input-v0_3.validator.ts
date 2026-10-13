import { createHash } from 'node:crypto';
import { representationsForMode } from './artifact.contract';
import { ANALYSIS_TARGETS, FOCUS_BEHAVIORS, type AgentAnalysisInputV0_3 } from './agent-analysis-input.contract';

/**
 * Semantic checks for Tier 3 input 0.3.0 that JSON Schema cannot express:
 * reference integrity across sections, plan invariants, slice provenance and
 * leakage of Scanner-internal locations or evaluation data. Structural checks
 * live in `agent-analysis-request-v0.3.schema.json`.
 */

const GROUND_TRUTH_KEYS = new Set([
  'label', 'sourceSampleId', 'groundTruth', 'expectedVerdict', 'expectedBehavior',
  'expectedRelationship', 'expectedScenario', 'verifiedBehaviors', 'verifiedRelations',
]);

const sha256Hex = (value: string): string => createHash('sha256').update(value).digest('hex');

function isUnsafePath(path: string): boolean {
  return path.length === 0 || path.startsWith('/') || /^[A-Za-z]:/u.test(path) || path.includes('\\') || path.split('/').includes('..');
}

function duplicates(values: readonly string[]): string[] {
  const seen = new Set<string>();
  return [...new Set(values.filter((value) => (seen.has(value) ? true : (seen.add(value), false))))];
}

function collectGroundTruthKeys(value: unknown, path: string, errors: string[]): void {
  if (Array.isArray(value)) { value.forEach((item, index) => collectGroundTruthKeys(item, `${path}[${index}]`, errors)); return; }
  if (typeof value !== 'object' || value === null) return;
  for (const [key, child] of Object.entries(value)) {
    if (GROUND_TRUTH_KEYS.has(key)) errors.push(`Ground Truth field is not allowed: ${path}.${key}`);
    collectGroundTruthKeys(child, `${path}.${key}`, errors);
  }
}

export interface AgentInputV0_3ValidationOptions {
  /** Scanner-internal strings (artifact roots, providerRef values) that must not appear anywhere in the input. */
  forbiddenSubstrings?: readonly string[];
}

export function validateAgentAnalysisInputV0_3(input: AgentAnalysisInputV0_3, options: AgentInputV0_3ValidationOptions = {}): string[] {
  const errors: string[] = [];
  const { artifactContext: context, analysisPlan: plan } = input;

  for (const [label, values] of [
    ['artifact', context.artifacts.map((item) => item.artifactId)],
    ['Finding', input.findings.map((item) => item.findingId)],
    ['Atomic Evidence', input.atomicEvidences.map((item) => item.evidenceId)],
    ['planning target', plan.targets.map((item) => item.targetId)],
    ['slice', input.initialCodeSlices.map((item) => item.sliceId)],
    ['tool', input.toolResponseCatalog.map((item) => item.tool)],
  ] as const) {
    for (const id of duplicates(values)) errors.push(`Duplicate ${label} ID: ${id}`);
  }

  const artifacts = new Map(context.artifacts.map((item) => [item.artifactId, item]));
  const findingIds = new Set(input.findings.map((item) => item.findingId));
  const evidenceIds = new Set(input.atomicEvidences.map((item) => item.evidenceId));
  const targets = new Map(plan.targets.map((item) => [item.targetId, item]));

  for (const artifact of context.artifacts) {
    const expectedPass = artifact.representation === 'ORIGINAL' ? 'TIER1' : 'TIER2';
    if (artifact.analysisPass !== expectedPass) errors.push(`Artifact ${artifact.artifactId} ${artifact.representation} must use analysisPass ${expectedPass}`);
    if (artifact.representation === 'ORIGINAL' && artifact.derivedFromArtifactId !== undefined) errors.push(`ORIGINAL artifact ${artifact.artifactId} must not be derived`);
    if (artifact.representation === 'ORIGINAL' && artifact.lineMappings !== undefined) errors.push(`ORIGINAL artifact ${artifact.artifactId} must not carry lineMappings`);
    if ((artifact.representation === 'ORIGINAL') !== (artifact.lineageStatus === 'DIRECT')) errors.push(`Artifact ${artifact.artifactId} ${artifact.representation} must ${artifact.representation === 'ORIGINAL' ? '' : 'not '}use lineageStatus DIRECT`);
    if (artifact.representation === 'DEOBFUSCATED') {
      const source = artifact.derivedFromArtifactId === undefined ? undefined : artifacts.get(artifact.derivedFromArtifactId);
      if (!source || source.representation !== 'ORIGINAL') errors.push(`DEOBFUSCATED artifact ${artifact.artifactId} must derive from an ORIGINAL artifact`);
      if (artifact.lineageStatus === 'MAPPED' && (artifact.lineMappings === undefined || artifact.lineMappings.length === 0)) {
        errors.push(`MAPPED artifact ${artifact.artifactId} must carry lineMappings`);
      }
      for (const mapping of artifact.lineMappings ?? []) validateLineMapping(mapping, `artifact ${artifact.artifactId}`, errors);
    }
  }

  const checkPath = (path: string, where: string) => { if (isUnsafePath(path)) errors.push(`Unsafe path in ${where}: ${path}`); };
  for (const location of context.findingLocations) {
    if (!findingIds.has(location.findingId)) errors.push(`findingLocations references unknown Finding ${location.findingId}`);
    if (!artifacts.has(location.artifactId)) errors.push(`findingLocations references unknown artifact ${location.artifactId}`);
    checkPath(location.filePath, 'findingLocations');
    if (location.derivedFrom !== undefined) checkPath(location.derivedFrom.file, 'findingLocations.derivedFrom');
  }
  for (const location of context.evidenceLocations) {
    if (!evidenceIds.has(location.evidenceId)) errors.push(`evidenceLocations references unknown Atomic Evidence ${location.evidenceId}`);
    if (!artifacts.has(location.artifactId)) errors.push(`evidenceLocations references unknown artifact ${location.artifactId}`);
    checkPath(location.filePath, 'evidenceLocations');
    if (location.derivedFrom !== undefined) checkPath(location.derivedFrom.file, 'evidenceLocations.derivedFrom');
  }
  for (const finding of input.findings) if (finding.location) checkPath(finding.location.file, `Finding ${finding.findingId}`);
  for (const finding of input.findings) if (finding.location?.derivedFrom) checkPath(finding.location.derivedFrom.file, `Finding ${finding.findingId}.derivedFrom`);
  for (const evidence of input.atomicEvidences) {
    for (const location of evidence.locations ?? []) if (location.path !== undefined) checkPath(location.path, `Atomic Evidence ${evidence.evidenceId}`);
  }

  if (!plan.shouldExecute) {
    if (plan.targets.length > 0 || plan.focusBehaviors.length > 0 || plan.analysisTargets.length > 0) {
      errors.push('shouldExecute=false requires empty targets, focusBehaviors and analysisTargets');
    }
    if (input.initialCodeSlices.length > 0) errors.push('shouldExecute=false must not carry initial code slices');
  }
  for (const value of plan.focusBehaviors) if (!(FOCUS_BEHAVIORS as readonly string[]).includes(value)) errors.push(`Unknown focusBehavior: ${value}`);
  for (const value of plan.analysisTargets) if (!(ANALYSIS_TARGETS as readonly string[]).includes(value)) errors.push(`Unknown analysisTarget: ${value}`);
  const allowed = representationsForMode(plan.analysisMode);
  for (const target of plan.targets) {
    const artifact = artifacts.get(target.artifactId);
    if (!artifact) errors.push(`Target ${target.targetId} references unknown artifact ${target.artifactId}`);
    else if (!allowed.includes(artifact.representation)) errors.push(`Target ${target.targetId} representation ${artifact.representation} is outside ${plan.analysisMode}`);
    checkPath(target.filePath, `target ${target.targetId}`);
    for (const id of target.findingRefs) if (!findingIds.has(id)) errors.push(`Target ${target.targetId} references unknown Finding ${id}`);
    for (const id of target.evidenceRefs) if (!evidenceIds.has(id)) errors.push(`Target ${target.targetId} references unknown Atomic Evidence ${id}`);
  }

  for (const slice of input.initialCodeSlices) {
    if (slice.origin !== 'INITIAL') errors.push(`Slice ${slice.sliceId} in initialCodeSlices must be INITIAL`);
    if (!artifacts.has(slice.artifactId)) errors.push(`Slice ${slice.sliceId} references unknown artifact ${slice.artifactId}`);
    checkPath(slice.filePath, `slice ${slice.sliceId}`);
    if (slice.derivedFrom !== undefined) checkPath(slice.derivedFrom.file, `slice ${slice.sliceId}.derivedFrom`);
    const target = slice.planningTargetId === null ? undefined : targets.get(slice.planningTargetId);
    if (!target) errors.push(`Slice ${slice.sliceId} must reference a planning target`);
    else if (target.artifactId !== slice.artifactId || target.filePath !== slice.filePath) errors.push(`Slice ${slice.sliceId} does not match target ${target.targetId} artifact and file`);
    if (slice.additionalCodeRequestId !== null || slice.agentRequestId !== null) errors.push(`Slice ${slice.sliceId} must not reference an additional code request`);
    if (slice.startLine < 1 || slice.endLine < slice.startLine) errors.push(`Slice ${slice.sliceId} has an invalid line range`);
    if (sha256Hex(slice.content) !== slice.contentSha256) errors.push(`Slice ${slice.sliceId} contentSha256 does not match content`);
    for (const id of slice.relatedFindingIds) if (!findingIds.has(id)) errors.push(`Slice ${slice.sliceId} references unknown Finding ${id}`);
    for (const id of slice.relatedEvidenceIds) if (!evidenceIds.has(id)) errors.push(`Slice ${slice.sliceId} references unknown Atomic Evidence ${id}`);
  }

  collectGroundTruthKeys(input, '$', errors);
  const serialized = JSON.stringify(input);
  for (const value of options.forbiddenSubstrings ?? []) {
    // Compare with the JSON-escaped form too, so Windows backslash paths cannot slip through.
    if (value && (serialized.includes(value) || serialized.includes(JSON.stringify(value).slice(1, -1)))) {
      errors.push('Scanner-internal location leaked into Agent input');
    }
  }
  return errors;
}

function validateLineMapping(
  mapping: NonNullable<AgentAnalysisInputV0_3['artifactContext']['artifacts'][number]['lineMappings']>[number],
  where: string,
  errors: string[],
): void {
  if (isUnsafePath(mapping.sourcePath)) errors.push(`Unsafe path in ${where}.lineMappings.sourcePath: ${mapping.sourcePath}`);
  if (isUnsafePath(mapping.derivedPath)) errors.push(`Unsafe path in ${where}.lineMappings.derivedPath: ${mapping.derivedPath}`);
  if (mapping.mappedLineCount !== mapping.entries.length) errors.push(`${where} line mapping mappedLineCount does not match entries`);
  if (mapping.status === 'MAPPED' && mapping.entries.length === 0) errors.push(`${where} MAPPED line mapping must have entries`);
  const derivedLines = new Set<number>();
  for (const entry of mapping.entries) {
    if (entry.derivedLine < 1 || entry.derivedLine > mapping.derivedLineCount) errors.push(`${where} line mapping has invalid derivedLine ${entry.derivedLine}`);
    if (entry.sourceLine < 1) errors.push(`${where} line mapping has invalid sourceLine ${entry.sourceLine}`);
    if (derivedLines.has(entry.derivedLine)) errors.push(`${where} line mapping has duplicate derivedLine ${entry.derivedLine}`);
    derivedLines.add(entry.derivedLine);
  }
}
