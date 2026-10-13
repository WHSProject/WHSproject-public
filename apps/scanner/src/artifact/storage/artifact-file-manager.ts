import type { FileHandle } from 'node:fs/promises';
import {
  chmod,
  lstat,
  mkdir,
  open,
  rename,
  rm,
  rmdir,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import type { IntegrityResult } from '../artifact.types';
import { ArtifactStorageError } from './artifact-storage.error';

export interface ArtifactTempFile {
  readonly artifactPath: string;
  readonly fileHandle: FileHandle;
  readonly partPath: string;
  readonly scanDirectory: string;
}

export interface FinalizedArtifactFile {
  artifactPath: string;
}

export class ArtifactFileManager {
  private readonly sealedFiles = new WeakSet<ArtifactTempFile>();

  constructor(
    private readonly tempDirectory =
      process.env.SCANNER_TEMP_DIR ?? join(tmpdir(), 'scanner'),
  ) {}

  async create(scanId: string): Promise<ArtifactTempFile> {
    const paths = this.resolvePaths(scanId);
    let createdScanDirectory = false;
    let fileHandle: FileHandle | undefined;

    try {
      await mkdir(this.tempDirectory, { recursive: true, mode: 0o700 });
      await mkdir(paths.scanDirectory, { mode: 0o700 });
      createdScanDirectory = true;
      await chmod(paths.scanDirectory, 0o700);
      fileHandle = await open(paths.partPath, 'wx', 0o600);
      await fileHandle.chmod(0o600);

      return Object.freeze({ ...paths, fileHandle });
    } catch (error) {
      await fileHandle?.close().catch(() => undefined);
      if (createdScanDirectory) {
        await rm(paths.partPath, { force: true }).catch(() => undefined);
        await rmdir(paths.scanDirectory).catch(() => undefined);
      }
      throw storageError(error, 'Unable to create Artifact temporary file');
    }
  }

  async seal(tempFile: ArtifactTempFile): Promise<void> {
    try {
      await tempFile.fileHandle.sync();
      await tempFile.fileHandle.close();
      this.sealedFiles.add(tempFile);
    } catch (error) {
      throw storageError(error, 'Unable to seal Artifact temporary file');
    }
  }

  async finalize(
    tempFile: ArtifactTempFile,
    integrity: Pick<IntegrityResult, 'verified'>,
  ): Promise<FinalizedArtifactFile> {
    if (!this.sealedFiles.has(tempFile) || integrity.verified !== true) {
      throw new ArtifactStorageError(
        'Artifact must be sealed and Integrity-verified before finalization',
      );
    }

    try {
      await assertPathDoesNotExist(tempFile.artifactPath);
      await rename(tempFile.partPath, tempFile.artifactPath);
      this.sealedFiles.delete(tempFile);
      return { artifactPath: tempFile.artifactPath };
    } catch (error) {
      throw storageError(error, 'Unable to finalize Artifact file');
    }
  }

  /** Never rejects; callers keep the primary failure and may log the returned error. */
  async cleanup(
    tempFile: ArtifactTempFile,
  ): Promise<ArtifactStorageError | undefined> {
    let cleanupError: ArtifactStorageError | undefined;

    try {
      await tempFile.fileHandle.close();
    } catch (error) {
      cleanupError = storageError(
        error,
        'Unable to close Artifact temporary file',
      );
    }

    try {
      await rm(tempFile.partPath, { force: true });
    } catch (error) {
      cleanupError ??= storageError(
        error,
        'Unable to remove Artifact temporary file',
      );
    }

    try {
      await rmdir(tempFile.scanDirectory);
    } catch (error) {
      if (!hasErrorCode(error, 'ENOENT') && !hasErrorCode(error, 'ENOTEMPTY')) {
        cleanupError ??= storageError(
          error,
          'Unable to remove Artifact temporary directory',
        );
      }
    }

    return cleanupError;
  }

  /** Filesystem cleanup errors are returned; invalid scanIds are rejected. */
  async cleanupByScanId(
    scanId: string,
  ): Promise<ArtifactStorageError | undefined> {
    const { scanDirectory } = this.resolvePaths(scanId);

    try {
      await rm(scanDirectory, { recursive: true, force: true });
      return undefined;
    } catch (error) {
      return storageError(error, 'Unable to remove Artifact scan directory');
    }
  }

  private resolvePaths(scanId: string): Omit<ArtifactTempFile, 'fileHandle'> {
    validateScanId(scanId);

    const root = resolve(this.tempDirectory);
    const scanDirectory = resolve(root, scanId);
    if (dirname(scanDirectory) !== root) {
      throw new ArtifactStorageError(
        'scanId resolves outside the temporary directory',
      );
    }

    return {
      artifactPath: join(scanDirectory, 'artifact.tgz'),
      partPath: join(scanDirectory, 'artifact.tgz.part'),
      scanDirectory,
    };
  }
}

function validateScanId(scanId: string): void {
  if (
    scanId.length === 0 ||
    scanId === '.' ||
    scanId === '..' ||
    scanId.includes('/') ||
    scanId.includes('\\') ||
    scanId.includes('\0')
  ) {
    throw new ArtifactStorageError('scanId must be a safe path segment');
  }
}

async function assertPathDoesNotExist(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return;
    }
    throw error;
  }

  throw new ArtifactStorageError('Artifact file already exists');
}

function storageError(error: unknown, fallback: string): ArtifactStorageError {
  return error instanceof ArtifactStorageError
    ? error
    : new ArtifactStorageError(fallback);
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
  );
}
