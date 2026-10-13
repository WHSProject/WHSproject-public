import { describe, expect, it } from 'vitest'

import { readRequestSearch, requestsHref } from '@/features/requests/model/query'

describe('request search params', () => {
  it('reads valid values and falls back to defaults', () => {
    expect(readRequestSearch({ q: '  kim ', decision: 'HOLD' })).toEqual({ q: 'kim', decision: 'HOLD' })
    expect(readRequestSearch({})).toEqual({ q: '', decision: 'ALL' })
    expect(readRequestSearch({ q: ['a', 'b'], decision: 'hold' })).toEqual({ q: '', decision: 'ALL' })
    expect(readRequestSearch({ q: 'x'.repeat(150) }).q).toHaveLength(100)
  })

  it('builds the address and leaves out default values', () => {
    expect(requestsHref({ q: '', decision: 'ALL' })).toBe('/requests')
    expect(requestsHref({ q: '@ctrl/tiny', decision: 'REJECT' })).toBe('/requests?q=%40ctrl%2Ftiny&decision=REJECT')
  })
})
