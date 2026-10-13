import { useEffect, useRef, useState } from 'react'

import { normalizeSearch, SEARCH_DELAY_MS } from './search'

// 주소 값 검색어(current)와 입력란을 맞추고, 입력을 멈추면 navigate(검색어)로 조회합니다(Package·Request 공용).
// 알려진 한계(PR #438 미해결 사항): 검색 대기 중 뒤로 가기·늦게 온 이전 응답 순서 → 실제 API 연결 때 popstate 기준으로 수정
export function useAddressSearch(current: string, navigate: (q: string) => void) {
  const [query, setQuery] = useState(current)
  // 마지막으로 요청한 검색어. 응답을 기다리는 중에도 새 입력은 이 값과 비교해 요청하므로 마지막 입력이 이깁니다.
  const [requested, setRequested] = useState(current)
  const [shown, setShown] = useState(current)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)

  // 주소의 검색어가 마지막 요청과 다르게 바뀌면(뒤로 가기 등) 입력란을 주소에 맞춥니다.
  // 자기 요청의 응답이 도착한 경우에는 그 사이 입력한 글자를 덮어쓰지 않습니다.
  if (current !== shown) {
    setShown(current)
    if (current !== requested) {
      setQuery(current)
      setRequested(current)
    }
  }

  useEffect(() => () => clearTimeout(timer.current), [])

  function change(value: string) {
    setQuery(value)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      const q = normalizeSearch(value)
      if (q === requested) return
      setRequested(q)
      navigate(q)
    }, SEARCH_DELAY_MS)
  }

  // 필터처럼 다른 값과 함께 바로 조회할 때: 기다리던 검색을 취소하고 지금 입력한 검색어를 돌려줍니다.
  function take(): string {
    clearTimeout(timer.current)
    const q = normalizeSearch(query)
    setRequested(q)
    return q
  }

  return { query, change, take }
}
