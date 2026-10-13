// @vitest-environment node
import type { Pool } from 'pg'
import { describe, expect, it, vi } from 'vitest'

import { changeUserRole, listUsers, setUserBanned } from '@/features/admin/server/users'

const ADMIN = '00000000-0000-4000-8000-00000000000a'
const TARGET = '00000000-0000-4000-8000-00000000000b'

type Row = Record<string, unknown>

// DB 대신 문장별로 정해 둔 결과를 돌려주고, 실행한 SQL을 순서대로 기록합니다.
function fakePool({ managers, participants }: { managers: string[]; participants: Row[] }) {
  const statements: string[] = []
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    statements.push(sql.replace(/\s+/gu, ' ').trim())
    if (sql.includes('role = ANY')) return { rows: managers.map((id) => ({ id })), rowCount: managers.length }
    if (sql.includes('id = ANY')) return { rows: participants, rowCount: participants.length }
    if (sql.startsWith('SELECT code, rank')) {
      return { rows: [{ code: 'viewer', rank: 10 }, { code: 'editor', rank: 20 }, { code: 'admin', rank: 30 }], rowCount: 3 }
    }
    return { rows: [], rowCount: params ? 1 : 0 }
  })
  const release = vi.fn()
  const pool = { connect: vi.fn(async () => ({ query, release })) } as unknown as Pool
  return { pool, query, release, statements }
}

const participants = (targetRole: string, targetActive = true) => [
  { id: ADMIN, role: 'admin', active: true },
  { id: TARGET, role: targetRole, active: targetActive },
]

describe('changeUserRole', () => {
  it('passes the actor to the history trigger, locks, updates and ends sessions on demotion in one transaction', async () => {
    const { pool, query, release, statements } = fakePool({ managers: [ADMIN], participants: participants('editor') })

    await expect(changeUserRole(pool, { actorId: ADMIN, targetId: TARGET, role: 'viewer' })).resolves.toEqual({
      ok: true,
      changed: true,
    })

    expect(statements[0]).toBe('BEGIN')
    expect(statements[1]).toBe("SELECT set_config('app.actor_user_id', $1, true)")
    expect(query.mock.calls[1][1]).toEqual([ADMIN])
    expect(statements[2]).toMatch(/FOR UPDATE$/u)
    expect(statements[3]).toMatch(/FOR UPDATE$/u)
    expect(statements).toContain('UPDATE users SET role = $2, updated_at = now() WHERE id = $1')
    expect(statements).toContain('DELETE FROM sessions WHERE user_id = $1')
    expect(statements.at(-1)).toBe('COMMIT')
    expect(release).toHaveBeenCalledOnce()
  })

  it('keeps sessions on promotion', async () => {
    const { pool, statements } = fakePool({ managers: [ADMIN], participants: participants('viewer') })

    await changeUserRole(pool, { actorId: ADMIN, targetId: TARGET, role: 'editor' })
    expect(statements).not.toContain('DELETE FROM sessions WHERE user_id = $1')
    expect(statements.at(-1)).toBe('COMMIT')
  })

  it('rolls back without writing when a rule rejects the change', async () => {
    const { pool, statements, release } = fakePool({ managers: [ADMIN], participants: participants('viewer') })

    await expect(changeUserRole(pool, { actorId: ADMIN, targetId: ADMIN, role: 'viewer' })).resolves.toEqual({
      ok: false,
      code: 'SELF_CHANGE_FORBIDDEN',
    })
    expect(statements.some((sql) => sql.startsWith('UPDATE'))).toBe(false)
    expect(statements.at(-1)).toBe('ROLLBACK')
    expect(release).toHaveBeenCalledOnce()
  })

  it('rolls back and releases the connection when the database fails', async () => {
    const { pool, query, release, statements } = fakePool({ managers: [ADMIN], participants: participants('viewer') })
    query.mockImplementationOnce(async () => {
      throw new Error('connection lost')
    })

    await expect(changeUserRole(pool, { actorId: ADMIN, targetId: TARGET, role: 'editor' })).rejects.toThrow('connection lost')
    expect(statements.at(-1)).toBe('ROLLBACK')
    expect(release).toHaveBeenCalledOnce()
  })
})

describe('setUserBanned', () => {
  it('deactivates and ends the target sessions', async () => {
    const { pool, query, statements } = fakePool({ managers: [ADMIN], participants: participants('viewer') })

    await expect(setUserBanned(pool, { actorId: ADMIN, targetId: TARGET, banned: true })).resolves.toEqual({
      ok: true,
      changed: true,
    })
    const update = query.mock.calls.find(([sql]) => String(sql).startsWith('UPDATE users SET banned'))
    expect(update?.[1]).toEqual([TARGET, true])
    expect(statements).toContain('DELETE FROM sessions WHERE user_id = $1')
    expect(statements.at(-1)).toBe('COMMIT')
  })

  it('reactivates without deleting sessions', async () => {
    const { pool, query, statements } = fakePool({ managers: [ADMIN], participants: participants('viewer', false) })

    await setUserBanned(pool, { actorId: ADMIN, targetId: TARGET, banned: false })
    const update = query.mock.calls.find(([sql]) => String(sql).startsWith('UPDATE users SET banned'))
    expect(update?.[1]).toEqual([TARGET, false])
    expect(statements).not.toContain('DELETE FROM sessions WHERE user_id = $1')
  })

  it('does not write when nothing changes', async () => {
    const { pool, statements } = fakePool({ managers: [ADMIN], participants: participants('viewer') })

    await expect(setUserBanned(pool, { actorId: ADMIN, targetId: TARGET, banned: false })).resolves.toEqual({
      ok: true,
      changed: false,
    })
    expect(statements.at(-1)).toBe('ROLLBACK')
  })
})

describe('listUsers', () => {
  it('maps rows for the admin screen without emails', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          id: TARGET,
          name: 'A_User',
          username: 'a_user',
          display_username: null,
          role: 'viewer',
          banned: false,
          providers: ['credential'],
          last_login_at: null,
          created_at: new Date('2026-09-26T00:00:00Z'),
        },
      ],
    })

    await expect(listUsers({ query } as unknown as Pool)).resolves.toEqual([
      {
        id: TARGET,
        displayName: 'a_user',
        username: 'a_user',
        role: 'viewer',
        banned: false,
        providers: ['credential'],
        lastLoginAt: null,
        createdAt: '2026-09-26T00:00:00.000Z',
      },
    ])
    expect(String(query.mock.calls[0][0])).not.toMatch(/email/u)
  })
})
