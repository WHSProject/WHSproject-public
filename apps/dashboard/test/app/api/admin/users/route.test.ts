// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { authorize, createUserAccount, pool } = vi.hoisted(() => ({
  authorize: vi.fn(),
  createUserAccount: vi.fn(),
  pool: { name: 'pool' },
}))

vi.mock('@/lib/auth/server/session', () => ({ authorize }))
vi.mock('@/lib/db', () => ({ getPool: () => pool }))
vi.mock('@/features/admin/server/accounts', () => ({ createUserAccount, issuePasswordLink: vi.fn() }))

import { POST } from '@/app/api/admin/users/route'

const ORIGIN = 'http://localhost:5173'
const LINK = { url: `${ORIGIN}/reset-password?token=abc`, expiresAt: '2026-09-29T04:00:00.000Z' }
const post = (body: unknown, origin = ORIGIN) =>
  POST(new Request(`${ORIGIN}/api/admin/users`, { method: 'POST', headers: { origin }, body: JSON.stringify(body) }))

describe('POST /api/admin/users', () => {
  beforeEach(() => {
    vi.stubEnv('BETTER_AUTH_URL', ORIGIN)
    authorize.mockReset().mockResolvedValue({ session: { user: { id: 'admin-id' } } })
    createUserAccount.mockReset()
  })

  it('creates the account as the signed-in admin and returns the setup link', async () => {
    createUserAccount.mockResolvedValue({ ok: true, id: 'new-id', link: LINK })

    const response = await post({ username: ' Kim_Dev ', role: 'developer' })
    expect(response.status).toBe(201)
    expect(await response.json()).toEqual({ id: 'new-id', ...LINK })
    expect(authorize).toHaveBeenCalledWith('user:manage')
    expect(createUserAccount).toHaveBeenCalledWith(pool, { actorId: 'admin-id', username: 'Kim_Dev', role: 'developer' })
  })

  it.each([{}, { username: 'ab', role: 'viewer' }, { username: 'kim.dev', role: 'viewer' }, { username: 1, role: 'viewer' }])(
    'rejects %j with 400 INVALID_USERNAME',
    async (body) => {
      const response = await post(body)
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ error: 'INVALID_USERNAME' })
      expect(createUserAccount).not.toHaveBeenCalled()
    },
  )

  it.each([{ username: 'kim_dev' }, { username: 'kim_dev', role: 'owner' }, { username: 'kim_dev', role: 'toString' }])(
    'rejects %j with 400 INVALID_ROLE',
    async (body) => {
      const response = await post(body)
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ error: 'INVALID_ROLE' })
      expect(createUserAccount).not.toHaveBeenCalled()
    },
  )

  it.each([
    ['USERNAME_TAKEN', 409],
    ['ACTOR_FORBIDDEN', 403],
  ])('maps %s to %s', async (code, status) => {
    createUserAccount.mockResolvedValue({ ok: false, code })

    const response = await post({ username: 'kim_dev', role: 'viewer' })
    expect(response.status).toBe(status)
    expect(await response.json()).toEqual({ error: code })
  })

  it('keeps non-admins out with the permission check response (403)', async () => {
    authorize.mockResolvedValue({ response: Response.json({ error: 'forbidden' }, { status: 403 }) })

    expect((await post({ username: 'kim_dev', role: 'admin' })).status).toBe(403)
    expect(createUserAccount).not.toHaveBeenCalled()
  })

  it('rejects requests from another origin before checking the session', async () => {
    const response = await post({ username: 'kim_dev', role: 'admin' }, 'http://localhost:4873')
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: 'INVALID_ORIGIN' })
    expect(authorize).not.toHaveBeenCalled()
  })
})
