import { normalizeSearch } from '@/components/ui/SearchField/search'
import { type Decision, DECISIONS } from '@/lib/decision/types'

import type { PackageSearch } from '../types/packages'

type SearchParams = Record<string, string | string[] | undefined>

const single = (value: string | string[] | undefined) => (typeof value === 'string' ? value : undefined)

// 주소 값(?q=&decision=&page=&selected=)을 읽습니다. 잘못된 값과 배열(같은 이름 여러 개)은 기본값으로 둡니다.
export function readPackageSearch(params: SearchParams): PackageSearch {
  const decision = single(params.decision)
  const page = Number(single(params.page))
  return {
    q: normalizeSearch(single(params.q) ?? ''),
    decision: DECISIONS.includes(decision as Decision) ? (decision as Decision) : 'ALL',
    page: Number.isSafeInteger(page) && page >= 1 ? page : 1,
    selected: single(params.selected) || undefined,
  }
}

// 기본값(빈 검색어, 전체, 1페이지, 선택 없음)은 주소에서 뺍니다.
export function packagesHref({ q, decision, page, selected }: PackageSearch): string {
  const params = new URLSearchParams()
  if (q) params.set('q', q)
  if (decision !== 'ALL') params.set('decision', decision)
  if (page > 1) params.set('page', String(page))
  if (selected) params.set('selected', selected)
  const query = params.toString()
  return query ? `/packages?${query}` : '/packages'
}
