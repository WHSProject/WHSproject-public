import { hasPermission } from '@/lib/auth/common/permissions'
import { requirePermission } from '@/lib/auth/server/session'
import { RulesMessage, RulesPage } from '@/features/rules'
import { loadRulesPage } from '@/features/rules/index.server'

// Editor·Admin만 볼 수 있습니다(policy:draft). 적용 중인 정책을 읽어 편집 화면을 그립니다.
// 적용하면 버전이 바뀌므로 버전을 key로 두어 편집 상태를 새로 만듭니다.
export default async function Page() {
  const session = await requirePermission('policy:draft')
  const data = await loadRulesPage()
  if (data.status === 'no-policy') return <RulesMessage />
  if (data.status === 'unavailable') return <RulesMessage code={data.code} />

  return (
    <RulesPage
      key={data.policy.version}
      policy={data.policy}
      predicates={data.predicates}
      canApply={hasPermission(session.user.role, 'policy:publish')}
    />
  )
}
