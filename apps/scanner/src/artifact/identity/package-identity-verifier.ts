import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { PackageIdentity } from '../../domain/analysis.types';
import { ArtifactProcessingError } from '../artifact.types';

export class PackageIdentityVerifier {
  async verify(
    extractedPath: string,
    expected: PackageIdentity,
  ): Promise<Record<string, unknown>> {
    return this.verifyPackageRoot(join(extractedPath, 'package'), expected);
  }

  /** Verifies an already-extracted package without changing the production extraction layout. */
  async verifyPackageRoot(
    packageRoot: string,
    expected: PackageIdentity,
  ): Promise<Record<string, unknown>> {
    try {
      const packageJsonPath = join(packageRoot, 'package.json');
      const value: unknown = JSON.parse(await readFile(packageJsonPath, 'utf8'));

      if (!this.isRecord(value) ||
        value.name !== expected.name || value.version !== expected.version) {
        throw this.identityError('Package identity does not match the requested package');
      }

      return value;
    } catch (error) {
      if (error instanceof ArtifactProcessingError) throw error;
      throw this.identityError(error instanceof Error ? error.message : 'Unable to read package.json');
    }
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  private identityError(message: string): ArtifactProcessingError {
    return new ArtifactProcessingError('IDENTITY_MISMATCH', 'IDENTITY', message);
  }
}
