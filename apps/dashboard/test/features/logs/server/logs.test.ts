// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'

import { loadLogsPage } from '@/features/logs/index.server'
import {
  listDownloadEvents, listDownloadUsernames, listRootDependencies, listRootInstallsContaining,
} from '@/lib/download-events/server/download-events'

vi.mock('@/lib/download-events/server/download-events', () => ({
  listDownloadEvents: vi.fn(), listDownloadUsernames: vi.fn(), listRootInstallsContaining: vi.fn(), listRootDependencies: vi.fn(),
}))

afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

const rootId = '5a4298e8-0000-4000-8000-0000000000a1'
const search = { from: '2026-09-30', to: '2026-10-01', q: 'express@5', user: '__anonymous__', trace: '', traceVersion: '', root: '', view: 'events', page: 1 } as const
const traceView = { ...search, view: 'trace' } as const
const range = { from: new Date('2026-09-29T15:00:00Z'), to: new Date('2026-10-01T15:00:00Z') }
const install = {
  rootRequestId: rootId, rootPackageName: 'express', rootPackageVersion: '5.2.1', matchedVersion: '4.4.3', username: 'alice', userId: 'user-1',
  occurredAt: '2026-10-04T15:00:00.000Z', capturedAt: '2026-10-04T15:00:01.000Z', outcome: 'DELIVERED', decision: 'ACCEPT',
} as const
const dependencies = [{ packageName: 'debug', version: '4.4.3', integrity: 'sha512-aaa==' }]

function mockReads() {
  vi.mocked(listDownloadEvents).mockResolvedValue({ events: [], hasNext: false })
  vi.mocked(listDownloadUsernames).mockResolvedValue(['alice'])
  vi.mocked(listRootInstallsContaining).mockResolvedValue({ installs: [install], truncated: false })
  vi.mocked(listRootDependencies).mockResolvedValue({ rootPackageName: 'express', rootPackageVersion: '5.2.1', dependencies })
}

describe('loadLogsPage, install log tab', () => {
  it('uses Korean midnight through exclusive midnight after the last day, and passes the page', async () => {
    vi.mocked(listDownloadEvents).mockResolvedValue({ events: [], hasNext: true })
    vi.mocked(listDownloadUsernames).mockResolvedValue(['alice', 'bob'])
    expect(await loadLogsPage({ ...search, page: 3 })).toEqual({
      log: { events: [], hasNext: true, usernames: ['alice', 'bob'] }, trace: null, rootDetail: null,
    })
    expect(listDownloadEvents).toHaveBeenCalledWith({ ...range, q: 'express@5', user: '__anonymous__', page: 3 })
    expect(listDownloadUsernames).toHaveBeenCalledWith(range)
  })

  it('reads only the install log, even when the address still has trace and root values', async () => {
    mockReads()
    const data = await loadLogsPage({ ...search, trace: 'debug', traceVersion: '4.4.3', root: rootId })
    expect(listRootInstallsContaining).not.toHaveBeenCalled()
    expect(listRootDependencies).not.toHaveBeenCalled()
    expect(data).toEqual({ log: { events: [], hasNext: false, usernames: ['alice'] }, trace: null, rootDetail: null })
  })

  it('normalizes the address values before reading, including an invalid page', async () => {
    mockReads()
    await loadLogsPage({ ...search, q: '  express ', page: 0 })
    expect(listDownloadEvents).toHaveBeenCalledWith({ ...range, q: 'express', user: '__anonymous__', page: 1 })
  })

  it.each(['events', 'usernames'])('returns a safe error when %s fails', async (failing) => {
    const error = new Error('connection refused')
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    mockReads()
    if (failing === 'events') vi.mocked(listDownloadEvents).mockRejectedValueOnce(error)
    else vi.mocked(listDownloadUsernames).mockRejectedValueOnce(error)
    expect(await loadLogsPage(search)).toEqual({ log: { error: 'DOWNLOAD_EVENTS_UNAVAILABLE' }, trace: null, rootDetail: null })
    expect(log).toHaveBeenCalledWith('설치 기록 조회 실패', error)
  })
})

describe('loadLogsPage, dependency trace tab', () => {
  it('does not read the install log at all', async () => {
    mockReads()
    await loadLogsPage({ ...traceView, trace: 'debug', root: rootId })
    expect(listDownloadEvents).not.toHaveBeenCalled()
    expect(listDownloadUsernames).not.toHaveBeenCalled()
  })

  it('returns empty trace data without trace and root in the address', async () => {
    mockReads()
    expect(await loadLogsPage({ ...traceView, traceVersion: '4.4.3' })).toEqual({ log: null, trace: null, rootDetail: null })
    expect(listRootInstallsContaining).not.toHaveBeenCalled()
    expect(listRootDependencies).not.toHaveBeenCalled()
  })

  it('reads the trace without the date range and the root detail by request id', async () => {
    mockReads()
    expect(await loadLogsPage({ ...traceView, trace: 'debug', traceVersion: '4.4.3', root: rootId })).toEqual({
      log: null,
      trace: { installs: [install], truncated: false },
      rootDetail: { rootRequestId: rootId, rootPackageName: 'express', rootPackageVersion: '5.2.1', dependencies },
    })
    expect(listRootInstallsContaining).toHaveBeenCalledWith({ packageName: 'debug', version: '4.4.3' })
    expect(listRootDependencies).toHaveBeenCalledWith(rootId)
  })

  it('reads the trace alone when only trace is given, and normalizes the address values', async () => {
    mockReads()
    const data = await loadLogsPage({ ...traceView, trace: '  debug ', traceVersion: ' 4.4.3 ', root: 'not-a-uuid' })
    expect(listRootInstallsContaining).toHaveBeenCalledWith({ packageName: 'debug', version: '4.4.3' })
    expect(listRootDependencies).not.toHaveBeenCalled()
    expect(data).toMatchObject({ log: null, trace: { installs: [install] }, rootDetail: null })
  })

  it('keeps the root detail when the trace fails', async () => {
    const error = new Error('connection refused')
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    mockReads()
    vi.mocked(listRootInstallsContaining).mockRejectedValueOnce(error)
    expect(await loadLogsPage({ ...traceView, trace: 'debug', root: rootId })).toEqual({
      log: null,
      trace: { error: 'ROOT_TRACE_UNAVAILABLE' },
      rootDetail: { rootRequestId: rootId, rootPackageName: 'express', rootPackageVersion: '5.2.1', dependencies },
    })
    expect(log).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledWith('의존성 역추적 조회 실패', error)
  })

  it('keeps the trace when the root detail fails or is missing', async () => {
    const error = new Error('connection refused')
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    mockReads()
    vi.mocked(listRootDependencies).mockRejectedValueOnce(error)
    expect(await loadLogsPage({ ...traceView, trace: 'debug', root: rootId })).toEqual({
      log: null,
      trace: { installs: [install], truncated: false },
      rootDetail: { error: 'ROOT_TRACE_UNAVAILABLE' },
    })
    expect(log).toHaveBeenCalledWith('Root 설치 의존성 조회 실패', error)

    log.mockClear()
    vi.mocked(listRootDependencies).mockResolvedValueOnce(null)
    expect(await loadLogsPage({ ...traceView, root: rootId })).toMatchObject({ log: null, rootDetail: { error: 'ROOT_NOT_FOUND' } })
    expect(log).not.toHaveBeenCalled()
  })
})
