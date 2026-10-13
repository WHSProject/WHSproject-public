// @vitest-environment node
import { describe, expect, it } from 'vitest'

import { USERNAME_RULE_MESSAGE } from '@/lib/auth/common/validation'
import {
  passwordChangeErrorMessage,
  sessionErrorMessage,
  SETTINGS_REQUEST_FAILED_MESSAGE,
  usernameErrorMessage,
} from '@/features/settings/model/errors'

describe('settings error messages', () => {
  it('explains username errors, including a name change without a username', () => {
    expect(usernameErrorMessage({ code: 'USERNAME_IS_ALREADY_TAKEN' })).toMatch(/이미 사용 중/u)
    expect(usernameErrorMessage({ code: 'NAME_FOLLOWS_USERNAME' })).toBe(USERNAME_RULE_MESSAGE)
    expect(usernameErrorMessage({ status: 429 })).toMatch(/요청이 너무 많습니다/u)
    expect(usernameErrorMessage(null)).toBe(SETTINGS_REQUEST_FAILED_MESSAGE)
  })

  it('explains password and session errors', () => {
    expect(passwordChangeErrorMessage({ code: 'INVALID_PASSWORD' })).toBe('현재 비밀번호가 올바르지 않습니다.')
    expect(passwordChangeErrorMessage({ status: 401 })).toMatch(/로그인이 만료/u)
    expect(sessionErrorMessage({ code: 'CURRENT_SESSION' })).toMatch(/로그아웃 버튼/u)
    expect(sessionErrorMessage({ code: 'SOMETHING' })).toBe(SETTINGS_REQUEST_FAILED_MESSAGE)
  })
})
