// @vitest-environment node
import { describe, expect, it } from 'vitest'

import { versionState } from '@/features/versions/model/versions'

import { summary } from '../../../lib/policy/fixtures'

const state = (version: string, status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED' = 'ARCHIVED', active = '0.1.3') =>
  versionState(summary({ version, status }), active)

describe('versionState', () => {
  it('marks the active version', () => {
    expect(state('0.1.3', 'PUBLISHED')).toBe('active')
  })

  // 다시 적용할 수 있는 것은 Policy 내부 버전(앞 두 자리)이 같은 보관 버전뿐입니다.
  it('allows archived versions of the same Policy internal version only', () => {
    expect(state('0.1.0')).toBe('applicable')
    expect(state('0.1.12')).toBe('applicable')
    expect(state('0.0.9')).toBe('blocked')
    expect(state('0.2.0')).toBe('blocked')
    expect(state('1.1.0')).toBe('blocked')
    expect(state('draft-x')).toBe('blocked')
  })

  it('compares version numbers, not their spelling', () => {
    expect(state('0.01.2')).toBe('applicable')
  })

  it('never allows drafts, even of the same internal version', () => {
    expect(state('0.1.4', 'DRAFT')).toBe('draft')
  })

  it('blocks everything else when the active version is not in 0.x.y form', () => {
    expect(state('0.1.0', 'ARCHIVED', 'v1')).toBe('blocked')
  })
})
