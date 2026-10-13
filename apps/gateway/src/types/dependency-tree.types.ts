import type { ArtifactIdentity } from './artifact.types';

export interface DependencyTreeNode {
  name: string;
  version: string;
  integrity: string | null;
}

export interface DependencyResolutionResult {
  // 요청 추적용 ID. 호출부에서 받은 값을 그대로 유지한다
  requestId: string;

  // npm이 요청한 Package 자신
  root: ArtifactIdentity;

  // root를 포함한 전체 검사 대상. name@version 기준으로 중복이 제거되어 있다.
  artifacts: ArtifactIdentity[];
}
