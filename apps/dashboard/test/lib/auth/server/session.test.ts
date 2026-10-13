// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getSession, requestHeaders } = vi.hoisted(() => ({
  getSession: vi.fn(),
  requestHeaders: new Headers({ cookie: 'better-auth.session_token=abc' }),
}))

vi.mock('next/headers', () => ({ headers: vi.fn(async () => requestHeaders) }))
vi.mock('next/navigation', () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT ${url}`)
  }),
  forbidden: vi.fn(() => {
    throw new Error('FORBIDDEN')
  }),
}))
vi.mock('@/lib/auth/server/auth', () => ({ getAuth: () => ({ api: { getSession } }) }))

import { authorize, getSession as currentSession, requirePermission, requireSession } from '@/lib/auth/server/session'

const sessionOf = (role: string) => ({ user: { id: 'u1', email: 'a@example.com', role }, session: { id: 's1' } })

describe('session helpers', () => {
  beforeEach(() => getSession.mockReset())

  it('reads the session from the current request headers', async () => {
    getSession.mockResolvedValue(sessionOf('viewer'))

    await expect(currentSession()).resolves.toMatchObject({ user: { role: 'viewer' } })
    expect(getSession).toHaveBeenCalledWith({ headers: requestHeaders })
  })

  it('returns null without touching Better Auth when there is no session cookie', async () => {
    const { headers } = await import('next/headers')
    vi.mocked(headers).mockResolvedValueOnce(new Headers() as Awaited<ReturnType<typeof headers>>)

    await expect(currentSession()).resolves.toBeNull()
    expect(getSession).not.toHaveBeenCalled()
  })

  it('requireSession sends signed-out users to /login', async () => {
    getSession.mockResolvedValue(null)
    await expect(requireSession()).rejects.toThrow('REDIRECT /login')
  })

  it('requirePermission returns the session when the role allows it', async () => {
    getSession.mockResolvedValue(sessionOf('editor'))
    await expect(requirePermission('policy:draft')).resolves.toMatchObject({ user: { role: 'editor' } })
  })

  it('requirePermission shows the 403 page when the role lacks the permission', async () => {
    getSession.mockResolvedValue(sessionOf('viewer'))
    await expect(requirePermission('policy:draft')).rejects.toThrow('FORBIDDEN')
  })

  it('requirePermission sends signed-out users to /login before checking permissions', async () => {
    getSession.mockResolvedValue(null)
    await expect(requirePermission('policy:draft')).rejects.toThrow('REDIRECT /login')
  })
})

describe('authorize (Route Handler)', () => {
  beforeEach(() => getSession.mockReset())

  it('returns 401 when signed out', async () => {
    getSession.mockResolvedValue(null)
    const { response } = await authorize('user:manage')
    expect(response?.status).toBe(401)
  })

  it('returns 403 when the role lacks the permission', async () => {
    getSession.mockResolvedValue(sessionOf('editor'))
    const { response } = await authorize('user:manage')
    expect(response?.status).toBe(403)
    expect(await response?.json()).toEqual({ error: 'forbidden' })
  })

  it('returns the session when allowed', async () => {
    getSession.mockResolvedValue(sessionOf('admin'))
    const { session, response } = await authorize('user:manage')
    expect(response).toBeUndefined()
    expect(session?.user.role).toBe('admin')
  })
})
