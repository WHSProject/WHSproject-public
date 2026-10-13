import { hasPermission } from '@/lib/auth/common/permissions'
import { requirePermission } from '@/lib/auth/server/session'
import { VersionsMessage, VersionsPage } from '@/features/versions'
import { loadVersionsPage } from '@/features/versions/index.server'

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> }

// Editor·Admin만 볼 수 있습니다(policy:draft). ?view=버전으로 그 버전의 Rule을 봅니다.
// 적용 중 버전·보는 버전이 바뀌면 key가 바뀌어 확인창 등 화면 상태를 새로 만듭니다.
export default async function Page({ searchParams }: Props) {
  const session = await requirePermission('policy:draft')
  const { view } = await searchParams
  const data = await loadVersionsPage(typeof view === 'string' ? view : undefined)
  if (data.status === 'no-policy') return <VersionsMessage />
  if (data.status === 'unavailable') return <VersionsMessage code={data.code} />

  return (
    <VersionsPage
      key={`${data.activeVersion}:${data.viewed.version}`}
      policyKey={data.policyKey}
      activeVersion={data.activeVersion}
      versions={data.versions}
      viewed={data.viewed}
      canApply={hasPermission(session.user.role, 'policy:publish')}
    />
  )
}
