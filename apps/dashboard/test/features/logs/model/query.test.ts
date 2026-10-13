// @vitest-environment node
import { describe, expect, it } from 'vitest'

import { SEARCH_MAX_LENGTH } from '@/components/ui/SearchField/search'
import { ANONYMOUS_USER, logsHref, readLogSearch, TRACE_MAX_LENGTH } from '@/features/logs/model/query'
import type { LogSearch } from '@/features/logs/types/logs'

const now = new Date('2026-10-04T15:00:00Z')
const defaults = { q: '', user: '', from: '2026-09-29', to: '2026-10-05', trace: '', traceVersion: '', root: '', view: 'events', page: 1 } as const
const rootId = '5a4298e8-0000-4000-8000-0000000000a1'

describe('Logs search parameters', () => {
  it('defaults to seven Korean dates, including today at the UTC boundary', () => {
    expect(readLogSearch({}, now)).toEqual(defaults)
    expect(readLogSearch({}, new Date('2026-10-04T14:59:59Z'))).toEqual({ ...defaults, from: '2026-09-28', to: '2026-10-04' })
  })

  it('normalizes and limits q while preserving exact usernames', () => {
    expect(readLogSearch({ q: '  EXPRESS@5  ', user: ANONYMOUS_USER }, now)).toEqual({ ...defaults, q: 'EXPRESS@5', user: ANONYMOUS_USER })
    expect(readLogSearch({ q: 'x'.repeat(200), user: 'Kim_Dev' }, now)).toMatchObject({ q: 'x'.repeat(SEARCH_MAX_LENGTH), user: 'Kim_Dev' })
  })

  it.each(['2026-02-30', '2025-02-29', '2026-13-01', '2026-9-01', 'invalid', '0000-01-01', ''])('defaults invalid dates: %s', (value) => {
    expect(readLogSearch({ from: value, to: value }, now)).toEqual(defaults)
  })

  it('uses defaults for arrays and accepts leap days', () => {
    expect(readLogSearch({ q: ['x'], user: ['alice'], from: ['2026-01-01'], to: ['2026-02-01'] }, now)).toEqual(defaults)
    expect(readLogSearch({ from: '2024-02-29', to: '2024-02-29' }, now)).toMatchObject({ from: '2024-02-29', to: '2024-02-29' })
  })

  it('swaps reversed dates', () => {
    expect(readLogSearch({ from: '2026-10-05', to: '2026-10-01' }, now)).toMatchObject({ from: '2026-10-01', to: '2026-10-05' })
  })

  it('omits defaults and round-trips partial date parameters', () => {
    expect(logsHref(defaults, now)).toBe('/logs')
    for (const search of [
      { ...defaults, from: '2026-09-01' },
      { ...defaults, to: '2026-10-10' },
      { ...defaults, q: '@scope/name@1%', user: ANONYMOUS_USER, from: '2026-09-01', to: '2026-09-03' },
    ]) {
      const href = logsHref(search, now)
      expect(readLogSearch(Object.fromEntries(new URL(href, 'http://localhost').searchParams), now)).toEqual(search)
    }
  })
})

describe('Logs trace parameters', () => {
  it('trims and limits trace and its version', () => {
    expect(readLogSearch({ trace: '  @Scope/Name  ', traceVersion: ' 4.4.3 ' }, now)).toEqual({ ...defaults, trace: '@Scope/Name', traceVersion: '4.4.3', view: 'trace' })
    // 정확히 일치로 찾으므로 검색창 길이(100자)가 아니라 npm 이름 최대 길이(214자)까지 그대로 둡니다.
    expect(SEARCH_MAX_LENGTH).toBeLessThan(TRACE_MAX_LENGTH)
    expect(readLogSearch({ trace: 'x'.repeat(117), traceVersion: 'y'.repeat(117) }, now))
      .toMatchObject({ trace: 'x'.repeat(117), traceVersion: 'y'.repeat(117) })
    expect(readLogSearch({ trace: 'x'.repeat(300), traceVersion: 'y'.repeat(300) }, now))
      .toMatchObject({ trace: 'x'.repeat(TRACE_MAX_LENGTH), traceVersion: 'y'.repeat(TRACE_MAX_LENGTH) })
  })

  it('ignores the trace version without a trace package', () => {
    expect(readLogSearch({ traceVersion: '4.4.3' }, now)).toEqual(defaults)
    expect(readLogSearch({ trace: '   ', traceVersion: '4.4.3' }, now)).toEqual(defaults)
  })

  it('accepts a request id only in UUID format', () => {
    expect(readLogSearch({ root: rootId }, now).root).toBe(rootId)
    expect(readLogSearch({ root: rootId.toUpperCase() }, now).root).toBe(rootId.toUpperCase())
    for (const root of ['', 'abc', rootId.slice(1), `${rootId}0`, rootId.replace('a1', 'zz'), rootId.replaceAll('-', ''), ` ${rootId}`, "x' OR '1'='1"]) {
      expect(readLogSearch({ root }, now).root).toBe('')
    }
  })

  it('uses defaults for arrays', () => {
    expect(readLogSearch({ trace: ['debug'], traceVersion: ['4.4.3'], root: [rootId] }, now)).toEqual(defaults)
    // 배열 버전은 기본값이지만 trace 자체는 유지합니다.
    expect(readLogSearch({ trace: 'debug', traceVersion: ['4.4.3'] }, now)).toEqual({ ...defaults, trace: 'debug', view: 'trace' })
  })

  it('keeps q, user and the date range next to the trace values', () => {
    expect(readLogSearch({ q: 'express', user: 'alice', from: '2026-09-01', to: '2026-10-01', trace: 'debug', traceVersion: '4.4.3', root: rootId }, now))
      .toEqual({ q: 'express', user: 'alice', from: '2026-09-01', to: '2026-10-01', trace: 'debug', traceVersion: '4.4.3', root: rootId, view: 'trace', page: 1 })
  })

  it('does not change an already normalized search', () => {
    const search = { ...defaults, trace: 'debug', traceVersion: '4.4.3', root: rootId, view: 'trace' } as const
    // loadLogsPage가 하듯 page는 주소 값(문자열)으로 넘깁니다.
    expect(readLogSearch({ ...search, page: String(search.page) }, now)).toEqual(search)
  })

  it('omits empty trace values and keeps the existing parameters first', () => {
    const trace = { ...defaults, view: 'trace' } as const
    expect(logsHref({ ...trace, trace: 'debug' }, now)).toBe('/logs?view=trace&trace=debug')
    expect(logsHref({ ...trace, trace: 'debug', traceVersion: '4.4.3' }, now)).toBe('/logs?view=trace&trace=debug&traceVersion=4.4.3')
    expect(logsHref({ ...trace, root: rootId }, now)).toBe(`/logs?view=trace&root=${rootId}`)
    // trace가 없으면 버전은 주소에 쓰지 않습니다.
    expect(logsHref({ ...defaults, traceVersion: '4.4.3' }, now)).toBe('/logs')
    expect(logsHref({ ...trace, q: 'express', user: 'alice', from: '2026-09-01', to: '2026-10-01', trace: 'debug', traceVersion: '4.4.3', root: rootId }, now))
      .toBe(`/logs?view=trace&q=express&user=alice&from=2026-09-01&to=2026-10-01&trace=debug&traceVersion=4.4.3&root=${rootId}`)
  })

  it('round-trips trace values including scoped names', () => {
    const searches: LogSearch[] = [
      { ...defaults, trace: '@scope/name', view: 'trace' },
      { ...defaults, trace: '@scope/name', traceVersion: '1.0.0-beta+1', root: rootId, view: 'trace' },
      { ...defaults, q: 'a&b', trace: 'x y&z=1%', traceVersion: '1.0.0', from: '2026-09-01', view: 'trace', page: 4 },
      // 설치 기록 탭에 역추적 값이 남아 있어도 탭이 바뀌지 않아야 합니다.
      { ...defaults, trace: 'debug', traceVersion: '4.4.3', root: rootId, view: 'events', page: 2 },
    ]
    for (const search of searches) {
      const href = logsHref(search, now)
      expect(readLogSearch(Object.fromEntries(new URL(href, 'http://localhost').searchParams), now)).toEqual(search)
    }
  })
})

describe('Logs view and page parameters', () => {
  it('opens the install log by default and the trace tab only when asked', () => {
    expect(readLogSearch({ view: 'trace' }, now)).toEqual({ ...defaults, view: 'trace' })
    expect(readLogSearch({ view: 'events' }, now)).toEqual(defaults)
  })

  it('infers the trace tab from a trace package only when view is absent', () => {
    expect(readLogSearch({ trace: 'debug' }, now).view).toBe('trace')
    expect(readLogSearch({ view: 'events', trace: 'debug' }, now)).toMatchObject({ view: 'events', trace: 'debug' })
    expect(readLogSearch({ view: 'trace', trace: 'debug' }, now).view).toBe('trace')
    // 공백뿐인 trace는 값이 없는 것과 같습니다.
    expect(readLogSearch({ trace: '   ' }, now).view).toBe('events')
    // 배열 view는 값이 없는 것으로 보고 같은 추정을 따릅니다.
    expect(readLogSearch({ view: ['trace'] }, now).view).toBe('events')
    expect(readLogSearch({ view: ['events'], trace: 'debug' }, now).view).toBe('trace')
  })

  it.each(['', 'TRACE', 'Events', 'foo', ' trace'])('treats an unknown view value as the install log: "%s"', (view) => {
    expect(readLogSearch({ view, trace: 'debug' }, now).view).toBe('events')
  })

  it.each(['1', '2', '50', '99999'])('accepts page %s', (page) => {
    expect(readLogSearch({ page }, now).page).toBe(Number(page))
  })

  it.each(['0', '-1', '1.5', '01', '100000', '999999999', 'abc', '', ' 2', '2 ', '1e3', '+2', '１２'])('falls back to page 1 for "%s"', (page) => {
    expect(readLogSearch({ page }, now).page).toBe(1)
  })

  it('falls back to page 1 for an array or a missing page', () => {
    expect(readLogSearch({ page: ['2'] }, now).page).toBe(1)
    expect(readLogSearch({}, now).page).toBe(1)
  })

  it('omits the default view and page, and writes view=trace and page>1', () => {
    expect(logsHref(defaults, now)).toBe('/logs')
    expect(logsHref({ ...defaults, page: 1 }, now)).toBe('/logs')
    expect(logsHref({ ...defaults, page: 3 }, now)).toBe('/logs?page=3')
    expect(logsHref({ ...defaults, view: 'trace' }, now)).toBe('/logs?view=trace')
    expect(logsHref({ ...defaults, q: 'express', page: 2 }, now)).toBe('/logs?q=express&page=2')
  })

  it('keeps the other tab values when the tab changes', () => {
    const both = { ...defaults, q: 'express', user: 'alice', trace: 'debug', traceVersion: '4.4.3', root: rootId, page: 3 }
    // 설치 기록 탭: 역추적 값이 남아 있으면 view=events를 명시해야 trace 탭으로 읽히지 않습니다.
    expect(logsHref({ ...both, view: 'events' }, now))
      .toBe(`/logs?view=events&q=express&user=alice&trace=debug&traceVersion=4.4.3&root=${rootId}&page=3`)
    expect(logsHref({ ...both, view: 'trace' }, now))
      .toBe(`/logs?view=trace&q=express&user=alice&trace=debug&traceVersion=4.4.3&root=${rootId}&page=3`)
    for (const view of ['events', 'trace'] as const) {
      const search = { ...both, view }
      expect(readLogSearch(Object.fromEntries(new URL(logsHref(search, now), 'http://localhost').searchParams), now)).toEqual(search)
    }
  })
})
