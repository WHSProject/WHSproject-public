// @vitest-environment node
import { describe, expect, it } from 'vitest'

import { providerLabel, roleLabel } from '@/lib/auth/common/labels'

describe('auth labels', () => {
  it('labels login methods and roles, keeping unknown values as they are', () => {
    expect(providerLabel('credential')).toBe('비밀번호')
    expect(providerLabel('google')).toBe('google')
    expect(roleLabel([{ code: 'viewer', name: 'Viewer', description: '', rank: 10 }], 'viewer')).toBe('Viewer')
    expect(roleLabel([], 'owner')).toBe('owner')
  })
})
