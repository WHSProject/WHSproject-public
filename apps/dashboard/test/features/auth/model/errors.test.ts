// @vitest-environment node
import { describe, expect, it } from 'vitest'

import { loginErrorMessage, RATE_LIMITED_MESSAGE, resetPasswordErrorMessage } from '@/features/auth/model/errors'
import { PASSWORD_RULE_MESSAGE, passwordError, USERNAME_RULE_MESSAGE, usernameError } from '@/lib/auth/common/validation'

describe('auth error messages', () => {
  it('uses one login failure message so account existence is not revealed', () => {
    const wrongPassword = loginErrorMessage({ status: 401, code: 'INVALID_USERNAME_OR_PASSWORD' })
    expect(loginErrorMessage({ status: 422, code: 'INVALID_USERNAME' })).toBe(wrongPassword)
    expect(loginErrorMessage(undefined)).toBe(wrongPassword)
  })

  it('explains ban and rate limit on login', () => {
    expect(loginErrorMessage({ status: 403, code: 'BANNED_USER' })).toContain('사용이 중지')
    expect(loginErrorMessage({ status: 429 })).toBe(RATE_LIMITED_MESSAGE)
  })

  it('maps reset errors', () => {
    expect(resetPasswordErrorMessage({ code: 'INVALID_TOKEN' })).toContain('만료')
    expect(resetPasswordErrorMessage({ code: 'PASSWORD_TOO_SHORT' })).toBe(PASSWORD_RULE_MESSAGE)
    expect(resetPasswordErrorMessage({ status: 429 })).toBe(RATE_LIMITED_MESSAGE)
  })
})

describe('auth input rules', () => {
  it.each(['john_1', 'John_1', ' me_1 ', 'abc'])('accepts username %j', (value) => {
    expect(usernameError(value)).toBeUndefined()
  })

  it.each(['ab', 'a.b', 'a'.repeat(31), '정환희'])('rejects username %j', (value) => {
    expect(usernameError(value)).toBe(USERNAME_RULE_MESSAGE)
  })

  it('requires 8 to 128 characters for passwords', () => {
    expect(passwordError('1234567')).toBe(PASSWORD_RULE_MESSAGE)
    expect(passwordError('12345678')).toBeUndefined()
    expect(passwordError('x'.repeat(129))).toBe(PASSWORD_RULE_MESSAGE)
  })
})
