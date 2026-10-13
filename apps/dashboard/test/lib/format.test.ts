// @vitest-environment node
import { describe, expect, it } from 'vitest'

import { formatDateTime } from '@/lib/format'

describe('formatDateTime', () => {
  it('formats times in Korea time and shows - when missing', () => {
    expect(formatDateTime('2026-09-25T15:30:00.000Z')).toBe('2026. 09. 26. 00:30')
    expect(formatDateTime(null)).toBe('-')
  })
})
