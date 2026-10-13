// @vitest-environment node
import { describe, expect, it } from 'vitest'

import {
  NAME_FOLLOWS_USERNAME,
  passwordChangedUserId,
  rejectDisabledAuthPath,
  rejectNonStringUsername,
  rejectUserCreation,
  syncUserUpdate,
  USER_CREATION_DISABLED,
} from '@/lib/auth/server/hooks'

describe('syncUserUpdate (profile changes)', () => {
  // 자동 이메일도 username을 따라가야 옛 username으로 새 계정을 만들 때 겹치지 않습니다.
  it('changes the display username, name and automatic email together with the username', () => {
    expect(syncUserUpdate({ username: 'new_name', displayUsername: 'New_Name', name: 'ignored' })).toEqual({
      username: 'new_name',
      displayUsername: 'New_Name',
      name: 'New_Name',
      email: 'new_name@argus.local',
    })
  })

  it('keeps the display username to a case change of the username', () => {
    expect(syncUserUpdate({ username: 'alice_1', displayUsername: 'Bob_2' })).toMatchObject({
      displayUsername: 'alice_1',
      name: 'alice_1',
    })
  })

  it.each([{ name: 'Hacker' }, { displayUsername: 'Hacker' }, { name: 'Hacker', image: null }])(
    'rejects changing name or display name without a username (%j)',
    (data) => {
      expect(() => syncUserUpdate(data)).toThrow(expect.objectContaining({ body: expect.objectContaining({ code: NAME_FOLLOWS_USERNAME }) }))
    },
  )

  it.each([{ name: null }, { displayUsername: null }, { name: 123 }, { name: { first: 'Hacker' } }, { displayUsername: null, image: 'x' }])(
    'rejects non-string name or display name without a username (%j)',
    (data) => {
      expect(() => syncUserUpdate(data)).toThrow(expect.objectContaining({ body: expect.objectContaining({ code: NAME_FOLLOWS_USERNAME }) }))
    },
  )

  it.each([{ username: null }, { username: '' }, { username: 123 }, { username: { value: 'a' } }, { username: null, displayUsername: 'Hacker' }])(
    'rejects a username that is not a non-empty string (%j)',
    (data) => {
      expect(() => syncUserUpdate(data)).toThrow(expect.objectContaining({ body: expect.objectContaining({ code: 'INVALID_USERNAME' }) }))
    },
  )

  it('passes other updates through (e.g. email verification, image)', () => {
    const data = { emailVerified: true, name: undefined, image: undefined, username: undefined }
    expect(syncUserUpdate(data)).toBe(data)
    expect(syncUserUpdate({ image: 'x' })).toEqual({ image: 'x' })
  })
})

describe('rejectDisabledAuthPath', () => {
  it.each([
    '/sign-up/email',
    '/sign-in/email',
    '/send-verification-email',
    '/verify-email',
    '/request-password-reset',
    '/sign-in/social',
    '/link-social',
    '/unlink-account',
  ])(
    'answers %s as a missing path (404)',
    (path) => {
      expect(() => rejectDisabledAuthPath(path)).toThrow(
        expect.objectContaining({ statusCode: 404, body: expect.objectContaining({ code: 'NOT_FOUND' }) }),
      )
    },
  )

  it.each(['/sign-in/username', '/sign-out', '/get-session', '/change-password', '/update-user', '/reset-password', undefined])(
    'leaves %s alone',
    (path) => {
      expect(() => rejectDisabledAuthPath(path)).not.toThrow()
    },
  )
})

describe('rejectNonStringUsername (update-user request)', () => {
  it.each([{ username: null }, { username: 123 }, { username: { value: 'a' } }, { username: ['a'] }])('rejects %j', (body) => {
    expect(() => rejectNonStringUsername('/update-user', body)).toThrow(
      expect.objectContaining({ body: expect.objectContaining({ code: 'INVALID_USERNAME' }) }),
    )
  })

  it('leaves string usernames to the username plugin and ignores other requests', () => {
    expect(() => rejectNonStringUsername('/update-user', { username: 'alice_1' })).not.toThrow()
    expect(() => rejectNonStringUsername('/update-user', { username: '' })).not.toThrow()
    expect(() => rejectNonStringUsername('/update-user', { image: 'x' })).not.toThrow()
    expect(() => rejectNonStringUsername('/update-user', undefined)).not.toThrow()
    expect(() => rejectNonStringUsername('/sign-in/username', { username: 123 })).not.toThrow()
  })
})

describe('passwordChangedUserId', () => {
  it('returns the user id only for a successful password change', () => {
    expect(passwordChangedUserId('/change-password', { token: null, user: { id: 'u1' } })).toBe('u1')
    expect(passwordChangedUserId('/update-user', { user: { id: 'u1' } })).toBeUndefined()
    expect(passwordChangedUserId('/change-password', new Error('INVALID_PASSWORD'))).toBeUndefined()
    expect(passwordChangedUserId('/change-password', null)).toBeUndefined()
    expect(passwordChangedUserId(undefined, { user: { id: 'u1' } })).toBeUndefined()
  })
})

describe('rejectUserCreation', () => {
  it('refuses every user creation through Better Auth', async () => {
    await expect(rejectUserCreation()).resolves.toEqual({ error: USER_CREATION_DISABLED })
  })
})
