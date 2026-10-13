import { createHash } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export interface ValidatedLocalArtifactBoundary {
  allowedArtifactRoot: string;
  packageRoot: string;
  relativePackageRoot: string;
  allowedRootId: string;
}

export class LocalArtifactBoundaryError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'LocalArtifactBoundaryError';
  }
}

export async function validateLocalArtifactBoundary(
  packageRoot: string,
  allowedArtifactRoot: string,
  forbiddenRoots: readonly string[],
): Promise<ValidatedLocalArtifactBoundary> {
  rejectRawPath(packageRoot);
  rejectRawPath(allowedArtifactRoot);
  rejectUnresolved(packageRoot);
  rejectUnresolved(allowedArtifactRoot);
  const canonicalAllowed = await canonicalDirectory(allowedArtifactRoot, 'ALLOWED_ROOT_INVALID');
  const canonicalPackage = await canonicalDirectory(packageRoot, 'PACKAGE_ROOT_INVALID');
  const broadRoots = ['/', homedir(), ...forbiddenRoots];
  for (const candidate of broadRoots) {
    let canonical: string;
    try { canonical = await realpath(candidate); } catch { continue; }
    if (canonicalAllowed === canonical) {
      throw new LocalArtifactBoundaryError('ALLOWED_ROOT_TOO_BROAD', 'Allowed artifact root is too broad');
    }
  }
  const relativePath = relative(canonicalAllowed, canonicalPackage);
  if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new LocalArtifactBoundaryError('PACKAGE_ROOT_ESCAPE', 'Package root is outside the allowed artifact root');
  }
  return {
    allowedArtifactRoot: canonicalAllowed,
    packageRoot: canonicalPackage,
    relativePackageRoot: relativePath === '' ? '.' : relativePath.split(sep).join('/'),
    allowedRootId: createHash('sha256').update(canonicalAllowed).digest('hex').slice(0, 16),
  };
}

async function canonicalDirectory(value: string, code: string): Promise<string> {
  try {
    const canonical = await realpath(resolve(value));
    if (!(await stat(canonical)).isDirectory()) throw new Error('not a directory');
    return canonical;
  } catch {
    throw new LocalArtifactBoundaryError(code, 'Artifact boundary path must be an existing directory');
  }
}

function rejectUnresolved(value: string): void {
  if (value.includes('\0') || /\$(?:\{|[A-Za-z_])|%[A-Za-z_][A-Za-z0-9_]*%/u.test(value)) {
    throw new LocalArtifactBoundaryError('UNRESOLVED_PATH', 'Artifact boundary contains an unresolved variable');
  }
}

function rejectRawPath(value: string): void {
  if (!isAbsolute(value)) {
    throw new LocalArtifactBoundaryError('ABSOLUTE_PATH_REQUIRED', 'Artifact boundary must be absolute');
  }
  if (value.split(/[\\/]/u).includes('..')) {
    throw new LocalArtifactBoundaryError('PATH_TRAVERSAL', 'Artifact boundary must not contain parent traversal');
  }
}
