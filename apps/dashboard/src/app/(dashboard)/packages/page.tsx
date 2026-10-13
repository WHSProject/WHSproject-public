import { hasPermission } from '@/lib/auth/common/permissions'
import { requireSession } from '@/lib/auth/server/session'
import { PackagesPage, readPackageSearch } from '@/features/packages'
import { loadPackagesPage } from '@/features/packages/index.server'

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> }

// 2겹 검사: 화면을 그리기 전에 DB에서 세션을 확인합니다. 페이지는 화면 이동 때마다 다시 실행됩니다.
// 검색·판정 필터·페이지·선택한 판정은 주소 값(?q=&decision=&page=&selected=)으로 받아 서버에서 조회합니다.
export default async function Page({ searchParams }: Props) {
  const session = await requireSession()
  const search = readPackageSearch(await searchParams)
  const { list, detail, error } = await loadPackagesPage(search)
  return (
    <PackagesPage search={search} list={list} detail={detail} error={error} canViewPolicy={hasPermission(session.user.role, 'policy:draft')} />
  )
}
