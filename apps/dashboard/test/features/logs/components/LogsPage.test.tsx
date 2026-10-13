import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SEARCH_DELAY_MS } from '@/components/ui/SearchField/search'
import { LogsPage } from '@/features/logs'
import type { LogRootDetail, LogsPageData, LogTrace } from '@/features/logs/types/logs'
import type { DownloadEvent, RootInstall } from '@/lib/download-events/types'

const { push, replace } = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, replace }) }))

const search = { q: '', user: '', from: '2026-09-29', to: '2026-10-05', trace: '', traceVersion: '', root: '', view: 'events', page: 1 } as const
const event: DownloadEvent = {
  id: 'event-1', occurredAt: '2026-10-05T01:00:00Z', requestId: 'req-1', userId: 'user-1',
  username: 'alice', sourceIp: '10.0.4.37', packageName: 'express', version: '5.0.0',
  outcome: 'DELIVERED', decision: 'ACCEPT', httpStatus: 200,
}
const logData = (events: DownloadEvent[] = [event], hasNext = false): LogsPageData => ({
  log: { events, usernames: ['alice', 'bob'], hasNext }, trace: null, rootDetail: null,
})
const data = logData()
const manyEvents = (count: number) => Array.from({ length: count }, (_, i) => ({ ...event, id: `event-${i}` }))
const searchbox = () => screen.getByRole('searchbox', { name: '패키지 이름 또는 버전으로 검색' })
const table = () => within(screen.getByRole('table', { name: '설치 기록' }))
const tabs = () => within(screen.getByRole('navigation', { name: '설치 기록 보기 방식' }))
const pager = () => within(screen.getByRole('navigation', { name: '설치 기록 페이지' }))

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-05T01:00:00Z'))
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('LogsPage tabs', () => {
  it('shows two tab links and marks only the current one', () => {
    const { rerender } = render(<LogsPage search={search} data={data} />)
    expect(tabs().getAllByRole('link').map((link) => link.textContent)).toEqual(['설치 기록', '의존성 역추적'])
    expect(tabs().getByRole('link', { name: '설치 기록' })).toHaveAttribute('aria-current', 'page')
    expect(tabs().getByRole('link', { name: '의존성 역추적' })).not.toHaveAttribute('aria-current')
    expect(tabs().getByRole('link', { name: '설치 기록' })).toHaveAttribute('href', '/logs')
    expect(tabs().getByRole('link', { name: '의존성 역추적' })).toHaveAttribute('href', '/logs?view=trace')

    rerender(<LogsPage search={{ ...search, view: 'trace' }} data={{ log: null, trace: null, rootDetail: null }} />)
    expect(tabs().getByRole('link', { name: '의존성 역추적' })).toHaveAttribute('aria-current', 'page')
    expect(tabs().getByRole('link', { name: '설치 기록' })).not.toHaveAttribute('aria-current')
  })

  it('moves to another tab with the pending search and cancels its timer', () => {
    render(<LogsPage search={{ ...search, page: 3 }} data={data} />)
    fireEvent.change(searchbox(), { target: { value: ' express ' } })
    // 검색 대기(300ms) 중에 탭을 누릅니다. 검색어가 바뀌었으므로 1페이지로 갑니다.
    fireEvent.click(tabs().getByRole('link', { name: '의존성 역추적' }))
    expect(push).toHaveBeenCalledWith('/logs?view=trace&q=express', { scroll: false })
    act(() => vi.advanceTimersByTime(SEARCH_DELAY_MS))
    // 늦게 실행된 검색이 설치 기록 탭 주소로 이동을 덮어쓰지 않습니다.
    expect(replace).not.toHaveBeenCalled()
  })

  it('keeps the page when moving tabs without a pending search, and leaves modified clicks to the browser', () => {
    render(<LogsPage search={{ ...search, q: 'express', page: 3 }} data={data} />)
    fireEvent.click(tabs().getByRole('link', { name: '의존성 역추적' }))
    expect(push).toHaveBeenCalledWith('/logs?view=trace&q=express&page=3', { scroll: false })
    push.mockClear()
    fireEvent.click(tabs().getByRole('link', { name: '의존성 역추적' }), { metaKey: true })
    expect(push).not.toHaveBeenCalled()
  })

  it('renders only the visible tab', () => {
    const { rerender } = render(<LogsPage search={search} data={data} />)
    expect(screen.getByRole('heading', { level: 1, name: '설치 기록' })).toBeInTheDocument()
    expect(screen.getByRole('table', { name: '설치 기록' })).toBeInTheDocument()
    expect(searchbox()).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: '의존성 역추적' })).not.toBeInTheDocument()
    expect(screen.queryByLabelText('패키지 이름')).not.toBeInTheDocument()

    rerender(<LogsPage search={{ ...search, view: 'trace' }} data={{ log: null, trace: null, rootDetail: null }} />)
    expect(screen.getByRole('region', { name: '의존성 역추적' })).toBeInTheDocument()
    expect(screen.queryByRole('table', { name: '설치 기록' })).not.toBeInTheDocument()
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument()
    expect(screen.queryByRole('navigation', { name: '설치 기록 페이지' })).not.toBeInTheDocument()
    // 제목은 탭과 관계없이 하나입니다.
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
  })

  it('keeps the values of the other tab in each tab link, including the page', () => {
    const both = { ...search, q: 'express', user: 'bob', trace: 'debug', traceVersion: '4.4.3', page: 3 }
    const { rerender } = render(<LogsPage search={{ ...both, view: 'events' }} data={data} />)
    // 역추적 값이 남은 설치 기록 주소는 view=events를 명시해야 trace 탭으로 읽히지 않습니다.
    expect(tabs().getByRole('link', { name: '설치 기록' }))
      .toHaveAttribute('href', '/logs?view=events&q=express&user=bob&trace=debug&traceVersion=4.4.3&page=3')
    expect(tabs().getByRole('link', { name: '의존성 역추적' }))
      .toHaveAttribute('href', '/logs?view=trace&q=express&user=bob&trace=debug&traceVersion=4.4.3&page=3')

    rerender(<LogsPage search={{ ...both, view: 'trace' }} data={{ log: null, trace: { installs: [], truncated: false }, rootDetail: null }} />)
    expect(tabs().getByRole('link', { name: '설치 기록' }))
      .toHaveAttribute('href', '/logs?view=events&q=express&user=bob&trace=debug&traceVersion=4.4.3&page=3')
  })
})

describe('LogsPage install log tab', () => {
  it('shows server rows without browser filtering and uses the server username list', () => {
    render(<LogsPage search={{ ...search, q: 'server-query' }} data={data} />)
    expect(table().getAllByRole('row')).toHaveLength(2)
    for (const value of ['alice', 'express', '@5.0.0', 'ACCEPT', '전달', '10.0.4.37']) {
      expect(table().getByText(value)).toBeInTheDocument()
    }
    expect(table().getByText(/10:00/u)).toBeInTheDocument()
    expect(within(screen.getByRole('combobox')).getAllByRole('option').map((option) => option.textContent))
      .toEqual(['전체', 'alice', 'bob', '로그인 안 함'])
  })

  it.each([
    ['FORBIDDEN', null, '권한 없음', 'neutral'],
    ['BLOCKED', null, '판정 대기', 'neutral'],
    ['BLOCKED', 'REJECT', '차단', 'blocked'],
    ['BLOCKED', 'HOLD', '차단', 'blocked'],
    ['UNAUTHENTICATED', null, '인증 실패', 'neutral'],
    ['ERROR', null, '오류', 'neutral'],
  ] as const)('labels %s with decision %s as %s', (outcome, decision, label, style) => {
    render(<LogsPage search={search} data={logData([{ ...event, outcome, decision, username: null, sourceIp: null }])} />)
    expect(table().getByText(label).className).toContain(style)
    expect(table().getByText('로그인 안 함')).toBeInTheDocument()
    expect(table().getByText('-')).toBeInTheDocument()
    if (decision === null) expect(table().getByText('미판정')).toBeInTheDocument()
  })

  it('replaces the URL after typing while keeping user and dates, and goes back to page 1', () => {
    render(<LogsPage search={{ ...search, user: 'bob', from: '2026-09-01', page: 4 }} data={data} />)
    fireEvent.change(searchbox(), { target: { value: ' EXPRESS@5 ' } })
    expect(replace).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(SEARCH_DELAY_MS))
    expect(replace).toHaveBeenCalledWith('/logs?q=EXPRESS%405&user=bob&from=2026-09-01', { scroll: false })
    expect(table().getByText('express')).toBeInTheDocument()
  })

  it.each(['alice', '__anonymous__', ''])('pushes user %s with pending search, back to page 1, and cancels its timer', (user) => {
    render(<LogsPage search={{ ...search, user: 'bob', page: 3 }} data={data} />)
    fireEvent.change(searchbox(), { target: { value: ' express ' } })
    fireEvent.change(screen.getByRole('combobox'), { target: { value: user } })
    expect(push).toHaveBeenCalledWith(`/logs?q=express${user ? `&user=${user}` : ''}`, { scroll: false })
    act(() => vi.advanceTimersByTime(SEARCH_DELAY_MS))
    expect(replace).not.toHaveBeenCalled()
  })

  it.each([
    ['시작일', '2026-09-01', 'from'], ['종료일', '2026-10-10', 'to'],
  ])('pushes %s with the current search and user, back to page 1', (label, value, key) => {
    render(<LogsPage search={{ ...search, user: 'bob', page: 2 }} data={data} />)
    expect(screen.getByLabelText('시작일')).toHaveValue(search.from)
    expect(screen.getByLabelText('종료일')).toHaveValue(search.to)
    expect(screen.getByLabelText('시작일')).toHaveAttribute('max', search.to)
    expect(screen.getByLabelText('종료일')).toHaveAttribute('min', search.from)
    fireEvent.change(searchbox(), { target: { value: 'express' } })
    fireEvent.change(screen.getByLabelText(label), { target: { value } })
    expect(push).toHaveBeenCalledWith(`/logs?q=express&user=bob&${key}=${value}`, { scroll: false })
    act(() => vi.advanceTimersByTime(SEARCH_DELAY_MS))
    expect(replace).not.toHaveBeenCalled()
  })

  it('preserves a selected username absent from the period options', () => {
    render(<LogsPage search={{ ...search, user: 'outside' }} data={data} />)
    expect(screen.getByRole('combobox')).toHaveValue('outside')
  })

  it('shows empty results and DB errors distinctly, without the old 500-row notice', () => {
    const { rerender } = render(<LogsPage search={search} data={logData([], false)} />)
    expect(screen.getByText('조건에 맞는 설치 기록이 없습니다.')).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    expect(screen.queryByRole('navigation', { name: '설치 기록 페이지' })).not.toBeInTheDocument()
    rerender(<LogsPage search={search} data={{ log: { error: 'DOWNLOAD_EVENTS_UNAVAILABLE' }, trace: null, rootDetail: null }} />)
    expect(screen.getByRole('alert')).toHaveTextContent('설치 기록을 불러오지 못했습니다. DB 연결을 확인해 주세요. (DOWNLOAD_EVENTS_UNAVAILABLE)')
    expect(screen.queryByText('조건에 맞는 설치 기록이 없습니다.')).not.toBeInTheDocument()
    expect(screen.queryByRole('navigation', { name: '설치 기록 페이지' })).not.toBeInTheDocument()
    expect(screen.queryByText(/500건/u)).not.toBeInTheDocument()
  })
})

describe('LogsPage install log pager', () => {
  it('disables both buttons on a single short page and shows the real count', () => {
    render(<LogsPage search={search} data={logData(manyEvents(7))} />)
    expect(pager().getByText('1–7건')).toBeInTheDocument()
    expect(pager().queryByRole('link')).not.toBeInTheDocument()
    expect(pager().getByText('이전')).toHaveAttribute('aria-disabled', 'true')
    expect(pager().getByText('다음')).toHaveAttribute('aria-disabled', 'true')
  })

  it('links to the next page on the first page when more rows follow', () => {
    render(<LogsPage search={{ ...search, q: 'express', user: 'bob' }} data={logData(manyEvents(50), true)} />)
    expect(pager().getByText('1–50건')).toBeInTheDocument()
    expect(pager().getByText('이전')).toHaveAttribute('aria-disabled', 'true')
    expect(pager().getByRole('link', { name: '다음' })).toHaveAttribute('href', '/logs?q=express&user=bob&page=2')
  })

  it('links both ways in the middle and ends at the real count on the last page', () => {
    const { rerender } = render(<LogsPage search={{ ...search, page: 3 }} data={logData(manyEvents(50), true)} />)
    expect(pager().getByText('101–150건')).toBeInTheDocument()
    expect(pager().getByRole('link', { name: '이전' })).toHaveAttribute('href', '/logs?page=2')
    expect(pager().getByRole('link', { name: '다음' })).toHaveAttribute('href', '/logs?page=4')

    rerender(<LogsPage search={{ ...search, page: 3 }} data={logData(manyEvents(20), false)} />)
    expect(pager().getByText('101–120건')).toBeInTheDocument()
    expect(pager().getByRole('link', { name: '이전' })).toBeInTheDocument()
    expect(pager().getByText('다음')).toHaveAttribute('aria-disabled', 'true')
  })

  it('moves pages normally, but starts from page 1 with a pending search and cancels its timer', () => {
    render(<LogsPage search={{ ...search, q: 'express', page: 2 }} data={logData(manyEvents(50), true)} />)
    fireEvent.click(pager().getByRole('link', { name: '다음' }))
    expect(push).toHaveBeenLastCalledWith('/logs?q=express&page=3', { scroll: false })

    fireEvent.change(searchbox(), { target: { value: 'debug' } })
    fireEvent.click(pager().getByRole('link', { name: '다음' }))
    expect(push).toHaveBeenLastCalledWith('/logs?q=debug', { scroll: false })
    act(() => vi.advanceTimersByTime(SEARCH_DELAY_MS))
    expect(replace).not.toHaveBeenCalled()
  })

  it('goes back to the first page without a page parameter', () => {
    render(<LogsPage search={{ ...search, page: 2 }} data={logData(manyEvents(5), false)} />)
    expect(pager().getByText('51–55건')).toBeInTheDocument()
    expect(pager().getByRole('link', { name: '이전' })).toHaveAttribute('href', '/logs')
  })

  it('tells that a page beyond the results is empty and links to the first page', () => {
    render(<LogsPage search={{ ...search, q: 'express', page: 999 }} data={logData([], false)} />)
    expect(screen.getByText(/이 페이지에 기록이 없습니다\./u)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '1페이지로 이동' })).toHaveAttribute('href', '/logs?q=express')
    expect(screen.queryByText('조건에 맞는 설치 기록이 없습니다.')).not.toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    expect(screen.queryByRole('navigation', { name: '설치 기록 페이지' })).not.toBeInTheDocument()
  })
})

const rootId = '5a4298e8-0000-4000-8000-0000000000a1'
const otherId = '5a4298e8-0000-4000-8000-0000000000b2'
const install: RootInstall = {
  rootRequestId: rootId, rootPackageName: 'express', rootPackageVersion: '5.2.1', matchedVersion: '4.4.3',
  username: 'alice', userId: 'user-1', occurredAt: '2026-10-05T01:00:00Z', capturedAt: '2026-10-05T01:00:01Z',
  outcome: 'DELIVERED', decision: 'ACCEPT',
}
// download_events 행이 없는 설치(기록 저장 실패)
const unrecorded: RootInstall = {
  ...install, rootRequestId: otherId, rootPackageName: 'is-odd', rootPackageVersion: '3.0.1', matchedVersion: '6.0.0',
  username: null, userId: null, occurredAt: null, capturedAt: '2026-10-05T02:30:00Z', outcome: null, decision: null,
}
const traceView = { ...search, view: 'trace' } as const
const traceSearch = { ...traceView, trace: 'debug', traceVersion: '4.4.3' }
const traceData = (trace: LogTrace | null, rootDetail: LogRootDetail | null = null): LogsPageData => ({ log: null, trace, rootDetail })
const tracePanel = () => within(screen.getByRole('region', { name: '의존성 역추적' }))
const installTable = () => within(screen.getByRole('table', { name: 'Root 설치' }))
const nameInput = () => tracePanel().getByLabelText('패키지 이름')
const versionInput = () => tracePanel().getByLabelText('버전(선택)')
const searchButton = () => tracePanel().getByRole('button', { name: '조회' })

describe('LogsPage dependency trace tab', () => {
  it('shows the form with its guidance and no results until a trace is in the address', () => {
    render(<LogsPage search={traceView} data={traceData(null)} />)
    expect(tracePanel().getByRole('heading', { level: 2, name: '의존성 역추적' })).toBeInTheDocument()
    expect(tracePanel().getByText('패키지 이름을 정확히 입력하면, 그 패키지가 포함됐던 Root 설치와 설치한 사용자를 찾습니다. 기간 필터는 적용되지 않습니다.')).toBeInTheDocument()
    expect(tracePanel().getByText('Root 설치로 기록된 설치만 검색됩니다.')).toBeInTheDocument()
    expect(nameInput()).toHaveValue('')
    expect(nameInput()).toBeRequired()
    expect(versionInput()).toHaveValue('')
    expect(versionInput()).not.toBeRequired()
    expect(screen.queryByRole('table', { name: 'Root 설치' })).not.toBeInTheDocument()
    expect(screen.queryByRole('table', { name: 'Root 설치의 전체 의존성' })).not.toBeInTheDocument()
    // 설치 기록 목록과 그 필터는 이 탭에 없습니다.
    expect(screen.queryByRole('table', { name: '설치 기록' })).not.toBeInTheDocument()
    expect(screen.queryByLabelText('시작일')).not.toBeInTheDocument()
  })

  it('pushes the trace on search keeping view=trace, the filters, the page, and dropping the selected root', () => {
    render(<LogsPage search={{ ...traceView, user: 'bob', from: '2026-09-01', root: rootId, page: 3 }} data={traceData(null)} />)
    fireEvent.change(nameInput(), { target: { value: '  @scope/name ' } })
    fireEvent.change(versionInput(), { target: { value: ' 1.0.0 ' } })
    fireEvent.click(searchButton())
    expect(push).toHaveBeenCalledTimes(1)
    expect(push).toHaveBeenCalledWith('/logs?view=trace&user=bob&from=2026-09-01&trace=%40scope%2Fname&traceVersion=1.0.0&page=3', { scroll: false })
    act(() => vi.advanceTimersByTime(SEARCH_DELAY_MS))
    expect(replace).not.toHaveBeenCalled()
  })

  it('keeps a package name longer than the 100-character search limit', () => {
    render(<LogsPage search={traceView} data={traceData(null)} />)
    const longName = `a${'b'.repeat(116)}`
    fireEvent.change(nameInput(), { target: { value: ` ${longName} ` } })
    fireEvent.click(searchButton())
    expect(push).toHaveBeenCalledWith(`/logs?view=trace&trace=${longName}`, { scroll: false })
  })

  it('searches all versions when the version is empty, and also on Enter (form submit)', () => {
    render(<LogsPage search={traceSearch} data={traceData({ installs: [], truncated: false })} />)
    fireEvent.change(nameInput(), { target: { value: 'ms' } })
    fireEvent.change(versionInput(), { target: { value: '' } })
    fireEvent.submit(nameInput().closest('form')!)
    expect(push).toHaveBeenCalledWith('/logs?view=trace&trace=ms', { scroll: false })
  })

  it.each(['', '   '])('does not search without a package name: "%s"', (name) => {
    render(<LogsPage search={traceView} data={traceData(null)} />)
    fireEvent.change(nameInput(), { target: { value: name } })
    fireEvent.change(versionInput(), { target: { value: '4.4.3' } })
    fireEvent.click(searchButton())
    fireEvent.submit(nameInput().closest('form')!)
    expect(push).not.toHaveBeenCalled()
  })

  it('fills the form from the address, follows address changes and keeps unsent typing otherwise', () => {
    const { rerender } = render(<LogsPage search={traceSearch} data={traceData({ installs: [], truncated: false })} />)
    expect(nameInput()).toHaveValue('debug')
    expect(versionInput()).toHaveValue('4.4.3')
    fireEvent.change(nameInput(), { target: { value: 'typed-only' } })
    // Root 선택처럼 trace 값이 그대로인 주소 변경에는 입력 중이던 값을 지킵니다.
    rerender(<LogsPage search={{ ...traceSearch, root: rootId }} data={traceData({ installs: [], truncated: false })} />)
    expect(nameInput()).toHaveValue('typed-only')
    // 뒤로 가기처럼 trace 값이 바뀐 주소는 입력란에 반영합니다.
    rerender(<LogsPage search={{ ...traceView, trace: 'ms' }} data={traceData({ installs: [], truncated: false })} />)
    expect(nameInput()).toHaveValue('ms')
    expect(versionInput()).toHaveValue('')
  })

  it('lists root installs with time, user, root package, matched version and result', () => {
    const blocked = { ...install, rootRequestId: '5a4298e8-0000-4000-8000-0000000000c3', outcome: 'BLOCKED', decision: null } as const
    render(<LogsPage search={traceSearch} data={traceData({ installs: [install, unrecorded, blocked], truncated: false })} />)
    expect(installTable().getAllByRole('columnheader').map((header) => header.textContent))
      .toEqual(['시각', '사용자', 'Root 패키지', '포함된 버전', '결과'])
    const rows = installTable().getAllByRole('row').slice(1).map((row) => within(row))
    expect(rows).toHaveLength(3)

    expect(rows[0].getByText(/10:00/u)).toBeInTheDocument()
    expect(rows[0].getByText('alice')).toBeInTheDocument()
    expect(rows[0].getByRole('link', { name: 'express@5.2.1' })).toBeInTheDocument()
    expect(rows[0].getByText('4.4.3')).toBeInTheDocument()
    expect(rows[0].getByText('전달').className).toContain('delivered')

    // 설치 기록(download_events)이 없으면 저장된 이력 시각을 보여 주고 사용자·결과는 "기록 없음"입니다.
    // 이력은 인증된 요청에만 생기므로 "로그인 안 함"으로 보여 주면 안 됩니다.
    expect(rows[1].getByText(/11:30/u)).toBeInTheDocument()
    expect(rows[1].queryByText('로그인 안 함')).not.toBeInTheDocument()
    expect(rows[1].getByRole('link', { name: 'is-odd@3.0.1' })).toBeInTheDocument()
    expect(rows[1].getByText('6.0.0')).toBeInTheDocument()
    expect(rows[1].getAllByText('기록 없음')).toHaveLength(2)

    // 판정 전에 차단된 요청은 설치 기록 목록과 같이 "판정 대기"(중립 색)입니다.
    expect(rows[2].getByText('판정 대기').className).toContain('neutral')
  })

  it('links each root to its dependency list keeping view=trace, and marks the selected one', () => {
    render(<LogsPage search={{ ...traceSearch, q: 'x', user: 'bob', root: otherId }} data={traceData({ installs: [install, unrecorded], truncated: false })} />)
    const other = installTable().getByRole('link', { name: 'express@5.2.1' })
    expect(other).toHaveAttribute('href', `/logs?view=trace&q=x&user=bob&trace=debug&traceVersion=4.4.3&root=${rootId}`)
    expect(other).not.toHaveAttribute('aria-current')
    expect(other.closest('tr')!.className).not.toContain('selected')
    const selected = installTable().getByRole('link', { name: 'is-odd@3.0.1' })
    expect(selected).toHaveAttribute('href', `/logs?view=trace&q=x&user=bob&trace=debug&traceVersion=4.4.3&root=${otherId}`)
    expect(selected).toHaveAttribute('aria-current', 'true')
    expect(selected.closest('tr')!.className).toContain('selected')
  })

  it('shows the dependencies of the selected root, with the full integrity as title', () => {
    const integrity = `sha512-${'A'.repeat(86)}==`
    render(<LogsPage search={{ ...traceSearch, root: rootId }} data={traceData({ installs: [install], truncated: false }, {
      rootRequestId: rootId, rootPackageName: 'express', rootPackageVersion: '5.2.1',
      dependencies: [{ packageName: '@scope/name', version: '1.0.0', integrity: 'sha512-bbb==' }, { packageName: 'debug', version: '4.4.3', integrity }],
    })} />)
    const section = within(screen.getByRole('region', { name: 'Root 설치의 전체 의존성' }))
    expect(section.getByRole('heading', { level: 3, name: 'Root 설치의 전체 의존성' })).toBeInTheDocument()
    expect(section.getByText('express@5.2.1 · 2개')).toBeInTheDocument()
    const dependencies = within(screen.getByRole('table', { name: 'Root 설치의 전체 의존성' }))
    expect(dependencies.getAllByRole('columnheader').map((header) => header.textContent)).toEqual(['패키지', 'integrity', '판정'])
    expect(dependencies.getAllByRole('row').slice(1).map((row) => row.textContent)).toEqual([
      '@scope/name@1.0.0sha512-bbb==Package에서 보기', `debug@4.4.3${integrity}Package에서 보기`,
    ])
    expect(dependencies.getByText(integrity)).toHaveAttribute('title', integrity)
    // 각 의존성의 판정은 Package 화면에서 그 이름으로 검색해 봅니다(scoped 이름은 인코딩).
    expect(dependencies.getByRole('link', { name: '@scope/name 판정을 Package에서 보기' })).toHaveAttribute('href', '/packages?q=%40scope%2Fname')
    expect(dependencies.getByRole('link', { name: 'debug 판정을 Package에서 보기' })).toHaveAttribute('href', '/packages?q=debug')
  })

  it('opens the dependency list by clicking anywhere on a root install row', () => {
    render(<LogsPage search={{ ...traceSearch, q: 'x' }} data={traceData({ installs: [install, unrecorded], truncated: false })} />)
    const row = installTable().getByRole('link', { name: 'is-odd@3.0.1' }).closest('tr')!
    expect(row.className).toContain('clickableRow')
    fireEvent.click(within(row).getByText('6.0.0'))
    expect(push).toHaveBeenCalledWith(`/logs?view=trace&q=x&trace=debug&traceVersion=4.4.3&root=${otherId}`, { scroll: false })
  })

  it('leaves a click on the root link to the link itself, without a second row navigation', () => {
    render(<LogsPage search={traceSearch} data={traceData({ installs: [install], truncated: false })} />)
    fireEvent.click(installTable().getByText('express'))
    expect(push).not.toHaveBeenCalled()
  })

  it('tells an empty result, truncation and each error apart', () => {
    const { rerender } = render(<LogsPage search={traceSearch} data={traceData({ installs: [], truncated: false })} />)
    expect(tracePanel().getByText('이 패키지가 포함된 Root 설치 기록이 없습니다.')).toBeInTheDocument()
    expect(screen.queryByRole('table', { name: 'Root 설치' })).not.toBeInTheDocument()
    expect(screen.queryByText('최근 200건만 표시합니다.')).not.toBeInTheDocument()

    rerender(<LogsPage search={traceSearch} data={traceData({ installs: [install], truncated: true })} />)
    expect(tracePanel().getByText('최근 200건만 표시합니다.')).toBeInTheDocument()
    expect(installTable().getAllByRole('row')).toHaveLength(2)
    expect(tracePanel().queryByText('이 패키지가 포함된 Root 설치 기록이 없습니다.')).not.toBeInTheDocument()

    rerender(<LogsPage search={traceSearch} data={traceData({ error: 'ROOT_TRACE_UNAVAILABLE' })} />)
    expect(tracePanel().getByRole('alert')).toHaveTextContent('의존성 역추적 결과를 불러오지 못했습니다. DB 연결을 확인해 주세요. (ROOT_TRACE_UNAVAILABLE)')
    expect(screen.queryByRole('table', { name: 'Root 설치' })).not.toBeInTheDocument()

    rerender(<LogsPage search={{ ...traceSearch, root: rootId }} data={traceData({ installs: [install], truncated: false }, { error: 'ROOT_NOT_FOUND' })} />)
    expect(tracePanel().getByRole('alert')).toHaveTextContent('Root 설치의 전체 의존성을 불러오지 못했습니다. (ROOT_NOT_FOUND)')
    expect(installTable().getAllByRole('row')).toHaveLength(2)
    expect(screen.queryByRole('table', { name: 'Root 설치의 전체 의존성' })).not.toBeInTheDocument()
  })

  it('keeps the root detail when the trace itself failed', () => {
    render(<LogsPage search={{ ...traceSearch, root: rootId }} data={traceData({ error: 'ROOT_TRACE_UNAVAILABLE' }, {
      rootRequestId: rootId, rootPackageName: 'express', rootPackageVersion: '5.2.1', dependencies: [],
    })} />)
    expect(tracePanel().getByRole('alert')).toHaveTextContent('(ROOT_TRACE_UNAVAILABLE)')
    expect(screen.getByRole('region', { name: 'Root 설치의 전체 의존성' })).toBeInTheDocument()
    expect(nameInput()).toHaveValue('debug')
  })
})
