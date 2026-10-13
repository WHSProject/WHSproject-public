import type { Queryable } from '@/lib/db'

import type { SessionRow } from '../types/account'

// 개인 설정 화면의 조회·기기 로그아웃입니다. 서버에서만 import하며, 항상 로그인한 본인 id로만 조회·변경합니다.
// Better Auth의 list-sessions는 로그인한 지 1일(freshAge)이 지나면 거부하므로 세션 목록은 DB에서 직접 읽습니다.
// 세션 토큰은 화면으로 보내지 않고 id로만 다룹니다.

type SessionRecord = {
  id: string
  user_agent: string | null
  ip_address: string | null
  created_at: Date
  expires_at: Date
}

// 만료되지 않은 세션만, 최근 로그인이 위에 옵니다.
export async function listUserSessions(db: Queryable, userId: string, currentSessionId: string): Promise<SessionRow[]> {
  const result = await db.query<SessionRecord>(
    `SELECT id, user_agent, ip_address, created_at, expires_at
       FROM sessions
      WHERE user_id = $1 AND expires_at > now()
      ORDER BY created_at DESC`,
    [userId],
  )
  return result.rows.map((row) => ({
    id: row.id,
    userAgent: row.user_agent,
    ipAddress: row.ip_address,
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    current: row.id === currentSessionId,
  }))
}

// 로그인 수단(accounts.provider_id): 지금은 credential(비밀번호)만 씁니다
export async function listLoginMethods(db: Queryable, userId: string): Promise<string[]> {
  const result = await db.query<{ provider_id: string }>(
    'SELECT DISTINCT provider_id FROM accounts WHERE user_id = $1 ORDER BY provider_id',
    [userId],
  )
  return result.rows.map((row) => row.provider_id)
}

// 본인 세션 하나를 끊습니다. 다른 사용자의 세션 id는 "없음"과 같게 처리합니다.
export async function revokeUserSession(db: Queryable, userId: string, sessionId: string): Promise<boolean> {
  const result = await db.query('DELETE FROM sessions WHERE id = $1 AND user_id = $2', [sessionId, userId])
  return (result.rowCount ?? 0) > 0
}
