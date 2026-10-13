import { describe, expect, it } from 'vitest'

import { packagesHref, readPackageSearch } from '@/features/packages/model/query'

describe('package search params', () => {
  it('reads valid values and falls back to defaults for missing, invalid or repeated ones', () => {
    expect(readPackageSearch({ q: '  lodash ', decision: 'REJECT', page: '3', selected: 'dec_1' }))
      .toEqual({ q: 'lodash', decision: 'REJECT', page: 3, selected: 'dec_1' })
    expect(readPackageSearch({})).toEqual({ q: '', decision: 'ALL', page: 1, selected: undefined })
    expect(readPackageSearch({ decision: 'reject', page: '0', selected: '' })).toEqual({ q: '', decision: 'ALL', page: 1, selected: undefined })
    expect(readPackageSearch({ page: '1.5' }).page).toBe(1)
    expect(readPackageSearch({ q: ['a', 'b'], decision: ['HOLD', 'REJECT'] })).toMatchObject({ q: '', decision: 'ALL' })
    expect(readPackageSearch({ q: 'x'.repeat(150) }).q).toHaveLength(100)
  })

  it('builds the address and leaves out default values', () => {
    expect(packagesHref({ q: '', decision: 'ALL', page: 1 })).toBe('/packages')
    expect(packagesHref({ q: '@ctrl/tiny color', decision: 'HOLD', page: 2, selected: 'dec_9' }))
      .toBe('/packages?q=%40ctrl%2Ftiny+color&decision=HOLD&page=2&selected=dec_9')
  })
})
