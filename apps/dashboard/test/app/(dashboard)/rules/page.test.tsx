// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { requirePermission, loadRulesPage } = vi.hoisted(() => ({ requirePermission: vi.fn(), loadRulesPage: vi.fn() }))

vi.mock('@/lib/auth/server/session', () => ({ requirePermission }))
vi.mock('@/features/rules/index.server', () => ({ loadRulesPage }))

import RulesRoute from '@/app/(dashboard)/rules/page'
import { RulesMessage, RulesPage } from '@/features/rules'

import { predicates, rule } from '../../../lib/policy/fixtures'

type Element = { type: unknown; key: string | null; props: Record<string, unknown> }
const route = async () => (await RulesRoute()) as unknown as Element
const policy = { policyKey: 'qa-npm-policy', name: 'QA npm Security Policy', version: '0.1.2', rules: [rule()] }

beforeEach(() => {
  requirePermission.mockReset().mockResolvedValue({ user: { role: 'editor' } })
  loadRulesPage.mockReset()
})

describe('/rules page', () => {
  it('checks policy:draft and renders the active policy keyed by its version', async () => {
    loadRulesPage.mockResolvedValue({ status: 'ready', policy, predicates })

    const element = await route()
    expect(requirePermission).toHaveBeenCalledWith('policy:draft')
    expect(element.type).toBe(RulesPage)
    expect(element.key).toBe('0.1.2')
    expect(element.props).toMatchObject({ policy, predicates, canApply: true })
  })

  it('hides applying from roles without policy:publish', async () => {
    requirePermission.mockResolvedValue({ user: { role: 'viewer' } })
    loadRulesPage.mockResolvedValue({ status: 'ready', policy, predicates })
    expect((await route()).props.canApply).toBe(false)
  })

  it('shows a message when there is no policy or Policy is unavailable', async () => {
    loadRulesPage.mockResolvedValueOnce({ status: 'no-policy' })
    expect(await route()).toMatchObject({ type: RulesMessage, props: {} })
    loadRulesPage.mockResolvedValueOnce({ status: 'unavailable', code: 'POLICY_UNAVAILABLE' })
    expect(await route()).toMatchObject({ type: RulesMessage, props: { code: 'POLICY_UNAVAILABLE' } })
  })
})
