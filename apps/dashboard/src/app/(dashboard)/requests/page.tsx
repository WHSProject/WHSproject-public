import { requireSession } from '@/lib/auth/server/session'
import { readRequestSearch, RequestsPage } from '@/features/requests'
import { loadRequestsPage } from '@/features/requests/index.server'

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> }

// 2겹 검사: 화면을 그리기 전에 DB에서 세션을 확인합니다. 페이지는 화면 이동 때마다 다시 실행됩니다.
// 검색·판정 필터는 주소 값(?q=&decision=)으로 받아 서버에서 조회합니다.
export default async function Page({ searchParams }: Props) {
  await requireSession()
  const search = readRequestSearch(await searchParams)
  return <RequestsPage search={search} data={await loadRequestsPage(search)} />
}
