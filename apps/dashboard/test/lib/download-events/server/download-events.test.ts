// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'

import {
  findRequesters, listDownloadEvents, listDownloadUsernames, listRootDependencies, listRootInstallsContaining,
  listRootRequests, LOG_PAGE_SIZE, ROOT_TRACE_LIMIT,
} from '@/lib/download-events/server/download-events'

import type { Queryable } from '@/lib/db'

const now = new Date('2026-10-02T03:00:00Z')
const sevenDaysFrom = new Date('2026-09-25T15:00:00Z')
const rootQuery = { from: sevenDaysFrom, to: now, q: "KiM%_'", decision: 'ALL' as const }

describe('root request DB reads', () => {
  it('binds filters and maps rows including undecided and unauthenticated requests', async () => {
    const row = {
      request_id: 'r1', occurred_at: now, username: 'kim', package_name: '@scope/pkg',
      version: '1.0.0', outcome: 'DELIVERED', decision: 'ACCEPT', decision_id: 'd1',
    }
    const query = vi.fn().mockResolvedValue({ rows: [row, {
      ...row, request_id: 'r2', username: null, outcome: 'UNAUTHENTICATED', decision: null, decision_id: null,
    }] })
    expect(await listRootRequests(rootQuery, { query } as Queryable)).toEqual([
      { requestId: 'r1', occurredAt: now.toISOString(), username: 'kim', packageName: '@scope/pkg', version: '1.0.0', outcome: 'DELIVERED', decision: 'ACCEPT', decisionId: 'd1' },
      { requestId: 'r2', occurredAt: now.toISOString(), username: null, packageName: '@scope/pkg', version: '1.0.0', outcome: 'UNAUTHENTICATED', decision: null, decisionId: null },
    ])
    const [sql, values] = query.mock.calls[0]
    expect(values).toEqual([sevenDaysFrom, now, rootQuery.q, null])
    expect(sql).not.toContain(rootQuery.q)
    expect(sql).toContain('WHERE is_root')
    expect(sql).toContain('occurred_at >= $1 AND occurred_at <= $2')
    expect(sql).toContain('position(lower($3) in lower(package_name)) > 0')
    expect(sql).toContain("position(lower($3) in lower(coalesce(username, ''))) > 0")
    expect(sql).toContain('($4::text IS NULL OR decision = $4)')
    expect(sql).toContain('ORDER BY occurred_at DESC, id')
  })

  it.each(['ACCEPT', 'REJECT', 'HOLD', 'REVIEW'] as const)('binds the %s decision and an empty search', async (decision) => {
    const query = vi.fn().mockResolvedValue({ rows: [] })
    expect(await listRootRequests({ ...rootQuery, q: '', decision }, { query } as Queryable)).toEqual([])
    expect(query.mock.calls[0][1]).toEqual([sevenDaysFrom, now, '', decision])
  })

  it('finds users by request ids, preserves null and leaves absent ids out', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ request_id: 'r1', username: 'kim' }, { request_id: 'r2', username: null }] })
    const result = await findRequesters(['r1', 'r2', 'missing'], { query } as Queryable)
    expect([...result]).toEqual([['r1', 'kim'], ['r2', null]])
    expect(result.has('missing')).toBe(false)
    expect(query.mock.calls[0][0]).toContain('SELECT request_id, username FROM download_events WHERE request_id = ANY($1)')
    expect(query.mock.calls[0][1]).toEqual([['r1', 'r2', 'missing']])
  })

  it('does not query for an empty id list', async () => {
    const query = vi.fn()
    expect(await findRequesters([], { query } as Queryable)).toEqual(new Map())
    expect(query).not.toHaveBeenCalled()
  })

  it('propagates query failures to loaders', async () => {
    const error = new Error('unavailable')
    const db = { query: vi.fn().mockRejectedValue(error) } as Queryable
    await expect(listRootRequests(rootQuery, db)).rejects.toBe(error)
    await expect(findRequesters(['r1'], db)).rejects.toBe(error)
  })
})

const dbRow = {
  id: 'event-1', occurred_at: new Date('2026-10-04T15:00:00Z'), request_id: 'req-1',
  user_id: 'user-1', username: 'alice', source_ip: '10.0.0.1', package_name: '@scope/name',
  version: '5.0.0', outcome: 'DELIVERED', decision: 'ACCEPT', http_status: 200,
}
const eventQuery = { from: sevenDaysFrom, to: now, q: "EXPRESS@5%_'", user: 'alice', page: 1 }

describe('download events DB reads', () => {
  it('binds parameters in order and maps pg rows to client data', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [dbRow, {
      ...dbRow, id: 'event-2', user_id: null, username: null, source_ip: null, decision: null, http_status: null,
    }] })
    const result = await listDownloadEvents(eventQuery, { query } as Queryable)
    const [sql, values] = query.mock.calls[0]
    expect(values).toEqual([sevenDaysFrom, now, "EXPRESS@5%_'", 'alice', 0])
    expect(sql).not.toContain(eventQuery.q)
    expect(sql).toContain('host(source_ip) AS source_ip')
    expect(sql).toContain('occurred_at >= $1 AND occurred_at < $2')
    expect(sql).toContain("position(lower($3) in lower(package_name || '@' || version)) > 0")
    expect(sql).toContain("($4 = '__anonymous__' AND username IS NULL)")
    expect(sql).toContain('ORDER BY occurred_at DESC, id')
    expect(sql).toContain('LIMIT 51 OFFSET $5')
    expect(result).toEqual({ hasNext: false, events: [
      { id: 'event-1', occurredAt: '2026-10-04T15:00:00.000Z', requestId: 'req-1', userId: 'user-1', username: 'alice', sourceIp: '10.0.0.1', packageName: '@scope/name', version: '5.0.0', outcome: 'DELIVERED', decision: 'ACCEPT', httpStatus: 200 },
      { id: 'event-2', occurredAt: '2026-10-04T15:00:00.000Z', requestId: 'req-1', userId: null, username: null, sourceIp: null, packageName: '@scope/name', version: '5.0.0', outcome: 'DELIVERED', decision: null, httpStatus: null },
    ] })
  })

  it('reads 50 rows per page and tells from the 51st row whether another page follows', async () => {
    expect(LOG_PAGE_SIZE).toBe(50)
    for (const [count, hasNext] of [[0, false], [1, false], [50, false], [51, true]] as const) {
      const query = vi.fn().mockResolvedValue({ rows: Array.from({ length: count }, (_, i) => ({ ...dbRow, id: `event-${i}` })) })
      const result = await listDownloadEvents({ ...eventQuery, user: '__anonymous__' }, { query } as Queryable)
      expect(result.events).toHaveLength(Math.min(count, 50))
      expect(result.hasNext).toBe(hasNext)
      // 51번째 행은 다음 페이지 판단에만 쓰고 돌려주지 않습니다.
      if (count > 0) expect(result.events.at(-1)?.id).toBe(`event-${Math.min(count, 50) - 1}`)
      expect(query.mock.calls[0][1][3]).toBe('__anonymous__')
    }
  })

  it.each([[1, 0], [2, 50], [3, 100], [99999, 4_999_900]])('binds OFFSET for page %i as %i, never in the SQL text', async (page, offset) => {
    const query = vi.fn().mockResolvedValue({ rows: [] })
    await listDownloadEvents({ ...eventQuery, page }, { query } as Queryable)
    const [sql, values] = query.mock.calls[0]
    expect(values).toEqual([sevenDaysFrom, now, "EXPRESS@5%_'", 'alice', offset])
    expect(sql).toContain('OFFSET $5')
    expect(sql).not.toContain(String(offset || 'OFFSET 0'))
  })

  it('keeps the filters and the stable order on every page', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] })
    await listDownloadEvents({ ...eventQuery, page: 2 }, { query } as Queryable)
    const sql = query.mock.calls[0][0] as string
    expect(sql).toContain('WHERE occurred_at >= $1 AND occurred_at < $2')
    expect(sql).toContain("position(lower($3) in lower(package_name || '@' || version)) > 0")
    expect(sql).toContain("($4 = '__anonymous__' AND username IS NULL) OR username = $4")
    // 같은 시각의 행이 있어도 id로 순서가 고정되어 페이지 사이에 중복·누락이 없습니다.
    expect(sql.replace(/\s+/gu, ' ')).toContain('ORDER BY occurred_at DESC, id LIMIT 51 OFFSET $5')
  })

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects an invalid page without querying: %s', async (page) => {
    const query = vi.fn()
    await expect(listDownloadEvents({ ...eventQuery, page }, { query } as Queryable)).rejects.toThrow(RangeError)
    expect(query).not.toHaveBeenCalled()
  })

  it('reads distinct non-null usernames from the same half-open range', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ username: 'alice' }, { username: 'bob' }] })
    expect(await listDownloadUsernames({ from: sevenDaysFrom, to: now }, { query } as Queryable)).toEqual(['alice', 'bob'])
    expect(query.mock.calls[0][1]).toEqual([sevenDaysFrom, now])
    expect(query.mock.calls[0][0]).toContain('SELECT DISTINCT username')
    expect(query.mock.calls[0][0]).toContain('occurred_at >= $1 AND occurred_at < $2 AND username IS NOT NULL')
    expect(query.mock.calls[0][0]).toContain('ORDER BY username')
  })

  it('propagates database errors to the loader', async () => {
    const error = new Error('unavailable')
    const db = { query: vi.fn().mockRejectedValue(error) } as Queryable
    await expect(listDownloadEvents(eventQuery, db)).rejects.toBe(error)
    await expect(listDownloadUsernames(eventQuery, db)).rejects.toBe(error)
  })
})

const rootId = '5a4298e8-0000-4000-8000-0000000000a1'
const installRow = {
  root_request_id: rootId, root_package_name: 'express', root_package_version: '5.2.1', matched_version: '4.4.3',
  captured_at: new Date('2026-10-04T15:00:01Z'), username: 'alice', user_id: 'user-1',
  occurred_at: new Date('2026-10-04T15:00:00Z'), outcome: 'DELIVERED', decision: 'ACCEPT',
}
const traceQuery = { packageName: 'DEBUG', version: '4.4.3' }

describe('root install trace DB reads', () => {
  it('binds the package and version, joins events on the root request id, and maps pg rows', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [installRow] })
    const result = await listRootInstallsContaining(traceQuery, { query } as Queryable)
    const [sql, values] = query.mock.calls[0]
    expect(values).toEqual(['DEBUG', '4.4.3'])
    expect(sql).not.toContain('DEBUG')
    expect(sql).toContain('FROM install_dependency_history h')
    expect(sql).toContain('LEFT JOIN download_events e ON e.request_id = h.root_request_id')
    expect(sql).toContain('lower(h.package_name) = lower($1)')
    expect(sql).toContain("($2 = '' OR h.package_version = $2)")
    expect(sql).toContain('ORDER BY h.captured_at DESC, h.root_request_id')
    expect(sql).toContain('LIMIT 201')
    expect(result).toEqual({ truncated: false, installs: [{
      rootRequestId: rootId, rootPackageName: 'express', rootPackageVersion: '5.2.1', matchedVersion: '4.4.3',
      username: 'alice', userId: 'user-1', occurredAt: '2026-10-04T15:00:00.000Z', capturedAt: '2026-10-04T15:00:01.000Z',
      outcome: 'DELIVERED', decision: 'ACCEPT',
    }] })
  })

  it('keeps an install without a download event, with null user and result', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{
      ...installRow, username: null, user_id: null, occurred_at: null, outcome: null, decision: null,
    }] })
    const { installs } = await listRootInstallsContaining({ packageName: 'is-number', version: '' }, { query } as Queryable)
    expect(query.mock.calls[0][1]).toEqual(['is-number', ''])
    expect(installs).toEqual([expect.objectContaining({
      username: null, userId: null, occurredAt: null, outcome: null, decision: null, capturedAt: '2026-10-04T15:00:01.000Z',
    })])
  })

  it('returns every joined row as is, so duplicate events for one request would repeat the install', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [installRow, installRow] })
    expect((await listRootInstallsContaining(traceQuery, { query } as Queryable)).installs).toHaveLength(2)
  })

  it.each([0, ROOT_TRACE_LIMIT, ROOT_TRACE_LIMIT + 1])('returns at most 200 installs with an accurate truncation flag for %i rows', async (count) => {
    const rows = Array.from({ length: count }, (_, i) => ({ ...installRow, root_request_id: `root-${i}` }))
    const query = vi.fn().mockResolvedValue({ rows })
    const result = await listRootInstallsContaining(traceQuery, { query } as Queryable)
    expect(result.installs).toHaveLength(Math.min(count, ROOT_TRACE_LIMIT))
    expect(result.truncated).toBe(count > ROOT_TRACE_LIMIT)
    if (count > 0) expect(result.installs.at(-1)?.rootRequestId).toBe(`root-${Math.min(count, ROOT_TRACE_LIMIT) - 1}`)
  })

  it('reads the dependencies of one root in package order and takes the root name from the rows', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [
      { root_package_name: 'express', root_package_version: '5.2.1', package_name: '@scope/a', package_version: '1.0.0', integrity: 'sha512-aaa==' },
      { root_package_name: 'express', root_package_version: '5.2.1', package_name: 'debug', package_version: '4.4.3', integrity: 'sha512-bbb==' },
    ] })
    const result = await listRootDependencies(rootId, { query } as Queryable)
    const [sql, values] = query.mock.calls[0]
    expect(values).toEqual([rootId])
    expect(sql).not.toContain(rootId)
    expect(sql).toContain('FROM install_dependency_history')
    expect(sql).toContain('WHERE root_request_id = $1')
    expect(sql).toContain('ORDER BY package_name, package_version')
    expect(result).toEqual({ rootPackageName: 'express', rootPackageVersion: '5.2.1', dependencies: [
      { packageName: '@scope/a', version: '1.0.0', integrity: 'sha512-aaa==' },
      { packageName: 'debug', version: '4.4.3', integrity: 'sha512-bbb==' },
    ] })
  })

  it('returns null for a root without dependency history', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] })
    expect(await listRootDependencies(rootId, { query } as Queryable)).toBeNull()
  })

  it('propagates database errors to the loader', async () => {
    const error = new Error('unavailable')
    const db = { query: vi.fn().mockRejectedValue(error) } as Queryable
    await expect(listRootInstallsContaining(traceQuery, db)).rejects.toBe(error)
    await expect(listRootDependencies(rootId, db)).rejects.toBe(error)
  })
})
