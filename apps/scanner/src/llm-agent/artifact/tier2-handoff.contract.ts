import type { LocationLineageStatus } from '../../domain/analysis.types';
import type { AtomicEvidenceV0_1 } from '../../evidence/normalizer/evidence-normalizer.types';
import type { CapabilityPreservationReport } from '../../analyzers/obfuscation/obfuscation.types';
import type { ArtifactDescriptor } from './artifact.contract';
import type {
  EvidenceArtifactBinding,
  FindingArtifactBinding,
  Tier3FindingProjection,
} from './agent-analysis-input.contract';

export type LineageStatus = LocationLineageStatus;

/** Scanner-internal descriptor for the restored Tier 2 artifact. */
export interface Tier2ArtifactDescriptor extends ArtifactDescriptor {
  representation: 'DEOBFUSCATED';
  analysisPass: 'TIER2';
  derivedFromArtifactId: string;
  lineageStatus: LineageStatus;
}

export interface Tier2HandoffLimitation {
  filePath: string;
  code: string;
  explanation?: string;
}

/**
 * Scanner-internal handoff between Tier 2 and the Tier 3 Shadow execution.
 * `artifactRoot` is intentionally not part of the Agent input contract.
 */
export interface Tier2Handoff {
  artifact: Tier2ArtifactDescriptor;
  artifactRoot: string;
  findings: Tier3FindingProjection[];
  atomicEvidences: AtomicEvidenceV0_1[];
  findingBindings: FindingArtifactBinding[];
  evidenceBindings: EvidenceArtifactBinding[];
  limitations: Tier2HandoffLimitation[];
  capabilityPreservation?: CapabilityPreservationReport;
}
