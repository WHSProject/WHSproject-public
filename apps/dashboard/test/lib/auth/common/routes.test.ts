// @vitest-environment node
import { describe, expect, it } from 'vitest'

import { LOGIN_NOTICES, loginNotice, loginURL, safeCallbackURL } from '@/lib/auth/common/routes'

describe('safeCallbackURL', () => {
  it.each(['/', '/requests', '/requests?day=today', '/packages/detail#top'])('keeps the in-site path %s', (value) => {
    expect(safeCallbackURL(value)).toBe(value)
  })

  it.each([
    ['missing', undefined],
    ['array (repeated query)', ['/requests', '/rules']],
    ['absolute URL', 'https://evil.example/phish'],
    ['protocol-relative URL', '//evil.example'],
    ['backslash trick', '/\\evil.example'],
    ['tab trick', '/\t/evil.example'],
    ['API path', '/api/auth/sign-out'],
    ['login page (loop)', '/login'],
    ['login page with query (loop)', '/login?callbackURL=%2F'],
    ['reset password page', '/reset-password'],
    ['relative path', 'requests'],
  ])('falls back to / for %s', (_, value) => {
    expect(safeCallbackURL(value)).toBe('/')
  })
})

describe('loginNotice', () => {
  it('accepts only known notices', () => {
    expect(loginNotice('password-changed')).toBe('password-changed')
    expect(LOGIN_NOTICES['password-changed']).toMatch(/새 비밀번호로 다시 로그인/u)
    for (const value of ['', 'unknown', 'toString', ['password-changed'], undefined]) {
      expect(loginNotice(value), String(value)).toBeUndefined()
    }
  })
})

describe('loginURL', () => {
  it('builds the login address, keeping a non-default page to return to', () => {
    expect(loginURL()).toBe('/login')
    expect(loginURL('/')).toBe('/login')
    expect(loginURL('/requests?day=today')).toBe('/login?callbackURL=%2Frequests%3Fday%3Dtoday')
  })
})
