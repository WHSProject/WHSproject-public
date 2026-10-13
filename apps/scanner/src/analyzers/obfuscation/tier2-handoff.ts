import type {
  AnalysisContext,
  AnalyzerResult,
  Finding,
  FindingLocation,
} from '../../domain/analysis.types';
import type {
  AtomicEvidenceV0_1,
} from '../../evidence/normalizer/evidence-normalizer.types';
import type {
  EvidenceArtifactBinding,
  FindingArtifactBinding,
  Tier3FindingProjection,
} from '../../llm-agent/artifact/agent-analysis-input.contract';
import type {
  Tier2Handoff,
  Tier2ArtifactDescriptor,
  Tier2HandoffLimitation,
} from '../../llm-agent/artifact/tier2-handoff.contract';
import type { RestoreResult } from './obfuscation.types';
import { mapDerivedLineRange, mappingForPath } from './line-mapping';
import { OBFUSCATION_ANALYZER_VERSION } from './obfuscation.analyzer';
import { canonicalizeEvidencePath } from './path-utils';

export interface Tier2HandoffInput {
  context: AnalysisContext;
  restore: RestoreResult;
  derivedAnalyzerResults: readonly AnalyzerResult[];
  atomicEvidences: readonly AtomicEvidenceV0_1[];
  contentSha256: string;
}

/** Shared restored-artifact projection; callers may prepare Tier 3 without a full Handoff. */
export function buildTier2ArtifactDescriptor(
  context: AnalysisContext,
  restore: RestoreResult,
  contentSha256: string,
): Tier2ArtifactDescriptor {
  const originalArtifactId = `artifact:${context.artifact.hash}`;
  return {
    artifactId: `${originalArtifactId}:deobfuscated:${contentSha256}`,
    representation: 'DEOBFUSCATED',
    analysisPass: 'TIER2',
    contentSha256,
    derivedFromArtifactId: originalArtifactId,
    lineageStatus: artifactLineageStatus(restore),
    lineMappings: restore.restored
      .map(({ lineMapping }) => lineMapping)
      .filter((lineMapping): lineMapping is NonNullable<typeof lineMapping> => lineMapping !== undefined)
      .map((lineMapping) => structuredClone(lineMapping)),
    producer: 'scanner-obfuscation-restore',
    producerVersion: OBFUSCATION_ANALYZER_VERSION,
  };
}

export function buildTier2Handoff(input: Tier2HandoffInput): Tier2Handoff {
  const artifact = buildTier2ArtifactDescriptor(input.context, input.restore, input.contentSha256);
  const artifactId = artifact.artifactId;
  const findings = input.derivedAnalyzerResults.flatMap((result) => result.findings.map((finding) => (
    projectFinding(result, finding, input.restore)
  )));
  const atomicEvidences = input.atomicEvidences
    .filter((evidence) => evidence.analysisPass === 'TIER2')
    .map((evidence) => structuredClone(evidence));

  return {
    artifact,
    artifactRoot: input.restore.outputRoot,
    findings,
    atomicEvidences,
    findingBindings: findings.flatMap((finding) => {
      const location = finding.location;
      return location === null ? [] : [{
        findingId: finding.findingId,
        artifactId,
        filePath: location.file,
        ...(location.startLine === null ? {} : { startLine: location.startLine }),
        ...(location.endLine === null ? {} : { endLine: location.endLine }),
        ...(location.lineageStatus === undefined ? {} : { lineageStatus: location.lineageStatus }),
        ...(location.derivedFrom === undefined ? {} : { derivedFrom: {
          file: location.derivedFrom.file,
          ...(location.derivedFrom.startLine === undefined ? {} : { startLine: location.derivedFrom.startLine }),
          ...(location.derivedFrom.endLine === undefined ? {} : { endLine: location.derivedFrom.endLine }),
        } }),
      } satisfies FindingArtifactBinding];
    }),
    evidenceBindings: atomicEvidences.flatMap((evidence) => {
      const location = evidence.locations.find((candidate) => (
        candidate.type === 'SOURCE_FILE' && candidate.path !== undefined
      ));
      if (location?.path === undefined) return [];
      return [{
        evidenceId: evidence.evidenceId,
        artifactId,
        filePath: canonicalizeEvidencePath(location.path),
        ...(location.startLine === undefined ? {} : { startLine: location.startLine }),
        ...(location.endLine === undefined ? {} : { endLine: location.endLine }),
        ...(location.lineageStatus === undefined ? {} : { lineageStatus: location.lineageStatus }),
        ...(location.derivedFrom === undefined ? {} : { derivedFrom: {
          file: location.derivedFrom.path,
          ...(location.derivedFrom.startLine === undefined ? {} : { startLine: location.derivedFrom.startLine }),
          ...(location.derivedFrom.endLine === undefined ? {} : { endLine: location.derivedFrom.endLine }),
        } }),
      } satisfies EvidenceArtifactBinding];
    }),
    limitations: toLimitations(input.restore),
    ...(input.restore.capabilityPreservation === undefined ? {} : {
      capabilityPreservation: structuredClone(input.restore.capabilityPreservation),
    }),
  };
}

function projectFinding(result: AnalyzerResult, finding: Finding, restore: RestoreResult): Tier3FindingProjection {
  const location = sourceLocation(finding);
  const data = finding.data as Record<string, unknown>;
  const rawMatch = typeof data.match === 'string'
    ? data.match
    : typeof data.rawMatch === 'string' ? data.rawMatch : null;

  return {
    findingId: finding.findingId,
    analyzer: result.analyzer,
    analyzerVersion: result.analyzerVersion ?? null,
    ruleId: finding.ruleId,
    kind: findingKind(finding.type),
    description: finding.message,
    location: location?.path === undefined ? null : toFileLocation(location, restore),
    rawMatch,
  };
}

function toFileLocation(
  location: FindingLocation,
  restore: RestoreResult,
): Tier3FindingProjection['location'] {
  const path = canonicalizeEvidencePath(location.path!);
  const mapping = mappingForPath(
    restore.restored
      .map(({ lineMapping }) => lineMapping)
      .filter((lineMapping): lineMapping is NonNullable<typeof lineMapping> => lineMapping !== undefined),
    path,
  );
  const lineage = mapDerivedLineRange(mapping, mapping?.sourcePath ?? path, location.startLine, location.endLine);
  return {
    file: path,
    startLine: location.startLine ?? null,
    endLine: location.endLine ?? null,
    lineageStatus: lineage.lineageStatus,
    derivedFrom: {
      file: lineage.derivedFrom.path,
      ...(lineage.derivedFrom.startLine === undefined ? {} : { startLine: lineage.derivedFrom.startLine }),
      ...(lineage.derivedFrom.endLine === undefined ? {} : { endLine: lineage.derivedFrom.endLine }),
    },
  };
}

function artifactLineageStatus(restore: RestoreResult): 'MAPPED' | 'UNMAPPED' {
  return restore.restored.length > 0
    && restore.restored.every(({ lineMapping }) => lineMapping?.status === 'MAPPED')
    ? 'MAPPED'
    : 'UNMAPPED';
}

function findingKind(type: string): Tier3FindingProjection['kind'] {
  if (type.startsWith('THREAT')) return 'THREAT';
  if (type.startsWith('CAPABILITY')) return 'CAPABILITY';
  return 'OTHER';
}

function sourceLocation(finding: Finding): FindingLocation | undefined {
  if (finding.location?.type === 'SOURCE_FILE' && finding.location.path !== undefined) {
    return finding.location;
  }
  const locations = (finding.data as Record<string, unknown>).locations;
  if (!Array.isArray(locations)) return undefined;
  return locations.find((location): location is FindingLocation => (
    typeof location === 'object'
    && location !== null
    && (location as FindingLocation).type === 'SOURCE_FILE'
    && typeof (location as FindingLocation).path === 'string'
  ));
}

function toLimitations(restore: RestoreResult): Tier2HandoffLimitation[] {
  const limitations: Tier2HandoffLimitation[] = [];
  for (const file of restore.restored) {
    for (const code of file.limitations) {
      limitations.push({ filePath: canonicalizeEvidencePath(file.path), code });
    }
    if (file.lineMapping?.status === 'UNMAPPED') {
      limitations.push({ filePath: canonicalizeEvidencePath(file.path), code: 'LINE_MAPPING_UNMAPPED' });
    }
    for (const code of file.lineMapping?.limitations ?? []) {
      limitations.push({ filePath: canonicalizeEvidencePath(file.path), code });
    }
  }
  for (const file of restore.unresolved) {
    const codes = file.limitations.length === 0 ? [file.reason] : file.limitations;
    for (const code of codes) {
      limitations.push({
        filePath: canonicalizeEvidencePath(file.path),
        code,
        ...(file.detail === undefined ? {} : { explanation: file.detail }),
      });
    }
  }
  return limitations;
}
