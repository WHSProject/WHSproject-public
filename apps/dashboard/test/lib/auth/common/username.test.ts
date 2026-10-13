// @vitest-environment node
import { describe, expect, it } from 'vitest'

import { accountEmail, isValidUsername, normalizeUsername } from '@/lib/auth/common/username'

describe('isValidUsername', () => {
  // 대문자 입력도 받는다. 저장은 username 플러그인이 소문자로 한다.
  it.each(['abc', 'john_1', 'John_1', 'JOHN_1', 'a'.repeat(30), '___'])('accepts %s', (value) => {
    expect(isValidUsername(value)).toBe(true)
  })

  it.each([
    ['too short', 'ab'],
    ['too long', 'a'.repeat(31)],
    ['dot', 'a.b'],
    ['hyphen', 'a-b'],
    ['space', 'john doe'],
    ['email', 'me@example.com'],
    ['Hangul', '정환희'],
    ['Hangul with ASCII', 'Kim_철수'],
    ['Hangul jamo', 'ㄱㄴㄷ'],
    ['Cyrillic look-alike', 'Жора'],
    ['emoji', 'kim😀'],
  ])('rejects %s', (_, value) => {
    expect(isValidUsername(value)).toBe(false)
  })
})

describe('normalizeUsername', () => {
  it('trims only; other characters are left to the rule check', () => {
    expect(normalizeUsername(' Jump_Top ')).toBe('Jump_Top')
    expect(isValidUsername(normalizeUsername(` ${'정환희'.normalize('NFD')} `))).toBe(false)
  })
})

describe('accountEmail', () => {
  // scripts/create-admin.js와 같은 형식이어야 합니다.
  it('builds the automatic email from the lowercase username', () => {
    expect(accountEmail('Kim_Dev')).toBe('kim_dev@argus.local')
  })
})
