import { posix } from 'node:path';
import type { ArtifactResolver } from '../../artifact/artifact.contract';
import { ArtifactReadError, readArtifactSource } from '../../artifact/code-slice.factory';
import { PROGRAM_FILE_EXTENSIONS, fileKey, type FileRef, type ModuleEdge } from './program-index.contract';

export type SpecifierResolution =
  | { resolution: 'RESOLVED'; to: FileRef }
  | { resolution: 'EXTERNAL' }
  | { resolution: 'UNRESOLVED'; reason: NonNullable<ModuleEdge['unresolvedReason']> };

export interface ModuleResolver {
  /** Resolves a static specifier written in `from`. `mode` picks between a package.json's CommonJS and ESM targets. */
  resolve(from: FileRef, specifier: string, mode: 'require' | 'import'): Promise<SpecifierResolution>;
  /** Resolves a package-relative path (a lifecycle script file, an entry point) in the artifact or the one it was restored from. */
  resolvePath(artifactId: string, path: string): Promise<FileRef | undefined>;
  /** The artifact itself, then the ORIGINAL it was restored from: a restored artifact holds restored files only. */
  lookupArtifacts(artifactId: string): string[];
  /** The parsed package.json of a directory of the artifact, or undefined. */
  manifest(artifactId: string, directory: string): Promise<unknown>;
}

const TS_FOR_JS: Record<string, readonly string[]> = { '.js': ['.ts', '.tsx'], '.jsx': ['.tsx'], '.mjs': [], '.cjs': [] };
const isRelative = (specifier: string): boolean => specifier === '.' || specifier === '..' || specifier.startsWith('./') || specifier.startsWith('../');

/** The file a package.json names as what the directory resolves to: `exports` (its `.` entry), then `main` or `module`. */
function manifestTargets(manifest: unknown, mode: 'require' | 'import'): string[] {
  if (typeof manifest !== 'object' || manifest === null) return [];
  const record = manifest as Record<string, unknown>;
  const conditions = mode === 'require' ? ['require', 'node', 'default', 'import'] : ['import', 'node', 'default', 'require'];
  const pick = (value: unknown, depth: number): string | undefined => {
    if (typeof value === 'string') return value;
    if (typeof value !== 'object' || value === null || Array.isArray(value) || depth > 4) return undefined;
    const entries = value as Record<string, unknown>;
    if ('.' in entries) return pick(entries['.'], depth + 1);
    for (const condition of conditions) {
      const found = condition in entries ? pick(entries[condition], depth + 1) : undefined;
      if (found !== undefined) return found;
    }
    return undefined;
  };
  const fields = mode === 'require' ? ['main', 'module'] : ['module', 'main'];
  return [pick(record.exports, 0), ...fields.map((field) => (typeof record[field] === 'string' ? record[field] as string : undefined))]
    .filter((value): value is string => value !== undefined && value.trim() !== '');
}

/**
 * Static module resolution inside the artifacts: an explicit or omitted
 * extension, a directory's `index.*`, and a nested package.json's `exports`,
 * `main` or `module`. Anything that is not a relative path is an external
 * dependency and is not followed. A path that leaves the artifact, or that
 * names no source file the index holds, is unresolved rather than guessed.
 */
export function createModuleResolver(
  resolver: ArtifactResolver, knownFiles: ReadonlySet<string>, parsedFiles: ReadonlySet<string>, maxFileSizeBytes: number, signal?: AbortSignal,
): ModuleResolver {
  const manifests = new Map<string, unknown>();
  const manifestOf = async (artifactId: string, directory: string): Promise<unknown> => {
    const filePath = directory === '' ? 'package.json' : `${directory}/package.json`;
    const key = fileKey({ artifactId, filePath });
    if (manifests.has(key)) return manifests.get(key);
    let manifest: unknown;
    try {
      const source = await readArtifactSource(resolver, artifactId, filePath, maxFileSizeBytes, signal);
      manifest = JSON.parse(source.lines.join('\n'));
    } catch (error) {
      if (!(error instanceof ArtifactReadError) && !(error instanceof SyntaxError)) throw error;
    }
    manifests.set(key, manifest);
    return manifest;
  };
  const lookupArtifacts = (artifactId: string): string[] => {
    const original = resolver.describe(artifactId)?.derivedFromArtifactId;
    return original === undefined || original === artifactId ? [artifactId] : [artifactId, original];
  };
  const known = (artifactId: string, filePath: string): boolean => knownFiles.has(fileKey({ artifactId, filePath }));
  const asFile = (artifactId: string, base: string): string | undefined => {
    if (base === '') return undefined;
    if (known(artifactId, base)) return base;
    for (const extension of PROGRAM_FILE_EXTENSIONS) if (known(artifactId, `${base}${extension}`)) return `${base}${extension}`;
    // TypeScript sources import their siblings under the emitted `.js` name.
    const extension = posix.extname(base);
    for (const alternative of TS_FOR_JS[extension] ?? []) {
      const candidate = `${base.slice(0, -extension.length)}${alternative}`;
      if (known(artifactId, candidate)) return candidate;
    }
    return undefined;
  };
  const asDirectory = async (artifactId: string, base: string, mode: 'require' | 'import'): Promise<string | undefined> => {
    for (const target of manifestTargets(await manifestOf(artifactId, base), mode)) {
      const joined = posix.normalize(posix.join(base, target)).replace(/\/+$/u, '');
      if (joined === '..' || joined.startsWith('../') || posix.isAbsolute(joined)) continue;
      const file = asFile(artifactId, joined === '.' ? '' : joined) ?? indexOf(artifactId, joined === '.' ? '' : joined);
      if (file !== undefined) return file;
    }
    return indexOf(artifactId, base);
  };
  const indexOf = (artifactId: string, base: string): string | undefined => {
    for (const extension of PROGRAM_FILE_EXTENSIONS) {
      const candidate = base === '' ? `index${extension}` : `${base}/index${extension}`;
      if (known(artifactId, candidate)) return candidate;
    }
    return undefined;
  };
  const locate = async (artifactId: string, base: string, mode: 'require' | 'import'): Promise<FileRef | undefined> => {
    for (const candidate of lookupArtifacts(artifactId)) {
      const filePath = asFile(candidate, base) ?? await asDirectory(candidate, base, mode);
      if (filePath !== undefined) return { artifactId: candidate, filePath };
    }
    return undefined;
  };
  const normalized = (path: string): string | undefined => {
    const base = posix.normalize(path).replace(/\/+$/u, '');
    if (base === '..' || base.startsWith('../') || posix.isAbsolute(base) || base.includes('\\')) return undefined;
    return base === '.' ? '' : base;
  };

  return {
    lookupArtifacts,
    manifest: manifestOf,
    async resolvePath(artifactId, path) {
      const base = normalized(path);
      return base === undefined ? undefined : locate(artifactId, base, 'require');
    },
    async resolve(from, specifier, mode) {
      if (!isRelative(specifier)) return { resolution: 'EXTERNAL' };
      const base = normalized(posix.join(posix.dirname(from.filePath), specifier));
      if (base === undefined) return { resolution: 'UNRESOLVED', reason: 'OUTSIDE_ARTIFACT' };
      const to = await locate(from.artifactId, base, mode);
      if (!to) {
        // A data file (`./config.json`, a native addon) is not code the index reads.
        const extension = posix.extname(base).toLowerCase();
        const dataFile = extension !== '' && !(PROGRAM_FILE_EXTENSIONS as readonly string[]).includes(extension);
        return dataFile ? { resolution: 'EXTERNAL' } : { resolution: 'UNRESOLVED', reason: 'TARGET_NOT_FOUND' };
      }
      return parsedFiles.has(fileKey(to)) ? { resolution: 'RESOLVED', to } : { resolution: 'UNRESOLVED', reason: 'TARGET_NOT_PARSED' };
    },
  };
}
