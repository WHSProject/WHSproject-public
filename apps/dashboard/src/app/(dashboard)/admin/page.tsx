import { redirect } from 'next/navigation'

import { requirePermission } from '@/lib/auth/server/session'

// Admin 입구: 지금은 화면이 적어 사용자 관리로 바로 보냅니다. 권한이 없으면 이동 전에 403입니다.
export default async function Page() {
  await requirePermission('user:read')
  redirect('/admin/users')
}
