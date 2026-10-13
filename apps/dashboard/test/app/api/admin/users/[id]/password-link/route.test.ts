// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { authorize, issuePasswordLink, pool } = vi.hoisted(() => ({
  authorize: vi.fn(),
  issuePasswordLink: vi.fn(),
  pool: { name: 'pool' },
}))

vi.mock('@/lib/auth/server/session', () => ({ authorize }))
vi.mock('@/lib/db', () => ({ getPool: () => pool }))
vi.mock('@/features/admin/server/accounts', () => ({ issuePasswordLink, createUserAccount: vi.fn() }))

import { POST } from '@/app/api/admin/users/[id]/password-link/route'

const ORIGIN = 'http://localhost:5173'
const ID = '00000000-0000-4000-8000-00000000000b'
const LINK = { url: `${ORIGIN}/reset-password?token=abc`, expiresAt: '2026-09-29T04:00:00.000Z' }
const post = (id: string, origin = ORIGIN) =>
  POST(new Request(`${ORIGIN}/api/admin/users/${id}/password-link`, { method: 'POST', headers: { origin } }), {
    params: Promise.resolve({ id }),
  })

describe('POST /api/admin/users/[id]/password-link', () => {
  beforeEach(() => {
    vi.stubEnv('BETTER_AUTH_URL', ORIGIN)
    authorize.mockReset().mockResolvedValue({ session: { user: { id: 'admin-id' } } })
    issuePasswordLink.mockReset()
  })

  it('issues a link as the signed-in admin', async () => {
    issuePasswordLink.mockResolvedValue({ ok: true, link: LINK })

    const response = await post(ID)
    expect(response.status).toBe(201)
    expect(await response.json()).toEqual(LINK)
    expect(authorize).toHaveBeenCalledWith('user:manage')
    expect(issuePasswordLink).toHaveBeenCalledWith(pool, { actorId: 'admin-id', targetId: ID })
  })

  it.each([
    ['SELF_CHANGE_FORBIDDEN', 403],
    ['ACTOR_FORBIDDEN', 403],
    ['USER_NOT_FOUND', 404],
  ])('maps %s to %s', async (code, status) => {
    issuePasswordLink.mockResolvedValue({ ok: false, code })

    const response = await post(ID)
    expect(response.status).toBe(status)
    expect(await response.json()).toEqual({ error: code })
  })

  it('answers 404 for a non-UUID id', async () => {
    expect((await post('abc')).status).toBe(404)
    expect(issuePasswordLink).not.toHaveBeenCalled()
  })

  it('keeps non-admins and other origins out', async () => {
    expect((await post(ID, 'http://localhost:4873')).status).toBe(403)
    authorize.mockResolvedValue({ response: Response.json({ error: 'forbidden' }, { status: 403 }) })
    expect((await post(ID)).status).toBe(403)
    expect(issuePasswordLink).not.toHaveBeenCalled()
  })
})
