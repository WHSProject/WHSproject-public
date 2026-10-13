import type { AnalysisContext } from '../../domain/analysis.types';
import type {
  Tier2DerivedFileInput,
  Tier2DerivedSignalFact,
  Tier2PlanningCandidate,
  Tier2PlanningInput,
  Tier2PlanningSourceLocation,
  Tier2RestoreFileInput,
} from '../../application/planning/tier2-planning-input.types';
import { EvidenceMappingRegistry } from '../../evidence/normalizer/evidence-mapping.registry';
import type { FileEvidenceBundle } from './agent-analysis.types';
import type { Tier2EvidenceCandidate } from './evidence-candidate-gate';
import { canonicalizeEvidencePath } from './path-utils';
import type { RestoreResult, RestoredFile, UnresolvedFile } from './obfuscation.types';

const EVIDENCE_MAPPINGS = new EvidenceMappingRegistry();

export function buildTier2PlanningInput(
  context: Pick<AnalysisContext, 'requestId' | 'scanId'> & {
    artifact: Pick<AnalysisContext['artifact'], 'hash'>;
  },
  restore: RestoreResult,
  evidenceCandidates: readonly Tier2EvidenceCandidate[],
  evidenceBundles: readonly Pick<FileEvidenceBundle, 'path' | 'newRuleIds'>[],
): Tier2PlanningInput {
  const bundleRuleIds = new Map(
    evidenceBundles.map((bundle) => [
      canonicalizeEvidencePath(bundle.path),
      [...new Set(bundle.newRuleIds)].sort(),
    ]),
  );
  const restoreFiles = [
    ...restore.restored.map(toRestoredInput),
    ...restore.unresolved.map(toUnresolvedInput),
  ].sort(compareRestoreFiles);

  const restoreByPath = new Map<string, Tier2RestoreFileInput>();
  for (const file of restoreFiles) {
    const existing = restoreByPath.get(file.originalLogicalPath);
    if (existing === undefined || isRestoredStatus(file.status)) {
      restoreByPath.set(file.originalLogicalPath, file);
    }
  }
  const candidates = evidenceCandidates
    .map((candidate) => toPlanningCandidate(candidate, restoreByPath, bundleRuleIds))
    .sort((left, right) => compareStrings(left.candidateId, right.candidateId));

  return {
    kind: 'TIER2_RESTORE_PROJECTION',
    requestId: context.requestId,
    scanId: context.scanId,
    artifactHash: context.artifact.hash,
    restoreFiles,
    evidenceCandidates: candidates,
  };
}

function toRestoredInput(file: RestoredFile): Tier2RestoreFileInput {
  const originalLogicalPath = canonicalizeEvidencePath(file.path);
  const derivedFiles: Tier2DerivedFileInput[] = [
    { logicalPath: originalLogicalPath, outputRef: file.outputPath },
    ...file.payloads.map((payload, index) => ({
      logicalPath: `${originalLogicalPath}.payload-${index + 1}.js`,
      outputRef: payload.outputPath,
    })),
  ];
  return {
    originalLogicalPath,
    status: file.status,
    derivedFiles,
    ...(file.reason === undefined ? {} : { reason: file.reason }),
    limitations: [...file.limitations],
    appliedStages: [...file.appliedStages],
    stageResults: [...file.stageResults],
    validation: file.validation,
  };
}

function toUnresolvedInput(file: UnresolvedFile): Tier2RestoreFileInput {
  return {
    originalLogicalPath: canonicalizeEvidencePath(file.path),
    status: file.status,
    derivedFiles: [],
    reason: file.reason,
    limitations: [...file.limitations],
    appliedStages: [],
    stageResults: [...file.stageResults],
    ...(file.validation === undefined ? {} : { validation: file.validation }),
  };
}

function toPlanningCandidate(
  candidate: Tier2EvidenceCandidate,
  restoreByPath: ReadonlyMap<string, Tier2RestoreFileInput>,
  bundleRuleIds: ReadonlyMap<string, string[]>,
): Tier2PlanningCandidate {
  const sourceLocations = candidate.paths.map((derivedLogicalPath, index): Tier2PlanningSourceLocation => ({
    originalLogicalPath: canonicalizeEvidencePath(
      candidate.originalPaths[index] ?? candidate.originalPath,
    ),
    derivedLogicalPath: canonicalizeEvidencePath(derivedLogicalPath),
    derivedOutputRef: candidate.derivedOutputPaths[index] ?? candidate.derivedOutputPath,
  }));
  const originalPaths = [...new Set(sourceLocations.map(({ originalLogicalPath }) => originalLogicalPath))];
  const validations = originalPaths.flatMap((originalLogicalPath) => {
    const validation = restoreByPath.get(originalLogicalPath)?.validation;
    return validation === undefined ? [] : [{ originalLogicalPath, snapshot: validation }];
  });
  const derivedNewRuleIds = [...new Set(
    originalPaths.flatMap((path) => bundleRuleIds.get(path) ?? []),
  )].sort();

  return {
    candidateId: `${candidate.analyzer}:${candidate.rawFindingId}:${candidate.ruleId}`,
    analyzer: candidate.analyzer,
    analyzerVersion: candidate.analyzerVersion,
    ruleId: candidate.ruleId,
    rawFindingId: candidate.rawFindingId,
    finding: candidate.finding,
    sourceLocations,
    restoreStatus: candidate.restoreStatus,
    validations,
    derivedNewRuleIds,
    derivedSignalFacts: deriveSignalFacts(candidate),
  };
}

function deriveSignalFacts(candidate: Tier2EvidenceCandidate): Tier2DerivedSignalFact[] {
  const baseAnalyzer = candidate.analyzer.replace(/-deobfuscated$/u, '');
  const mapping = EVIDENCE_MAPPINGS.find(baseAnalyzer, candidate.ruleId);
  if (mapping === undefined || mapping.mappingStatus === 'AMBIGUOUS' || mapping.mappingStatus === 'INVALID') {
    return [];
  }
  return mapping.targets
    .map((target) => ({
      ruleId: candidate.ruleId,
      signalId: target.signalId,
      signalType: target.signalType,
      mappingStatus: mapping.mappingStatus,
    }))
    .sort((left, right) => (
      left.signalId.localeCompare(right.signalId)
      || left.signalType.localeCompare(right.signalType)
    ));
}

function compareRestoreFiles(left: Tier2RestoreFileInput, right: Tier2RestoreFileInput): number {
  return compareStrings(left.originalLogicalPath, right.originalLogicalPath)
    || compareStrings(left.status, right.status);
}

function isRestoredStatus(status: Tier2RestoreFileInput['status']): boolean {
  return status === 'RESTORED' || status === 'PARTIAL_RESTORED';
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
