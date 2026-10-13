import type {
  AnalyzerResult,
  Finding,
  FindingLocation,
} from '../../domain/analysis.types';
import { EvidenceMappingRegistry } from '../../evidence/normalizer/evidence-mapping.registry';
import { canonicalizeEvidencePath } from './path-utils';
import { mapDerivedLineRange, mappingForPath } from './line-mapping';
import type {
  CapabilityComparison,
  CapabilityObservation,
  CapabilityPreservationFile,
  CapabilityPreservationReport,
  CapabilityPreservationStatus,
  CapabilityValidation,
  RestoreLimitation,
  RestoreResult,
  RestoreStatus,
  UnresolvedFile,
  SourceLineMapping,
} from './obfuscation.types';

const MISSING_CAPABILITY_LIMITATION: RestoreLimitation = 'CAPABILITY_COMPARISON_INCOMPLETE';
const DERIVED_ANALYSIS_LIMITATION: RestoreLimitation = 'DERIVED_ANALYSIS_UNAVAILABLE';
const PARTIAL_RESTORE_LIMITATION: RestoreLimitation = 'PARTIAL_RESTORE_PREVENTS_COMPLETE_VERIFICATION';

const registry = new EvidenceMappingRegistry();

/**
 * Compares semantic capability signals, not analyzer-specific Rule IDs.
 * A result is only marked LOST when the restored artifact and every required
 * derived analyzer completed successfully. Partial restoration or analyzer
 * failure keeps missing capabilities NOT_VERIFIED.
 */
export function attachCapabilityPreservation(
  restore: RestoreResult,
  originalResults: readonly AnalyzerResult[],
  derivedResults: readonly AnalyzerResult[],
): RestoreResult {
  const comparisonRequired = restore.restored.length > 0 || restore.unresolved.length > 0;
  if (!comparisonRequired) {
    return {
      ...restore,
      capabilityPreservation: { status: 'NOT_APPLICABLE', files: [], limitations: [] },
    };
  }
  const derivedAnalysisComplete = derivedResults.length > 0
    && derivedResults.every(({ status }) => status === 'SUCCESS');
  const restoreComplete = restore.restored.every(({ status }) => status === 'RESTORED')
    && restore.unresolved.length === 0
    && !restore.budgetExceeded;

  const files: CapabilityPreservationFile[] = [
    ...restore.restored.map((file) => buildFileComparison(
      file.path,
      file.status,
      [file.path, ...file.payloads.map((payload, index) => `${file.path}.payload-${index + 1}.js`)],
      originalResults,
      derivedResults,
      derivedAnalysisComplete,
      file.lineMapping === undefined ? [] : [file.lineMapping, ...file.payloads.flatMap(({ lineMapping }) => lineMapping === undefined ? [] : [lineMapping])],
    )),
    ...restore.unresolved.map((file) => buildUnresolvedComparison(
      file,
      originalResults,
      derivedResults,
    )),
  ].sort((left, right) => left.originalPath.localeCompare(right.originalPath));

  const reportLimitations = unique([
    ...files.flatMap(({ validation }) => validation.limitations ?? []),
    ...(restoreComplete && derivedAnalysisComplete ? [] : [MISSING_CAPABILITY_LIMITATION]),
    ...(derivedAnalysisComplete ? [] : [DERIVED_ANALYSIS_LIMITATION]),
  ]);
  const reportStatus = aggregateStatus(files, reportLimitations, restoreComplete && derivedAnalysisComplete);

  return {
    ...restore,
    restored: restore.restored.map((file) => {
      const comparison = files.find(({ originalPath }) => samePath(originalPath, file.path));
      return comparison === undefined ? file : {
        ...file,
        validation: {
          ...file.validation,
          capability: comparison.validation,
        },
        limitations: unique([
          ...file.limitations.filter((code) => (
            code !== 'RISK_CAPABILITY_NOT_REANALYZED'
            || comparison.validation.status === 'NOT_VERIFIED'
          )),
          ...(comparison.validation.limitations ?? []),
        ]),
      };
    }),
    unresolved: restore.unresolved.map((file) => {
      const comparison = files.find(({ originalPath }) => samePath(originalPath, file.path));
      return comparison === undefined ? file : {
        ...file,
        ...(file.validation === undefined ? {} : {
          validation: { ...file.validation, capability: comparison.validation },
        }),
        limitations: unique([...file.limitations, ...(comparison.validation.limitations ?? [])]),
      };
    }),
    capabilityPreservation: {
      status: reportStatus,
      files,
      limitations: reportLimitations,
    },
  };
}

function buildFileComparison(
  originalPath: string,
  restoreStatus: Extract<RestoreStatus, 'RESTORED' | 'PARTIAL_RESTORED'>,
  deobfuscatedPaths: string[],
  originalResults: readonly AnalyzerResult[],
  derivedResults: readonly AnalyzerResult[],
  derivedAnalysisComplete: boolean,
  lineMappings: readonly SourceLineMapping[],
): CapabilityPreservationFile {
  const original = observationsForPaths(originalResults, [originalPath], 'ORIGINAL', originalPath);
  const deobfuscated = observationsForPaths(derivedResults, deobfuscatedPaths, 'DEOBFUSCATED', originalPath, lineMappings);
  const validation = compare(
    originalPath,
    deobfuscatedPaths,
    restoreStatus,
    original,
    deobfuscated,
    derivedAnalysisComplete,
  );
  return { originalPath: canonicalizeEvidencePath(originalPath), deobfuscatedPaths: deobfuscatedPaths.map(canonicalizeEvidencePath), restoreStatus, validation };
}

function buildUnresolvedComparison(
  file: UnresolvedFile,
  originalResults: readonly AnalyzerResult[],
  derivedResults: readonly AnalyzerResult[],
): CapabilityPreservationFile {
  const originalPath = canonicalizeEvidencePath(file.path);
  const original = observationsForPaths(originalResults, [originalPath], 'ORIGINAL', originalPath);
  const deobfuscated = observationsForPaths(derivedResults, [], 'DEOBFUSCATED', originalPath, []);
  const validation = compare(originalPath, [], file.status, original, deobfuscated, false);
  return { originalPath, deobfuscatedPaths: [], restoreStatus: file.status, validation };
}

function compare(
  originalPath: string,
  deobfuscatedPaths: string[],
  restoreStatus: RestoreStatus,
  original: Map<string, CapabilityObservation[]>,
  deobfuscated: Map<string, CapabilityObservation[]>,
  derivedAnalysisComplete: boolean,
): CapabilityValidation {
  const before = [...original.keys()].sort();
  const after = derivedAnalysisComplete ? [...deobfuscated.keys()].sort() : null;
  const capabilityIds = [...new Set([...before, ...deobfuscated.keys()])].sort();
  const incomplete = !derivedAnalysisComplete || restoreStatus !== 'RESTORED';
  const comparisons = capabilityIds.map((capability): CapabilityComparison => {
    const originalObservations = original.get(capability) ?? [];
    const derivedObservations = deobfuscated.get(capability) ?? [];
    const status = originalObservations.length > 0 && derivedObservations.length > 0
      ? 'PRESERVED'
      : derivedObservations.length > 0
        ? 'DISCOVERED'
        : incomplete
          ? 'NOT_VERIFIED'
          : 'LOST';
    return {
      capability,
      status,
      original: originalObservations,
      deobfuscated: derivedObservations,
    };
  });
  const preserved = comparisons.filter(({ status }) => status === 'PRESERVED').map(({ capability }) => capability);
  const lost = comparisons.filter(({ status }) => status === 'LOST').map(({ capability }) => capability);
  const discovered = comparisons.filter(({ status }) => status === 'DISCOVERED').map(({ capability }) => capability);
  const limitations = unique([
    ...(incomplete ? [MISSING_CAPABILITY_LIMITATION] : []),
    ...(!derivedAnalysisComplete ? [DERIVED_ANALYSIS_LIMITATION] : []),
    ...(restoreStatus === 'PARTIAL_RESTORED' ? [PARTIAL_RESTORE_LIMITATION] : []),
  ]);
  const status = aggregateValidationStatus(before, after, comparisons, incomplete);
  return {
    before,
    after,
    status,
    preserved,
    lost,
    discovered,
    comparisons,
    limitations,
    originalPath: canonicalizeEvidencePath(originalPath),
    deobfuscatedPaths: deobfuscatedPaths.map(canonicalizeEvidencePath),
    restoreStatus,
  };
}

function observationsForPaths(
  results: readonly AnalyzerResult[],
  paths: readonly string[],
  representation: CapabilityObservation['representation'],
  originalPath: string,
  lineMappings: readonly SourceLineMapping[] = [],
): Map<string, CapabilityObservation[]> {
  const allowed = new Set(paths.map(canonicalizeEvidencePath));
  const byCapability = new Map<string, CapabilityObservation[]>();
  for (const result of results) {
    const baseAnalyzer = result.analyzer.replace(/-deobfuscated$/u, '');
    if (baseAnalyzer !== 'custom-rule' && baseAnalyzer !== 'guarddog') continue;
    for (const finding of result.findings) {
      const capabilityIds = registry.find(baseAnalyzer, finding.ruleId)?.targets
        .map(({ signalId }) => signalId)
        .filter((signalId) => signalId.startsWith('capability.') && !signalId.startsWith('capability.lifecycle.')) ?? [];
      if (capabilityIds.length === 0) continue;
      for (const location of sourceLocations(finding)) {
        const path = location.path === undefined ? undefined : canonicalizeEvidencePath(location.path);
        if (path === undefined || (allowed.size > 0 && !allowed.has(path))) continue;
        const mapping = representation === 'DEOBFUSCATED'
          ? mappingForPath(lineMappings, path)
          : undefined;
        const lineage = representation === 'DEOBFUSCATED'
          ? mapDerivedLineRange(mapping, canonicalizeEvidencePath(originalPath), location.startLine, location.endLine)
          : { lineageStatus: 'DIRECT' as const, derivedFrom: undefined };
        const observation: CapabilityObservation = {
          analyzer: result.analyzer,
          analyzerVersion: result.analyzerVersion,
          ruleId: finding.ruleId,
          findingId: finding.findingId,
          path,
          ...(location.startLine === undefined ? {} : { startLine: location.startLine }),
          ...(location.endLine === undefined ? {} : { endLine: location.endLine }),
          representation,
          lineageStatus: lineage.lineageStatus,
          ...(lineage.derivedFrom === undefined ? {} : { derivedFrom: lineage.derivedFrom }),
        };
        for (const capability of new Set(capabilityIds)) {
          const values = byCapability.get(capability) ?? [];
          if (!values.some((value) => value.findingId === observation.findingId && value.path === observation.path)) values.push(observation);
          byCapability.set(capability, values);
        }
      }
    }
  }
  return byCapability;
}

function sourceLocations(finding: Finding): FindingLocation[] {
  const data = finding.data as Record<string, unknown>;
  const locations = Array.isArray(data.locations) ? data.locations : finding.location === undefined ? [] : [finding.location];
  return locations.filter((location): location is FindingLocation => (
    typeof location === 'object'
    && location !== null
    && (location as FindingLocation).type === 'SOURCE_FILE'
    && typeof (location as FindingLocation).path === 'string'
  ));
}

function aggregateValidationStatus(
  before: readonly string[],
  after: readonly string[] | null,
  comparisons: readonly CapabilityComparison[],
  incomplete: boolean,
): CapabilityPreservationStatus {
  if (incomplete) return 'NOT_VERIFIED';
  if (before.length === 0 && (after?.length ?? 0) === 0) return 'NOT_APPLICABLE';
  if (comparisons.some(({ status }) => status === 'LOST')) return 'LOST';
  if (before.length === 0) return 'DISCOVERED';
  return 'PRESERVED';
}

function aggregateStatus(
  files: readonly CapabilityPreservationFile[],
  limitations: readonly RestoreLimitation[],
  complete: boolean,
): CapabilityPreservationStatus {
  if (!complete || limitations.includes(MISSING_CAPABILITY_LIMITATION)) return 'NOT_VERIFIED';
  const statuses = files.flatMap(({ validation }) => (validation.comparisons ?? []).map(({ status }) => status));
  if (statuses.includes('LOST')) return 'LOST';
  if (statuses.includes('PRESERVED')) return 'PRESERVED';
  if (statuses.includes('DISCOVERED')) return 'DISCOVERED';
  return 'NOT_APPLICABLE';
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function samePath(left: string, right: string): boolean {
  return canonicalizeEvidencePath(left) === canonicalizeEvidencePath(right);
}
