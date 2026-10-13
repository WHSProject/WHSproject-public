import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { ArtifactHasher } from './artifact-hasher';

describe('ArtifactHasher.hashDirectory', () => {
  const hasher = new ArtifactHasher();

  it('is independent of the absolute root and filesystem entry order', async () => {
    const first = await mkdtemp(join(tmpdir(), 'scanner-hash-'));
    const second = await mkdtemp(join(tmpdir(), 'scanner-hash-'));
    try {
      await Promise.all([
        fs.mkdir(join(first, 'nested')),
        fs.mkdir(join(second, 'nested')),
      ]);
      await Promise.all([
        fs.writeFile(join(first, 'z.js'), 'z'),
        fs.writeFile(join(first, 'nested', 'a.js'), 'a'),
        fs.writeFile(join(second, 'nested', 'a.js'), 'a'),
        fs.writeFile(join(second, 'z.js'), 'z'),
      ]);

      await expect(hasher.hashDirectory(first)).resolves.toBe(await hasher.hashDirectory(second));
    } finally {
      await Promise.all([
        fs.rm(first, { recursive: true, force: true }),
        fs.rm(second, { recursive: true, force: true }),
      ]);
    }
  });

  it('changes when a relative path or file content changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scanner-hash-'));
    try {
      await fs.writeFile(join(root, 'a.js'), 'same');
      const original = await hasher.hashDirectory(root);
      await fs.rename(join(root, 'a.js'), join(root, 'b.js'));
      const changedPath = await hasher.hashDirectory(root);
      expect(changedPath).not.toBe(original);

      await fs.writeFile(join(root, 'b.js'), 'changed');
      await expect(hasher.hashDirectory(root)).resolves.not.toBe(changedPath);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
