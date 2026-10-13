// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { betterAuth } = vi.hoisted(() => ({
  betterAuth: vi.fn((options: unknown) => ({ options })),
}))

vi.mock('better-auth', () => ({ betterAuth }))

describe('getAuth', () => {
  it('does not initialize Better Auth on import and reuses one instance', async () => {
    const { getAuth } = await import('@/lib/auth/server/auth')
    expect(betterAuth).not.toHaveBeenCalled()

    const first = getAuth()
    const second = getAuth()

    expect(first).toBe(second)
    expect(betterAuth).toHaveBeenCalledTimes(1)
  })
})

type AuthOptions = {
  socialProviders?: unknown
  emailVerification?: unknown
  user: { validateUserInfo?: unknown }
  emailAndPassword: {
    enabled?: boolean
    requireEmailVerification?: boolean
    sendResetPassword?: unknown
    revokeSessionsOnPasswordReset?: boolean
  }
}

async function loadOptions(): Promise<AuthOptions> {
  vi.resetModules()
  const { getAuth } = await import('@/lib/auth/server/auth')
  return (getAuth() as unknown as { options: AuthOptions }).options
}

// 메일 인증·Google 로그인 설정이 다시 들어오지 않았는지 확인합니다.
describe('login options', () => {
  beforeEach(() => betterAuth.mockClear())

  it('uses username·password only, with no social provider and no email verification', async () => {
    const options = await loadOptions()
    expect(options.socialProviders).toBeUndefined()
    expect(options.emailVerification).toBeUndefined()
    expect(options.emailAndPassword.enabled).toBe(true)
    expect(options.emailAndPassword.requireEmailVerification).toBe(false)
  })

})

describe('account management options', () => {
  beforeEach(() => betterAuth.mockClear())

  it('has no reset mail callback and signs out every device after a password reset', async () => {
    const { emailAndPassword } = await loadOptions()
    expect(emailAndPassword.sendResetPassword).toBeUndefined()
    expect(emailAndPassword.revokeSessionsOnPasswordReset).toBe(true)
  })

  it('refuses user creation through Better Auth', async () => {
    const options = await loadOptions()
    const { rejectUserCreation } = await import('@/lib/auth/server/hooks')
    expect(options.user.validateUserInfo).toBe(rejectUserCreation)
  })
})
