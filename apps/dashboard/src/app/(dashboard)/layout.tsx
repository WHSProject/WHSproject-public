import type { ReactNode } from 'react'

import { hasPermission } from '@/lib/auth/common/permissions'
import { getSession } from '@/lib/auth/server/session'

import { AppShell, type ShellUser } from '../_shell/AppShell'

// 상단 사용자 표시·Admin·Rule 메뉴 표시용으로 세션을 읽기만 합니다. 레이아웃은 화면 이동 때 다시 실행되지 않으므로
// 접근 차단은 각 페이지의 requireSession()·requirePermission()이 합니다.
export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const session = await getSession()
  const user: ShellUser | null = session
    ? {
        name: session.user.displayUsername || session.user.username || session.user.name,
        role: session.user.role ?? 'viewer',
        canAccessAdmin: hasPermission(session.user.role, 'user:read'),
        canEditRules: hasPermission(session.user.role, 'policy:draft'),
      }
    : null

  return <AppShell user={user}>{children}</AppShell>
}
