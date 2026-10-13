// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'

import { listLoginMethods, listUserSessions, revokeUserSession } from '@/features/settings/server/account'
import type { Queryable } from '@/lib/db'

const db = (result: unknown) => {
  const query = vi.fn().mockResolvedValue(result)
  return { db: { query } as unknown as Queryable, query }
}

describe('account queries (always scoped to the signed-in user)', () => {
  it('lists live sessions of the user, marks the current one and never returns tokens', async () => {
    const { db: fake, query } = db({
      rows: [
        { id: 's2', user_agent: 'UA', ip_address: '10.0.0.2', created_at: new Date('2026-09-26T01:00:00Z'), expires_at: new Date('2026-10-03T01:00:00Z') },
        { id: 's1', user_agent: null, ip_address: null, created_at: new Date('2026-09-25T01:00:00Z'), expires_at: new Date('2026-10-02T01:00:00Z') },
      ],
    })

    const sessions = await listUserSessions(fake, 'u1', 's1')
    expect(sessions.map((s) => [s.id, s.current])).toEqual([
      ['s2', false],
      ['s1', true],
    ])
    expect(sessions[0]).toEqual({
      id: 's2',
      userAgent: 'UA',
      ipAddress: '10.0.0.2',
      createdAt: '2026-09-26T01:00:00.000Z',
      expiresAt: '2026-10-03T01:00:00.000Z',
      current: false,
    })
    const [sql, params] = query.mock.calls[0]
    expect(sql).toMatch(/WHERE user_id = \$1 AND expires_at > now\(\)/u)
    expect(sql).not.toMatch(/token/u)
    expect(params).toEqual(['u1'])
  })

  it('lists the login methods of the user', async () => {
    const { db: fake, query } = db({ rows: [{ provider_id: 'credential' }, { provider_id: 'github' }] })

    await expect(listLoginMethods(fake, 'u1')).resolves.toEqual(['credential', 'github'])
    expect(query.mock.calls[0][1]).toEqual(['u1'])
  })

  it.each([
    [1, true],
    [0, false],
  ])('revokes a session only when it belongs to the user (rows: %s)', async (rowCount, revoked) => {
    const { db: fake, query } = db({ rowCount })

    await expect(revokeUserSession(fake, 'u1', 's9')).resolves.toBe(revoked)
    expect(query).toHaveBeenCalledWith('DELETE FROM sessions WHERE id = $1 AND user_id = $2', ['s9', 'u1'])
  })
})
