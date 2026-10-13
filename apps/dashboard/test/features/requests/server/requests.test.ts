// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'

import { loadRequestsPage } from '@/features/requests/server/requests'
import { listRootRequests } from '@/lib/download-events/server/download-events'
import type { RootRequest } from '@/lib/download-events/types'

vi.mock('@/lib/download-events/server/download-events', () => ({ listRootRequests: vi.fn() }))

const now = new Date('2026-10-02T03:00:00Z') // 한국 시간 10-02(금) 12:00
const all = { q: '', decision: 'ALL' as const }
const request = (requestId: string, occurredAt: string): RootRequest => ({
  requestId, occurredAt, username: 'alice', packageName: 'express', version: '5.0.0',
  outcome: 'DELIVERED', decision: 'ACCEPT', decisionId: 'd1',
})

afterEach(() => { vi.resetAllMocks(); vi.restoreAllMocks() })

describe('requests page data', () => {
  it('queries the last 7 Korean dates and groups returned rows without changing their order', async () => {
    const items = [
      request('r1', '2026-10-02T02:00:00Z'),
      request('r2', '2026-10-01T15:00:00Z'),
      request('r3', '2026-10-01T14:59:59Z'),
      request('r4', '2026-09-25T15:00:00Z'),
    ]
    vi.mocked(listRootRequests).mockResolvedValue(items)
    const data = await loadRequestsPage(all, now)
    expect(listRootRequests).toHaveBeenCalledWith({ from: new Date('2026-09-25T15:00:00Z'), to: now, ...all })
    expect(data).toEqual({ total: 4, days: [
      { date: '2026-10-02', label: '오늘', items: items.slice(0, 2) },
      { date: '2026-10-01', label: '어제', items: [items[2]] },
      { date: '2026-09-26', label: '9월 26일 (토)', items: [items[3]] },
    ] })
  })

  it('passes search and decision filters and preserves an empty result', async () => {
    vi.mocked(listRootRequests).mockResolvedValue([])
    expect(await loadRequestsPage({ q: 'KIM%_', decision: 'REJECT' }, now)).toEqual({ days: [], total: 0 })
    expect(listRootRequests).toHaveBeenCalledWith({ from: new Date('2026-09-25T15:00:00Z'), to: now, q: 'KIM%_', decision: 'REJECT' })
  })

  it('returns an error code and logs the cause when the database fails', async () => {
    const error = new Error('unavailable')
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(listRootRequests).mockRejectedValue(error)
    expect(await loadRequestsPage(all, now)).toEqual({ error: 'DOWNLOAD_EVENTS_UNAVAILABLE' })
    expect(log).toHaveBeenCalledWith('설치 요청 조회 실패', error)
  })
})
