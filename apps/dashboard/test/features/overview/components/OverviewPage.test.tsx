import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { OverviewPage } from '@/features/overview'
import type { OverviewData } from '@/features/overview/types/overview'

const hourly = (counts: number[]) => counts.map((total, index) => ({
  hour: new Date(Date.UTC(2026, 9, 1, index)).toISOString(), total, notAccepted: Math.min(total, 1),
}))
const data = (overrides: Partial<OverviewData> = {}): OverviewData => ({
  installRequests: { total: 9, hourly: [1, 0, 3, 5] },
  decisions: { from: '2026-10-01T00:00:00Z', to: '2026-10-01T04:00:00Z', total: 8, byDecision: { ACCEPT: 4, REJECT: 2, HOLD: 1, REVIEW: 1 }, hourly: hourly([2, 0, 3, 3]) },
  policy: { status: 'ready', version: '0.1.3', enabledRules: 10, appliedBy: 'park_admin' },
  recent: [
    { decisionId: 'dec_1', requestId: 'req_1', packageName: 'minipass-fetch', version: '5.0.2', decision: 'REJECT', evaluatedAt: '2026-10-01T01:12:00Z', matchedRuleIds: ['RULE-REJECT-EXFIL', 'RULE-REVIEW-CRED'], policyKey: 'qa-npm-policy', policyVersion: '0.1.0', username: 'kim_dev', triggeredRule: { name: '인증 정보 유출 차단', others: 1 } },
    { decisionId: 'dec_2', requestId: 'req_2', packageName: 'p-limit', version: '7.3.1', decision: 'ACCEPT', evaluatedAt: '2026-10-01T00:58:00Z', matchedRuleIds: [], policyKey: 'qa-npm-policy', policyVersion: '0.1.0', username: null, triggeredRule: null },
  ],
  ...overrides,
})

const policyCard = () => within(screen.getByRole('heading', { name: '적용 중 정책' }).closest('article')!)

afterEach(cleanup)

describe('OverviewPage', () => {
  it('shows the 24-hour summary, not-accepted ratio and the active policy', () => {
    render(<OverviewPage data={data()} canViewPolicy />)

    expect(screen.getByRole('heading', { level: 1, name: 'Overview' })).toBeInTheDocument()
    expect(screen.getByRole('img', { name: '판정 8건 중 미승인 4건' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Overview' }).parentElement?.querySelector('p')).toHaveTextContent('최근 24시간의 설치 요청에서 4개의 미승인 패키지를 확인했습니다.')
    const unapproved = screen.getByRole('heading', { name: '미승인' }).closest('article')!
    expect(within(unapproved).getByText('미승인 4건')).toBeInTheDocument()
    expect(within(unapproved).queryByText('승인 4건')).not.toBeInTheDocument()
    expect(unapproved.querySelector('[stroke-dasharray]')).toHaveAttribute('stroke-dasharray', '50 50')
    expect(policyCard().getByText('v0.1.3')).toBeInTheDocument()
    expect(policyCard().getByText('사용 중 Rule 10개')).toBeInTheDocument()
    expect(policyCard().getByText('적용 park_admin')).toBeInTheDocument()
    // 요약 블록의 항목 이름은 한국어입니다.
    expect(screen.getByText('최근 24시간')).toBeInTheDocument()
    for (const label of ['설치 요청', '판정', '미승인']) expect(screen.getByRole('heading', { level: 2, name: label })).toBeInTheDocument()
    const summaryBlock = screen.getByRole('heading', { level: 1 }).closest('section')!
    expect(summaryBlock.textContent).not.toMatch(/[A-Z]{2,} [A-Z]{2,}|Request|Decision/u)
    expect(policyCard().getByRole('link', { name: 'Rule' })).toHaveAttribute('href', '/rules')
    expect(policyCard().getByRole('link', { name: 'Version' })).toHaveAttribute('href', '/versions')
    // 점수 기반 시안의 표시는 없습니다.
    expect(screen.queryByText('RISK SCORING SYSTEM')).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: /위험 신호 등급/u })).not.toBeInTheDocument()
    expect(screen.queryByText(/점수/u)).not.toBeInTheDocument()
  })

  it('links recent decisions to the package detail and shows the decision distribution and method', () => {
    render(<OverviewPage data={data()} canViewPolicy={false} />)

    const recent = within(screen.getByRole('table', { name: '최근 판정' }))
    expect(recent.getAllByRole('row')).toHaveLength(3)
    expect(recent.getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual(['판정', '설치 시도 사용자', '패키지', '트리거된 Rule', '판정 시각'])
    const reject = within(recent.getByRole('row', { name: /minipass-fetch/u }))
    expect(reject.getByText('kim_dev')).toBeInTheDocument()
    expect(reject.getByText('인증 정보 유출 차단').closest('td')).toHaveTextContent('인증 정보 유출 차단 외 1개')
    const accept = within(recent.getByRole('row', { name: /p-limit/u }))
    expect(accept.getByText('해당 Rule 없음')).toBeInTheDocument()
    expect(accept.getAllByRole('cell')[1]).toHaveTextContent('-')
    expect(recent.getByRole('link', { name: /minipass-fetch/u })).toHaveAttribute('href', '/packages?selected=dec_1')
    expect(screen.getByRole('link', { name: '전체 보기' })).toHaveAttribute('href', '/packages')

    expect(screen.getByRole('img', { name: 'REJECT 2건 25%' })).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'ACCEPT 4건 50%' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /판정 방식/u })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /판정 방식/u }).closest('section')).toHaveTextContent('우선순위와 관계없이 REJECT입니다.')

    expect(policyCard().queryByRole('link')).not.toBeInTheDocument()
  })

  it('shows the install error only in its card while preserving other content', () => {
    render(<OverviewPage data={data({ installError: 'DOWNLOAD_EVENTS_UNAVAILABLE', installRequests: { total: 0, hourly: Array(24).fill(0) } })} canViewPolicy />)
    const card = screen.getByRole('heading', { name: '설치 요청' }).closest('article')!
    expect(within(card).getByRole('alert')).toHaveTextContent('설치 요청을 불러오지 못했습니다. (DOWNLOAD_EVENTS_UNAVAILABLE)')
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    expect(card.querySelector('svg')).toBeNull()
    expect(within(card).queryByText('0')).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Overview')
    expect(screen.getByRole('img', { name: 'REJECT 2건 25%' })).toBeInTheDocument()
    expect(policyCard().getByText('v0.1.3')).toBeInTheDocument()
    expect(screen.getByRole('table', { name: '최근 판정' })).toBeInTheDocument()
  })

  it('keeps recent rows and links with empty user cells when requester data is unavailable', () => {
    const input = data()
    input.recent = input.recent.map((item) => ({ ...item, username: null }))
    render(<OverviewPage data={input} canViewPolicy />)
    const rows = within(screen.getByRole('table', { name: '최근 판정' })).getAllByRole('row').slice(1)
    expect(rows).toHaveLength(2)
    for (const row of rows) {
      expect(within(row).getAllByRole('cell')[1]).toHaveTextContent('-')
      expect(within(row).getByRole('link')).toBeInTheDocument()
    }
    expect(screen.getByText('인증 정보 유출 차단')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('explains an unavailable or missing policy and an empty day', () => {
    const empty = { from: '', to: '', total: 0, byDecision: { ACCEPT: 0, REJECT: 0, HOLD: 0, REVIEW: 0 }, hourly: hourly([0, 0]) }
    const { rerender } = render(<OverviewPage data={data({ policy: { status: 'unavailable', code: 'POLICY_UNAVAILABLE' }, decisions: empty, recent: [] })} canViewPolicy />)

    expect(policyCard().getByText(/Policy 서비스에 연결하지 못했습니다/u)).toBeInTheDocument()
    expect(screen.getByText('최근 24시간 판정이 없습니다.')).toBeInTheDocument()
    expect(screen.getByText('아직 판정이 없습니다.')).toBeInTheDocument()
    expect(screen.getByRole('img', { name: '판정 0건 중 미승인 0건' })).toBeInTheDocument()

    rerender(<OverviewPage data={data({ policy: { status: 'no-policy' } })} canViewPolicy />)
    expect(policyCard().getByText('적용 중인 정책이 없습니다.')).toBeInTheDocument()
  })
})
