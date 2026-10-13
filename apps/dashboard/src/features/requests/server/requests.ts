import { listRootRequests } from '@/lib/download-events/server/download-events'

import type { RequestDay, RequestSearch, RequestsPageData } from '../types/requests'

// Request 페이지의 읽기 순서입니다. 서버에서만 import합니다.

/** 목록 기간: 오늘 포함 최근 7일 */
export const DAYS = 7
const DAY_MS = 24 * 60 * 60 * 1000

// 날짜는 서버 시간대와 관계없이 한국 시간으로 나눕니다.
const seoulDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' })
const seoulWeekday = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', weekday: 'short' })
/** YYYY-MM-DD (한국 시간) */
const dateKey = (value: Date | string) => seoulDate.format(new Date(value))
// 그 날짜의 한국 시간 0시. Asia/Seoul은 서머타임이 없어 +09:00으로 고정합니다.
const startOfDay = (key: string) => new Date(`${key}T00:00:00+09:00`)

function dayLabel(key: string, todayKey: string): string {
  const daysAgo = Math.round((Date.parse(todayKey) - Date.parse(key)) / DAY_MS)
  if (daysAgo === 0) return '오늘'
  if (daysAgo === 1) return '어제'
  const [, month, day] = key.split('-').map(Number)
  return `${month}월 ${day}일 (${seoulWeekday.format(startOfDay(key))})`
}

// 최근 7일(한국 시간 6일 전 0시 ~ 지금)의 루트 패키지 요청을 날짜별로 묶습니다(최신순).
export async function loadRequestsPage(search: RequestSearch, now = new Date()): Promise<RequestsPageData> {
  const todayKey = dateKey(now)
  const from = new Date(startOfDay(todayKey).getTime() - (DAYS - 1) * DAY_MS)
  let items
  try {
    items = await listRootRequests({ from, to: now, q: search.q, decision: search.decision })
  } catch (error) {
    console.error('설치 요청 조회 실패', error)
    return { error: 'DOWNLOAD_EVENTS_UNAVAILABLE' }
  }

  const days: RequestDay[] = []
  for (const item of items) {
    const key = dateKey(item.occurredAt)
    const last = days.at(-1)
    if (last?.date === key) last.items.push(item)
    else days.push({ date: key, label: dayLabel(key, todayKey), items: [item] })
  }
  return { days, total: items.length }
}
