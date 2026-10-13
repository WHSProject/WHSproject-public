import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import { relative, sep } from 'node:path';

import { ArtifactProcessingError } from '../artifact.types';

export class ArtifactHasher {
  async hash(artifactPath: string): Promise<string> {
    const hash = createHash('sha256');

    try {
      for await (const chunk of createReadStream(artifactPath)) hash.update(chunk);
      return hash.digest('hex');
    } catch (error) {
      throw new ArtifactProcessingError(
        'INTERNAL_ERROR',
        'HASH',
        error instanceof Error ? error.message : 'Unable to hash artifact',
      );
    }
  }

  /**
   * Hashes a directory by sorted package-relative paths and file bytes.
   * Absolute roots are deliberately excluded so equivalent restored trees
   * have the same identity across scans and machines.
   */
  async hashDirectory(root: string): Promise<string> {
    const hash = createHash('sha256');

    try {
      const files: string[] = [];
      const visit = async (directory: string): Promise<void> => {
        const entries = await fs.readdir(directory, { withFileTypes: true });
        for (const entry of entries) {
          const path = `${directory}/${entry.name}`;
          if (entry.isDirectory()) await visit(path);
          else if (entry.isFile()) files.push(path);
        }
      };
      await visit(root);

      files.sort((left, right) => {
        const leftRelative = relative(root, left).split(sep).join('/');
        const rightRelative = relative(root, right).split(sep).join('/');
        return leftRelative < rightRelative ? -1 : leftRelative > rightRelative ? 1 : 0;
      });

      for (const file of files) {
        const relativePath = relative(root, file).split(sep).join('/');
        hash.update(relativePath, 'utf8');
        hash.update('\0', 'utf8');
        hash.update(await fs.readFile(file));
        hash.update('\0', 'utf8');
      }
      return hash.digest('hex');
    } catch (error) {
      throw new ArtifactProcessingError(
        'INTERNAL_ERROR',
        'HASH',
        error instanceof Error ? error.message : 'Unable to hash artifact directory',
      );
    }
  }
}
