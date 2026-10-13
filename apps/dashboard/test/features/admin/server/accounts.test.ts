// @vitest-environment node
import type { Pool } from 'pg'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createUserAccount, issuePasswordLink, PASSWORD_LINK_TTL_MS } from '@/features/admin/server/accounts'

const ADMIN = '00000000-0000-4000-8000-00000000000a'
const TARGET = '00000000-0000-4000-8000-00000000000b'
const NEW_ID = '00000000-0000-4000-8000-00000000000c'
const NOW = new Date('2026-09-29T03:00:00.000Z')

type Row = Record<string, unknown>

// DB 대신 문장별로 정해 둔 결과를 돌려주고, 실행한 SQL과 값을 순서대로 기록합니다.
function fakePool(participants: Row[], insertError?: unknown) {
  const calls: { sql: string; params?: unknown[] }[] = []
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    calls.push({ sql: sql.replace(/\s+/gu, ' ').trim(), params })
    if (sql.includes('FROM users WHERE id = ANY')) return { rows: participants, rowCount: participants.length }
    if (sql.includes('INSERT INTO users')) {
      if (insertError) throw insertError
      return { rows: [{ id: NEW_ID }], rowCount: 1 }
    }
    return { rows: [], rowCount: 1 }
  })
  const release = vi.fn()
  const pool = { connect: vi.fn(async () => ({ query, release })) } as unknown as Pool
  const sqls = () => calls.map((call) => call.sql)
  return { pool, calls, sqls, release }
}

const admin = { id: ADMIN, role: 'admin', active: true }
const target = { id: TARGET, role: 'viewer', active: true }

beforeEach(() => {
  vi.useFakeTimers({ now: NOW })
  vi.stubEnv('BETTER_AUTH_URL', 'https://argus.internal:8443/some/path')
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

// 링크는 Better Auth 재설정 토큰 형식이어야 /reset-password가 받아 줍니다.
function expectPasswordLink(calls: { sql: string; params?: unknown[] }[], userId: string, url: string) {
  const token = new URL(url).searchParams.get('token') ?? ''
  expect(url).toBe(`https://argus.internal:8443/reset-password?token=${token}`)
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/u)

  const cleared = calls.find((call) => call.sql.startsWith('DELETE FROM verifications'))
  expect(cleared?.sql).toBe(`DELETE FROM verifications WHERE identifier LIKE 'reset-password:%' AND value = $1`)
  expect(cleared?.params).toEqual([userId])
  const inserted = calls.find((call) => call.sql.startsWith('INSERT INTO verifications'))
  expect(inserted?.params).toEqual([`reset-password:${token}`, userId, new Date(NOW.getTime() + PASSWORD_LINK_TTL_MS)])
}

describe('createUserAccount', () => {
  it('creates the user with an automatic email and a one-hour setup link in one transaction', async () => {
    const { pool, calls, sqls, release } = fakePool([admin])

    const result = await createUserAccount(pool, { actorId: ADMIN, username: 'Kim_Dev', role: 'developer' })

    expect(result).toEqual({
      ok: true,
      id: NEW_ID,
      link: { url: expect.any(String), expiresAt: '2026-09-29T04:00:00.000Z' },
    })
    const user = calls.find((call) => call.sql.startsWith('INSERT INTO users'))
    expect(user?.sql).toContain('VALUES ($1, $2, false, $3, $1, $4, false)')
    expect(user?.params).toEqual(['Kim_Dev', 'kim_dev@argus.local', 'kim_dev', 'developer'])
    if (result.ok) expectPasswordLink(calls, NEW_ID, result.link.url)
    expect(sqls()[0]).toBe('BEGIN')
    expect(sqls().at(-1)).toBe('COMMIT')
    expect(release).toHaveBeenCalledOnce()
  })

  it('reports a taken username (unique violation) and rolls back', async () => {
    const { pool, sqls, release } = fakePool([admin], Object.assign(new Error('duplicate'), { code: '23505' }))

    await expect(createUserAccount(pool, { actorId: ADMIN, username: 'kim_dev', role: 'viewer' })).resolves.toEqual({
      ok: false,
      code: 'USERNAME_TAKEN',
    })
    expect(sqls().at(-1)).toBe('ROLLBACK')
    expect(release).toHaveBeenCalledOnce()
  })

  it.each([
    ['demoted', [{ ...admin, role: 'editor' }]],
    ['deactivated', [{ ...admin, active: false }]],
    ['deleted', []],
  ])('refuses when the actor was %s after loading the page', async (_, participants) => {
    const { pool, sqls } = fakePool(participants)

    await expect(createUserAccount(pool, { actorId: ADMIN, username: 'kim_dev', role: 'viewer' })).resolves.toEqual({
      ok: false,
      code: 'ACTOR_FORBIDDEN',
    })
    expect(sqls().some((sql) => sql.startsWith('INSERT'))).toBe(false)
  })

  it('rolls back and rethrows other database errors', async () => {
    const { pool, sqls } = fakePool([admin], new Error('connection lost'))

    await expect(createUserAccount(pool, { actorId: ADMIN, username: 'kim_dev', role: 'viewer' })).rejects.toThrow('connection lost')
    expect(sqls().at(-1)).toBe('ROLLBACK')
  })
})

describe('issuePasswordLink', () => {
  it('replaces the previous link of the target with a new one-hour link', async () => {
    const { pool, calls, sqls } = fakePool([admin, target])

    const result = await issuePasswordLink(pool, { actorId: ADMIN, targetId: TARGET })

    expect(result).toEqual({ ok: true, link: { url: expect.any(String), expiresAt: '2026-09-29T04:00:00.000Z' } })
    if (result.ok) expectPasswordLink(calls, TARGET, result.link.url)
    expect(sqls().at(-1)).toBe('COMMIT')
  })

  // 동시 발급이 서로의 새 토큰을 지우지 못해 링크가 2개 남지 않도록, 대상 행을 먼저 잠그고 지우고 넣습니다.
  it('locks the target row before replacing the link, and locks only the target', async () => {
    const { pool, calls, sqls } = fakePool([admin, target])

    await issuePasswordLink(pool, { actorId: ADMIN, targetId: TARGET })

    const lock = sqls().indexOf('SELECT 1 FROM users WHERE id = $1 FOR UPDATE')
    expect(lock).toBeGreaterThan(sqls().indexOf('BEGIN'))
    expect(calls[lock].params).toEqual([TARGET])
    expect(lock).toBeLessThan(sqls().findIndex((sql) => sql.startsWith('DELETE FROM verifications')))
    expect(sqls().filter((sql) => sql.includes('FOR UPDATE'))).toHaveLength(1)
  })

  it.each([
    ['USER_NOT_FOUND', [admin], TARGET],
    ['SELF_CHANGE_FORBIDDEN', [admin], ADMIN],
    ['ACTOR_FORBIDDEN', [{ ...admin, role: 'viewer' }, target], TARGET],
  ])('refuses with %s without writing', async (code, participants, targetId) => {
    const { pool, sqls } = fakePool(participants)

    await expect(issuePasswordLink(pool, { actorId: ADMIN, targetId })).resolves.toEqual({ ok: false, code })
    expect(sqls().some((sql) => sql.includes('verifications'))).toBe(false)
  })
})
