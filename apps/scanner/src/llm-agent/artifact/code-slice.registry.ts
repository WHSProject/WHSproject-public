import type { AgentCodeSlice } from './artifact.contract';

export interface CodeSliceRegistry {
  register(slice: AgentCodeSlice): void;
  get(sliceId: string): AgentCodeSlice | undefined;
  list(): readonly AgentCodeSlice[];
}

/** Throws when a slice violates the INITIAL/RUNTIME provenance rules or its range. */
export function assertSliceProvenance(slice: AgentCodeSlice): void {
  if (slice.origin === 'INITIAL') {
    if (!slice.planningTargetId) throw new Error(`INITIAL slice ${slice.sliceId} requires planningTargetId`);
    if (slice.additionalCodeRequestId !== null || slice.agentRequestId !== null) {
      throw new Error(`INITIAL slice ${slice.sliceId} must not reference an additional code request`);
    }
  } else {
    if (!slice.additionalCodeRequestId) throw new Error(`RUNTIME slice ${slice.sliceId} requires additionalCodeRequestId`);
    if (slice.planningTargetId !== null) throw new Error(`RUNTIME slice ${slice.sliceId} must not reference a planning target`);
  }
  if (!Number.isSafeInteger(slice.startLine) || !Number.isSafeInteger(slice.endLine) || slice.startLine < 1 || slice.endLine < slice.startLine) {
    throw new Error(`Slice ${slice.sliceId} has an invalid line range`);
  }
}

function frozenCopy(slice: AgentCodeSlice): AgentCodeSlice {
  return Object.freeze({
    ...slice,
    redactionTypes: Object.freeze([...slice.redactionTypes]) as string[],
    relatedFindingIds: Object.freeze([...slice.relatedFindingIds]) as string[],
    relatedEvidenceIds: Object.freeze([...slice.relatedEvidenceIds]) as string[],
  });
}

/**
 * Single collection for INITIAL and RUNTIME slices, kept in registration order.
 * Slices are stored as frozen copies: output validation relies on them, so a
 * registered slice can be neither mutated through `get`/`list` nor through the
 * object originally passed to `register`.
 */
export class InMemoryCodeSliceRegistry implements CodeSliceRegistry {
  private readonly slices = new Map<string, AgentCodeSlice>();

  register(slice: AgentCodeSlice): void {
    if (this.slices.has(slice.sliceId)) throw new Error(`Duplicate slice ID: ${slice.sliceId}`);
    assertSliceProvenance(slice);
    this.slices.set(slice.sliceId, frozenCopy(slice));
  }

  get(sliceId: string): AgentCodeSlice | undefined {
    return this.slices.get(sliceId);
  }

  list(): readonly AgentCodeSlice[] {
    return [...this.slices.values()];
  }
}
