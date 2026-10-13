// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { authorize, changeUserRole, pool } = vi.hoisted(() => ({
  authorize: vi.fn(),
  changeUserRole: vi.fn(),
  pool: { name: 'pool' },
}))

vi.mock('@/lib/auth/server/session', () => ({ authorize }))
vi.mock('@/lib/db', () => ({ getPool: () => pool }))
vi.mock('@/features/admin/server/users', () => ({ changeUserRole }))

import { PUT } from '@/app/api/admin/users/[id]/role/route'

const ORIGIN = 'http://localhost:5173'
const ID = '00000000-0000-4000-8000-00000000000b'
const put = (id: string, body: unknown, origin = ORIGIN) =>
  PUT(
    new Request(`${ORIGIN}/api/admin/users/${id}/role`, { method: 'PUT', headers: { origin }, body: JSON.stringify(body) }),
    { params: Promise.resolve({ id }) },
  )

describe('PUT /api/admin/users/[id]/role', () => {
  beforeEach(() => {
    vi.stubEnv('BETTER_AUTH_URL', ORIGIN)
    authorize.mockReset().mockResolvedValue({ session: { user: { id: 'admin-id' } } })
    changeUserRole.mockReset()
  })

  it('changes the role as the signed-in admin', async () => {
    changeUserRole.mockResolvedValue({ ok: true, changed: true })

    const response = await put(ID, { role: 'editor' })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ changed: true })
    expect(authorize).toHaveBeenCalledWith('user:manage')
    expect(changeUserRole).toHaveBeenCalledWith(pool, { actorId: 'admin-id', targetId: ID, role: 'editor' })
  })

  it.each([{}, { role: 'owner' }, { role: 'toString' }, { role: 1 }])('rejects %j with 400 INVALID_ROLE', async (body) => {
    const response = await put(ID, body)
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'INVALID_ROLE' })
    expect(changeUserRole).not.toHaveBeenCalled()
  })

  it.each([
    ['SELF_CHANGE_FORBIDDEN', 403],
    ['ACTOR_FORBIDDEN', 403],
    ['USER_NOT_FOUND', 404],
    ['LAST_ADMIN', 409],
  ])('maps %s to %s', async (code, status) => {
    changeUserRole.mockResolvedValue({ ok: false, code })

    const response = await put(ID, { role: 'viewer' })
    expect(response.status).toBe(status)
    expect(await response.json()).toEqual({ error: code })
  })

  it('answers 404 for a non-UUID id', async () => {
    expect((await put('abc', { role: 'viewer' })).status).toBe(404)
    expect(changeUserRole).not.toHaveBeenCalled()
  })

  it('keeps viewers and editors out with the permission check response (403)', async () => {
    authorize.mockResolvedValue({ response: Response.json({ error: 'forbidden' }, { status: 403 }) })

    const response = await put(ID, { role: 'admin' })
    expect(response.status).toBe(403)
    expect(changeUserRole).not.toHaveBeenCalled()
  })

  it('rejects requests from another origin', async () => {
    expect((await put(ID, { role: 'admin' }, 'http://evil.example')).status).toBe(403)
    expect(authorize).not.toHaveBeenCalled()
  })
})
