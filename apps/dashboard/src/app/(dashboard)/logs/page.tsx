import { requireSession } from '@/lib/auth/server/session'
import { LogsPage, readLogSearch } from '@/features/logs'
import { loadLogsPage } from '@/features/logs/index.server'

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> }

// Viewer 이상 모두 볼 수 있습니다. 주소의 검색 조건으로 user_db를 조회합니다.
export default async function Page({ searchParams }: Props) {
  await requireSession()
  const search = readLogSearch(await searchParams)
  return <LogsPage search={search} data={await loadLogsPage(search)} />
}
