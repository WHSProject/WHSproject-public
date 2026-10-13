import { normalizeSearch } from '@/components/ui/SearchField/search'

import type { LogSearch } from '../types/logs'

/** 사용자 필터에서 username 없는 요청을 뜻합니다. */
export const ANONYMOUS_USER = '__anonymous__'

/** npm 패키지 이름 최대 길이입니다. 역추적은 정확히 일치로 찾으므로 검색창 길이(100자)로 자르면 다른 이름이 됩니다. */
export const TRACE_MAX_LENGTH = 214
export const normalizeTraceValue = (value: string) => value.trim().slice(0, TRACE_MAX_LENGTH)

type SearchParams = Record<string, string | string[] | undefined>
const single = (value: string | string[] | undefined) => (typeof value === 'string' ? value : undefined)
const DAY_MS = 24 * 60 * 60 * 1000
// Gateway 요청 id(randomUUID)의 형식입니다.
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
// 앞자리 0·부호·소수를 막고 최대 5자리(99999)까지만 받습니다. OFFSET이 커지는 것도 함께 제한합니다.
const PAGE = /^[1-9][0-9]{0,4}$/u
const seoulDate = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
})

function validDate(value: string | undefined): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/u.test(value) || value.startsWith('0000')) return false
  const date = new Date(`${value}T00:00:00Z`)
  // Date가 2월 30일 등을 다음 달로 보정하므로 원래 날짜와 대조합니다.
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

export function readLogSearch(params: SearchParams, now = new Date()): LogSearch {
  const today = seoulDate.format(now)
  const defaultFrom = seoulDate.format(new Date(new Date(`${today}T00:00:00+09:00`).getTime() - 6 * DAY_MS))
  const fromValue = single(params.from)
  const toValue = single(params.to)
  // 기본값을 생략한 주소도 복원하도록 날짜별로 검증합니다.
  let from = validDate(fromValue) ? fromValue : defaultFrom
  let to = validDate(toValue) ? toValue : today
  if (from > to) [from, to] = [to, from]
  const trace = normalizeTraceValue(single(params.trace) ?? '')
  const root = single(params.root) ?? ''
  const viewValue = single(params.view)
  const pageValue = single(params.page)
  return {
    q: normalizeSearch(single(params.q) ?? ''),
    user: single(params.user) ?? '',
    from,
    to,
    trace,
    // 버전은 역추적할 패키지가 있을 때만 의미가 있습니다.
    traceVersion: trace ? normalizeTraceValue(single(params.traceVersion) ?? '') : '',
    root: REQUEST_ID.test(root) ? root : '',
    // view가 없을 때만 trace 값으로 추정합니다(Package 링크·탭이 생기기 전 주소 호환). 명시된 view는 그대로 따릅니다.
    view: viewValue === undefined ? (trace ? 'trace' : 'events') : viewValue === 'trace' ? 'trace' : 'events',
    page: pageValue !== undefined && PAGE.test(pageValue) ? Number(pageValue) : 1,
  }
}

export function logsHref(search: LogSearch, now = new Date()): string {
  const defaults = readLogSearch({}, now)
  const params = new URLSearchParams()
  // 설치 기록 탭은 보통 생략합니다. 다만 역추적 값이 남아 있으면 생략한 주소가 trace 탭으로 읽히므로 events를 명시합니다.
  if (search.view === 'trace') params.set('view', 'trace')
  else if (search.trace) params.set('view', 'events')
  if (search.q) params.set('q', search.q)
  if (search.user) params.set('user', search.user)
  if (search.from !== defaults.from) params.set('from', search.from)
  if (search.to !== defaults.to) params.set('to', search.to)
  if (search.trace) params.set('trace', search.trace)
  if (search.trace && search.traceVersion) params.set('traceVersion', search.traceVersion)
  if (search.root) params.set('root', search.root)
  // 다른 탭에 있어도 페이지는 지우지 않습니다. 설치 기록 탭으로 돌아오면 그 페이지를 이어서 봅니다.
  if (search.page > 1) params.set('page', String(search.page))
  const query = params.toString()
  return query ? `/logs?${query}` : '/logs'
}
