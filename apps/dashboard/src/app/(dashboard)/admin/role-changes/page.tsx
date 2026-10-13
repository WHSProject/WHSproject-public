import { RoleChangesPage } from '@/features/admin'
import { listRoleChanges, ROLE_CHANGES_LIMIT } from '@/features/admin/index.server'
import { listRoles } from '@/lib/auth/server/roles'
import { requirePermission } from '@/lib/auth/server/session'
import { getPool } from '@/lib/db'

export default async function Page() {
  await requirePermission('audit:read')
  const pool = getPool()
  const [changes, roles] = await Promise.all([listRoleChanges(pool), listRoles(pool)])

  return <RoleChangesPage changes={changes} roles={roles} limit={ROLE_CHANGES_LIMIT} />
}
