// @vitest-environment node
import { describe, expect, it } from 'vitest'

import {
  PASSWORD_MISMATCH_MESSAGE,
  PASSWORD_RULE_MESSAGE,
  passwordConfirmError,
  passwordError,
  USERNAME_RULE_MESSAGE,
  usernameError,
} from '@/lib/auth/common/validation'

describe('auth input rules', () => {
  it('checks the username rule (letters, digits, _; 3~30) on the trimmed value', () => {
    expect(usernameError(' Jump_Top ')).toBeUndefined()
    expect(USERNAME_RULE_MESSAGE).toBe('username은 3~30자의 영문, 숫자, _만 사용할 수 있습니다.')
    for (const value of ['ab', 'a.b', 'a b', 'x'.repeat(31), '정환희', 'me@example.com']) {
      expect(usernameError(value), value).toBe(USERNAME_RULE_MESSAGE)
    }
  })

  it('checks the password length (8~128) and the confirmation', () => {
    expect(passwordError('12345678')).toBeUndefined()
    expect(passwordError('1234567')).toBe(PASSWORD_RULE_MESSAGE)
    expect(passwordError('x'.repeat(129))).toBe(PASSWORD_RULE_MESSAGE)
    expect(passwordConfirmError('a', 'a')).toBeUndefined()
    expect(passwordConfirmError('a', 'b')).toBe(PASSWORD_MISMATCH_MESSAGE)
  })
})
