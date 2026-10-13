export interface ParsedTarballRequest {
  // 정규화된 전체 Package Name: `name` 또는 `@scope/name`
  packageName: string;

  // 파일명에서 추출한 정확한 Version
  version: string;
}
