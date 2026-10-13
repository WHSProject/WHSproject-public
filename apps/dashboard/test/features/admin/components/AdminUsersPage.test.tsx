import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AdminUserRow } from '@/features/admin/types/users'
import type { RoleOption } from '@/lib/auth/common/roles'

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }))

import { AdminUsersPage } from '@/features/admin'

const roles: RoleOption[] = [
  { code: 'viewer', name: 'Viewer', description: '', rank: 10 },
  { code: 'developer', name: 'Developer', description: '', rank: 15 },
  { code: 'editor', name: 'Editor', description: '', rank: 20 },
  { code: 'admin', name: 'Admin', description: '', rank: 30 },
]

const user = (overrides: Partial<AdminUserRow>): AdminUserRow => ({
  id: 'id',
  displayName: 'User',
  username: 'user',
  role: 'viewer',
  banned: false,
  providers: ['credential'],
  lastLoginAt: '2026-09-25T15:30:00.000Z',
  createdAt: '2026-09-25T00:00:00.000Z',
  ...overrides,
})

const users = [
  user({ id: 'me', displayName: 'Jump_Top', role: 'admin' }),
  user({ id: 'u-viewer', displayName: 'Viewer_One', lastLoginAt: null }),
  user({ id: 'u-editor', displayName: 'Editor_One', role: 'editor', banned: true }),
  // 비밀번호를 아직 설정하지 않은 계정
  user({ id: 'u-new', displayName: 'New_One', providers: [], lastLoginAt: null }),
]

const LINK = { url: 'http://localhost:5173/reset-password?token=abc', expiresAt: '2026-09-25T16:30:00.000Z' }

const fetchMock = vi.fn()
const respond = (status: number, body?: unknown) =>
  fetchMock.mockResolvedValueOnce(new Response(body === undefined ? null : JSON.stringify(body), { status }))

function renderPage() {
  return render(<AdminUsersPage users={users} roles={roles} currentUserId="me" />)
}

const row = (tableName: string, text: string) =>
  within(within(screen.getByRole('table', { name: tableName })).getByRole('row', { name: new RegExp(text, 'u') }))

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  cleanup()
  fetchMock.mockReset()
  refresh.mockReset()
  vi.unstubAllGlobals()
})

describe('users table', () => {
  it('shows role, status, login methods and last login for each user, without emails', () => {
    renderPage()

    expect(screen.getByRole('heading', { name: '사용자 4명' })).toBeInTheDocument()
    expect(row('사용자 목록', 'Viewer_One').getByText('활성')).toBeInTheDocument()
    expect(row('사용자 목록', 'Viewer_One').getByText('-', { selector: 'td' })).toBeInTheDocument()
    expect(row('사용자 목록', 'Viewer_One').getByText('비밀번호')).toBeInTheDocument()
    expect(row('사용자 목록', 'Editor_One').getByText('비활성')).toBeInTheDocument()
    expect(row('사용자 목록', 'New_One').getByText('설정 대기')).toBeInTheDocument()
    expect(screen.queryByRole('columnheader', { name: '이메일' })).not.toBeInTheDocument()
    // 2026-09-25T15:30Z = 한국 시각 9월 26일 00:30
    expect(row('사용자 목록', 'Jump_Top').getByText(/2026\. 09\. 26\. 00:30/u)).toBeInTheDocument()
  })

  it('does not offer role or status changes on your own row', () => {
    renderPage()

    const me = row('사용자 목록', 'Jump_Top')
    expect(me.getByText('나')).toBeInTheDocument()
    expect(me.queryByRole('combobox')).not.toBeInTheDocument()
    expect(me.queryByRole('button')).not.toBeInTheDocument()
    expect(me.getByText('자기 자신의 권한은 바꿀 수 없습니다.')).toBeInTheDocument()
  })

  it('saves a promotion and refreshes the list', async () => {
    respond(200, { changed: true })
    renderPage()

    fireEvent.change(screen.getByRole('combobox', { name: 'Viewer_One 권한' }), { target: { value: 'editor' } })
    expect(screen.queryByText('강등하면 이 사용자의 로그인이 모두 끊깁니다.')).not.toBeInTheDocument()
    fireEvent.click(row('사용자 목록', 'Viewer_One').getByRole('button', { name: '저장' }))

    expect(await screen.findByRole('status')).toHaveTextContent('Viewer_One 권한 변경: Viewer → Editor')
    expect(fetchMock).toHaveBeenCalledWith('/api/admin/users/u-viewer/role', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'editor' }),
    })
    expect(refresh).toHaveBeenCalledOnce()
  })

  it('warns that a demotion signs the user out and can be cancelled', () => {
    renderPage()

    const select = screen.getByRole('combobox', { name: 'New_One 권한' })
    fireEvent.change(select, { target: { value: 'admin' } })
    expect(screen.queryByText('강등하면 이 사용자의 로그인이 모두 끊깁니다.')).not.toBeInTheDocument()

    fireEvent.change(screen.getByRole('combobox', { name: 'Editor_One 권한' }), { target: { value: 'viewer' } })
    expect(screen.getByText('강등하면 이 사용자의 로그인이 모두 끊깁니다.')).toBeInTheDocument()

    fireEvent.click(row('사용자 목록', 'Editor_One').getByRole('button', { name: '취소' }))
    expect(screen.getByRole('combobox', { name: 'Editor_One 권한' })).toHaveValue('editor')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('asks for confirmation before deactivating and shows the server rule on failure', async () => {
    respond(409, { error: 'LAST_ADMIN' })
    renderPage()

    fireEvent.click(screen.getByRole('button', { name: 'Viewer_One 비활성화' }))
    expect(screen.getByText('로그인이 모두 끊기고 다시 로그인할 수 없습니다.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '비활성화 확인' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('마지막 Admin은 강등하거나 비활성화할 수 없습니다.')
    expect(fetchMock).toHaveBeenCalledWith('/api/admin/users/u-viewer/ban', { method: 'PUT', headers: undefined, body: undefined })
    expect(refresh).not.toHaveBeenCalled()
  })

  it('reactivates a deactivated user', async () => {
    respond(200, { changed: true })
    renderPage()

    fireEvent.click(row('사용자 목록', 'Editor_One').getByRole('button', { name: '활성화' }))

    expect(await screen.findByRole('status')).toHaveTextContent('Editor_One 활성화했습니다.')
    expect(fetchMock).toHaveBeenCalledWith('/api/admin/users/u-editor/ban', { method: 'DELETE', headers: undefined, body: undefined })
  })
})

describe('password links', () => {
  it('issues a reset link for a user with a password and shows it without refreshing', async () => {
    respond(201, LINK)
    renderPage()

    fireEvent.click(screen.getByRole('button', { name: 'Viewer_One 재설정 링크' }))

    const notice = await screen.findByRole('status')
    expect(notice).toHaveTextContent('Viewer_One 비밀번호 재설정 링크를 발급했습니다.')
    expect(within(notice).getByRole('textbox', { name: '비밀번호 설정 링크' })).toHaveValue(LINK.url)
    expect(fetchMock).toHaveBeenCalledWith('/api/admin/users/u-viewer/password-link', {
      method: 'POST',
      headers: undefined,
      body: undefined,
    })
    expect(refresh).not.toHaveBeenCalled()
  })

  it('offers a new setup link for an account still waiting for its password', () => {
    renderPage()

    expect(screen.getByRole('button', { name: 'New_One 설정 링크 재발급' })).toBeInTheDocument()
  })

  it('selects the link for manual copying when the clipboard is unavailable (http intranet)', async () => {
    respond(201, LINK)
    vi.stubGlobal('navigator', { clipboard: undefined })
    renderPage()

    fireEvent.click(screen.getByRole('button', { name: 'Viewer_One 재설정 링크' }))
    const notice = await screen.findByRole('status')
    fireEvent.click(within(notice).getByRole('button', { name: '복사' }))

    expect(await within(notice).findByText(/자동으로 복사하지 못했습니다/u)).toBeInTheDocument()
  })

  it('copies the link when the clipboard is available', async () => {
    respond(201, LINK)
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    renderPage()

    fireEvent.click(screen.getByRole('button', { name: 'Viewer_One 재설정 링크' }))
    const notice = await screen.findByRole('status')
    fireEvent.click(within(notice).getByRole('button', { name: '복사' }))

    expect(await within(notice).findByRole('button', { name: '복사됨' })).toBeInTheDocument()
    expect(writeText).toHaveBeenCalledWith(LINK.url)
  })
})

describe('create account', () => {
  it('creates an account with the chosen role, shows the setup link and refreshes the list', async () => {
    respond(201, { id: 'u-created', ...LINK })
    renderPage()

    expect(screen.getByRole('combobox', { name: '권한' })).toHaveValue('viewer')
    fireEvent.change(screen.getByLabelText('username'), { target: { value: ' Kim_Dev ' } })
    fireEvent.change(screen.getByRole('combobox', { name: '권한' }), { target: { value: 'developer' } })
    fireEvent.click(screen.getByRole('button', { name: '계정 만들기' }))

    const notice = await screen.findByRole('status')
    expect(notice).toHaveTextContent('Kim_Dev 계정을 만들었습니다.')
    expect(within(notice).getByRole('textbox', { name: '비밀번호 설정 링크' })).toHaveValue(LINK.url)
    expect(fetchMock).toHaveBeenCalledWith('/api/admin/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'Kim_Dev', role: 'developer' }),
    })
    expect(screen.getByLabelText('username')).toHaveValue('')
    expect(screen.getByRole('combobox', { name: '권한' })).toHaveValue('viewer')
    expect(refresh).toHaveBeenCalledOnce()
  })

  it('checks the username rule before sending', () => {
    renderPage()

    fireEvent.change(screen.getByLabelText('username'), { target: { value: 'kim.dev' } })
    fireEvent.click(screen.getByRole('button', { name: '계정 만들기' }))

    expect(screen.getByText('username은 3~30자의 영문, 숫자, _만 사용할 수 있습니다.')).toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('shows why the account was refused', async () => {
    respond(409, { error: 'USERNAME_TAKEN' })
    renderPage()

    fireEvent.change(screen.getByLabelText('username'), { target: { value: 'viewer_one' } })
    fireEvent.click(screen.getByRole('button', { name: '계정 만들기' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('이미 있는 username입니다.')
    expect(refresh).not.toHaveBeenCalled()
  })
})
