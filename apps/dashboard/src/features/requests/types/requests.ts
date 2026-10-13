import type { DecisionFilterValue } from '@/lib/decision/types'
import type { RootRequest } from '@/lib/download-events/types'

/** 주소 값(?q=&decision=) */
export type RequestSearch = { q: string; decision: DecisionFilterValue }

/** 하루치 루트 패키지 요청(Asia/Seoul 날짜 기준), 최신순 */
export type RequestDay = {
  /** YYYY-MM-DD */
  date: string
  /** 오늘 · 어제 · 9월 28일 (일) */
  label: string
  items: RootRequest[]
}

export type RequestsPageData = { days: RequestDay[]; total: number } | { error: 'DOWNLOAD_EVENTS_UNAVAILABLE' }
