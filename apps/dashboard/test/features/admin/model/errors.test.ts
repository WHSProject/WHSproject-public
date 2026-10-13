// @vitest-environment node
import { describe, expect, it } from 'vitest'

import { ADMIN_REQUEST_FAILED_MESSAGE, adminErrorMessage } from '@/features/admin/model/errors'

describe('adminErrorMessage', () => {
  it('turns API error codes into messages and falls back for unknown codes', () => {
    expect(adminErrorMessage('LAST_ADMIN')).toBe('마지막 Admin은 강등하거나 비활성화할 수 없습니다.')
    expect(adminErrorMessage('forbidden')).toBe('이 작업을 할 권한이 없습니다.')
    for (const code of ['SOMETHING_NEW', 'constructor', undefined, 42]) {
      expect(adminErrorMessage(code)).toBe(ADMIN_REQUEST_FAILED_MESSAGE)
    }
  })
})
