import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RulesPageProps } from '@/features/rules'

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }))

import { RulesPage } from '@/features/rules'

import { predicates, reviewRule, rule } from '../../../lib/policy/fixtures'

const props = (overrides: Partial<RulesPageProps> = {}): RulesPageProps => ({
  policy: { policyKey: 'qa-npm-policy', name: 'QA npm Security Policy', version: '0.1.2', rules: [reviewRule, rule()] },
  predicates,
  predicateSource: 'policy',
  canApply: true,
  ...overrides,
})

const fetchMock = vi.fn()
const respond = (status: number, body: unknown) => fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status }))
const card = (code: string) => within(screen.getByRole('article', { name: `Rule ${code}` }))
const cards = () => screen.queryAllByRole('article').map((item) => item.getAttribute('aria-label'))
const applyButton = () => screen.getByRole('button', { name: '적용' })
const filter = () => within(screen.getByRole('group', { name: '판정 필터' }))

beforeEach(() => vi.stubGlobal('fetch', fetchMock))

afterEach(() => {
  cleanup()
  fetchMock.mockReset()
  refresh.mockReset()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('RulesPage', () => {
  it('shows the active version and rules from the highest priority, with nothing to apply yet', () => {
    render(<RulesPage {...props()} />)

    expect(screen.getByText('POLICY · RULES · v0.1.2')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /QA npm Security Policy/u })).toHaveTextContent('적용 중')
    expect(screen.getByText(/어떤 Rule에도 해당하지 않으면/u).closest('p')).toHaveTextContent('어떤 Rule에도 해당하지 않으면 REVIEW')
    expect(cards()).toEqual(['Rule RULE-REJECT-EXFIL', 'Rule RULE-REVIEW-OBFUSCATION'])

    const reject = card('RULE-REJECT-EXFIL')
    // 판정 선택은 판정 필터와 같은 순서입니다.
    expect(within(reject.getByRole('group', { name: 'RULE-REJECT-EXFIL 판정' })).getAllByRole('button').map((button) => button.textContent))
      .toEqual(['ACCEPT', 'REJECT', 'HOLD', 'REVIEW'])
    expect(reject.getByRole('button', { name: 'REJECT' })).toHaveAttribute('aria-pressed', 'true')
    expect(reject.getByRole('spinbutton', { name: 'RULE-REJECT-EXFIL 우선순위' })).toHaveValue(90)
    expect(reject.getByRole('combobox', { name: 'RULE-REJECT-EXFIL 조건 방식' })).toHaveValue('all')
    expect(reject.getByText('인증 정보 접근')).toHaveAttribute('title', expect.stringMatching(/^CREDENTIAL_SOURCE_ACCESSED — /u))
    expect(card('RULE-REVIEW-OBFUSCATION').getByRole('combobox', { name: 'RULE-REVIEW-OBFUSCATION 분석 범위' })).toHaveValue('PARTIAL')
    expect(applyButton()).toBeDisabled()
    expect(screen.queryByText('적용하지 않은 변경 있음')).not.toBeInTheDocument()
  })

  it('edits a rule, shows errors on the card and blocks applying until they are fixed', () => {
    render(<RulesPage {...props()} />)
    const reject = card('RULE-REJECT-EXFIL')

    fireEvent.change(reject.getByRole('spinbutton', { name: 'RULE-REJECT-EXFIL 우선순위' }), { target: { value: '60' } })
    expect(screen.getByText('적용하지 않은 변경 있음')).toBeInTheDocument()
    expect(reject.getByText('우선순위 60를 다른 Rule(난독화 검토)도 쓰고 있습니다.')).toBeInTheDocument()
    expect(applyButton()).toBeDisabled()

    fireEvent.change(reject.getByRole('spinbutton', { name: 'RULE-REJECT-EXFIL 우선순위' }), { target: { value: '95' } })
    fireEvent.click(reject.getByRole('button', { name: 'RULE-REJECT-EXFIL 조건 인증 정보 접근 삭제' }))
    fireEvent.change(reject.getByRole('combobox', { name: 'RULE-REJECT-EXFIL 조건 추가' }), { target: { value: 'OBFUSCATION_PRESENT' } })
    fireEvent.change(reject.getByRole('combobox', { name: 'RULE-REJECT-EXFIL 판단할 수 없을 때' }), { target: { value: 'REVIEW' } })
    expect(reject.queryByRole('list', { name: 'RULE-REJECT-EXFIL 검사 결과' })).not.toBeInTheDocument()
    expect(applyButton()).toBeEnabled()

    fireEvent.click(screen.getByRole('button', { name: '변경 취소' }))
    expect(card('RULE-REJECT-EXFIL').getByText('인증 정보 접근')).toBeInTheDocument()
    expect(applyButton()).toBeDisabled()
  })

  it('adds a rule with a new code, clearing filters so it stays visible, and removes rules', () => {
    render(<RulesPage {...props()} />)
    fireEvent.click(filter().getByRole('button', { name: 'REJECT' }))
    fireEvent.click(within(screen.getByRole('group', { name: '조건 필터' })).getByRole('button', { name: /^인증 정보 접근/u }))
    expect(cards()).toEqual(['Rule RULE-REJECT-EXFIL'])

    fireEvent.click(screen.getByRole('button', { name: '+ Rule 추가' }))
    expect(within(screen.getByRole('group', { name: '조건 필터' })).queryByRole('button', { name: /^선택 해제/u })).not.toBeInTheDocument()
    const added = cards().find((name) => /^Rule RULE-[0-9A-F]{8}$/u.test(name ?? ''))
    expect(cards()).toHaveLength(3)
    const code = added!.replace('Rule ', '')
    expect(card(code).getByText('Rule 이름을 입력하세요.')).toBeInTheDocument()
    expect(card(code).getByText('조건을 하나 이상 선택하세요.')).toBeInTheDocument()

    fireEvent.click(card(code).getByRole('button', { name: `${code} 삭제` }))
    fireEvent.click(card('RULE-REVIEW-OBFUSCATION').getByRole('button', { name: 'RULE-REVIEW-OBFUSCATION 삭제' }))
    expect(cards()).toEqual(['Rule RULE-REJECT-EXFIL'])
    expect(applyButton()).toBeEnabled()
  })

  it('filters by decision in the order 전체·ACCEPT·REJECT·HOLD·REVIEW, without a name search', () => {
    render(<RulesPage {...props()} />)
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument()
    expect(filter().getAllByRole('button').map((button) => button.textContent)).toEqual(['전체', 'ACCEPT', 'REJECT', 'HOLD', 'REVIEW'])

    fireEvent.click(filter().getByRole('button', { name: 'REVIEW' }))
    expect(cards()).toEqual(['Rule RULE-REVIEW-OBFUSCATION'])
    fireEvent.click(filter().getByRole('button', { name: 'ACCEPT' }))
    expect(cards()).toEqual([])
    expect(screen.getByText('조건에 맞는 Rule이 없습니다.')).toBeInTheDocument()
    fireEvent.click(filter().getByRole('button', { name: '전체' }))
    expect(cards()).toHaveLength(2)
  })

  it('folds the filter, summarizing the active filters while closed', () => {
    render(<RulesPage {...props()} />)
    const panel = screen.getByText('필터').closest('details')!
    expect(panel).not.toHaveAttribute('open')
    expect(within(panel).getByText('없음')).toBeInTheDocument()

    fireEvent.click(screen.getByText('필터'))
    expect(panel).toHaveAttribute('open')
    fireEvent.click(filter().getByRole('button', { name: 'REJECT' }))
    fireEvent.click(within(screen.getByRole('group', { name: '조건 필터' })).getByRole('button', { name: /^인증 정보 접근/u }))
    expect(within(panel).getByText('REJECT · 조건 1개(AND)')).toBeInTheDocument()
  })

  it('filters by registered conditions shown in Korean, with AND or OR and the decision beside them', () => {
    render(<RulesPage {...props()} />)
    const conditions = within(screen.getByRole('group', { name: '조건 필터' }))
    const chip = (name: string) => conditions.getByRole('button', { name: new RegExp(`^${name}\\d+$`, 'u') })

    // 등록된 조건 전체를 한국어 이름·분류로, 원래 코드는 툴팁으로 보여 줍니다. 숫자는 그 조건을 쓰는 Rule 수입니다.
    expect(conditions.getAllByTitle(/^[A-Z_]+ — /u)).toHaveLength(predicates.length)
    expect(chip('인증 정보 접근')).toHaveTextContent('인증 정보 접근1')
    expect(chip('인증 정보 접근')).toHaveAttribute('title', 'CREDENTIAL_SOURCE_ACCESSED — Credential access')
    expect(conditions.getByText('외부 피드')).toBeInTheDocument()
    // 판정 필터는 결합 방식 옆, 같은 줄에 있습니다.
    expect(conditions.getByRole('group', { name: '판정 필터' })).toBeInTheDocument()

    fireEvent.click(chip('인증 정보 접근'))
    expect(chip('인증 정보 접근')).toHaveAttribute('aria-pressed', 'true')
    expect(cards()).toEqual(['Rule RULE-REJECT-EXFIL'])

    fireEvent.click(chip('코드 난독화'))
    expect(cards()).toEqual([])
    fireEvent.click(conditions.getByRole('button', { name: '하나 이상(OR)' }))
    expect(cards()).toEqual(['Rule RULE-REJECT-EXFIL', 'Rule RULE-REVIEW-OBFUSCATION'])

    fireEvent.click(filter().getByRole('button', { name: 'REVIEW' }))
    expect(cards()).toEqual(['Rule RULE-REVIEW-OBFUSCATION'])

    fireEvent.click(conditions.getByRole('button', { name: '선택 해제(2)' }))
    expect(chip('코드 난독화')).toHaveAttribute('aria-pressed', 'false')
    expect(cards()).toEqual(['Rule RULE-REVIEW-OBFUSCATION'])
  })

  it('sends condition codes, not the Korean names, when applying', async () => {
    respond(201, { version: '0.1.3' })
    render(<RulesPage {...props()} />)
    const add = card('RULE-REJECT-EXFIL').getByRole('combobox', { name: 'RULE-REJECT-EXFIL 조건 추가' })
    expect(within(add).getByRole('option', { name: '코드 난독화' })).toHaveValue('OBFUSCATION_PRESENT')
    fireEvent.change(add, { target: { value: 'OBFUSCATION_PRESENT' } })
    fireEvent.click(applyButton())
    fireEvent.click(screen.getByRole('button', { name: '적용 확인' }))

    await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce())
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).rules[0].conditions).toEqual([
      'CREDENTIAL_SOURCE_ACCESSED',
      'DATA_REACHES_EXTERNAL_SINK',
      'OBFUSCATION_PRESENT',
    ])
  })

  it('applies after confirmation with the base version and refreshes the page', async () => {
    respond(201, { version: '0.1.3' })
    render(<RulesPage {...props()} />)
    fireEvent.click(card('RULE-REJECT-EXFIL').getByRole('checkbox', { name: 'RULE-REJECT-EXFIL 활성' }))

    fireEvent.click(applyButton())
    expect(screen.getByRole('alertdialog', { name: '적용 확인' })).toHaveTextContent('이미 판정된 패키지에는 적용되지 않습니다')
    fireEvent.click(screen.getByRole('button', { name: '적용 확인' }))

    await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce())
    expect(fetchMock.mock.calls[0][0]).toBe('/api/policies/qa-npm-policy/versions')
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ baseVersion: '0.1.2', rules: [rule({ enabled: false }), reviewRule] })
  })

  // 확인창이 열린 뒤에도 편집할 수 있으므로, 확인 버튼도 같은 조건으로 다시 확인합니다.
  it('does not send from the confirmation after the changes are undone or become invalid', () => {
    render(<RulesPage {...props()} />)
    const name = () => card('RULE-REJECT-EXFIL').getByRole('textbox', { name: 'RULE-REJECT-EXFIL 이름' })
    const confirm = () => screen.getByRole('button', { name: '적용 확인' })

    fireEvent.change(name(), { target: { value: '유출 차단' } })
    fireEvent.click(applyButton())
    fireEvent.click(screen.getByRole('button', { name: '변경 취소' }))
    expect(confirm()).toBeDisabled()
    fireEvent.click(confirm())

    fireEvent.change(name(), { target: { value: '' } })
    expect(confirm()).toBeDisabled()
    fireEvent.click(confirm())
    expect(fetchMock).not.toHaveBeenCalled()

    fireEvent.change(name(), { target: { value: '유출 차단' } })
    expect(confirm()).toBeEnabled()
  })

  it('shows the server message and issues when applying fails', async () => {
    respond(400, { error: 'INVALID_RULES', issues: [{ ruleCode: 'RULE-REJECT-EXFIL', message: 'OBFUSCATION_PRESENT는 등록되지 않은 조건입니다.' }] })
    render(<RulesPage {...props()} />)
    fireEvent.change(card('RULE-REJECT-EXFIL').getByRole('textbox', { name: 'RULE-REJECT-EXFIL 이름' }), { target: { value: '유출 차단' } })
    fireEvent.click(applyButton())
    fireEvent.click(screen.getByRole('button', { name: '적용 확인' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Rule 입력값을 확인하세요.')
    expect(card('RULE-REJECT-EXFIL').getByText('OBFUSCATION_PRESENT는 등록되지 않은 조건입니다.')).toBeInTheDocument()
    expect(refresh).not.toHaveBeenCalled()

    respond(409, { error: 'POLICY_CHANGED' })
    fireEvent.change(card('RULE-REJECT-EXFIL').getByRole('textbox', { name: 'RULE-REJECT-EXFIL 이름' }), { target: { value: '유출 차단!' } })
    fireEvent.click(applyButton())
    fireEvent.click(screen.getByRole('button', { name: '적용 확인' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('다른 사용자가 먼저 적용 버전을 바꿨습니다')
  })

  it('hides applying without the permission and notes the built-in condition list', () => {
    render(<RulesPage {...props({ canApply: false, predicateSource: 'fallback' })} />)
    expect(screen.queryByRole('button', { name: '적용' })).not.toBeInTheDocument()
    expect(screen.getByText('Policy에서 조건 목록을 받지 못해 기본 조건 목록을 사용합니다.')).toBeInTheDocument()
  })

  it('asks before leaving through a link only while there are changes', () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(
      <>
        <a href="/packages">Package</a>
        <RulesPage {...props()} />
      </>,
    )
    const link = screen.getByRole('link', { name: 'Package' })

    expect(fireEvent.click(link)).toBe(true)
    expect(confirm).not.toHaveBeenCalled()

    fireEvent.click(card('RULE-REJECT-EXFIL').getByRole('button', { name: 'HOLD' }))
    // 취소하면 이동(기본 동작)을 막습니다.
    expect(fireEvent.click(link)).toBe(false)
    expect(confirm).toHaveBeenCalledWith('적용하지 않은 변경이 사라집니다. 이 페이지를 벗어날까요?')

    confirm.mockReturnValue(true)
    expect(fireEvent.click(link)).toBe(true)

    const unload = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(unload)
    expect(unload.defaultPrevented).toBe(true)
  })
})
