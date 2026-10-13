// 권한 변경 이력 화면과 서버(server/role-changes.ts)가 함께 쓰는 타입입니다. 표시 이름 규칙은 서버 쪽 주석을 봅니다.
export type RoleChangeRow = {
  id: string
  changedAt: string
  target: string
  changedBy: string | null
  previousRole: string
  newRole: string
}
