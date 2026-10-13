import type { Pool, PoolClient } from 'pg'

import { roles } from '@/lib/auth/common/permissions'
import type { Queryable } from '@/lib/db'

import type { AdminUserRow } from '../types/users'
import {
  type AdminActionError,
  type AdminActionPlan,
  canManageUsers,
  type Participant,
  type PlanInput,
  planBanChange,
  planRoleChange,
} from './user-rules'

// Admin 관리 화면의 사용자 조회·권한 변경·비활성화입니다. 서버에서만 import합니다.
// Better Auth admin 플러그인의 setRole·banUser 대신 직접 transaction으로 처리합니다.
// 같은 연결에서 변경한 사람(app.actor_user_id)을 넘겨야 권한 변경 이력 Trigger가 기록할 수 있고,
// 마지막 Admin 확인과 변경을 한 transaction에서 잠금으로 묶어야 동시 요청에도 규칙이 지켜집니다.
// 비활성화한 사용자의 로그인 차단은 admin 플러그인이 banned 값을 보고 합니다.

// 비활성화(ban)되지 않은 사용자. 기간이 지난 비활성화는 활성으로 봅니다.
export const ACTIVE_SQL = '(banned IS NOT TRUE OR (ban_expires IS NOT NULL AND ban_expires <= now()))'

type UserRecord = {
  id: string
  name: string
  username: string | null
  display_username: string | null
  role: string
  banned: boolean
  providers: string[]
  last_login_at: Date | null
  created_at: Date
}

// 높은 역할(Admin)이 위에 오고, 같은 역할은 가입 순서입니다.
export async function listUsers(db: Queryable): Promise<AdminUserRow[]> {
  const result = await db.query<UserRecord>(
    `SELECT u.id, u.name, u.username, u.display_username, u.role, u.created_at,
            NOT ${ACTIVE_SQL} AS banned,
            COALESCE(
              (SELECT array_agg(DISTINCT a.provider_id ORDER BY a.provider_id) FROM accounts a WHERE a.user_id = u.id),
              '{}'
            ) AS providers,
            (SELECT max(s.created_at) FROM sessions s WHERE s.user_id = u.id) AS last_login_at
       FROM users u
       JOIN roles r ON r.code = u.role
      ORDER BY r.rank DESC, u.created_at`,
  )
  return result.rows.map((row) => ({
    id: row.id,
    displayName: row.display_username || row.username || row.name,
    username: row.username,
    role: row.role,
    banned: row.banned,
    providers: row.providers,
    lastLoginAt: row.last_login_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  }))
}

export type AdminActionResult = { ok: true; changed: boolean } | { ok: false; code: AdminActionError }

// 잠금 순서를 항상 같게 해(관리자 행 → 대상·실행자 행, 각각 id 순) 동시 요청끼리 교착되지 않게 합니다.
// 기다리는 동안 다른 요청이 커밋한 변경은 각 문장이 다시 읽습니다(READ COMMITTED).
async function lockParticipants(client: PoolClient, actorId: string, targetId: string): Promise<PlanInput> {
  const managerRoles = Object.keys(roles).filter(canManageUsers)
  const managers = await client.query<{ id: string }>(
    `SELECT id FROM users WHERE role = ANY($1::text[]) AND ${ACTIVE_SQL} ORDER BY id FOR UPDATE`,
    [managerRoles],
  )
  const participants = await client.query<Participant>(
    `SELECT id, role, ${ACTIVE_SQL} AS active FROM users WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`,
    [[actorId, targetId]],
  )
  return {
    actor: participants.rows.find((row) => row.id === actorId),
    target: participants.rows.find((row) => row.id === targetId),
    managerIds: managers.rows.map((row) => row.id),
  }
}

// 규칙을 통과하면 apply로 반영하고 커밋합니다. 규칙에 걸리거나 오류가 나면 되돌립니다.
async function runAdminAction(
  pool: Pool,
  actorId: string,
  decide: (client: PoolClient) => Promise<AdminActionPlan>,
  apply: (client: PoolClient, revokeSessions: boolean) => Promise<void>,
): Promise<AdminActionResult> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    // SET LOCAL app.actor_user_id와 같습니다. 이 transaction 안에서만 유지되며 이력 Trigger가 읽습니다.
    await client.query(`SELECT set_config('app.actor_user_id', $1, true)`, [actorId])

    const plan = await decide(client)
    if (!plan.ok || !plan.changed) {
      await client.query('ROLLBACK')
      return plan.ok ? { ok: true, changed: false } : plan
    }

    await apply(client, plan.revokeSessions)
    await client.query('COMMIT')
    return { ok: true, changed: true }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

async function revokeSessions(client: PoolClient, userId: string): Promise<void> {
  await client.query('DELETE FROM sessions WHERE user_id = $1', [userId])
}

export async function changeUserRole(
  pool: Pool,
  { actorId, targetId, role }: { actorId: string; targetId: string; role: string },
): Promise<AdminActionResult> {
  return runAdminAction(
    pool,
    actorId,
    async (client) => {
      const locked = await lockParticipants(client, actorId, targetId)
      const ranks = await client.query<{ code: string; rank: number }>('SELECT code, rank FROM roles')
      const rankOf = (code: string) => ranks.rows.find((row) => row.code === code)?.rank
      return planRoleChange({ ...locked, newRole: role, rankOf })
    },
    async (client, revoke) => {
      await client.query('UPDATE users SET role = $2, updated_at = now() WHERE id = $1', [targetId, role])
      if (revoke) await revokeSessions(client, targetId)
    },
  )
}

export async function setUserBanned(
  pool: Pool,
  { actorId, targetId, banned }: { actorId: string; targetId: string; banned: boolean },
): Promise<AdminActionResult> {
  return runAdminAction(
    pool,
    actorId,
    async (client) => planBanChange({ ...(await lockParticipants(client, actorId, targetId)), banned }),
    async (client, revoke) => {
      await client.query(
        'UPDATE users SET banned = $2, ban_reason = NULL, ban_expires = NULL, updated_at = now() WHERE id = $1',
        [targetId, banned],
      )
      if (revoke) await revokeSessions(client, targetId)
    },
  )
}
