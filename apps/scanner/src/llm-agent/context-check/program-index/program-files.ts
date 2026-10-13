import { readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type { ArtifactResolver } from '../../artifact/artifact.contract';
import { ArtifactReadError, readArtifactSource } from '../../artifact/code-slice.factory';
import { PROGRAM_FILE_EXTENSIONS, type FileExclusionReason, type FileRef, type ProgramIndexLimits } from './program-index.contract';

export interface CollectedFile extends FileRef { code: string; bytes: number; lineCount: number }

export interface FileCollection {
  files: CollectedFile[];
  candidateFileCount: number;
  excluded: Array<FileRef & { reason: FileExclusionReason }>;
  totalSourceBytes: number;
  appliedLimits: string[];
  limitations: string[];
  timing: { artifactDiscoveryMs: number; sourceReadMs: number };
}

export interface FileCollectionOptions {
  /**
   * Package-relative paths to read first (the files that hold Findings, the
   * files a lifecycle script or entry point names), with or without their
   * extension. When a limit stops the collection, these are the files it has.
   */
  priorityPaths?: readonly string[];
  /** `Date.now()` after which no further file is read. */
  deadline?: number;
  signal?: AbortSignal;
}

const SUPPORTED = new Set<string>(PROGRAM_FILE_EXTENSIONS);
const SKIPPED_DIRECTORIES = new Set(['node_modules', '.git']);
/** TypeScript declaration files describe types only; they hold no code that runs. */
const DECLARATION_FILE = /\.d\.[cm]?ts$/iu;
const READ_CONCURRENCY = 16;

/**
 * Package-relative paths of the supported source files under an artifact root,
 * in a stable order. Symbolic links are never followed and `node_modules` is
 * never entered; a directory that cannot be listed is skipped. Only names are
 * read here: file contents go through the safe reader.
 */
async function listSourcePaths(root: string, signal?: AbortSignal): Promise<string[]> {
  const found: string[] = [];
  const walk = async (directory: string, prefix: string): Promise<void> => {
    signal?.throwIfAborted();
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))) {
      if (entry.isSymbolicLink()) continue;
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) await walk(join(directory, entry.name), relative);
      } else if (entry.isFile() && SUPPORTED.has(extname(entry.name).toLowerCase()) && !DECLARATION_FILE.test(entry.name)) found.push(relative);
    }
  };
  await walk(root, '');
  return found;
}

/** Whether `filePath` is what a priority path names: the path itself, with an extension added, or as a directory index. */
function isPriority(filePath: string, priorityPaths: readonly string[]): boolean {
  return priorityPaths.some((raw) => {
    const path = raw.replace(/^\.\//u, '').replace(/\/+$/u, '');
    return path !== '' && (filePath === path || filePath.startsWith(`${path}.`) || filePath.startsWith(`${path}/index.`));
  });
}

/**
 * Reads every supported source file of the given artifacts once. A file that
 * the safe reader rejects (a link, a binary, an oversized or unreadable file)
 * and a file beyond the file, byte or time limit is left out and recorded with
 * its reason. Nothing outside an artifact root is ever opened.
 */
export async function collectProgramFiles(
  resolver: ArtifactResolver, artifactIds: readonly string[], limits: ProgramIndexLimits, options: FileCollectionOptions = {},
): Promise<FileCollection> {
  const { signal } = options;
  const collection: FileCollection = {
    files: [], candidateFileCount: 0, excluded: [], totalSourceBytes: 0, appliedLimits: [], limitations: [],
    timing: { artifactDiscoveryMs: 0, sourceReadMs: 0 },
  };
  const limit = (name: string) => { if (!collection.appliedLimits.includes(name)) collection.appliedLimits.push(name); };
  const exclude = (ref: FileRef, reason: FileExclusionReason) => { collection.excluded.push({ ...ref, reason }); };

  const discoveryStarted = performance.now();
  const candidates: FileRef[] = [];
  for (const artifactId of artifactIds) {
    signal?.throwIfAborted();
    let root: string;
    try {
      root = await resolver.resolveRoot(artifactId, signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      collection.limitations.push('ARTIFACT_ROOT_UNAVAILABLE');
      continue;
    }
    for (const filePath of await listSourcePaths(root, signal)) candidates.push({ artifactId, filePath });
  }
  collection.timing.artifactDiscoveryMs = performance.now() - discoveryStarted;
  collection.candidateFileCount = candidates.length;
  const priority = options.priorityPaths ?? [];
  const ordered = [...candidates.filter((file) => isPriority(file.filePath, priority)), ...candidates.filter((file) => !isPriority(file.filePath, priority))];

  const readStarted = performance.now();
  for (let start = 0; start < ordered.length; start += READ_CONCURRENCY) {
    signal?.throwIfAborted();
    const batch = ordered.slice(start, start + READ_CONCURRENCY);
    if (options.deadline !== undefined && Date.now() > options.deadline) {
      limit('TIMEOUT');
      for (const file of ordered.slice(start)) exclude(file, 'TIMEOUT');
      break;
    }
    if (collection.files.length >= limits.maxFiles) {
      limit('FILE_LIMIT');
      for (const file of ordered.slice(start)) exclude(file, 'FILE_LIMIT');
      break;
    }
    const sources = await Promise.all(batch.map(async (file) => {
      try {
        return await readArtifactSource(resolver, file.artifactId, file.filePath, limits.maxFileSizeBytes, signal);
      } catch (error) {
        if (!(error instanceof ArtifactReadError)) throw error;
        return error;
      }
    }));
    for (const [position, source] of sources.entries()) {
      const file = batch[position]!;
      if (source instanceof ArtifactReadError) { exclude(file, source.reason === 'FILE_UNAVAILABLE' ? 'FILE_UNAVAILABLE' : 'FILE_REJECTED'); continue; }
      if (collection.files.length >= limits.maxFiles) { limit('FILE_LIMIT'); exclude(file, 'FILE_LIMIT'); continue; }
      const code = source.lines.slice(0, source.lineCount).join('\n');
      const bytes = Buffer.byteLength(code, 'utf8');
      if (collection.totalSourceBytes + bytes > limits.maxTotalSourceBytes) { limit('TOTAL_BYTES_LIMIT'); exclude(file, 'TOTAL_BYTES_LIMIT'); continue; }
      collection.files.push({ artifactId: file.artifactId, filePath: source.filePath, code, bytes, lineCount: source.lineCount });
      collection.totalSourceBytes += bytes;
    }
  }
  collection.timing.sourceReadMs = performance.now() - readStarted;
  return collection;
}
