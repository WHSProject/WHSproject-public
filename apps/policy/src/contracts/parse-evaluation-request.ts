import type { EvaluationRequest, Evidence, OsvFeed } from './evidence';

export function parseEvaluationRequest(value: unknown): EvaluationRequest {
  if (!value || typeof value !== 'object') throw new Error('INVALID_REQUEST');
  const input = value as Record<string, unknown>;
  if (typeof input.requestId !== 'string' || typeof input.scanId !== 'string' || !isRecord(input.subject) || !Array.isArray(input.evidences) || !isRecord(input.osvFeed)) throw new Error('INVALID_REQUEST');
  const subject = input.subject as Record<string, unknown>;
  if (subject.ecosystem !== 'npm' || typeof subject.packageName !== 'string' || typeof subject.packageVersion !== 'string' || typeof subject.artifactHash !== 'string' || typeof subject.integrity !== 'string') throw new Error('INVALID_SUBJECT');
  if (input.scanStatus !== 'COMPLETED' && input.scanStatus !== 'PARTIAL' && input.scanStatus !== 'FAILED' && input.scanStatus !== 'TIMEOUT') throw new Error('INVALID_SCAN_STATUS');
  if (input.score !== undefined && input.score !== null && typeof input.score !== 'number') throw new Error('INVALID_SCORE');
  if (input.expectedArtifactHash !== undefined && input.expectedArtifactHash !== null && typeof input.expectedArtifactHash !== 'string') throw new Error('INVALID_EXPECTED_ARTIFACT_HASH');
  const evidences = input.evidences as Evidence[];
  if (evidences.some((evidence) => !isRecord(evidence) || typeof evidence.evidenceId !== 'string' || !['ATOMIC', 'CORRELATED', 'LLM_ASSESSMENT'].includes(evidence.kind) || !isRecord(evidence.subject) || !isRecord(evidence.provenance) || typeof evidence.provenance.scanId !== 'string')) throw new Error('INVALID_EVIDENCE');
  for (const evidence of evidences) validateEvidenceProvenance(evidence);
  return { requestId: input.requestId, scanId: input.scanId, scanStatus: input.scanStatus, subject: subject as unknown as EvaluationRequest['subject'], evidences, osvFeed: input.osvFeed as unknown as OsvFeed, expectedArtifactHash: typeof input.expectedArtifactHash === 'string' ? input.expectedArtifactHash : null, agentAnalysisSummary: isRecord(input.agentAnalysisSummary) ? input.agentAnalysisSummary : undefined, score: typeof input.score === 'number' ? input.score : null };
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }

const taxonomyValues = new Set([
  'INSTALLATION_AND_EXECUTION', 'DISCOVERY_AND_COLLECTION',
  'CREDENTIAL_AND_SENSITIVE_DATA_ACCESS', 'NETWORK_C2_AND_EXFILTRATION',
  'PAYLOAD_AND_DYNAMIC_CODE', 'FILESYSTEM_AND_SYSTEM_MODIFICATION',
  'PERSISTENCE_AND_PROPAGATION', 'EVASION_AND_OBFUSCATION',
  'PACKAGE_AND_PUBLISHING_RISK',
]);
const capabilityStatuses = new Set(['PRESERVED', 'LOST', 'DISCOVERED', 'NOT_VERIFIED', 'NOT_APPLICABLE']);
const restoreStatuses = new Set(['RESTORED', 'PARTIAL_RESTORED', 'UNRESOLVED', 'SKIPPED', 'FAILED']);
const representations = new Set(['ORIGINAL', 'DEOBFUSCATED']);
const lineageStatuses = new Set(['DIRECT', 'MAPPED', 'UNMAPPED']);

function hasOnlyFields(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((field) => Object.hasOwn(value, field))
    && Object.keys(value).every((field) => allowed.has(field));
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

function validDerivedFrom(value: unknown, nonemptyPath: boolean): boolean {
  if (!isRecord(value) || !hasOnlyFields(value, ['path'], ['startLine', 'endLine'])
    || typeof value.path !== 'string' || (nonemptyPath && value.path.length === 0)) return false;
  return ['startLine', 'endLine'].every((field) => !Object.hasOwn(value, field) || isPositiveInteger(value[field]));
}

function validObservation(value: unknown): boolean {
  if (!isRecord(value) || !hasOnlyFields(value,
    ['analyzer', 'analyzerVersion', 'ruleId', 'findingId', 'path', 'representation', 'lineageStatus'],
    ['startLine', 'endLine', 'derivedFrom'])) return false;
  return ['analyzer', 'analyzerVersion', 'ruleId', 'findingId', 'path'].every((field) => typeof value[field] === 'string')
    && representations.has(value.representation as string)
    && lineageStatuses.has(value.lineageStatus as string)
    && ['startLine', 'endLine'].every((field) => !Object.hasOwn(value, field) || isPositiveInteger(value[field]))
    && (!Object.hasOwn(value, 'derivedFrom') || validDerivedFrom(value.derivedFrom, false));
}

function validCapabilityPreservation(value: unknown): boolean {
  if (!isRecord(value) || !hasOnlyFields(value,
    ['before', 'after', 'status', 'preserved', 'lost', 'discovered', 'comparisons', 'limitations'],
    ['originalPath', 'deobfuscatedPaths', 'restoreStatus'])) return false;
  if (!isStringArray(value.before) || !(value.after === null || isStringArray(value.after))
    || !capabilityStatuses.has(value.status as string)
    || !['preserved', 'lost', 'discovered', 'limitations'].every((field) => isStringArray(value[field]))
    || !Array.isArray(value.comparisons)
    || (Object.hasOwn(value, 'originalPath') && typeof value.originalPath !== 'string')
    || (Object.hasOwn(value, 'deobfuscatedPaths') && !isStringArray(value.deobfuscatedPaths))
    || (Object.hasOwn(value, 'restoreStatus') && !restoreStatuses.has(value.restoreStatus as string))) return false;
  return value.comparisons.every((comparison: unknown) => isRecord(comparison)
    && hasOnlyFields(comparison, ['capability', 'status', 'original', 'deobfuscated'])
    && typeof comparison.capability === 'string'
    && capabilityStatuses.has(comparison.status as string)
    && Array.isArray(comparison.original) && comparison.original.every(validObservation)
    && Array.isArray(comparison.deobfuscated) && comparison.deobfuscated.every(validObservation));
}

function validateEvidenceProvenance(evidence: Evidence): void {
  const allowedEvidenceFields = new Set(['schemaVersion', 'evidenceId', 'kind', 'analysisPass', 'taxonomy', 'action', 'signal', 'subject', 'assertion', 'sources', 'locations', 'derivedFrom', 'provenance', 'limitations', 'capabilityPreservation', 'executionContext', 'reachability', 'intentAssessment', 'verificationStatus', 'confidence', 'reasonCodes', 'alternatives', 'relatedFindingIds', 'relatedAtomicEvidenceIds']);
  if (Object.keys(evidence).some((key) => !allowedEvidenceFields.has(key))) throw new Error('INVALID_EVIDENCE_FIELD');
  if (evidence.analysisPass !== undefined && !['TIER1', 'TIER2'].includes(evidence.analysisPass)) throw new Error('INVALID_EVIDENCE_ANALYSIS_PASS');
  const fields = evidence as unknown as Record<string, unknown>;
  if (Object.hasOwn(fields, 'taxonomy') && !taxonomyValues.has(fields.taxonomy as string)) throw new Error('INVALID_EVIDENCE_TAXONOMY');
  if (Object.hasOwn(fields, 'action') && (typeof fields.action !== 'string' || fields.action.length === 0)) throw new Error('INVALID_EVIDENCE_ACTION');
  if (Object.hasOwn(fields, 'capabilityPreservation') && !validCapabilityPreservation(fields.capabilityPreservation)) throw new Error('INVALID_EVIDENCE_CAPABILITY_PRESERVATION');
  if (evidence.locations === undefined) return;
  if (!Array.isArray(evidence.locations)) throw new Error('INVALID_EVIDENCE_LOCATIONS');
  for (const location of evidence.locations) {
    if (!isRecord(location)) throw new Error('INVALID_EVIDENCE_LOCATION');
    const allowed = new Set(['type', 'path', 'startLine', 'startColumn', 'endLine', 'endColumn', 'jsonPointer', 'role', 'representation', 'lineageStatus', 'derivedFrom']);
    if (Object.keys(location).some((key) => !allowed.has(key))) throw new Error('INVALID_EVIDENCE_LOCATION_FIELD');
    if (!['SOURCE_FILE', 'METADATA'].includes(location.type as string)) throw new Error('INVALID_EVIDENCE_LOCATION_TYPE');
    if (location.representation !== undefined && !['ORIGINAL', 'DEOBFUSCATED'].includes(location.representation as string)) throw new Error('INVALID_EVIDENCE_REPRESENTATION');
    if (location.lineageStatus !== undefined && !['DIRECT', 'MAPPED', 'UNMAPPED'].includes(location.lineageStatus as string)) throw new Error('INVALID_EVIDENCE_LINEAGE_STATUS');
    if (location.derivedFrom !== undefined) {
      const derived = location.derivedFrom;
      if (!validDerivedFrom(derived, true)) throw new Error('INVALID_EVIDENCE_LOCATION_DERIVED_FROM');
    }
  }
}
