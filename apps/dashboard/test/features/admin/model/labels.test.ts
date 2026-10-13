// @vitest-environment node
import { describe, expect, it } from 'vitest'

import { userStatus } from '@/features/admin/model/labels'

describe('admin labels', () => {
  it('puts deactivation before a pending password in the status', () => {
    expect(userStatus({ banned: true, providers: [] })).toBe('banned')
    expect(userStatus({ banned: false, providers: [] })).toBe('pending')
    expect(userStatus({ banned: false, providers: ['credential'] })).toBe('active')
  })
})
