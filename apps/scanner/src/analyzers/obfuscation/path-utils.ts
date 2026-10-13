/** Canonical path used for package-relative evidence identity comparisons. */
export function canonicalizeEvidencePath(path: string): string {
  return path
    .replace(/[\\/]+/gu, '/')
    .replace(/^(?:\.\/)+/u, '');
}
