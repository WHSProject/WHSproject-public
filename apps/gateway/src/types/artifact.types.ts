export interface ArtifactIdentity {
  packageName: string;
  version: string;

  // Gateway 내부 Critical Path에 진입한 Artifact는 integrity가 반드시 존재한다.
  integrity: string;
}
