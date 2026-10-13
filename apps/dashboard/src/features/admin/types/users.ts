// 사용자 목록 화면과 서버(server/users.ts)가 함께 쓰는 타입입니다.
export type AdminUserRow = {
  id: string
  displayName: string
  username: string | null
  role: string
  banned: boolean
  // accounts.provider_id: 지금은 credential(비밀번호)만 씁니다. 비어 있으면 비밀번호 설정 전입니다.
  providers: string[]
  // 남아 있는 세션 중 가장 최근 로그인. 로그아웃하면 세션이 지워지므로 없을 수 있습니다.
  lastLoginAt: string | null
  createdAt: string
}

// 계정 생성·링크 발급 API가 돌려주는 비밀번호 설정·재설정 링크입니다.
export type PasswordLink = { url: string; expiresAt: string }
