// Verdaccio 중계 실패 (네트워크 오류, Timeout)
export class VerdaccioForwardError extends Error {
  constructor(path: string, cause?: unknown) {
    super(`failed to forward request to verdaccio: ${path}`, { cause });
    this.name = 'VerdaccioForwardError';
  }
}
