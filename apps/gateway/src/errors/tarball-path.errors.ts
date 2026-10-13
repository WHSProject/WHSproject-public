// tarball 요청 경로가 규칙을 만족하지 않음
export class InvalidTarballPathError extends Error {
  constructor(public readonly reason: string) {
    super(`invalid tarball path: ${reason}`);
    this.name = 'InvalidTarballPathError';
  }
}
