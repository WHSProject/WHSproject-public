// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { requirePermission, loadVersionsPage } = vi.hoisted(() => ({ requirePermission: vi.fn(), loadVersionsPage: vi.fn() }))

vi.mock('@/lib/auth/server/session', () => ({ requirePermission }))
vi.mock('@/features/versions/index.server', () => ({ loadVersionsPage }))

import VersionsRoute from '@/app/(dashboard)/versions/page'
import { VersionsMessage, VersionsPage } from '@/features/versions'

import { rule, summary } from '../../../lib/policy/fixtures'

type Element = { type: unknown; key: string | null; props: Record<string, unknown> }
const route = async (search: Record<string, string | string[]> = {}) =>
  (await VersionsRoute({ searchParams: Promise.resolve(search) })) as unknown as Element
const ready = {
  status: 'ready',
  policyKey: 'qa-npm-policy',
  activeVersion: '0.1.3',
  versions: [summary({ version: '0.1.3', status: 'PUBLISHED' }), summary()],
  viewed: { policyKey: 'qa-npm-policy', name: 'QA npm Security Policy', version: '0.1.2', rules: [rule()] },
}

beforeEach(() => {
  requirePermission.mockReset().mockResolvedValue({ user: { role: 'editor' } })
  loadVersionsPage.mockReset()
})

describe('/versions page', () => {
  it('checks policy:draft, loads the version to view and keys the screen by active and viewed version', async () => {
    loadVersionsPage.mockResolvedValue(ready)

    const element = await route({ view: '0.1.2' })
    expect(requirePermission).toHaveBeenCalledWith('policy:draft')
    expect(loadVersionsPage).toHaveBeenCalledWith('0.1.2')
    expect(element.type).toBe(VersionsPage)
    expect(element.key).toBe('0.1.3:0.1.2')
    expect(element.props).toMatchObject({ policyKey: 'qa-npm-policy', activeVersion: '0.1.3', viewed: ready.viewed, canApply: true })
  })

  it('ignores a repeated view query and hides applying from roles without policy:publish', async () => {
    requirePermission.mockResolvedValue({ user: { role: 'viewer' } })
    loadVersionsPage.mockResolvedValue(ready)

    const element = await route({ view: ['0.1.2', '0.1.0'] })
    expect(loadVersionsPage).toHaveBeenCalledWith(undefined)
    expect(element.props.canApply).toBe(false)
  })

  it('shows a message when there is no policy or Policy is unavailable', async () => {
    loadVersionsPage.mockResolvedValueOnce({ status: 'no-policy' })
    expect(await route()).toMatchObject({ type: VersionsMessage, props: {} })
    loadVersionsPage.mockResolvedValueOnce({ status: 'unavailable', code: 'POLICY_UNAVAILABLE' })
    expect(await route()).toMatchObject({ type: VersionsMessage, props: { code: 'POLICY_UNAVAILABLE' } })
  })
})
