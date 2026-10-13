// Arborist 의존성 트리 구성 실패
export class DependencyTreeBuildError extends Error {
  constructor(spec: string, cause?: unknown) {
    super(`failed to build dependency tree for "${spec}"`, { cause });
    this.name = 'DependencyTreeBuildError';
  }
}

// 요청한 Package가 구성된 트리에 존재하지 않음
export class DependencyTreeRootMissingError extends Error {
  constructor(spec: string) {
    super(`requested package "${spec}" was not found in the dependency tree`);
    this.name = 'DependencyTreeRootMissingError';
  }
}

// Dependency Tree의 Package에 Policy/Decision 식별에 필요한 integrity가 없음.
// 오래된 npm Package 등에서 발생할 수 있으며 Security REJECT가 아니라
// 현재 MVP Contract에서 지원할 수 없는 Artifact 입력으로 처리한다.
export class DependencyTreeIntegrityMissingError extends Error {
  constructor(spec: string) {
    super(`integrity is required for package "${spec}"`);
    this.name = 'DependencyTreeIntegrityMissingError';
  }
}
