import { Injectable } from '@nestjs/common';
import type { CodeSlicePolicy } from '../agent.contract';
import {
  representationsForMode,
  type AgentCodeSlice,
  type ArtifactResolver,
  type ValidatedAgentAnalysisPlan,
  type ValidatedPlanningTarget,
} from './artifact.contract';
import { ArtifactReadError, readArtifactSource, registerCodeSlice, type ArtifactReadFailure, type ArtifactSource } from './code-slice.factory';
import type { CodeSliceRegistry } from './code-slice.registry';

export type SliceBuildIssueReason =
  | ArtifactReadFailure
  | 'REPRESENTATION_NOT_ALLOWED'
  | 'INVALID_RANGE'
  | 'RANGE_OUTSIDE_FILE'
  | 'SLICE_LIMIT_REACHED'
  | 'LINE_BUDGET_EXHAUSTED'
  | 'RANGE_TRUNCATED';

/** Target-level outcome that did not become (or did not fully become) a slice. */
export interface SliceBuildIssue { targetId: string; reason: SliceBuildIssueReason }

export interface ArtifactSliceBuildResult { slices: AgentCodeSlice[]; issues: SliceBuildIssue[] }

/**
 * Separate budget for the targets from `fromTargetIndex` on. Earlier targets
 * keep the regular INITIAL budget, so appending targets never changes their slices.
 * With `maxSlices` the appended targets are also counted on their own, so how
 * many of them become slices does not depend on how many INITIAL slices exist;
 * without it they share `maxInitialSlices` with the earlier targets.
 */
export interface SliceSupplementBudget { fromTargetIndex: number; maxCodeLines: number; maxSlices?: number }

/** Deterministic INITIAL slice ID; it never encodes a line range. */
export function initialSliceId(targetIndex: number, sequence: number): string {
  return `SLICE-${String(targetIndex + 1).padStart(3, '0')}-${sequence}`;
}

export function planningSelectionReason(target: ValidatedPlanningTarget): string {
  return `Planning target ${target.targetId}${target.reasonCodes.length > 0 ? `: ${target.reasonCodes.join(', ')}` : ''}`;
}

/**
 * Turns validated Planning targets into INITIAL slices. It only executes the
 * targets it is given: it never selects files from Findings, lifecycle scripts,
 * entry points or risky API searches.
 *
 * Overlap merging (PR 1 decision A): overlapping ranges are merged only within
 * one target, never across targets, so every slice keeps exactly one
 * planningTargetId. A target carries a single preferredRange and a long range is
 * split into contiguous, non-overlapping chunks, so there is nothing to merge
 * inside a target. Overlapping targets therefore yield separate slices whose
 * shared lines count against the line budget once per target.
 */
@Injectable()
export class ArtifactCodeSliceBuilder {
  async build(
    plan: ValidatedAgentAnalysisPlan, resolver: ArtifactResolver, registry: CodeSliceRegistry, policy: CodeSlicePolicy, signal?: AbortSignal,
    supplement?: SliceSupplementBudget,
  ): Promise<ArtifactSliceBuildResult> {
    const result: ArtifactSliceBuildResult = { slices: [], issues: [] };
    if (!plan.shouldExecute) return result;
    const allowed = representationsForMode(plan.analysisMode);
    const regular = { lines: Math.min(policy.maxInitialCodeLines, policy.maxTotalCodeLines) };
    const supplemental = { lines: supplement?.maxCodeLines ?? 0 };
    let supplementalSlices = 0;

    for (const [index, target] of plan.targets.entries()) {
      signal?.throwIfAborted();
      const appended = supplement !== undefined && index >= supplement.fromTargetIndex;
      const budget = appended ? supplemental : regular;
      const skip = (reason: SliceBuildIssueReason) => result.issues.push({ targetId: target.targetId, reason });
      // Appended targets with their own slice limit are not held back by the slices already built.
      const ownLimit = appended ? supplement.maxSlices : undefined;
      const slicesLeft = () => (ownLimit === undefined ? result.slices.length < policy.maxInitialSlices : supplementalSlices < ownLimit);
      if (!slicesLeft()) { skip('SLICE_LIMIT_REACHED'); continue; }
      if (budget.lines <= 0) { skip('LINE_BUDGET_EXHAUSTED'); continue; }
      const artifact = resolver.describe(target.artifactId);
      if (!artifact) { skip('ARTIFACT_NOT_FOUND'); continue; }
      if (!allowed.includes(artifact.representation)) { skip('REPRESENTATION_NOT_ALLOWED'); continue; }

      let source: ArtifactSource;
      try {
        source = await readArtifactSource(resolver, target.artifactId, target.filePath, policy.maxFileSizeBytes, signal);
      } catch (error) {
        if (error instanceof ArtifactReadError) { skip(error.reason); continue; }
        throw error;
      }

      const range = this.effectiveRange(target, source.lineCount);
      if (range === 'INVALID_RANGE' || range === 'RANGE_OUTSIDE_FILE') { skip(range); continue; }

      let sequence = 0;
      let start = range.startLine;
      while (start <= range.endLine && budget.lines > 0 && slicesLeft()) {
        const end = Math.min(range.endLine, start + policy.maxLinesPerSlice - 1, start + budget.lines - 1);
        sequence += 1;
        const wholeFile = start === 1 && end === source.lineCount;
        const exactRequest = target.preferredRange !== undefined && start === target.preferredRange.startLine && end === target.preferredRange.endLine;
        result.slices.push(registerCodeSlice(registry, source, { startLine: start, endLine: end }, {
          sliceId: initialSliceId(index, sequence),
          origin: 'INITIAL',
          boundaryConfidence: wholeFile ? 'HIGH' : exactRequest ? 'MEDIUM' : 'LOW',
          planningTargetId: target.targetId,
          additionalCodeRequestId: null,
          agentRequestId: null,
          selectionReason: planningSelectionReason(target),
          relatedFindingIds: target.findingRefs,
          relatedEvidenceIds: target.evidenceRefs,
        }));
        budget.lines -= end - start + 1;
        if (appended) supplementalSlices += 1;
        start = end + 1;
      }
      if (start <= range.endLine) skip('RANGE_TRUNCATED');
    }
    return result;
  }

  /** Clips the requested range to the file; without a request the whole file is the range. */
  private effectiveRange(target: ValidatedPlanningTarget, lineCount: number): { startLine: number; endLine: number } | 'INVALID_RANGE' | 'RANGE_OUTSIDE_FILE' {
    if (lineCount === 0) return 'RANGE_OUTSIDE_FILE';
    const requested = target.preferredRange ?? { startLine: 1, endLine: lineCount };
    if (!Number.isSafeInteger(requested.startLine) || !Number.isSafeInteger(requested.endLine) || requested.startLine < 1 || requested.endLine < requested.startLine) {
      return 'INVALID_RANGE';
    }
    const startLine = requested.startLine;
    const endLine = Math.min(requested.endLine, lineCount);
    return startLine > endLine ? 'RANGE_OUTSIDE_FILE' : { startLine, endLine };
  }
}
