import { Injectable } from '@nestjs/common';
import type { AgentPackageContext, CodeSlicePolicy } from '../agent.contract';
import {
  AGENT_INPUT_SCHEMA_VERSION_V0_3,
  AGENT_TOOL_CATALOG_V0_3,
  type AgentAnalysisInputV0_3,
  type FindingKind,
  type MissingDataV0_3,
  type PackageContextV0_3,
  type Tier3ExecutionInput,
} from './agent-analysis-input.contract';
import type { ArtifactDescriptor, ValidatedPlanningTarget } from './artifact.contract';
import { ArtifactCodeSliceBuilder, type SliceSupplementBudget } from './artifact-code-slice.builder';
import { InMemoryCodeSliceRegistry, type CodeSliceRegistry } from './code-slice.registry';
import { validateAgentAnalysisInputV0_3 } from './agent-input-v0_3.validator';
import { projectAgentCapabilityReport, projectCapabilityReports } from './capability-report-projection';

export interface AgentInputV0_3Context {
  scanId: string;
  packageName: string;
  packageVersion: string;
  /** SHA-256 of the analyzed tarball bytes. */
  archiveSha256: string;
  /** Injected so identical inputs build identical requests; unknown is null. */
  createdAt?: string | null;
}

export interface AgentInputV0_3Policy {
  codeSlices: CodeSlicePolicy;
  maxToolCalls: number;
  maxAdditionalCodeRequests: number;
  /** Line budget for plan targets appended after the regular ones (context-check expansion). */
  supplement?: SliceSupplementBudget;
}

export interface AgentInputV0_3BuildResult {
  input: AgentAnalysisInputV0_3;
  /** Registry holding the INITIAL slices; runtime slices are added to it later. */
  registry: CodeSliceRegistry;
}

/** Maps a Scanner Finding type to the Agent-facing analyzer classification. */
export function findingKind(type: string): FindingKind {
  if (type.startsWith('THREAT')) return 'THREAT';
  if (type.startsWith('CAPABILITY')) return 'CAPABILITY';
  return 'OTHER';
}

/** Drops the 0.2.0-only `packageMetadata` and `bin` fields; `entryPoints` keeps BIN entries. */
export function toPackageContextV0_3(context: AgentPackageContext): PackageContextV0_3 {
  return {
    source: context.source,
    description: context.packageMetadata.description,
    main: context.main,
    exports: context.exports,
    scripts: { ...context.scripts },
    dependencies: { ...context.dependencies },
    entryPoints: context.entryPoints.map((entry) => ({ ...entry })),
    lifecycleScripts: context.lifecycleScripts.map((script) => ({ ...script })),
  };
}

/** Limitation code recorded when an artifact's line mappings are reduced to the initial-slice ranges. */
const AGENT_INPUT_LINE_MAPPING_TRUNCATED = 'AGENT_INPUT_LINE_MAPPING_TRUNCATED';

interface SliceRange { startLine: number; endLine: number }

/** Groups initial-slice ranges by artifactId then by file path (the mapping's derivedPath). */
function sliceRangesByArtifact(
  slices: readonly { artifactId: string; filePath: string; startLine: number; endLine: number }[],
): Map<string, Map<string, SliceRange[]>> {
  const byArtifact = new Map<string, Map<string, SliceRange[]>>();
  for (const slice of slices) {
    const byFile = byArtifact.get(slice.artifactId) ?? new Map<string, SliceRange[]>();
    const ranges = byFile.get(slice.filePath) ?? [];
    ranges.push({ startLine: slice.startLine, endLine: slice.endLine });
    byFile.set(slice.filePath, ranges);
    byArtifact.set(slice.artifactId, byFile);
  }
  return byArtifact;
}

/**
 * Copies only contract fields, so resolver-internal data cannot reach the Agent.
 * Line mappings are reduced to the entries the initial slices actually cover; the
 * resolver keeps the full mapping for later GET_FILE_RANGE lineage. A MAPPED
 * mapping is never emitted empty (the semantic validator forbids it), so a file
 * with no overlapping slice keeps its mapping intact.
 */
function projectDescriptor(
  item: ArtifactDescriptor,
  ranges: Map<string, SliceRange[]> | undefined,
): { descriptor: ArtifactDescriptor; truncated: boolean } {
  const base: ArtifactDescriptor = {
    artifactId: item.artifactId, representation: item.representation, analysisPass: item.analysisPass,
    contentSha256: item.contentSha256,
    ...(item.derivedFromArtifactId === undefined ? {} : { derivedFromArtifactId: item.derivedFromArtifactId }),
    lineageStatus: item.lineageStatus, producer: item.producer,
    ...(item.producerVersion === undefined ? {} : { producerVersion: item.producerVersion }),
  };
  if (item.lineMappings === undefined) return { descriptor: base, truncated: false };

  let truncated = false;
  const lineMappings = item.lineMappings.map((mapping) => {
    const clone = structuredClone(mapping);
    const fileRanges = ranges?.get(mapping.derivedPath) ?? [];
    if (fileRanges.length === 0) return clone;
    const keptEntries = clone.entries.filter((entry) => fileRanges.some(
      (range) => entry.derivedLine >= range.startLine && entry.derivedLine <= range.endLine,
    ));
    // Keep the mapping intact when nothing overlaps (never emit an empty MAPPED mapping)
    // or when every entry is already needed (nothing to truncate).
    if (keptEntries.length === 0 || keptEntries.length === clone.entries.length) return clone;
    truncated = true;
    return {
      ...clone,
      entries: keptEntries,
      mappedLineCount: keptEntries.length,
      limitations: [...new Set([...clone.limitations, AGENT_INPUT_LINE_MAPPING_TRUNCATED])],
    };
  });
  return { descriptor: { ...base, lineMappings }, truncated };
}

function target(item: ValidatedPlanningTarget): ValidatedPlanningTarget {
  return {
    targetId: item.targetId, artifactId: item.artifactId, filePath: item.filePath,
    ...(item.preferredRange === undefined ? {} : { preferredRange: { startLine: item.preferredRange.startLine, endLine: item.preferredRange.endLine } }),
    priority: item.priority, findingRefs: [...item.findingRefs], evidenceRefs: [...item.evidenceRefs], reasonCodes: [...item.reasonCodes],
  };
}

/**
 * Assembles Tier 3 input 0.3.0 from Tier 2 handoff data and a validated plan.
 * INITIAL slices come only from plan targets via ArtifactCodeSliceBuilder. The
 * The legacy 0.2.0 LlmAgentInputBuilderService remains available in parallel
 * for the non-Tier-2 Agent path.
 */
@Injectable()
export class AgentInputV0_3Builder {
  private readonly slices = new ArtifactCodeSliceBuilder();

  async build(execution: Tier3ExecutionInput, context: AgentInputV0_3Context, policy: AgentInputV0_3Policy, signal?: AbortSignal): Promise<AgentInputV0_3BuildResult> {
    const plan = execution.validatedPlan;
    const registry = new InMemoryCodeSliceRegistry();
    const built = await this.slices.build(plan, execution.artifacts, registry, policy.codeSlices, signal, policy.supplement);
    const missingData: MissingDataV0_3[] = built.issues.map((issue) => ({ field: 'initialCodeSlices', reason: `Target ${issue.targetId}: ${issue.reason}` }));
    if (!plan.shouldExecute) missingData.push({ field: 'initialCodeSlices', reason: 'Planning decided that Tier 3 analysis is not required.' });
    missingData.push({ field: 'symbolAndCallerToolResponses', reason: 'No symbol, reference, caller, or import graph exists.' });
    const projectedEvidence = projectCapabilityReports(execution);
    missingData.push(...projectedEvidence.sharedReports);

    const sliceRanges = sliceRangesByArtifact(built.slices);
    let mappingTruncated = false;
    const artifacts = execution.artifacts.list().map((item) => {
      const projected = projectDescriptor(item, sliceRanges.get(item.artifactId));
      if (projected.truncated) mappingTruncated = true;
      return projected.descriptor;
    });
    const planLimitations = [...new Set([
      ...plan.limitations,
      ...(mappingTruncated ? [AGENT_INPUT_LINE_MAPPING_TRUNCATED] : []),
    ])];

    const input: AgentAnalysisInputV0_3 = {
      request: {
        analysisRequestId: `agent-analysis:${context.scanId}:${AGENT_INPUT_SCHEMA_VERSION_V0_3}`,
        requestType: 'MALICIOUS_CODE_ANALYSIS', schemaVersion: AGENT_INPUT_SCHEMA_VERSION_V0_3,
        scanId: context.scanId, createdAt: context.createdAt ?? null,
      },
      subject: { ecosystem: 'npm', packageName: context.packageName, packageVersion: context.packageVersion, archiveSha256: context.archiveSha256 },
      packageContext: structuredClone(execution.packageContext),
      artifactContext: {
        artifacts,
        findingLocations: execution.bindings.findingBindings.map((binding) => ({ ...binding })),
        evidenceLocations: execution.bindings.evidenceBindings.map((binding) => ({ ...binding })),
      },
      findings: execution.findings.map((finding) => ({ ...finding, location: finding.location === null ? null : { ...finding.location } })),
      atomicEvidences: projectedEvidence.atomicEvidences,
      analysisPlan: {
        shouldExecute: plan.shouldExecute, analysisMode: plan.analysisMode, targets: plan.targets.map(target),
        focusBehaviors: [...plan.focusBehaviors], analysisTargets: [...plan.analysisTargets], limitations: planLimitations,
      },
      analysisPolicy: {
        maxToolCalls: policy.maxToolCalls, maxAdditionalCodeRequests: policy.maxAdditionalCodeRequests,
        maxTotalCodeLines: policy.codeSlices.maxTotalCodeLines,
      },
      initialCodeSlices: built.slices.map((slice) => structuredClone(slice)),
      toolResponseCatalog: AGENT_TOOL_CATALOG_V0_3.map((item) => ({ ...item })),
      missingData,
      ...(execution.capabilityPreservation === undefined ? {} : {
        capabilityPreservation: projectAgentCapabilityReport(execution.capabilityPreservation),
      }),
    };

    const roots = await Promise.all(execution.artifacts.list().map((item) => execution.artifacts.resolveRoot(item.artifactId, signal)));
    const errors = validateAgentAnalysisInputV0_3(input, { forbiddenSubstrings: roots });
    if (errors.length > 0) throw new Error(`Invalid Tier 3 input 0.3.0: ${errors.join('; ')}`);
    return { input, registry };
  }
}
