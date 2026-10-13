import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { RootRequest } from '@/lib/download-events/types'
import type { RequestsPageProps } from '@/features/requests/components/RequestsPage'

const { push, replace } = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, replace }) }))

import { SEARCH_DELAY_MS } from '@/components/ui/SearchField/search'
import { RequestsPage } from '@/features/requests/components/RequestsPage'

const request = (overrides: Partial<RootRequest> = {}): RootRequest => ({
  requestId: 'req_1',
  occurredAt: '2026-10-02T02:48:00Z',
  username: 'kim_dev',
  packageName: 'minipass-fetch',
  version: '5.0.2',
  outcome: 'BLOCKED',
  decision: 'REJECT',
  decisionId: 'dec_1',
  ...overrides,
})
const props = (overrides: Partial<RequestsPageProps> = {}): RequestsPageProps => ({
  search: { q: '', decision: 'ALL' },
  data: {
    total: 3,
    days: [
      { date: '2026-10-02', label: '오늘', items: [
        request(),
        request({ requestId: 'req_2', occurredAt: '2026-10-01T22:00:00Z', username: null, packageName: 'left-pad', version: '1.3.0', outcome: 'UNAUTHENTICATED', decision: null, decisionId: null }),
      ] },
      { date: '2026-10-01', label: '어제', items: [
        request({ requestId: 'req_3', occurredAt: '2026-10-01T01:00:00Z', username: 'park_editor', packageName: 'p-limit', version: '7.3.1', outcome: 'DELIVERED', decision: 'ACCEPT', decisionId: 'dec_4' }),
      ] },
    ],
  },
  ...overrides,
})

const day = (label: string) => within(screen.getByRole('region', { name: label }))
const searchbox = () => screen.getByRole('searchbox', { name: '루트 패키지 또는 사용자로 검색' })

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  push.mockReset()
  replace.mockReset()
})

describe('RequestsPage', () => {
  it('shows root requests by day and links decided ones to the package detail', () => {
    render(<RequestsPage {...props()} />)

    expect(screen.getByText('최근 7일 루트 패키지 설치 요청 3건')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /오늘/u })).toHaveTextContent('2026.10.02')

    const rejected = day('오늘').getByRole('link', { name: /minipass-fetch/u })
    expect(rejected).toHaveAttribute('href', '/packages?selected=dec_1')
    expect(rejected).toHaveTextContent('11:48')
    expect(rejected).toHaveTextContent('kim_dev')
    expect(rejected).toHaveTextContent('차단')
    expect(within(rejected).getByText('REJECT')).toBeInTheDocument()

    // 판정 전에 끝난 요청은 연결이 없고 결과를 보여 줍니다.
    const unauthenticated = day('오늘').getByText('left-pad').closest('li')!
    expect(within(unauthenticated).queryByRole('link')).not.toBeInTheDocument()
    expect(unauthenticated).toHaveTextContent('인증 실패')
    expect(unauthenticated).toHaveTextContent('인증되지 않은 요청')

    expect(day('어제').getByRole('link', { name: /p-limit/u })).toHaveTextContent('전달')
    // 점수 기반 시안과 REQUEST ID는 없습니다.
    expect(screen.queryByRole('img', { name: /점수/u })).not.toBeInTheDocument()
    expect(screen.queryByText('req_1')).not.toBeInTheDocument()
  })

  it('shows an error while keeping search and decision filters usable', () => {
    vi.useFakeTimers()
    render(<RequestsPage {...props({ data: { error: 'DOWNLOAD_EVENTS_UNAVAILABLE' }, search: { q: 'kim', decision: 'HOLD' } })} />)
    expect(screen.getByRole('alert')).toHaveTextContent('설치 요청을 불러오지 못했습니다. DB 연결을 확인해 주세요. (DOWNLOAD_EVENTS_UNAVAILABLE)')
    expect(searchbox()).toHaveValue('kim')
    expect(screen.queryByText(/설치 요청 0건/u)).not.toBeInTheDocument()
    expect(screen.queryByText('조건에 맞는 설치 요청이 없습니다.')).not.toBeInTheDocument()
    fireEvent.change(searchbox(), { target: { value: 'alice' } })
    act(() => vi.advanceTimersByTime(SEARCH_DELAY_MS))
    expect(replace).toHaveBeenCalledWith('/requests?q=alice&decision=HOLD', { scroll: false })
    fireEvent.click(screen.getByRole('button', { name: 'REJECT' }))
    expect(push).toHaveBeenCalledWith('/requests?q=alice&decision=REJECT', { scroll: false })
  })

  it('labels pending and forbidden requests and only links rows with a decision id', () => {
    render(<RequestsPage {...props({ data: { total: 3, days: [{ date: '2026-10-02', label: '오늘', items: [
      request({ requestId: 'pending', packageName: 'pending', decision: null, decisionId: null }),
      request({ requestId: 'forbidden', packageName: 'forbidden', outcome: 'FORBIDDEN', decision: null, decisionId: null }),
      request({ requestId: 'no-id', packageName: 'no-id', decision: 'REJECT', decisionId: null }),
    ] }] } })} />)
    expect(screen.getByText('판정 대기')).toBeInTheDocument()
    expect(screen.getByText('권한 없음')).toBeInTheDocument()
    expect(screen.getByText('차단')).toBeInTheDocument()
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
  })

  it('tells the difference between no requests and no matching requests', () => {
    const empty = { total: 0, days: [] }
    const { rerender } = render(<RequestsPage {...props({ data: empty })} />)
    expect(screen.getByText('최근 7일 동안 설치 요청이 없습니다.')).toBeInTheDocument()

    rerender(<RequestsPage {...props({ data: empty, search: { q: 'zzz', decision: 'ALL' } })} />)
    expect(screen.getByText('조건에 맞는 설치 요청이 없습니다.')).toBeInTheDocument()
  })

  it('searches after typing stops and filters by decision right away', () => {
    vi.useFakeTimers()
    render(<RequestsPage {...props({ search: { q: '', decision: 'HOLD' } })} />)

    fireEvent.change(searchbox(), { target: { value: ' kim ' } })
    act(() => vi.advanceTimersByTime(SEARCH_DELAY_MS))
    expect(replace).toHaveBeenCalledWith('/requests?q=kim&decision=HOLD', { scroll: false })

    fireEvent.click(screen.getByRole('button', { name: 'REJECT' }))
    expect(push).toHaveBeenCalledWith('/requests?q=kim&decision=REJECT', { scroll: false })
  })
})
