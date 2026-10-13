import { AdminUsersPage } from '@/features/admin'
import { listUsers } from '@/features/admin/index.server'
import { listRoles } from '@/lib/auth/server/roles'
import { requirePermission } from '@/lib/auth/server/session'
import { getPool } from '@/lib/db'

// 조회는 user:read, 변경 API는 user:manage 권한을 확인합니다(둘 다 Admin 전용).
export default async function Page() {
  const session = await requirePermission('user:read')
  const pool = getPool()
  const [users, roles] = await Promise.all([listUsers(pool), listRoles(pool)])

  return <AdminUsersPage users={users} roles={roles} currentUserId={session.user.id} />
}
