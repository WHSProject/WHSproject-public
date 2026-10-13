import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { PackagesPageProps } from '@/features/packages/components/PackagesPage'
import type { PackageDetail } from '@/features/packages/types/packages'
import type { PackageSummary } from '@/lib/decision/types'

const { push, replace } = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, replace }) }))

import { SEARCH_DELAY_MS } from '@/components/ui/SearchField/search'
import { PackagesPage } from '@/features/packages/components/PackagesPage'

import { rule } from '../../../lib/policy/fixtures'

const item = (name: string, version: string, decisionId = `dec_${name}_${version}`): PackageSummary => ({
  decisionId, requestId: 'req_1', packageName: name, version, decision: 'REJECT', evaluatedAt: '2026-10-01T01:12:00Z', matchedRuleIds: [], policyKey: 'qa-npm-policy', policyVersion: '0.1.0',
})
const detail = (overrides: Partial<PackageDetail> = {}): PackageDetail => ({
  decisionId: 'dec_minipass-fetch_5.0.2',
  packageName: 'minipass-fetch',
  version: '5.0.2',
  decision: 'REJECT',
  evaluatedAt: '2026-10-01T01:12:00Z',
  reasonCode: 'POLICY_CONFIRMED_EXFILTRATION',
  reason: 'Credential data reaches an external sink.',
  policyKey: 'qa-npm-policy',
  policyVersion: '0.1.0',
  policyError: null,
  policyLinkable: true,
  matchedRules: [{ ruleCode: 'RULE-REJECT-EXFIL', rule: rule() }, { ruleCode: 'RULE-REMOVED', rule: null }],
  evidences: [{ evidenceId: 'ev_1', signalType: 'CREDENTIAL_FILE_READ', category: 'CREDENTIAL', summary: 'Reads ~/.npmrc' }],
  missingEvidenceIds: [],
  history: [item('minipass-fetch', '5.0.2'), { ...item('minipass-fetch', '5.0.1'), decision: 'ACCEPT' }],
  ...overrides,
})
const props = (overrides: Partial<PackagesPageProps> = {}): PackagesPageProps => ({
  search: { q: '', decision: 'ALL', page: 1 },
  list: { items: [item('minipass-fetch', '5.0.2'), item('node-ipc', '10.1.1')], total: 23, page: 1, pageCount: 3 },
  detail: null,
  canViewPolicy: true,
  ...overrides,
})

const packageList = () => within(screen.getByRole('list', { name: '패키지 목록' }))
const detailPanel = () => within(screen.getByRole('region', { name: '패키지 상세' }))
const pager = () => within(screen.getByRole('navigation', { name: '패키지 페이지' }))
const searchbox = () => screen.getByRole('searchbox', { name: '패키지 이름 또는 버전으로 검색' })

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  push.mockReset()
  replace.mockReset()
})

describe('PackagesPage', () => {
  it('shows the list and pager, and no detail until a package is chosen', () => {
    render(<PackagesPage {...props({ search: { q: 'mini', decision: 'REJECT', page: 1 } })} />)

    expect(screen.getByRole('heading', { name: '패키지 23' })).toBeInTheDocument()
    expect(packageList().getByRole('link', { name: /minipass-fetch/u }))
      .toHaveAttribute('href', '/packages?q=mini&decision=REJECT&selected=dec_minipass-fetch_5.0.2')
    expect(detailPanel().getByText('목록에서 패키지를 선택하면 판정 상세가 보입니다.')).toBeInTheDocument()
    expect(pager().getByText('1 / 3')).toBeInTheDocument()
    expect(pager().queryByRole('link', { name: '이전 페이지' })).not.toBeInTheDocument()
    expect(pager().getByRole('link', { name: '다음 페이지' })).toHaveAttribute('href', '/packages?q=mini&decision=REJECT&page=2')
    // 점수 기반 시안의 표시는 없습니다.
    expect(screen.queryByRole('img', { name: /점수/u })).not.toBeInTheDocument()
    expect(screen.queryByText('SCAN STATUS')).not.toBeInTheDocument()
  })

  it('shows the selected decision with its reason, policy version, matched rules, evidence and history', () => {
    render(<PackagesPage {...props({ search: { q: '', decision: 'ALL', page: 1, selected: 'dec_minipass-fetch_5.0.2' }, detail: detail() })} />)

    expect(packageList().getByRole('link', { name: /minipass-fetch/u })).toHaveAttribute('aria-current', 'true')
    const panel = detailPanel()
    expect(panel.getByRole('heading', { level: 2, name: 'minipass-fetch' })).toBeInTheDocument()
    expect(panel.getByText('Credential data reaches an external sink.')).toBeInTheDocument()
    expect(panel.getByText('POLICY_CONFIRMED_EXFILTRATION')).toBeInTheDocument()
    expect(panel.getByRole('link', { name: 'Rule 보기' })).toHaveAttribute('href', '/versions?view=0.1.0')

    const rules = within(panel.getByRole('heading', { name: '매칭 Rule' }).closest('section')!)
    expect(rules.getByText('Credential 유출 차단')).toBeInTheDocument()
    expect(rules.getByText('인증 정보 접근')).toHaveAttribute('title', 'CREDENTIAL_SOURCE_ACCESSED')
    expect(rules.getByText('정책 버전에서 찾지 못한 Rule')).toBeInTheDocument()
    expect(rules.getByText('RULE-REMOVED')).toBeInTheDocument()

    expect(panel.getByText('CREDENTIAL_FILE_READ')).toBeInTheDocument()
    expect(panel.getByText('Reads ~/.npmrc')).toBeInTheDocument()

    const history = within(panel.getByRole('heading', { name: '버전 이력' }).closest('section')!)
    expect(history.getByRole('link', { name: /5\.0\.2/u })).toHaveAttribute('aria-current', 'true')
    expect(history.getByRole('link', { name: /5\.0\.1/u })).toHaveAttribute('href', '/packages?selected=dec_minipass-fetch_5.0.1')
  })

  it('links the package to the Logs trace of installs that included it, encoding the name and version', () => {
    const selected = { q: '', decision: 'ALL', page: 1, selected: 'dec_minipass-fetch_5.0.2' } as const
    const { rerender } = render(<PackagesPage {...props({ search: selected, detail: detail() })} />)
    const link = () => detailPanel().getByRole('link', { name: '이 패키지가 포함된 설치 보기' })
    expect(link()).toHaveAttribute('href', '/logs?view=trace&trace=minipass-fetch&traceVersion=5.0.2')

    rerender(<PackagesPage {...props({ search: selected, detail: detail({ packageName: '@scope/na me&x=1', version: '1.0.0-beta+1' }) })} />)
    const href = link().getAttribute('href')!
    expect(href).toBe('/logs?view=trace&trace=%40scope%2Fna+me%26x%3D1&traceVersion=1.0.0-beta%2B1')
    // 주소를 읽으면 원래 값이 그대로 나옵니다.
    const params = new URL(href, 'http://localhost').searchParams
    expect([params.get('trace'), params.get('traceVersion')]).toEqual(['@scope/na me&x=1', '1.0.0-beta+1'])
  })

  it('explains missing data and hides the policy link without the permission', () => {
    render(<PackagesPage {...props({
      search: { q: '', decision: 'ALL', page: 1, selected: 'dec_minipass-fetch_5.0.2' },
      detail: detail({ matchedRules: [], evidences: [], missingEvidenceIds: ['ev_gone'], policyError: 'POLICY_UNAVAILABLE' }),
      canViewPolicy: false,
    })} />)

    const panel = detailPanel()
    expect(panel.queryByRole('link', { name: 'Rule 보기' })).not.toBeInTheDocument()
    expect(panel.getByText(/정책 버전을 불러오지 못해.*POLICY_UNAVAILABLE/u)).toBeInTheDocument()
    expect(panel.getByText(/매칭된 Rule이 없습니다/u)).toBeInTheDocument()
    expect(panel.getByText(/근거 1건을 찾지 못했습니다.*ev_gone/u)).toBeInTheDocument()
  })

  it('tells when the selected decision does not exist and when nothing matches', () => {
    render(<PackagesPage {...props({ search: { q: 'zzz', decision: 'ALL', page: 1, selected: 'dec_unknown' }, list: { items: [], total: 0, page: 1, pageCount: 1 } })} />)

    expect(screen.getByText('조건에 맞는 패키지가 없습니다.')).toBeInTheDocument()
    expect(detailPanel().getByText(/선택한 판정을 찾을 수 없습니다/u)).toBeInTheDocument()
    expect(pager().queryByRole('link')).not.toBeInTheDocument()
  })

  it('searches after typing stops and filters by decision right away, from the first page', () => {
    vi.useFakeTimers()
    render(<PackagesPage {...props({ search: { q: '', decision: 'HOLD', page: 2 } })} />)

    fireEvent.change(searchbox(), { target: { value: 'lod' } })
    fireEvent.change(searchbox(), { target: { value: ' lodash ' } })
    act(() => vi.advanceTimersByTime(SEARCH_DELAY_MS - 1))
    expect(replace).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(1))
    expect(replace).toHaveBeenCalledTimes(1)
    expect(replace).toHaveBeenCalledWith('/packages?q=lodash&decision=HOLD', { scroll: false })

    fireEvent.click(screen.getByRole('button', { name: 'REJECT' }))
    expect(push).toHaveBeenCalledWith('/packages?q=lodash&decision=REJECT', { scroll: false })
  })

  it('lets the last input win while an earlier search is still loading (empty input included)', () => {
    vi.useFakeTimers()
    const { rerender } = render(<PackagesPage {...props()} />)

    fireEvent.change(searchbox(), { target: { value: 'chalk' } })
    act(() => vi.advanceTimersByTime(SEARCH_DELAY_MS))
    expect(replace).toHaveBeenLastCalledWith('/packages?q=chalk', { scroll: false })

    // 응답 전에 입력을 비우면 빈 검색을 다시 요청합니다(주소는 아직 빈 검색어).
    fireEvent.change(searchbox(), { target: { value: '' } })
    act(() => vi.advanceTimersByTime(SEARCH_DELAY_MS))
    expect(replace).toHaveBeenLastCalledWith('/packages', { scroll: false })
    rerender(<PackagesPage {...props()} />)
    expect(searchbox()).toHaveValue('')
  })

  it('keeps text typed after a search when its response arrives, and follows outside address changes', () => {
    vi.useFakeTimers()
    const { rerender } = render(<PackagesPage {...props()} />)

    fireEvent.change(searchbox(), { target: { value: 'chalk' } })
    act(() => vi.advanceTimersByTime(SEARCH_DELAY_MS))
    fireEvent.change(searchbox(), { target: { value: 'chalk 5' } })
    rerender(<PackagesPage {...props({ search: { q: 'chalk', decision: 'ALL', page: 1 } })} />)
    expect(searchbox()).toHaveValue('chalk 5')

    // 뒤로 가기처럼 요청하지 않은 검색어로 바뀌면 입력란도 바뀝니다.
    rerender(<PackagesPage {...props({ search: { q: 'semver', decision: 'ALL', page: 1 } })} />)
    expect(searchbox()).toHaveValue('semver')
  })

  it('hides the policy link when the decision was made by a policy that is no longer active', () => {
    render(<PackagesPage {...props({ search: { q: '', decision: 'ALL', page: 1, selected: 'dec_minipass-fetch_5.0.2' }, detail: detail({ policyLinkable: false }) })} />)

    expect(detailPanel().queryByRole('link', { name: 'Rule 보기' })).not.toBeInTheDocument()
    expect(detailPanel().getByText('Credential 유출 차단')).toBeInTheDocument()
  })
})
