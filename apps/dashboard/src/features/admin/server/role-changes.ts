import type { Queryable } from '@/lib/db'

import type { RoleChangeRow } from '../types/role-changes'

// 권한 변경 이력(user_role_changes) 조회입니다. 서버에서만 import합니다.
// 변경한 사람(changedBy)이 없으면 DB에서 직접 수정한 기록입니다.
// 이메일은 자동값이라 현재 username을 보여 주고, 삭제된 사용자만 이력에 남은 이메일을 보여 줍니다.

type RoleChangeRecord = {
  id: string
  changed_at: Date
  target_name: string
  changed_by_name: string | null
  previous_role: string
  new_role: string
}

export const ROLE_CHANGES_LIMIT = 100

// 최근 변경이 위에 옵니다.
export async function listRoleChanges(db: Queryable, limit = ROLE_CHANGES_LIMIT): Promise<RoleChangeRow[]> {
  const result = await db.query<RoleChangeRecord>(
    `SELECT c.id, c.changed_at, c.previous_role, c.new_role,
            COALESCE(t.display_username, t.username, c.target_email) AS target_name,
            CASE WHEN c.changed_by_email IS NOT NULL
                 THEN COALESCE(a.display_username, a.username, c.changed_by_email) END AS changed_by_name
       FROM user_role_changes c
       LEFT JOIN users t ON t.id = c.target_user_id
       LEFT JOIN users a ON a.id = c.changed_by_user_id
      ORDER BY c.changed_at DESC, c.id
      LIMIT $1`,
    [limit],
  )
  return result.rows.map((row) => ({
    id: row.id,
    changedAt: row.changed_at.toISOString(),
    target: row.target_name,
    changedBy: row.changed_by_name,
    previousRole: row.previous_role,
    newRole: row.new_role,
  }))
}
