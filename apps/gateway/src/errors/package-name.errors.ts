// 요청된 Package Name이 npm Package Name 규칙을 만족하지 않음
export class InvalidPackageNameError extends Error {
  constructor(public readonly reason: string) {
    super(`invalid npm package name: ${reason}`);
    this.name = 'InvalidPackageNameError';
  }
}
