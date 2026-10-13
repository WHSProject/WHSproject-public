import { randomUUID } from 'node:crypto';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import type {
  AnalyzerResult,
  Finding,
  FindingLocation,
  ScanError,
} from '../../domain/analysis.types';
import { ScannerErrorCode } from '../../domain/scanner-error-code';
import { mapDerivedLineRange, mappingForPath } from '../../analyzers/obfuscation/line-mapping';
import { EvidenceMappingRegistry } from './evidence-mapping.registry';
import type {
  AtomicEvidenceV0_1,
  EvidenceMappingTarget,
  EvidenceSource,
  NormalizationInput,
  NormalizationResult,
  Tier2EvidenceCandidateInput,
  UnmappedFinding,
} from './evidence-normalizer.types';

export const EVIDENCE_NORMALIZER_VERSION = '0.1.0';

export class EvidenceNormalizer {
  constructor(
    private readonly registry = new EvidenceMappingRegistry(),
    private readonly createEvidenceId: () => string = randomUUID,
    private readonly now: () => Date = () => new Date(),
  ) {}

  normalize(input: NormalizationInput): NormalizationResult {
    const state: NormalizationState = {
      atomicEvidences: [],
      evidenceByDeduplicationKey: new Map(),
      unmappedFindings: [],
      errors: [],
      inputFindingCount: 0,
      normalizedFindingCount: 0,
      invalidFindingCount: 0,
      deduplicatedEvidenceCount: 0,
    };

    for (const analyzerResult of input.analyzerResults) {
      state.inputFindingCount += analyzerResult.findings.length;
      for (const candidate of analyzerResult.findings) {
        this.normalizeFinding(input, analyzerResult, candidate, state);
      }
    }

    for (const candidate of input.tier2Candidates ?? []) {
      state.inputFindingCount += 1;
      this.normalizeTier2Candidate(input, candidate, state);
    }

    return {
      atomicEvidences: state.atomicEvidences,
      unmappedFindings: state.unmappedFindings,
      errors: state.errors,
      summary: {
        inputFindingCount: state.inputFindingCount,
        normalizedFindingCount: state.normalizedFindingCount,
        atomicEvidenceCount: state.atomicEvidences.length,
        unmappedFindingCount: state.unmappedFindings.length,
        invalidFindingCount: state.invalidFindingCount,
        deduplicatedEvidenceCount: state.deduplicatedEvidenceCount,
        normalizerVersion: EVIDENCE_NORMALIZER_VERSION,
        mappingVersion: this.registry.mappingVersion,
        mappingHash: this.registry.mappingHash,
      },
    };
  }

  private normalizeFinding(
    input: NormalizationInput,
    analyzerResult: AnalyzerResult,
    candidate: unknown,
    state: NormalizationState,
    options: FindingNormalizationOptions = {},
  ): void {
    const validation = validateFinding(candidate);
    if (!validation.valid) {
      state.invalidFindingCount += 1;
      state.errors.push(
        normalizationError('INVALID_FINDING', analyzerResult.analyzer, validation.reason),
      );
      return;
    }

    const finding = validation.finding;
    if (finding.type === 'UNKNOWN') {
      state.unmappedFindings.push(
        toUnmappedFinding(
          analyzerResult,
          finding,
          'UNMAPPED',
          'UNKNOWN Findings are not converted to Evidence',
        ),
      );
      return;
    }
    const mapping = this.registry.find(
      options.mappingAnalyzer ?? analyzerResult.analyzer,
      finding.ruleId,
    );
    if (mapping === undefined) {
      state.unmappedFindings.push(
        toUnmappedFinding(
          analyzerResult,
          finding,
          'UNMAPPED',
          'No Evidence mapping is registered for this Analyzer and Rule ID',
        ),
      );
      return;
    }
    if (mapping.mappingStatus === 'AMBIGUOUS') {
      state.unmappedFindings.push(
        toUnmappedFinding(analyzerResult, finding, 'AMBIGUOUS', mapping.reason),
      );
      return;
    }
    if (mapping.mappingStatus === 'INVALID') {
      state.unmappedFindings.push(
        toUnmappedFinding(analyzerResult, finding, 'INVALID', mapping.reason),
      );
      return;
    }

    const invalidTarget = mapping.targets.find(
      (target) => !isValidMappingTarget(target),
    );
    if (invalidTarget !== undefined) {
      state.unmappedFindings.push(
        toUnmappedFinding(
          analyzerResult,
          finding,
          'INVALID',
          'Evidence mapping target is invalid',
        ),
      );
      return;
    }

    let locations: FindingLocation[];
    try {
      const locationFinding = options.locations === undefined
        ? finding
        : {
            ...finding,
            location: undefined,
            data: { ...finding.data, locations: options.locations },
          };
      locations = normalizeFindingLocations(locationFinding, input.artifactRoot);
      if (options.tier2 !== undefined) {
        locations = toTier2Locations(
          locations,
          options.tier2.originalPaths,
          options.tier2.originalPath,
          input.artifactRoot,
          options.tier2.lineMapping,
          options.tier2.lineMappings,
        );
      }
    } catch {
      state.invalidFindingCount += 1;
      state.errors.push(
        normalizationError(
          'INVALID_LOCATION',
          analyzerResult.analyzer,
          `Finding ${finding.findingId} contains an invalid location`,
        ),
      );
      return;
    }

    let createdForFinding = false;
    for (const target of mapping.targets) {
      const deduplicationKey = createDeduplicationKey(
        analyzerResult.analyzer,
        finding,
        locations,
        target,
      );
      const existing = state.evidenceByDeduplicationKey.get(deduplicationKey);
      if (existing !== undefined) {
        appendSource(existing.sources, analyzerResult, finding);
        state.deduplicatedEvidenceCount += 1;
        continue;
      }

      try {
        const evidence = this.buildEvidence(
          input,
          analyzerResult,
          finding,
          locations,
          target,
          options.analysisPass,
          options.tier2?.limitations,
          options.tier2?.restoreStatus,
          options.tier2?.capabilityPreservation,
        );
        state.evidenceByDeduplicationKey.set(deduplicationKey, evidence);
        state.atomicEvidences.push(evidence);
        createdForFinding = true;
      } catch {
        state.errors.push(
          normalizationError(
            'EVIDENCE_BUILD_FAILED',
            analyzerResult.analyzer,
            `Unable to build Evidence for Finding ${finding.findingId}`,
          ),
        );
      }
    }

    if (createdForFinding) state.normalizedFindingCount += 1;
  }

  private normalizeTier2Candidate(
    input: NormalizationInput,
    candidate: Tier2EvidenceCandidateInput,
    state: NormalizationState,
  ): void {
    const baseAnalyzer = tier2BaseAnalyzer(candidate.analyzer);
    if (
      baseAnalyzer === undefined
      || candidate.requestId !== input.requestId
      || candidate.scanId !== input.scanId
      || candidate.artifactHash !== input.subject.artifactHash
      || candidate.ruleId !== candidate.finding.ruleId
      || candidate.rawFindingId !== candidate.finding.findingId
      || candidate.locations.length === 0
      || candidate.locations.some(({ type }) => type !== 'SOURCE_FILE')
    ) {
      state.invalidFindingCount += 1;
      state.errors.push(
        normalizationError(
          'INVALID_FINDING',
          candidate.analyzer,
          `Tier2 candidate ${candidate.rawFindingId} is invalid`,
        ),
      );
      return;
    }

    const analyzerResult: AnalyzerResult = {
      requestId: candidate.requestId,
      scanId: candidate.scanId,
      analyzer: candidate.analyzer,
      analyzerVersion: candidate.analyzerVersion,
      status: 'SUCCESS',
      findings: [candidate.finding],
      errors: [],
    };
    this.normalizeFinding(input, analyzerResult, candidate.finding, state, {
      analysisPass: 'TIER2',
      mappingAnalyzer: baseAnalyzer,
      locations: candidate.locations,
      tier2: candidate,
    });
  }

  private buildEvidence(
    input: NormalizationInput,
    analyzerResult: AnalyzerResult,
    finding: Finding,
    locations: FindingLocation[],
    target: EvidenceMappingTarget,
    analysisPass?: 'TIER1' | 'TIER2',
    candidateLimitations: readonly string[] = [],
    restoreStatus?: Tier2EvidenceCandidateInput['restoreStatus'],
    capabilityPreservation?: Tier2EvidenceCandidateInput['capabilityPreservation'],
  ): AtomicEvidenceV0_1 {
    return {
      schemaVersion: '0.1',
      evidenceId: this.createEvidenceId(),
      kind: 'ATOMIC',
      ...(analysisPass === undefined ? {} : { analysisPass }),
      signal: {
        id: target.signalId,
        type: target.signalType,
        category: target.signalCategory,
      },
      ...(target.taxonomy === undefined ? {} : { taxonomy: target.taxonomy }),
      ...(target.action === undefined ? {} : { action: target.action }),
      subject: { ...input.subject },
      assertion: {
        summary: finding.message,
        basis: target.assertionBasis,
      },
      sources: [createSource(analyzerResult, finding)],
      locations,
      provenance: {
        scanId: input.scanId,
        generatedBy: 'EVIDENCE_NORMALIZER',
        observedAt: this.now().toISOString(),
      },
      limitations: [
        ...new Set([
          ...target.limitations,
          ...candidateLimitations,
          ...(restoreStatus === 'PARTIAL_RESTORED' ? ['PARTIAL_RESTORED'] : []),
        ]),
      ],
      ...(capabilityPreservation === undefined ? {} : { capabilityPreservation: structuredClone(capabilityPreservation) }),
    };
  }
}

interface NormalizationState {
  atomicEvidences: AtomicEvidenceV0_1[];
  evidenceByDeduplicationKey: Map<string, AtomicEvidenceV0_1>;
  unmappedFindings: UnmappedFinding[];
  errors: ScanError[];
  inputFindingCount: number;
  normalizedFindingCount: number;
  invalidFindingCount: number;
  deduplicatedEvidenceCount: number;
}

interface FindingNormalizationOptions {
  mappingAnalyzer?: string;
  locations?: readonly FindingLocation[];
  analysisPass?: 'TIER1' | 'TIER2';
  tier2?: Tier2EvidenceCandidateInput;
}

type FindingValidation =
  | { valid: true; finding: Finding }
  | { valid: false; reason: string };

function validateFinding(value: unknown): FindingValidation {
  if (!isRecord(value)) {
    return { valid: false, reason: 'Finding must be an object' };
  }
  for (const field of ['findingId', 'ruleId', 'type', 'message'] as const) {
    if (typeof value[field] !== 'string' || value[field].length === 0) {
      return {
        valid: false,
        reason: `Finding ${field} must be a non-empty string`,
      };
    }
  }
  if (!isRecord(value.data)) {
    return { valid: false, reason: 'Finding data must be an object' };
  }

  return { valid: true, finding: value as unknown as Finding };
}

function normalizeFindingLocations(
  finding: Finding,
  artifactRoot: string,
): FindingLocation[] {
  const locations = Array.isArray(finding.data.locations)
    ? finding.data.locations
    : finding.location === undefined
      ? []
      : [finding.location];

  return locations.map((value) => normalizeLocation(value, artifactRoot));
}

function normalizeLocation(
  value: unknown,
  artifactRoot: string,
): FindingLocation {
  if (!isRecord(value)) {
    throw new Error('Location must be an object');
  }
  if (value.type !== 'SOURCE_FILE' && value.type !== 'METADATA') {
    throw new Error('Location type is invalid');
  }

  const location: FindingLocation = { type: value.type };
  if (value.path !== undefined) {
    if (typeof value.path !== 'string' || value.path.length === 0) {
      throw new Error('Location path is invalid');
    }
    location.path = normalizeArtifactPath(value.path, artifactRoot);
  }
  for (const field of [
    'startLine',
    'startColumn',
    'endLine',
    'endColumn',
  ] as const) {
    const coordinate = value[field];
    if (coordinate !== undefined) {
      if (!Number.isSafeInteger(coordinate) || (coordinate as number) <= 0) {
        throw new Error(`Location ${field} is invalid`);
      }
      location[field] = coordinate as number;
    }
  }
  if (
    location.startLine !== undefined &&
    location.endLine !== undefined &&
    location.endLine < location.startLine
  ) {
    throw new Error('Location endLine precedes startLine');
  }
  if (value.jsonPointer !== undefined) {
    if (typeof value.jsonPointer !== 'string') {
      throw new Error('Location jsonPointer is invalid');
    }
    location.jsonPointer = value.jsonPointer;
  }

  return location;
}

function normalizeArtifactPath(path: string, artifactRoot: string): string {
  if (path.split(/[\\/]+/u).includes('..')) {
    throw new Error('Location contains a parent path segment');
  }

  const root = resolve(artifactRoot);
  const resolvedPath = isAbsolute(path) ? resolve(path) : resolve(root, path);
  const relativePath = relative(root, resolvedPath);
  if (
    relativePath === '' ||
    relativePath === '..' ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw new Error('Location resolves outside the Artifact root');
  }
  return relativePath.split(sep).join('/');
}

function tier2BaseAnalyzer(analyzer: string): 'custom-rule' | 'guarddog' | undefined {
  if (analyzer === 'custom-rule-deobfuscated') return 'custom-rule';
  if (analyzer === 'guarddog-deobfuscated') return 'guarddog';
  return undefined;
}

function toTier2Locations(
  locations: FindingLocation[],
  originalPaths: readonly string[],
  originalPath: string,
  artifactRoot: string,
  lineMapping?: import('../../analyzers/obfuscation/obfuscation.types').SourceLineMapping,
  lineMappings?: readonly import('../../analyzers/obfuscation/obfuscation.types').SourceLineMapping[],
): FindingLocation[] {
  return locations.map((location, index) => {
    if (location.type !== 'SOURCE_FILE' || location.path === undefined) {
      throw new Error('Tier2 candidate location must be a source file');
    }
    const sourcePath = normalizeArtifactPath(
      originalPaths[index] ?? originalPath,
      artifactRoot,
    );
    const derivedPath = normalizeArtifactPath(location.path, artifactRoot);
    const applicableMapping = mappingForPath(
      lineMappings ?? (lineMapping === undefined ? undefined : [lineMapping]),
      derivedPath,
    );
    const lineage = mapDerivedLineRange(
      applicableMapping,
      normalizeArtifactPath(originalPaths[index] ?? originalPath, artifactRoot),
      location.startLine,
      location.endLine,
    );
    return {
      ...location,
      representation: 'DEOBFUSCATED',
      lineageStatus: lineage.lineageStatus,
      derivedFrom: lineage.lineageStatus === 'MAPPED'
        ? lineage.derivedFrom
        : { path: sourcePath },
    };
  });
}

function createDeduplicationKey(
  analyzerName: string,
  finding: Finding,
  locations: FindingLocation[],
  target: EvidenceMappingTarget,
): string {
  return canonicalStringify({
    analyzerName,
    ruleId: finding.ruleId,
    locations,
    match: typeof finding.data.match === 'string' ? finding.data.match : null,
    code: typeof finding.data.code === 'string' ? finding.data.code : null,
    signalId: target.signalId,
  });
}

function canonicalStringify(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalValue);
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalValue(value[key])]),
    );
  }
  return value;
}

function toUnmappedFinding(
  analyzerResult: AnalyzerResult,
  finding: Finding,
  mappingStatus: UnmappedFinding['mappingStatus'],
  reason: string,
): UnmappedFinding {
  return {
    findingId: finding.findingId,
    analyzerName: analyzerResult.analyzer,
    analyzerVersion: analyzerResult.analyzerVersion,
    ruleId: finding.ruleId,
    mappingStatus,
    reason,
    location: finding.location,
    signal: null,
    taxonomy: null,
    ...(finding.rawResultRef === undefined
      ? analyzerResult.rawResultRef === undefined
        ? {}
        : { rawResultRef: analyzerResult.rawResultRef }
      : { rawResultRef: finding.rawResultRef }),
  };
}

function isValidMappingTarget(target: EvidenceMappingTarget): boolean {
  return (
    typeof target.signalId === 'string' && target.signalId.length > 0 &&
    typeof target.signalType === 'string' &&
    typeof target.signalCategory === 'string' &&
    typeof target.assertionBasis === 'string' &&
    Array.isArray(target.limitations) &&
    (target.taxonomy === undefined || typeof target.taxonomy === 'string') &&
    (target.action === undefined || typeof target.action === 'string')
  );
}

function createSource(
  analyzerResult: AnalyzerResult,
  finding: Finding,
): EvidenceSource {
  return {
    analyzer: analyzerResult.analyzer,
    analyzerVersion: analyzerResult.analyzerVersion,
    ruleId: finding.ruleId,
    rawFindingId: finding.findingId,
  };
}

function appendSource(
  sources: EvidenceSource[],
  analyzerResult: AnalyzerResult,
  finding: Finding,
): void {
  if (!sources.some(({ rawFindingId }) => rawFindingId === finding.findingId)) {
    sources.push(createSource(analyzerResult, finding));
  }
}

function normalizationError(
  kind:
    | 'INVALID_FINDING'
    | 'INVALID_LOCATION'
    | 'EVIDENCE_BUILD_FAILED',
  analyzer: string,
  message: string,
): ScanError {
  return {
    code: ScannerErrorCode.INTERNAL_ERROR,
    stage: `NORMALIZATION:${kind}`,
    analyzer,
    message,
    retryable: false,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
