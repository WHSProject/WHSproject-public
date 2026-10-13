import { randomBytes } from 'node:crypto'

import type { Pool, PoolClient } from 'pg'

import { AUTH_ROUTES } from '@/lib/auth/common/routes'
import { accountEmail } from '@/lib/auth/common/username'
import { dashboardOrigin } from '@/lib/auth/server/request'
import { isUniqueViolation, type Queryable } from '@/lib/db'

import type { PasswordLink } from '../types/users'
import { type AdminActionError, checkActor, checkParticipants, type Participant } from './user-rules'
import { ACTIVE_SQL } from './users'

// Admin의 계정 생성과 비밀번호 설정·재설정 링크 발급입니다. 서버에서만 import합니다.
// 링크 토큰은 Better Auth 재설정 토큰 형식(verifications의 reset-password:<token>, value = 사용자 id)으로 직접 넣습니다.
// Better Auth /reset-password가 토큰을 한 번만 쓰고, 비밀번호가 없는 계정이면 credential을 새로 만듭니다.
// scripts/create-admin.js도 같은 형식을 쓰므로 바꾸면 함께 바꿉니다.

export const PASSWORD_LINK_TTL_MS = 60 * 60 * 1000

export type AccountResult<T> = ({ ok: true } & T) | { ok: false; code: AdminActionError }

// 사용자당 유효한 링크는 하나입니다. 새로 발급하면 이전 링크는 쓸 수 없습니다.
async function insertPasswordLink(db: Queryable, userId: string): Promise<PasswordLink> {
  const token = randomBytes(32).toString('base64url')
  const expiresAt = new Date(Date.now() + PASSWORD_LINK_TTL_MS)
  await db.query(`DELETE FROM verifications WHERE identifier LIKE 'reset-password:%' AND value = $1`, [userId])
  await db.query('INSERT INTO verifications (identifier, value, expires_at) VALUES ($1, $2, $3)', [
    `reset-password:${token}`,
    userId,
    expiresAt,
  ])
  return { url: `${dashboardOrigin()}${AUTH_ROUTES.resetPassword}?token=${token}`, expiresAt: expiresAt.toISOString() }
}

async function readParticipants(db: Queryable, ids: string[]): Promise<Participant[]> {
  const result = await db.query<Participant>(`SELECT id, role, ${ACTIVE_SQL} AS active FROM users WHERE id = ANY($1::uuid[])`, [ids])
  return result.rows
}

async function inTransaction<T>(pool: Pool, run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await run(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

// username은 검사를 마친 입력값입니다. 입력한 표기는 화면 이름으로 남기고 소문자로 저장합니다.
export async function createUserAccount(
  pool: Pool,
  { actorId, username, role }: { actorId: string; username: string; role: string },
): Promise<AccountResult<{ id: string; link: PasswordLink }>> {
  try {
    return await inTransaction(pool, async (client) => {
      const [actor] = await readParticipants(client, [actorId])
      const actorError = checkActor(actor)
      if (actorError) return { ok: false, code: actorError }

      const inserted = await client.query<{ id: string }>(
        `INSERT INTO users (name, email, email_verified, username, display_username, role, banned)
         VALUES ($1, $2, false, $3, $1, $4, false) RETURNING id`,
        [username, accountEmail(username), username.toLowerCase(), role],
      )
      const id = inserted.rows[0].id
      return { ok: true, id, link: await insertPasswordLink(client, id) }
    })
  } catch (error) {
    // users.username 또는 users_email_lower_key
    if (isUniqueViolation(error)) return { ok: false, code: 'USERNAME_TAKEN' }
    throw error
  }
}

// 설정 링크와 재설정 링크는 같은 링크입니다. 재설정하면 그 사용자의 로그인이 모두 끊깁니다.
export async function issuePasswordLink(
  pool: Pool,
  { actorId, targetId }: { actorId: string; targetId: string },
): Promise<AccountResult<{ link: PasswordLink }>> {
  return inTransaction(pool, async (client) => {
    // 같은 사용자에게 동시에 발급하면 서로의 새 토큰을 지우지 못해 링크가 2개 남으므로, 대상 행을 잠가 차례로 처리합니다.
    await client.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [targetId])
    const participants = await readParticipants(client, [actorId, targetId])
    const error = checkParticipants({
      actor: participants.find((row) => row.id === actorId),
      target: participants.find((row) => row.id === targetId),
    })
    if (error) return { ok: false, code: error }
    return { ok: true, link: await insertPasswordLink(client, targetId) }
  })
}
