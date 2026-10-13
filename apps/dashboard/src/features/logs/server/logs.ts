import {
  listDownloadEvents, listDownloadUsernames, listRootDependencies, listRootInstallsContaining,
} from '@/lib/download-events/server/download-events'

import { readLogSearch } from '../model/query'
import type { LogSearch, LogsPageData } from '../types/logs'

// 역추적·Root 상세는 서로 독립이라 하나가 실패해도 나머지는 정상 표시합니다. 원인은 서버 로그에만 남깁니다.
async function orError<T>(label: string, code: string, load: () => Promise<T>): Promise<T | { error: string }> {
  try {
    return await load()
  } catch (error) {
    console.error(label, error)
    return { error: code }
  }
}

// 보이는 탭의 데이터만 조회합니다. 탭 이동은 주소 이동이라 숨은 탭을 미리 읽을 이유가 없습니다.
export async function loadLogsPage(search: LogSearch, now = new Date()): Promise<LogsPageData> {
  // readLogSearch는 주소 값(문자열)을 받으므로 page만 문자열로 바꿔 같은 검증을 다시 적용합니다.
  const normalized = readLogSearch({ ...search, page: String(search.page) }, now)

  if (normalized.view === 'events') {
    const from = new Date(`${normalized.from}T00:00:00+09:00`)
    const to = new Date(new Date(`${normalized.to}T00:00:00+09:00`).getTime() + 24 * 60 * 60 * 1000)
    const log = await orError('설치 기록 조회 실패', 'DOWNLOAD_EVENTS_UNAVAILABLE', async () => {
      const [result, usernames] = await Promise.all([
        listDownloadEvents({ from, to, q: normalized.q, user: normalized.user, page: normalized.page }),
        listDownloadUsernames({ from, to }),
      ])
      return { ...result, usernames }
    })
    return { log, trace: null, rootDetail: null }
  }

  const [trace, rootDetail] = await Promise.all([
    // 역추적에는 기간(from·to)을 적용하지 않습니다.
    normalized.trace
      ? orError('의존성 역추적 조회 실패', 'ROOT_TRACE_UNAVAILABLE', () =>
        listRootInstallsContaining({ packageName: normalized.trace, version: normalized.traceVersion }))
      : null,
    normalized.root
      ? orError('Root 설치 의존성 조회 실패', 'ROOT_TRACE_UNAVAILABLE', async () => {
        const detail = await listRootDependencies(normalized.root)
        return detail ? { rootRequestId: normalized.root, ...detail } : { error: 'ROOT_NOT_FOUND' }
      })
      : null,
  ])
  return { log: null, trace, rootDetail }
}
