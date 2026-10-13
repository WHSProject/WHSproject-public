// 로그인 기기 목록 화면과 서버(server/account.ts)가 함께 쓰는 타입입니다. 세션 토큰은 담지 않습니다.
export type SessionRow = {
  id: string
  userAgent: string | null
  ipAddress: string | null
  createdAt: string
  expiresAt: string
  current: boolean
}
