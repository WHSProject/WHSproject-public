import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { usePathname } from 'next/navigation'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import Forbidden from '@/app/(dashboard)/forbidden'
import DashboardLayout from '@/app/(dashboard)/layout'
import LogsRoute from '@/app/(dashboard)/logs/page'
import OverviewRoute from '@/app/(dashboard)/page'
import PackagesRoute from '@/app/(dashboard)/packages/page'
import RequestsRoute from '@/app/(dashboard)/requests/page'
import NotFound from '@/app/not-found'
import { getSession } from '@/lib/auth/server/session'
import { loadLogsPage } from '@/features/logs/index.server'

const { signOut, hardNavigate } = vi.hoisted(() => ({
  signOut: vi.fn(async () => ({ data: { success: true }, error: null })),
  hardNavigate: vi.fn(),
}))

// 로그인 확인은 여기서 통과시키고, 실제 차단은 test/app/(dashboard)/pages-auth.test.ts에서 검증합니다.
vi.mock('@/lib/auth/server/session', () => {
  const session = {
    user: { id: 'u1', name: 'Jump_Top', username: 'jump_top', displayUsername: 'Jump_Top', role: 'editor' },
    session: { id: 's1' },
  }
  return { requireSession: vi.fn(async () => session), getSession: vi.fn(async () => session) }
})
vi.mock('@/features/logs/index.server', () => ({ loadLogsPage: vi.fn(async () => ({
  log: {
    events: [{ id: 'event-1', occurredAt: '2026-10-05T01:00:00Z', requestId: 'req-1', userId: null, username: 'alice', sourceIp: null, packageName: 'express', version: '5.0.0', outcome: 'DELIVERED', decision: 'ACCEPT', httpStatus: 200 }],
    usernames: ['alice'], hasNext: false,
  },
  trace: null, rootDetail: null,
})) }))
// 설치 요청 데이터는 주입하고, route와 실제 로더의 연결을 확인합니다.
vi.mock('@/lib/download-events/server/download-events', () => ({
  listRootRequests: vi.fn(async ({ to }: { to: Date }) => [{
    requestId: 'req-app', occurredAt: to.toISOString(), username: 'alice', packageName: 'express',
    version: '5.0.0', outcome: 'DELIVERED', decision: 'ACCEPT', decisionId: 'dec-app',
  }]),
  findRequesters: vi.fn(async () => new Map()),
}))
vi.mock('@/lib/auth/client', () => ({ authClient: { signOut } }))
vi.mock('@/lib/navigation', () => ({ hardNavigate }))

vi.mock('next/navigation', async (importOriginal) => ({
  ...await importOriginal<typeof import('next/navigation')>(),
  usePathname: vi.fn(() => '/'),
  useRouter: vi.fn(() => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() })),
}))

// 실제 URL 이동은 브라우저에서 검증하고, 여기서는 route와 layout의 화면 동작을 검증합니다.
// Dashboard 레이아웃·페이지는 세션을 읽는 async 서버 컴포넌트라 먼저 실행한 결과를 그립니다.
async function renderDashboard(pathname: string, route: () => Promise<ReactNode>) {
  vi.mocked(usePathname).mockReturnValue(pathname)
  return render(await DashboardLayout({ children: await route() }))
}

describe('App', () => {
  // Overview·Package가 Policy DB API를 부르므로 실제 서비스(127.0.0.1:9000)로 나가지 않게 막습니다.
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('fetch failed')
    }))
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  // 화면 내용은 test/features/overview에서 검증하고, 여기서는 route·layout 연결만 확인합니다.
  it('renders the overview with its navigation items', async () => {
    await renderDashboard('/', OverviewRoute)

    expect(screen.getByRole('heading', { level: 1, name: 'Overview' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 2, name: '최근 판정' })).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent(/Decision DB 연결/u)

    const navigation = within(screen.getByRole('navigation', { name: '주요 메뉴' }))
    expect(navigation.getByRole('link', { name: 'Overview' })).toHaveAttribute('aria-current', 'page')
    expect(navigation.queryAllByRole('button')).toHaveLength(0)
    expect(navigation.getByRole('link', { name: 'Request' })).toBeInTheDocument()
    expect(navigation.getByRole('link', { name: 'Package' })).toBeInTheDocument()
    expect(navigation.getByRole('link', { name: 'Log' })).toHaveAttribute('href', '/logs')
    expect(navigation.getByRole('link', { name: 'Rule' })).toHaveAttribute('href', '/rules')
    expect(navigation.getByRole('link', { name: 'Version' })).toHaveAttribute('href', '/versions')
  })

  it('renders the not found page inside AppShell with a link to the overview', async () => {
    vi.mocked(usePathname).mockReturnValue('/unknown')
    render(<NotFound />)

    expect(screen.getByRole('heading', { name: '요청한 화면을 찾을 수 없습니다.' })).toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: '주요 메뉴' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Overview로 돌아가기' })).toHaveAttribute('href', '/')
    // 로그인 정보가 없는 404 화면에는 사용자 영역이 없습니다.
    expect(screen.queryByRole('button', { name: '로그아웃' })).not.toBeInTheDocument()
  })

  it('shows the signed-in user with role and signs out to the login page', async () => {
    await renderDashboard('/', OverviewRoute)

    expect(screen.getByText('Jump_Top')).toBeInTheDocument()
    expect(screen.getByText('editor')).toBeInTheDocument()
    expect(screen.queryByText('Sobin')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '로그아웃' }))

    await vi.waitFor(() => expect(hardNavigate).toHaveBeenCalledWith('/login'))
    expect(signOut).toHaveBeenCalledTimes(1)
  })

  it('hides the Admin menu from users without the user permission', async () => {
    await renderDashboard('/', OverviewRoute)

    const navigation = within(screen.getByRole('navigation', { name: '주요 메뉴' }))
    expect(navigation.queryByRole('link', { name: 'Admin' })).not.toBeInTheDocument()
  })

  it('hides the Rule menu from users without the policy:draft permission', async () => {
    vi.mocked(getSession).mockResolvedValueOnce({
      user: { id: 'u2', name: 'Viewer', username: 'viewer_one', displayUsername: 'Viewer', role: 'viewer' },
      session: { id: 's2' },
    } as Awaited<ReturnType<typeof getSession>>)
    await renderDashboard('/', OverviewRoute)

    const navigation = within(screen.getByRole('navigation', { name: '주요 메뉴' }))
    expect(navigation.queryByRole('link', { name: 'Rule' })).not.toBeInTheDocument()
    expect(navigation.queryByRole('link', { name: 'Version' })).not.toBeInTheDocument()
    expect(navigation.getByRole('link', { name: 'Log' })).toBeInTheDocument()
  })

  it('opens personal settings from the Setting menu and from the user chip', async () => {
    vi.mocked(usePathname).mockReturnValue('/settings')
    render(await DashboardLayout({ children: <p>settings page</p> }))

    const navigation = within(screen.getByRole('navigation', { name: '주요 메뉴' }))
    expect(navigation.getByRole('link', { name: 'Setting' })).toHaveAttribute('href', '/settings')
    expect(navigation.getByRole('link', { name: 'Setting' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('link', { name: 'Jump_Top 개인 설정' })).toHaveAttribute('href', '/settings')
    expect(screen.getByText('개인 설정')).toBeInTheDocument()
  })

  it('shows the Admin menu to admins and marks it current on admin pages', async () => {
    vi.mocked(getSession).mockResolvedValueOnce({
      user: { id: 'u1', name: 'Root', username: 'root', displayUsername: 'Root', role: 'admin' },
      session: { id: 's1' },
    } as Awaited<ReturnType<typeof getSession>>)
    vi.mocked(usePathname).mockReturnValue('/admin/users')
    render(await DashboardLayout({ children: <p>admin page</p> }))

    const navigation = within(screen.getByRole('navigation', { name: '주요 메뉴' }))
    expect(navigation.getByRole('link', { name: 'Admin' })).toHaveAttribute('href', '/admin')
    expect(navigation.getByRole('link', { name: 'Admin' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByText('사용자 관리')).toBeInTheDocument()
  })

  it('renders the 403 page for a Viewer without exposing Admin or policy menus', async () => {
    vi.mocked(getSession).mockResolvedValueOnce({
      user: { id: 'u2', name: 'Viewer', username: 'viewer_one', displayUsername: 'Viewer', role: 'viewer' },
      session: { id: 's2' },
    } as Awaited<ReturnType<typeof getSession>>)
    vi.mocked(usePathname).mockReturnValue('/admin/users')
    render(await DashboardLayout({ children: <Forbidden /> }))

    expect(screen.getByRole('heading', { name: '이 화면을 볼 권한이 없습니다.' })).toBeInTheDocument()
    expect(screen.getByText('ACCESS DENIED · 403')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Overview로 돌아가기' })).toHaveAttribute('href', '/')
    expect(screen.getByRole('button', { name: '로그아웃' })).toBeInTheDocument()
    // 권한 없는 사용자에게는 Admin 화면 이름을 보여 주지 않습니다.
    expect(screen.queryByText('사용자 관리')).not.toBeInTheDocument()
    const navigation = within(screen.getByRole('navigation', { name: '주요 메뉴' }))
    for (const name of ['Admin', 'Rule', 'Version']) expect(navigation.queryByRole('link', { name })).not.toBeInTheDocument()
  })

  // 목록·상세·검색 동작은 test/features/packages에서 검증하고, 여기서는 route·layout 연결만 확인합니다.
  it('renders the package list under the Package menu with no detail until a package is chosen', async () => {
    await renderDashboard('/packages', () => PackagesRoute({ searchParams: Promise.resolve({}) }))

    expect(screen.getByRole('alert')).toHaveTextContent(/DB 연결/u)
    expect(screen.getByText('조건에 맞는 패키지가 없습니다.')).toBeInTheDocument()
    expect(screen.getByText('목록에서 패키지를 선택하면 판정 상세가 보입니다.')).toBeInTheDocument()

    const navigation = within(screen.getByRole('navigation', { name: '주요 메뉴' }))
    expect(navigation.getByRole('link', { name: 'Package' })).toHaveAttribute('aria-current', 'page')
  })

  // 필터 동작은 test/features/logs에서 검증하고, 여기서는 route·layout 연결만 확인합니다.
  it('renders the install log under the Log menu with its title', async () => {
    await renderDashboard('/logs', () => LogsRoute({ searchParams: Promise.resolve({ q: ' express@5 ', user: 'alice', from: '2026-10-01', to: '2026-10-05', page: '3' }) }))
    expect(loadLogsPage).toHaveBeenCalledWith({ q: 'express@5', user: 'alice', from: '2026-10-01', to: '2026-10-05', trace: '', traceVersion: '', root: '', view: 'events', page: 3 })

    expect(screen.getByRole('heading', { level: 1, name: '설치 기록' })).toBeInTheDocument()
    expect(within(screen.getByRole('banner')).getByText('설치 기록')).toBeInTheDocument()
    expect(within(screen.getByRole('table', { name: '설치 기록' })).getAllByRole('row')).toHaveLength(2)

    const navigation = within(screen.getByRole('navigation', { name: '주요 메뉴' }))
    expect(navigation.getByRole('link', { name: 'Log' })).toHaveAttribute('aria-current', 'page')
  })

  // 목록·검색 동작은 test/features/requests에서 검증하고, 여기서는 route·layout 연결만 확인합니다.
  describe('requests', () => {
    const renderRequests = () => renderDashboard('/requests', () => RequestsRoute({ searchParams: Promise.resolve({}) }))

    it('renders the root requests of the last 7 days under the Request menu', async () => {
      await renderRequests()

      expect(screen.getByRole('heading', { level: 1, name: '설치 요청 목록' })).toBeInTheDocument()
      expect(screen.getByText(/^최근 7일 루트 패키지 설치 요청 \d+건$/u)).toBeInTheDocument()
      expect(screen.getByRole('link', { name: /express/u })).toHaveAttribute('href', '/packages?selected=dec-app')

      const navigation = within(screen.getByRole('navigation', { name: '주요 메뉴' }))
      expect(navigation.getByRole('link', { name: 'Request' })).toHaveAttribute('aria-current', 'page')
    })
  })
})
