// @vitest-environment node
import { describe, expect, it } from 'vitest'

import { adminActionError } from '@/features/admin/server/admin-api'

describe('adminActionError', () => {
  it.each([
    ['ACTOR_FORBIDDEN', 403],
    ['SELF_CHANGE_FORBIDDEN', 403],
    ['USER_NOT_FOUND', 404],
    ['INVALID_ROLE', 400],
    ['LAST_ADMIN', 409],
  ] as const)('maps %s to HTTP %s', async (code, status) => {
    const response = adminActionError(code)
    expect(response.status).toBe(status)
    expect(await response.json()).toEqual({ error: code })
  })
})
