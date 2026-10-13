// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getSession, revokeUserSession, pool } = vi.hoisted(() => ({
  getSession: vi.fn(),
  revokeUserSession: vi.fn(),
  pool: { name: 'pool' },
}))

vi.mock('@/lib/auth/server/session', () => ({ getSession, authorize: vi.fn() }))
vi.mock('@/lib/db', () => ({ getPool: () => pool }))
vi.mock('@/features/settings/server/account', () => ({ revokeUserSession }))

import { DELETE } from '@/app/api/settings/sessions/[id]/route'

const ORIGIN = 'http://localhost:5173'
const CURRENT = '00000000-0000-4000-8000-00000000000c'
const OTHER = '00000000-0000-4000-8000-00000000000d'
const remove = (id: string, origin = ORIGIN) =>
  DELETE(new Request(`${ORIGIN}/api/settings/sessions/${id}`, { method: 'DELETE', headers: { origin } }), {
    params: Promise.resolve({ id }),
  })

describe('DELETE /api/settings/sessions/[id]', () => {
  beforeEach(() => {
    vi.stubEnv('BETTER_AUTH_URL', ORIGIN)
    getSession.mockReset().mockResolvedValue({ user: { id: 'u1' }, session: { id: CURRENT } })
    revokeUserSession.mockReset()
  })

  it('signs out another device of the signed-in user', async () => {
    revokeUserSession.mockResolvedValue(true)

    expect((await remove(OTHER)).status).toBe(204)
    expect(revokeUserSession).toHaveBeenCalledWith(pool, 'u1', OTHER)
  })

  it('answers 404 when the session is not the user’s (or already gone)', async () => {
    revokeUserSession.mockResolvedValue(false)

    const response = await remove(OTHER)
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'SESSION_NOT_FOUND' })
  })

  it('refuses the current session (use the sign-out button) and non-UUID ids', async () => {
    expect((await remove(CURRENT)).status).toBe(400)
    expect((await remove('abc')).status).toBe(404)
    expect(revokeUserSession).not.toHaveBeenCalled()
  })

  // PostgreSQL은 UUID를 대소문자 구분 없이 비교하므로 대문자 표기로 현재 세션 보호를 우회하면 안 됩니다.
  it.each(['abcdef00-0000-4000-8000-00000000000c', 'ABCDEF00-0000-4000-8000-00000000000C', 'AbCdEf00-0000-4000-8000-00000000000c'])(
    'refuses the current session written in any letter case (%s)',
    async (id) => {
      getSession.mockResolvedValue({ user: { id: 'u1' }, session: { id: 'abcdef00-0000-4000-8000-00000000000c' } })

      const response = await remove(id)
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ error: 'CURRENT_SESSION' })
      expect(revokeUserSession).not.toHaveBeenCalled()
    },
  )

  it('passes another session id to the database in lower case', async () => {
    revokeUserSession.mockResolvedValue(true)

    expect((await remove(OTHER.toUpperCase())).status).toBe(204)
    expect(revokeUserSession).toHaveBeenCalledWith(pool, 'u1', OTHER)
  })

  it('requires a signed-in request from the dashboard origin', async () => {
    getSession.mockResolvedValue(null)
    expect((await remove(OTHER)).status).toBe(401)

    expect((await remove(OTHER, 'http://localhost:3000')).status).toBe(403)
    expect(revokeUserSession).not.toHaveBeenCalled()
  })
})
