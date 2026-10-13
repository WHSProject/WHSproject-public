/**
 * Artifact-aware contracts for Tier 3 code slicing (issue #340, PR 1).
 *
 * Original and deobfuscated code are identified by `artifactId`, never by file
 * path alone: `install.js` in an ORIGINAL artifact and `install.js` in a
 * DEOBFUSCATED artifact are different code. The legacy single-root
 * `AgentCodeSlice` in `../agent.contract` stays in use until the Tier 3 input
 * 0.3.0 contract (PR 2) switches the input path over.
 */

import type { AgentAnalysisTarget } from '../agent.contract';
import type { FocusBehavior } from './agent-analysis-input.contract';
import type { SourceLineMapping } from '../../analyzers/obfuscation/obfuscation.types';

export type CodeRepresentation = 'ORIGINAL' | 'DEOBFUSCATED';
export type AnalysisPass = 'TIER1' | 'TIER2';
/**
 * Same vocabulary as the shared Evidence location `lineageStatus` (#355):
 * DIRECT = original code itself, MAPPED = derived code whose lines map back to
 * the original, UNMAPPED = derived code without a line mapping.
 */
export type LineageStatus = 'DIRECT' | 'MAPPED' | 'UNMAPPED';

export interface ArtifactDescriptor {
  artifactId: string;
  representation: CodeRepresentation;
  analysisPass: AnalysisPass;
  contentSha256: string;
  /** Original artifact a deobfuscated artifact was restored from. */
  derivedFromArtifactId?: string;
  /** Artifact-level summary of how lines of this artifact map back to the original artifact. */
  lineageStatus: LineageStatus;
  /** Per-file mappings; omitted for DIRECT artifacts. */
  lineMappings?: SourceLineMapping[];
  producer: string;
  producerVersion?: string;
}

/**
 * Tier 3 consumer side of the shared Artifact Resolver contract. The resolved
 * root is a Scanner-internal filesystem location and must never be placed in
 * Planning or Agent input.
 */
export interface ArtifactResolver {
  describe(artifactId: string): ArtifactDescriptor | undefined;
  list(): readonly ArtifactDescriptor[];
  resolveRoot(artifactId: string, signal?: AbortSignal): Promise<string>;
}

export type AgentAnalysisMode = 'ORIGINAL_ONLY' | 'DEOBFUSCATED_ONLY' | 'ORIGINAL_AND_DEOBFUSCATED';
export type PlanningTargetPriority = 'HIGH' | 'MEDIUM' | 'LOW';

export interface ValidatedPlanningTarget {
  targetId: string;
  artifactId: string;
  filePath: string;
  /** Requested range only; the Slice Builder decides the final range. */
  preferredRange?: { startLine: number; endLine: number };
  priority: PlanningTargetPriority;
  findingRefs: string[];
  evidenceRefs: string[];
  reasonCodes: string[];
}

/** Consumer-side type of the plan produced and validated upstream by Planning. */
export interface ValidatedAgentAnalysisPlan {
  planId: string;
  shouldExecute: boolean;
  analysisMode: AgentAnalysisMode;
  targets: ValidatedPlanningTarget[];
  focusBehaviors: FocusBehavior[];
  analysisTargets: AgentAnalysisTarget[];
  limitations: string[];
  validation: { status: 'VALIDATED' };
}

// INITIAL: planningTargetId 필수, additionalCodeRequestId·agentRequestId는 null
// RUNTIME: planningTargetId는 null, additionalCodeRequestId 필수
export interface AgentCodeSlice {
  sliceId: string;

  artifactId: string;
  filePath: string;

  startLine: number;
  endLine: number;

  content: string;
  contentSha256: string;
  sourceSha256: string;

  origin: 'INITIAL' | 'RUNTIME';

  boundaryConfidence: 'HIGH' | 'MEDIUM' | 'LOW';

  planningTargetId: string | null;
  additionalCodeRequestId: string | null;
  agentRequestId: string | null;

  contentRedacted: boolean;      // 현재 항상 false (가림 로직 없음)
  redactionTypes: string[];      // 현재 항상 []
  selectionReason: string;

  relatedFindingIds: string[];
  relatedEvidenceIds: string[];
  lineageStatus?: LineageStatus;
  derivedFrom?: { file: string; startLine?: number; endLine?: number };
}

export function representationsForMode(mode: AgentAnalysisMode): readonly CodeRepresentation[] {
  if (mode === 'ORIGINAL_ONLY') return ['ORIGINAL'];
  if (mode === 'DEOBFUSCATED_ONLY') return ['DEOBFUSCATED'];
  return ['ORIGINAL', 'DEOBFUSCATED'];
}
