// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getSession } = vi.hoisted(() => ({ getSession: vi.fn() }))

vi.mock('@/lib/auth/server/session', () => ({ getSession }))
vi.mock('next/navigation', () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT ${url}`)
  }),
}))
vi.mock('@/features/auth', () => ({
  LoginPage: (props: unknown) => ({ page: 'login', props }),
}))

import LoginRoute from '@/app/(auth)/login/page'

const params = (value: Record<string, string>) => ({ searchParams: Promise.resolve(value) })

describe('auth routes', () => {
  beforeEach(() => getSession.mockReset())

  it('login sends a signed-in user to the (safe) callback page', async () => {
    getSession.mockResolvedValue({ user: { id: 'u1' } })
    await expect(LoginRoute(params({ callbackURL: '/requests' }))).rejects.toThrow('REDIRECT /requests')
    await expect(LoginRoute(params({ callbackURL: '//evil.example' }))).rejects.toThrow('REDIRECT /')
  })

  it('login renders the form with a sanitized callback when signed out', async () => {
    getSession.mockResolvedValue(null)
    const element = (await LoginRoute(params({ callbackURL: '/login' }))) as { props: { callbackURL: string } }
    expect(element.props).toEqual({ callbackURL: '/', notice: undefined })
  })

  it('login passes only known notices (e.g. after a password change)', async () => {
    getSession.mockResolvedValue(null)
    const known = (await LoginRoute(params({ notice: 'password-changed' }))) as { props: { notice?: string } }
    expect(known.props.notice).toBe('password-changed')

    const unknown = (await LoginRoute(params({ notice: '<script>' }))) as { props: { notice?: string } }
    expect(unknown.props.notice).toBeUndefined()
  })
})
