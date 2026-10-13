import { normalizeSearch } from '@/components/ui/SearchField/search'
import { type Decision, DECISIONS } from '@/lib/decision/types'

import type { RequestSearch } from '../types/requests'

type SearchParams = Record<string, string | string[] | undefined>

const single = (value: string | string[] | undefined) => (typeof value === 'string' ? value : undefined)

// 주소 값(?q=&decision=)을 읽습니다. 잘못된 값과 배열(같은 이름 여러 개)은 기본값으로 둡니다.
export function readRequestSearch(params: SearchParams): RequestSearch {
  const decision = single(params.decision)
  return {
    q: normalizeSearch(single(params.q) ?? ''),
    decision: DECISIONS.includes(decision as Decision) ? (decision as Decision) : 'ALL',
  }
}

// 기본값(빈 검색어, 전체)은 주소에서 뺍니다.
export function requestsHref({ q, decision }: RequestSearch): string {
  const params = new URLSearchParams()
  if (q) params.set('q', q)
  if (decision !== 'ALL') params.set('decision', decision)
  const query = params.toString()
  return query ? `/requests?${query}` : '/requests'
}
