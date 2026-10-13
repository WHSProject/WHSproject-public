import type { FileHandle } from 'node:fs/promises';
import {
  access,
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ArtifactFileManager,
  type ArtifactTempFile,
} from './artifact-file-manager';
import { ArtifactStorageError } from './artifact-storage.error';

describe('ArtifactFileManager', () => {
  let testDirectory: string;
  let scannerTempDirectory: string;
  let manager: ArtifactFileManager;

  beforeEach(async () => {
    testDirectory = await mkdtemp(join(tmpdir(), 'scanner-storage-'));
    scannerTempDirectory = join(testDirectory, 'scanner');
    manager = new ArtifactFileManager(scannerTempDirectory);
  });

  afterEach(async () => {
    await chmod(testDirectory, 0o700).catch(() => undefined);
    await rm(testDirectory, { recursive: true, force: true });
  });

  it('creates an exclusive owner-only .part file in an isolated directory', async () => {
    const tempFile = await manager.create('scan-1');

    expect(tempFile.partPath).toBe(
      join(scannerTempDirectory, 'scan-1', 'artifact.tgz.part'),
    );
    expect(tempFile.artifactPath).toBe(
      join(scannerTempDirectory, 'scan-1', 'artifact.tgz'),
    );
    expect((await stat(tempFile.scanDirectory)).mode & 0o777).toBe(0o700);
    expect((await stat(tempFile.partPath)).mode & 0o777).toBe(0o600);
    await expect(access(tempFile.artifactPath)).rejects.toBeDefined();

    await manager.cleanup(tempFile);
  });

  it('does not overwrite an existing .part file', async () => {
    const scanDirectory = join(scannerTempDirectory, 'existing');
    const partPath = join(scanDirectory, 'artifact.tgz.part');
    await mkdir(scanDirectory, { recursive: true });
    await writeFile(partPath, 'existing-data');

    await expect(manager.create('existing')).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
      stage: 'ARTIFACT_STORAGE',
      retryable: false,
    });
    await expect(readFile(partPath, 'utf8')).resolves.toBe('existing-data');
  });

  it.each(['../escape', '..', '.', 'nested/scan', 'nested\\scan', 'bad\0id'])(
    'rejects path escape scanId %j',
    async (scanId) => {
      await expect(manager.create(scanId)).rejects.toBeInstanceOf(
        ArtifactStorageError,
      );
    },
  );

  it('seals and atomically renames only an Integrity-verified Artifact', async () => {
    const tempFile = await manager.create('finalize');
    await tempFile.fileHandle.writeFile('artifact-bytes');

    await expect(
      manager.finalize(tempFile, { verified: true }),
    ).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
    await expect(access(tempFile.artifactPath)).rejects.toBeDefined();

    await manager.seal(tempFile);
    const result = await manager.finalize(tempFile, { verified: true });

    expect(result).toEqual({ artifactPath: tempFile.artifactPath });
    expect(Object.keys(result)).toEqual(['artifactPath']);
    await expect(readFile(result.artifactPath, 'utf8')).resolves.toBe(
      'artifact-bytes',
    );
    await expect(access(tempFile.partPath)).rejects.toBeDefined();
  });

  it('does not overwrite an existing finalized Artifact', async () => {
    const tempFile = await manager.create('existing-final');
    await tempFile.fileHandle.writeFile('new-data');
    await manager.seal(tempFile);
    await writeFile(tempFile.artifactPath, 'existing-data');

    await expect(
      manager.finalize(tempFile, { verified: true }),
    ).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
    await expect(readFile(tempFile.artifactPath, 'utf8')).resolves.toBe(
      'existing-data',
    );
    await manager.cleanup(tempFile);
  });

  it('cleans up a failed .part file', async () => {
    const tempFile = await manager.create('failed');
    await tempFile.fileHandle.writeFile('partial-data');

    await expect(manager.cleanup(tempFile)).resolves.toBeUndefined();
    await expect(access(tempFile.partPath)).rejects.toBeDefined();
  });

  it('safely cleans up when the .part file is already absent', async () => {
    const tempFile = await manager.create('already-absent');
    await tempFile.fileHandle.close();
    await rm(tempFile.partPath, { force: true });

    await expect(manager.cleanup(tempFile)).resolves.toBeUndefined();
  });

  it('removes the complete scan directory by scanId', async () => {
    const scanDirectory = join(scannerTempDirectory, 'scan-complete');
    await mkdir(join(scanDirectory, 'extracted', 'package'), {
      recursive: true,
    });
    await writeFile(join(scanDirectory, 'artifact.tgz'), 'artifact');
    await writeFile(
      join(scanDirectory, 'artifact.tgz.part'),
      'partial-artifact',
    );
    await writeFile(
      join(scanDirectory, 'extracted', 'package', 'package.json'),
      '{}',
    );

    await expect(
      manager.cleanupByScanId('scan-complete'),
    ).resolves.toBeUndefined();
    await expect(access(scanDirectory)).rejects.toBeDefined();
  });

  it('does not remove another scanId directory', async () => {
    const targetDirectory = join(scannerTempDirectory, 'target');
    const otherDirectory = join(scannerTempDirectory, 'other');
    await mkdir(join(targetDirectory, 'extracted'), { recursive: true });
    await mkdir(otherDirectory, { recursive: true });
    await writeFile(join(targetDirectory, 'artifact.tgz'), 'target');
    await writeFile(join(otherDirectory, 'artifact.tgz'), 'other');

    await expect(manager.cleanupByScanId('target')).resolves.toBeUndefined();
    await expect(access(targetDirectory)).rejects.toBeDefined();
    await expect(
      readFile(join(otherDirectory, 'artifact.tgz'), 'utf8'),
    ).resolves.toBe('other');
  });

  it('succeeds when the scanId directory does not exist', async () => {
    await expect(manager.cleanupByScanId('missing')).resolves.toBeUndefined();
  });

  it.each([
    '..',
    '../escape',
    'nested/scan',
    'nested\\scan',
  ])('rejects unsafe cleanup scanId %j', async (scanId) => {
    await expect(manager.cleanupByScanId(scanId)).rejects.toBeInstanceOf(
      ArtifactStorageError,
    );
  });

  it('rejects an absolute cleanup scanId', async () => {
    await expect(
      manager.cleanupByScanId(scannerTempDirectory),
    ).rejects.toBeInstanceOf(ArtifactStorageError);
  });

  it('rejects a cleanup scanId outside the scanner temp directory', async () => {
    await expect(
      manager.cleanupByScanId(join(scannerTempDirectory, '..', 'outside')),
    ).rejects.toBeInstanceOf(ArtifactStorageError);
  });

  it('does not remove a directory outside the scanner temp directory', async () => {
    const outsideDirectory = join(testDirectory, 'outside');
    const outsideFile = join(outsideDirectory, 'keep.txt');
    await mkdir(outsideDirectory, { recursive: true });
    await writeFile(outsideFile, 'keep');

    await expect(
      manager.cleanupByScanId(outsideDirectory),
    ).rejects.toBeInstanceOf(ArtifactStorageError);
    await expect(readFile(outsideFile, 'utf8')).resolves.toBe('keep');
  });

  it('returns a cleanup error instead of replacing the original failure', async () => {
    const originalError = new Error('original download failure');
    const closeError = new Error('close failure');
    const tempFile: ArtifactTempFile = {
      artifactPath: join(testDirectory, 'artifact.tgz'),
      fileHandle: {
        close: jest.fn().mockRejectedValue(closeError),
      } as unknown as FileHandle,
      partPath: join(testDirectory, 'missing', 'artifact.tgz.part'),
      scanDirectory: join(testDirectory, 'missing'),
    };

    const cleanupError = await manager.cleanup(tempFile);

    expect(cleanupError).toBeInstanceOf(ArtifactStorageError);
    expect(originalError.message).toBe('original download failure');
  });
});
