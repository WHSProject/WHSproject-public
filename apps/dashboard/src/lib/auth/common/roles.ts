// DB roles 테이블의 역할 정보입니다. 역할 이름 표시와 권한 선택에 씁니다(Admin·개인 설정).
// 역할별 권한은 DB가 아니라 permissions.ts에서 정의합니다.
export type RoleOption = { code: string; name: string; description: string; rank: number }
