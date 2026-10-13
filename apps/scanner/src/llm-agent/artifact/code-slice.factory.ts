import { createHash } from 'node:crypto';
import { readSafeCodeFile, SafeCodeFileError } from '../safe-code-reader';
import type { AgentCodeSlice, ArtifactDescriptor, ArtifactResolver } from './artifact.contract';
import type { CodeSliceRegistry } from './code-slice.registry';
import { mapDerivedLineRange, mappingForPath } from '../../analyzers/obfuscation/line-mapping';

/**
 * Shared slice creation used by the Plan-based Slice Builder (INITIAL) and the
 * runtime GET_FILE_RANGE tool (RUNTIME). Neither caller reads files or builds
 * slices on its own, so hashing and safety rules stay identical for both.
 */

export type ArtifactReadFailure = 'ARTIFACT_NOT_FOUND' | 'FILE_UNAVAILABLE' | 'FILE_REJECTED';

/** Carries only a reason code; underlying messages may contain absolute paths. */
export class ArtifactReadError extends Error {
  constructor(readonly reason: ArtifactReadFailure, readonly detail?: { kind: 'TOO_LARGE' | 'BINARY'; sizeBytes?: number }) {
    super(`Artifact code read failed: ${reason}`);
  }
}

export interface ArtifactSource {
  artifact: ArtifactDescriptor;
  filePath: string;
  lines: string[];
  lineCount: number;
}

export const sha256Hex = (value: string): string => createHash('sha256').update(value).digest('hex');

/** Reads one package-relative file of an artifact through the safe reader. */
export async function readArtifactSource(
  resolver: ArtifactResolver, artifactId: string, filePath: string, maxFileSizeBytes: number, signal?: AbortSignal,
): Promise<ArtifactSource> {
  const artifact = resolver.describe(artifactId);
  if (!artifact) throw new ArtifactReadError('ARTIFACT_NOT_FOUND');
  let root: string;
  try {
    root = await resolver.resolveRoot(artifactId, signal);
  } catch {
    signal?.throwIfAborted();
    throw new ArtifactReadError('ARTIFACT_NOT_FOUND');
  }
  try {
    const file = await readSafeCodeFile(root, filePath, maxFileSizeBytes, signal);
    // A trailing newline yields a final empty element that is not a source line.
    const lineCount = file.lines.length > 0 && file.lines[file.lines.length - 1] === '' ? file.lines.length - 1 : file.lines.length;
    return { artifact, filePath: file.file, lines: file.lines, lineCount };
  } catch (error) {
    signal?.throwIfAborted();
    const code = (error as { code?: unknown }).code;
    throw new ArtifactReadError(code === 'ENOENT' || code === 'ENOTDIR' ? 'FILE_UNAVAILABLE' : 'FILE_REJECTED',
      error instanceof SafeCodeFileError ? { kind: error.kind, sizeBytes: error.sizeBytes } : undefined);
  }
}

export interface CodeSliceProvenance {
  sliceId: string;
  origin: AgentCodeSlice['origin'];
  boundaryConfidence: AgentCodeSlice['boundaryConfidence'];
  planningTargetId: string | null;
  additionalCodeRequestId: string | null;
  agentRequestId: string | null;
  selectionReason: string;
  relatedFindingIds: string[];
  relatedEvidenceIds: string[];
}

/**
 * Creates a slice for an already-validated range of `source` and registers it.
 * `sourceSha256` hashes the raw selected lines; `contentSha256` hashes the
 * content handed to the Agent. No redaction is applied (only public npm packages
 * are analyzed), so both hashes are equal and contentRedacted is always false.
 */
export function registerCodeSlice(
  registry: CodeSliceRegistry, source: ArtifactSource, range: { startLine: number; endLine: number }, provenance: CodeSliceProvenance,
): AgentCodeSlice {
  if (range.startLine < 1 || range.endLine < range.startLine || range.endLine > source.lineCount) {
    throw new Error(`Slice ${provenance.sliceId} range is outside the source file`);
  }
  const raw = source.lines.slice(range.startLine - 1, range.endLine).join('\n');
  const content = raw;
  const mapping = mappingForPath(source.artifact.lineMappings, source.filePath);
  const lineage = source.artifact.representation === 'ORIGINAL'
    ? { lineageStatus: 'DIRECT' as const, derivedFrom: undefined }
    : mapDerivedLineRange(mapping, mapping?.sourcePath ?? source.filePath, range.startLine, range.endLine);
  const slice: AgentCodeSlice = {
    sliceId: provenance.sliceId,
    artifactId: source.artifact.artifactId,
    filePath: source.filePath,
    startLine: range.startLine,
    endLine: range.endLine,
    content,
    contentSha256: sha256Hex(content),
    sourceSha256: sha256Hex(raw),
    origin: provenance.origin,
    boundaryConfidence: provenance.boundaryConfidence,
    planningTargetId: provenance.planningTargetId,
    additionalCodeRequestId: provenance.additionalCodeRequestId,
    agentRequestId: provenance.agentRequestId,
    contentRedacted: false,
    redactionTypes: [],
    selectionReason: provenance.selectionReason,
    relatedFindingIds: [...provenance.relatedFindingIds],
    relatedEvidenceIds: [...provenance.relatedEvidenceIds],
    lineageStatus: lineage.lineageStatus,
    ...(source.artifact.representation === 'ORIGINAL' || lineage.derivedFrom === undefined ? {} : { derivedFrom: {
      file: lineage.derivedFrom.path,
      ...(lineage.derivedFrom.startLine === undefined ? {} : { startLine: lineage.derivedFrom.startLine }),
      ...(lineage.derivedFrom.endLine === undefined ? {} : { endLine: lineage.derivedFrom.endLine }),
    } }),
  };
  registry.register(slice);
  // Hand back the registry's frozen copy so callers cannot drift from what was registered.
  return registry.get(slice.sliceId) ?? slice;
}
