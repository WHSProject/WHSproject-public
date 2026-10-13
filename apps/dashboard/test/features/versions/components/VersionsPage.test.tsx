import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { VersionsPageProps } from '@/features/versions'

const { push } = vi.hoisted(() => ({ push: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }))

import { VersionsPage } from '@/features/versions'

import { reviewRule, rule, summary } from '../../../lib/policy/fixtures'

const versions = [
  summary({ version: '0.1.4', status: 'DRAFT', publishedAt: null }),
  summary({ version: '0.1.3', status: 'PUBLISHED', updatedBy: 'park_admin', publishedAt: '2026-10-01T05:20:00Z' }),
  summary({ version: '0.1.2' }),
  summary({ version: '0.0.9', createdBy: 'qa-fixture' }),
]
const props = (viewed = '0.1.2', overrides: Partial<VersionsPageProps> = {}): VersionsPageProps => ({
  policyKey: 'qa-npm-policy',
  activeVersion: '0.1.3',
  versions,
  viewed: { policyKey: 'qa-npm-policy', name: 'QA npm Security Policy', version: viewed, rules: [reviewRule, rule({ enabled: false })] },
  canApply: true,
  ...overrides,
})

const fetchMock = vi.fn()
const versionRow = (version: string) => within(screen.getByRole('table', { name: '정책 버전' })).getByText(`v${version}`).closest('tr')!
const applyButton = () => screen.queryByRole('button', { name: '이 버전 적용' })

beforeEach(() => vi.stubGlobal('fetch', fetchMock))

afterEach(() => {
  cleanup()
  fetchMock.mockReset()
  push.mockReset()
  vi.unstubAllGlobals()
})

describe('VersionsPage', () => {
  it('lists versions with their state, who applied the active one, and links to view each version', () => {
    render(<VersionsPage {...props()} />)

    expect(screen.getByRole('heading', { name: 'Version', level: 1 })).toBeInTheDocument()
    expect(screen.getByText(/지금 적용 중:/u)).toHaveTextContent('지금 적용 중: v0.1.3 · park_admin · 2026. 10. 01. 14:20')
    expect(within(versionRow('0.1.3')).getByText('적용 중')).toBeInTheDocument()
    expect(within(versionRow('0.1.2')).getByText('적용 가능')).toBeInTheDocument()
    expect(within(versionRow('0.0.9')).getByText('적용 불가')).toBeInTheDocument()
    expect(within(versionRow('0.1.4')).getByText('초안')).toBeInTheDocument()

    expect(versionRow('0.1.2')).toHaveAttribute('aria-current', 'true')
    expect(within(versionRow('0.1.2')).getByText('보는 중')).toBeInTheDocument()
    expect(within(versionRow('0.0.9')).getByRole('link', { name: 'v0.0.9 Rule 보기' })).toHaveAttribute('href', '/versions?view=0.0.9')
  })

  it('shows the viewed version rules read-only, highest priority first, with Korean condition names', () => {
    render(<VersionsPage {...props()} />)
    const table = within(screen.getByRole('table', { name: '버전 Rule' }))
    const [, first, second] = table.getAllByRole('row')

    expect(screen.getByRole('heading', { name: 'v0.1.2 Rule' })).toBeInTheDocument()
    expect(within(first).getByText('Credential 유출 차단')).toBeInTheDocument()
    expect(within(first).getByText('인증 정보 접근')).toHaveAttribute('title', 'CREDENTIAL_SOURCE_ACCESSED')
    expect(within(first).getByText('사용 안 함')).toBeInTheDocument()
    expect(within(second).getByText('하나 이상(OR)')).toBeInTheDocument()
    expect(second).toHaveTextContent('일부만 분석돼도 적용')
    expect(second).toHaveTextContent('판단 불가 시 검토(REVIEW)')
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('activates the viewed version after confirmation and returns to the version list', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ version: '0.1.2' }), { status: 200 }))
    render(<VersionsPage {...props()} />)

    fireEvent.click(applyButton()!)
    expect(screen.getByRole('alertdialog', { name: '적용 확인' })).toHaveTextContent(
      'v0.1.2의 Rule로 바로 판정합니다. 지금 버전 v0.1.3은 보관됩니다.이미 판정된 패키지에는 적용되지 않습니다(기존 판정 재사용).',
    )
    fireEvent.click(screen.getByRole('button', { name: '적용 확인' }))

    await vi.waitFor(() => expect(push).toHaveBeenCalledWith('/versions'))
    expect(fetchMock.mock.calls[0][0]).toBe('/api/policies/qa-npm-policy/versions/0.1.2/publish')
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ baseVersion: '0.1.3' })
  })

  it('shows the server message when activating fails', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'POLICY_CHANGED' }), { status: 409 }))
    render(<VersionsPage {...props()} />)
    fireEvent.click(applyButton()!)
    fireEvent.click(screen.getByRole('button', { name: '적용 확인' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('다른 사용자가 먼저 적용 버전을 바꿨습니다')
    expect(push).not.toHaveBeenCalled()
  })

  it.each([
    ['0.1.3', '적용 중', null],
    ['0.0.9', '적용 불가', '이전 Policy 내부 버전이라 다시 적용할 수 없습니다.'],
    ['0.1.4', '초안', '적용된 적 없는 초안이라 적용할 수 없습니다'],
  ])('offers no apply button for v%s (%s) and explains why', (version, label, reason) => {
    render(<VersionsPage {...props(version)} />)
    expect(screen.getByText(`Rule 2개 · ${label}`)).toBeInTheDocument()
    expect(applyButton()).not.toBeInTheDocument()
    if (reason) expect(screen.getByText(reason, { exact: false })).toBeInTheDocument()
  })

  it('hides applying without the permission', () => {
    render(<VersionsPage {...props('0.1.2', { canApply: false })} />)
    expect(applyButton()).not.toBeInTheDocument()
  })

  it('says so when the viewed version has no rules', () => {
    render(<VersionsPage {...props('0.1.2', { viewed: { policyKey: 'qa-npm-policy', name: 'QA', version: '0.1.2', rules: [] } })} />)
    expect(screen.getByText('Rule이 없습니다. 어떤 패키지든 REVIEW로 판정됩니다.')).toBeInTheDocument()
  })
})
