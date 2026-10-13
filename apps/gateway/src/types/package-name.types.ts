export interface ParsedPackageName {
  // 정규화된 전체 Package Name: `name` 또는 `@scope/name`
  packageName: string;

  // 앞의 `@`를 제외한 Scope. Unscoped Package인 경우 null
  scope: string | null;

  // Scope를 제외한 Package Name
  name: string;
}
