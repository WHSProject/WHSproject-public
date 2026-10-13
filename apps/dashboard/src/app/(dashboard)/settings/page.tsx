import { SettingsPage } from '@/features/settings'
import { listLoginMethods, listUserSessions, npmTokenExpiresAt } from '@/features/settings/index.server'
import { hasPermission } from '@/lib/auth/common/permissions'
import { roleLabel } from '@/lib/auth/common/labels'
import { listRoles } from '@/lib/auth/server/roles'
import { requireSession } from '@/lib/auth/server/session'
import { getPool } from '@/lib/db'

// 모든 로그인 사용자의 개인 설정입니다. 항상 로그인한 본인 id로만 조회합니다.
export default async function Page() {
  const { user, session } = await requireSession()
  const pool = getPool()
  const [providers, sessions, roles, tokenExpiresAt] = await Promise.all([
    listLoginMethods(pool, user.id),
    listUserSessions(pool, user.id, session.id),
    listRoles(pool),
    npmTokenExpiresAt(pool, user.id),
  ])

  return (
    <SettingsPage
      profile={{
        displayName: user.displayUsername || user.username || user.name,
        roleName: roleLabel(roles, user.role ?? 'viewer'),
        providers,
        createdAt: new Date(user.createdAt).toISOString(),
      }}
      sessions={sessions}
      npmTokenExpiresAt={tokenExpiresAt}
      canInstall={hasPermission(user.role, 'package:install')}
    />
  )
}
