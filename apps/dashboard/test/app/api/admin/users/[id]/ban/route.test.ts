// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { authorize, setUserBanned, pool } = vi.hoisted(() => ({
  authorize: vi.fn(),
  setUserBanned: vi.fn(),
  pool: { name: 'pool' },
}))

vi.mock('@/lib/auth/server/session', () => ({ authorize }))
vi.mock('@/lib/db', () => ({ getPool: () => pool }))
vi.mock('@/features/admin/server/users', () => ({ setUserBanned }))

import { DELETE, PUT } from '@/app/api/admin/users/[id]/ban/route'

const ORIGIN = 'http://localhost:5173'
const ID = '00000000-0000-4000-8000-00000000000b'
const call = (handler: typeof PUT, method: string, id = ID) =>
  handler(new Request(`${ORIGIN}/api/admin/users/${id}/ban`, { method, headers: { origin: ORIGIN } }), {
    params: Promise.resolve({ id }),
  })

describe('/api/admin/users/[id]/ban', () => {
  beforeEach(() => {
    vi.stubEnv('BETTER_AUTH_URL', ORIGIN)
    authorize.mockReset().mockResolvedValue({ session: { user: { id: 'admin-id' } } })
    setUserBanned.mockReset().mockResolvedValue({ ok: true, changed: true })
  })

  it('PUT deactivates and DELETE reactivates the user', async () => {
    expect((await call(PUT, 'PUT')).status).toBe(200)
    expect(setUserBanned).toHaveBeenLastCalledWith(pool, { actorId: 'admin-id', targetId: ID, banned: true })

    expect((await call(DELETE, 'DELETE')).status).toBe(200)
    expect(setUserBanned).toHaveBeenLastCalledWith(pool, { actorId: 'admin-id', targetId: ID, banned: false })
    expect(authorize).toHaveBeenCalledWith('user:manage')
  })

  it.each([
    ['SELF_CHANGE_FORBIDDEN', 403],
    ['LAST_ADMIN', 409],
    ['USER_NOT_FOUND', 404],
  ])('maps %s to %s', async (code, status) => {
    setUserBanned.mockResolvedValue({ ok: false, code })

    const response = await call(PUT, 'PUT')
    expect(response.status).toBe(status)
    expect(await response.json()).toEqual({ error: code })
  })

  it('answers 404 for a non-UUID id and passes through the permission check', async () => {
    expect((await call(PUT, 'PUT', 'abc')).status).toBe(404)

    authorize.mockResolvedValue({ response: Response.json({ error: 'forbidden' }, { status: 403 }) })
    expect((await call(DELETE, 'DELETE')).status).toBe(403)
    expect(setUserBanned).not.toHaveBeenCalled()
  })
})
