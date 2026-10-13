import { createHash, randomBytes } from 'node:crypto'
import type { Queryable } from '@/lib/db'

export async function npmTokenExpiresAt(db: Queryable, userId: string): Promise<string | null> {
  const result = await db.query<{ expires_at: Date }>('SELECT expires_at FROM npm_tokens WHERE user_id = $1', [userId])
  return result.rows[0]?.expires_at.toISOString() ?? null
}

// 현재 users 행을 잠근 뒤 권한을 확인한다. 역할/비활성 변경 및 동시 재발급과 직렬화한다.
// ACTIVE_SQL과 같은 활성 규칙이며, 토큰 원문은 이 응답 외에는 보관하지 않는다.
export async function issueNpmToken(db: Queryable, userId: string): Promise<{ token: string; expiresAt: string } | null> {
  const token = `whs_npm_${randomBytes(32).toString('base64url')}`
  const tokenHash = createHash('sha256').update(token).digest('hex')
  const result = await db.query<{ expires_at: Date }>(
    `WITH eligible AS (
       SELECT id FROM users WHERE id = $1
       AND (banned IS NOT TRUE OR (ban_expires IS NOT NULL AND ban_expires <= now()))
       AND role IN ('developer', 'editor', 'admin') FOR UPDATE
     )
     INSERT INTO npm_tokens (user_id, token_hash, created_at, expires_at)
     SELECT id, $2, now(), now() + interval '90 days' FROM eligible
     ON CONFLICT (user_id) DO UPDATE SET token_hash = EXCLUDED.token_hash,
       created_at = EXCLUDED.created_at, expires_at = EXCLUDED.expires_at
     RETURNING expires_at`, [userId, tokenHash],
  )
  const row = result.rows[0]
  return row ? { token, expiresAt: row.expires_at.toISOString() } : null
}

export async function revokeNpmToken(db: Queryable, userId: string): Promise<void> {
  await db.query('DELETE FROM npm_tokens WHERE user_id = $1', [userId])
}
