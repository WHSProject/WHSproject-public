import { hasPermission } from '@/lib/auth/common/permissions'
import { requireSession } from '@/lib/auth/server/session'
import { OverviewPage } from '@/features/overview'
import { loadOverview } from '@/features/overview/index.server'

// 2겹 검사: 화면을 그리기 전에 DB에서 세션을 확인합니다. 페이지는 화면 이동 때마다 다시 실행됩니다.
// 정책 카드의 Rule·Version 링크는 그 페이지를 볼 수 있는 사람(policy:draft)에게만 보입니다.
export default async function Page() {
  const session = await requireSession()
  const data = await loadOverview()
  return <OverviewPage data={data} canViewPolicy={hasPermission(session.user.role, 'policy:draft')} />
}
