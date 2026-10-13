import { createHash } from 'node:crypto';
import { z } from 'zod';

import { AGENT_FINDING_ANALYZERS } from '../agent-input/agent-finding-projection';
import type { AgentExperimentRequestV0_3 } from './agent-experiment.types';
import { AGENT_EXPERIMENT_MAX_PAYLOAD_BYTES } from './agent-experiment.types';

const nonempty = z.string().min(1);
const positive = z.number().int().positive();
const nullableLine = positive.nullable();
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const inputLocation = z.strictObject({ file: nonempty, startLine: nullableLine, endLine: nullableLine });
const findingLocation = z.strictObject({
  type: z.enum(['SOURCE_FILE', 'METADATA']), path: nonempty.optional(), startLine: positive.optional(), startColumn: positive.optional(),
  endLine: positive.optional(), endColumn: positive.optional(), jsonPointer: z.string().optional(), representation: z.enum(['ORIGINAL', 'DEOBFUSCATED']).optional(),
  lineageStatus: z.enum(['DIRECT', 'MAPPED', 'UNMAPPED']).optional(), derivedFrom: z.strictObject({ path: nonempty }).optional(),
});
const finding = z.strictObject({ findingId: nonempty, analyzer: z.enum(AGENT_FINDING_ANALYZERS), analyzerVersion: nonempty,
  ruleId: nonempty, type: nonempty, message: z.string(), location: findingLocation.optional(), data: z.record(z.string(), z.unknown()) });
const evidenceSource = z.strictObject({ analyzer: nonempty, analyzerVersion: nonempty, ruleId: nonempty, rawFindingId: nonempty });
const atomicEvidence = z.strictObject({
  schemaVersion: z.literal('0.1'), evidenceId: nonempty, kind: z.literal('ATOMIC'), analysisPass: z.enum(['TIER1', 'TIER2']).optional(),
  signal: z.strictObject({ id: nonempty, type: nonempty, category: nonempty }), taxonomy: nonempty.optional(), action: z.string().optional(),
  subject: z.strictObject({ ecosystem: z.literal('npm'), packageName: nonempty, packageVersion: nonempty, artifactHash: sha256 }),
  assertion: z.strictObject({ summary: z.string(), basis: z.enum(['PATTERN_MATCH', 'METADATA_VALUE', 'CO_OCCURRENCE', 'EXECUTION_LINK', 'DATA_FLOW', 'TOOL_CORRELATION']) }),
  sources: z.array(evidenceSource), locations: z.array(findingLocation),
  provenance: z.strictObject({ scanId: nonempty, generatedBy: z.literal('EVIDENCE_NORMALIZER'), observedAt: nonempty }), limitations: z.array(z.string()),
  sourceType: z.unknown().optional(),
});
const codeSlice = z.strictObject({ sliceId: nonempty, file: nonempty, startLine: positive, endLine: positive, content: z.string(), contentSha256: sha256,
  sourceSha256: sha256, contentRedacted: z.boolean(), redactionTypes: z.array(z.string()), boundaryConfidence: z.enum(['HIGH', 'MEDIUM', 'LOW']),
  selectionReason: nonempty, relatedFindingIds: z.array(nonempty) });
const requestSchema = z.strictObject({
  request: z.strictObject({ analysisRequestId: nonempty, requestType: z.literal('MALICIOUS_CODE_ANALYSIS'),
    inputProfile: z.enum(['CODE_ONLY', 'CODE_FINDING', 'CODE_FINDING_EVIDENCE']), schemaVersion: z.literal('0.3.0'),
    sampleId: z.string().regex(/^SAMPLE-[0-9]{3}$/u), createdAt: z.string().datetime().nullable() }),
  subject: z.strictObject({ ecosystem: z.literal('npm'), packageName: nonempty, packageVersion: nonempty, archiveSha256: sha256 }),
  packageContext: z.strictObject({ source: z.literal('TARBALL_PACKAGE_MANIFEST_PROJECTION'), description: z.string().nullable(), main: z.string().nullable(),
    exports: z.unknown(), scripts: z.record(z.string(), z.unknown()), dependencies: z.record(z.string(), z.unknown()),
    entryPoints: z.array(z.strictObject({ type: z.enum(['MAIN', 'BIN', 'EXPORTS']), value: z.unknown(), location: inputLocation })),
    lifecycleScripts: z.array(z.strictObject({ name: z.enum(['preinstall', 'install', 'postinstall']), command: z.string(), location: inputLocation })) }),
  findings: z.array(finding), atomicEvidences: z.array(atomicEvidence),
  analysisPolicy: z.strictObject({ maxToolCalls: z.number().int().nonnegative().optional(), maxAdditionalCodeRequests: z.number().int().nonnegative().optional(), maxTotalCodeLines: z.number().int().nonnegative().optional() }),
  initialCodeSlices: z.array(codeSlice), analysisTargets: z.array(z.enum(['ENV_OR_SENSITIVE_FILE_TO_NETWORK', 'NETWORK_DOWNLOAD_TO_FILE_WRITE_TO_PROCESS_EXECUTION', 'LIFECYCLE_TO_PROCESS_EXECUTION'])),
  toolResponseCatalog: z.array(z.strictObject({ tool: nonempty, status: z.enum(['AVAILABLE', 'UNAVAILABLE']), indexPath: z.string().optional(), reason: z.string().optional() })),
  missingData: z.array(z.strictObject({ field: nonempty, reason: nonempty })),
});

const forbiddenKeys = new Set(['groundTruth', 'expectedVerdict', 'expectedLabel', 'split', 'sourceType', 'leakageGroupId', 'humanVerificationTier',
  'reviewerDecision', 'quickDecision', 'finalDecision', 'clusterDecision', 'scannerFinalDecision', 'evaluationScore']);
const unsafePath = /^(?:\/Users\/|\/private\/tmp\/|\/analysis\/package(?:\/|$)|[A-Za-z]:[\\/])|(?:^|[\\/])\.\.(?:[\\/]|$)/u;

export class AgentExperimentRequestValidationError extends Error {
  constructor(readonly issues: string[]) { super(`AGENT_EXPERIMENT_REQUEST_INVALID:${issues.join(';')}`); }
}

export class AgentExperimentRequestValidator {
  validate(value: unknown): AgentExperimentRequestV0_3 {
    const issues: string[] = [];
    try { assertJsonSafe(value); } catch (error) { issues.push(error instanceof Error ? error.message : 'NON_JSON_VALUE'); }
    if (issues.length > 0) throw new AgentExperimentRequestValidationError(issues);
    const bytes = Buffer.byteLength(canonicalJson(value));
    if (bytes > AGENT_EXPERIMENT_MAX_PAYLOAD_BYTES) issues.push('PAYLOAD_TOO_LARGE');
    const parsed = requestSchema.safeParse(value);
    if (!parsed.success) issues.push(...parsed.error.issues.map((item) => `SCHEMA:${item.path.join('.')}:${item.message}`));
    if (!parsed.success) throw new AgentExperimentRequestValidationError(issues);
    const request = parsed.data as AgentExperimentRequestV0_3;
    findForbiddenKeys(request, [], issues);
    validatePaths(request, issues);
    validateReferences(request, issues);
    validateProfile(request, issues);
    if (issues.length > 0) throw new AgentExperimentRequestValidationError([...new Set(issues)]);
    return canonicalize(request) as AgentExperimentRequestV0_3;
  }
}

function validateProfile(input: AgentExperimentRequestV0_3, issues: string[]): void {
  if (input.request.inputProfile === 'CODE_ONLY' && (input.findings.length > 0 || input.atomicEvidences.length > 0)) issues.push('CODE_ONLY_DISCLOSURE_VIOLATION');
  if (input.request.inputProfile === 'CODE_FINDING' && input.atomicEvidences.length > 0) issues.push('CODE_FINDING_EVIDENCE_DISCLOSURE_VIOLATION');
  if (input.request.inputProfile === 'CODE_FINDING_EVIDENCE' && input.atomicEvidences.length > 0 && input.findings.length === 0) issues.push('EVIDENCE_WITHOUT_FINDINGS');
}

function validateReferences(input: AgentExperimentRequestV0_3, issues: string[]): void {
  const findings = new Map<string, AgentExperimentRequestV0_3['findings'][number]>(), evidenceIds = new Set<string>(), sliceIds = new Set<string>();
  for (const item of input.findings) { if (findings.has(item.findingId)) issues.push(`DUPLICATE_FINDING_ID:${item.findingId}`); findings.set(item.findingId, item); validateRange(item.location, issues); }
  for (const slice of input.initialCodeSlices) {
    if (sliceIds.has(slice.sliceId)) issues.push(`DUPLICATE_SLICE_ID:${slice.sliceId}`); sliceIds.add(slice.sliceId);
    if (slice.endLine < slice.startLine) issues.push(`INVALID_SLICE_RANGE:${slice.sliceId}`);
    if (sha(slice.content) !== slice.contentSha256) issues.push(`SLICE_CONTENT_HASH_MISMATCH:${slice.sliceId}`);
    // relatedFindingIds are slice-selection provenance and intentionally remain
    // identical across disclosure profiles, including CODE_ONLY.
  }
  for (const evidence of input.atomicEvidences) {
    if (evidenceIds.has(evidence.evidenceId)) issues.push(`DUPLICATE_EVIDENCE_ID:${evidence.evidenceId}`); evidenceIds.add(evidence.evidenceId);
    if (evidence.subject.artifactHash !== input.subject.archiveSha256) issues.push(`EVIDENCE_SUBJECT_MISMATCH:${evidence.evidenceId}`);
    for (const location of evidence.locations) validateRange(location, issues);
    for (const source of evidence.sources) {
      const item = findings.get(source.rawFindingId);
      if (!item) { issues.push(`DANGLING_EVIDENCE_FINDING:${source.rawFindingId}`); continue; }
      if (item.analyzer !== source.analyzer || item.analyzerVersion !== source.analyzerVersion || item.ruleId !== source.ruleId) issues.push(`EVIDENCE_PROVENANCE_MISMATCH:${evidence.evidenceId}`);
    }
  }
}

function validateRange(location: { startLine?: number; endLine?: number } | undefined, issues: string[]): void {
  if (location?.startLine !== undefined && location.endLine !== undefined && location.endLine < location.startLine) issues.push('INVALID_LOCATION_RANGE');
}

function validatePaths(input: AgentExperimentRequestV0_3, issues: string[]): void {
  const paths: string[] = [];
  for (const finding of input.findings) { if (finding.location?.path) paths.push(finding.location.path); if (finding.location?.derivedFrom?.path) paths.push(finding.location.derivedFrom.path); }
  for (const evidence of input.atomicEvidences) for (const location of evidence.locations) { if (location.path) paths.push(location.path); if (location.derivedFrom?.path) paths.push(location.derivedFrom.path); }
  for (const slice of input.initialCodeSlices) paths.push(slice.file);
  for (const entry of input.packageContext.entryPoints) paths.push(entry.location.file);
  for (const lifecycle of input.packageContext.lifecycleScripts) paths.push(lifecycle.location.file);
  for (const path of paths) if (unsafePath.test(path) || path.startsWith('/')) issues.push(`UNSAFE_PATH:${redact(path)}`);
}

function findForbiddenKeys(value: unknown, segments: Array<string | number>, issues: string[]): void {
  if (Array.isArray(value)) { value.forEach((item, index) => findForbiddenKeys(item, [...segments, index], issues)); return; }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    const childSegments = [...segments, key];
    if (forbiddenKeys.has(key) && !isCanonicalSourceTypePath(childSegments)) issues.push(`MANAGEMENT_FIELD_FORBIDDEN:${formatPath(childSegments)}`);
    findForbiddenKeys(child, childSegments, issues);
  }
}

function isCanonicalSourceTypePath(segments: Array<string | number>): boolean {
  if (segments.at(-1) !== 'sourceType') return false;
  return (segments.length === 4 && segments[0] === 'findings' && typeof segments[1] === 'number' && segments[2] === 'data')
    || (segments.length === 3 && segments[0] === 'atomicEvidences' && typeof segments[1] === 'number');
}

function formatPath(segments: Array<string | number>): string {
  return `$${segments.map((segment) => typeof segment === 'number' ? `[${segment}]` : `.${segment}`).join('')}`;
}

function assertJsonSafe(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') { if (!Number.isFinite(value)) throw new Error('NON_FINITE_NUMBER'); return; }
  if (typeof value !== 'object' || Buffer.isBuffer(value)) throw new Error('NON_JSON_VALUE');
  if (seen.has(value)) throw new Error('CIRCULAR_VALUE'); seen.add(value);
  if (Array.isArray(value)) value.forEach((item) => assertJsonSafe(item, seen)); else Object.values(value).forEach((item) => assertJsonSafe(item, seen));
  seen.delete(value);
}

export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize((value as Record<string, unknown>)[key])]));
  return value;
}
export function canonicalJson(value: unknown): string { return JSON.stringify(canonicalize(value)); }
function sha(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function redact(value: string): string { return value.replace(/\/Users\/[^/]+/gu, '/Users/[REDACTED]').replace(/\/private\/tmp\/[^/]+/gu, '/private/tmp/[REDACTED]'); }
