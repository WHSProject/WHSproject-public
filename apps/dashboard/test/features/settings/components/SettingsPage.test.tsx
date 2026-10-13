import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { SessionRow } from '@/features/settings/types/account'

const { authClient, hardNavigate, refresh } = vi.hoisted(() => ({
  authClient: { updateUser: vi.fn(), changePassword: vi.fn(), revokeOtherSessions: vi.fn() },
  hardNavigate: vi.fn(),
  refresh: vi.fn(),
}))

vi.mock('@/lib/auth/client', () => ({ authClient }))
vi.mock('@/lib/navigation', () => ({ hardNavigate }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }))

import { SettingsPage, type SettingsProfile } from '@/features/settings'

const profile: SettingsProfile = {
  displayName: 'Jump_Top',
  roleName: 'Editor',
  providers: ['credential'],
  createdAt: '2026-09-24T15:30:00.000Z',
}

const CHROME_WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36'
const SAFARI_IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'

const sessions: SessionRow[] = [
  { id: 'cur', userAgent: CHROME_WINDOWS, ipAddress: '10.0.0.1', createdAt: '2026-09-26T01:00:00.000Z', expiresAt: '2026-10-03T01:00:00.000Z', current: true },
  { id: 'phone', userAgent: SAFARI_IPHONE, ipAddress: null, createdAt: '2026-09-25T01:00:00.000Z', expiresAt: '2026-10-02T01:00:00.000Z', current: false },
]

const ok = { data: {}, error: null }
const fail = (status: number, code?: string) => ({ data: null, error: { status, code } })
const fetchMock = vi.fn()

// 응답이 오기 전 상태를 확인하려고, 끝나는 시점을 테스트가 정하는 요청입니다.
function deferred<T>() {
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((_resolve, rejectPromise) => {
    reject = rejectPromise
  })
  return { promise, reject }
}
// Better Auth 클라이언트는 네트워크 오류를 { error }가 아니라 예외로 던집니다.
const offline = () => new TypeError('Failed to fetch')

function renderPage(overrides: Partial<SettingsProfile> = {}, rows = sessions) {
  return render(<SettingsPage profile={{ ...profile, ...overrides }} sessions={rows} />)
}

const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } })

beforeEach(() => vi.stubGlobal('fetch', fetchMock))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe('profile', () => {
  // 이메일은 로그인에 쓰지 않는 자동값이라 보여 주지 않습니다.
  it('shows my information read-only with the role changed only by an Admin, without email', () => {
    renderPage()

    expect(screen.getByRole('heading', { name: '개인 설정' })).toBeInTheDocument()
    expect(screen.queryByText('이메일')).not.toBeInTheDocument()
    expect(screen.queryByText(/인증 (완료|전)/u)).not.toBeInTheDocument()
    expect(screen.getByText('Editor')).toBeInTheDocument()
    expect(screen.getByText('권한은 Admin이 바꿉니다.')).toBeInTheDocument()
    expect(screen.getByText('비밀번호')).toBeInTheDocument()
    // 2026-09-24T15:30Z = 한국 시각 9월 25일 00:30
    expect(screen.getByText('2026. 09. 25. 00:30')).toBeInTheDocument()
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
  })
})

describe('username', () => {
  it('sends the same value as username and display username, then refreshes', async () => {
    authClient.updateUser.mockResolvedValue(ok)
    renderPage()

    type('새 username', ' New_Name ')
    fireEvent.click(screen.getByRole('button', { name: 'username 변경' }))

    expect(await screen.findByRole('status')).toHaveTextContent('username을 New_Name(으)로 바꿨습니다.')
    expect(authClient.updateUser).toHaveBeenCalledWith({ username: 'New_Name', displayUsername: 'New_Name' })
    expect(refresh).toHaveBeenCalledOnce()
  })

  it('checks the rule and skips an unchanged value without calling the server', async () => {
    renderPage()

    for (const invalid of ['a.b', '정환희']) {
      type('새 username', invalid)
      fireEvent.click(screen.getByRole('button', { name: 'username 변경' }))
      expect(screen.getByLabelText('새 username')).toBeInvalid()
      expect(screen.getByLabelText('새 username')).toHaveAccessibleDescription(/username은 3~30자의 영문, 숫자, _만/u)
    }

    type('새 username', 'Jump_Top')
    fireEvent.click(screen.getByRole('button', { name: 'username 변경' }))
    expect(await screen.findByRole('status')).toHaveTextContent('현재 username과 같습니다.')
    expect(authClient.updateUser).not.toHaveBeenCalled()
  })

  it('tells when the username is taken', async () => {
    authClient.updateUser.mockResolvedValue(fail(400, 'USERNAME_IS_ALREADY_TAKEN'))
    renderPage()

    type('새 username', 'Taken_1')
    fireEvent.click(screen.getByRole('button', { name: 'username 변경' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('이미 사용 중인 username입니다.')
    expect(refresh).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'username 변경' })).toBeEnabled()
  })

  it('restores the button without claiming success when no response arrives, then allows a retry', async () => {
    const request = deferred<typeof ok>()
    authClient.updateUser.mockReturnValueOnce(request.promise).mockResolvedValueOnce(ok)
    renderPage()

    type('새 username', 'New_Name')
    fireEvent.click(screen.getByRole('button', { name: 'username 변경' }))
    expect(screen.getByRole('button', { name: '변경 중…' })).toBeDisabled()

    request.reject(offline())
    expect(await screen.findByRole('alert')).toHaveTextContent('서버 응답을 받지 못했습니다. 화면을 새로고침해 결과를 확인한 뒤 다시 시도하세요.')
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(refresh).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'username 변경' }))
    expect(await screen.findByRole('status')).toHaveTextContent('username을 New_Name(으)로 바꿨습니다.')
    expect(authClient.updateUser).toHaveBeenCalledTimes(2)
    expect(refresh).toHaveBeenCalledOnce()
  })
})

describe('password', () => {
  it('warns that every device is signed out, changes the password and goes to login', async () => {
    authClient.changePassword.mockResolvedValue(ok)
    renderPage()

    expect(screen.getByText(/이 기기를 포함한 모든 기기에서 로그아웃되고/u)).toBeInTheDocument()
    type('현재 비밀번호', 'old-password-1')
    type('새 비밀번호', 'new-password-2')
    type('새 비밀번호 확인', 'new-password-2')
    fireEvent.click(screen.getByRole('button', { name: '비밀번호 변경' }))

    await vi.waitFor(() => expect(hardNavigate).toHaveBeenCalledWith('/login?notice=password-changed'))
    // 다른 기기 로그아웃 여부는 서버가 강제하므로 보내지 않습니다.
    expect(authClient.changePassword).toHaveBeenCalledWith({ currentPassword: 'old-password-1', newPassword: 'new-password-2' })
  })

  it('checks the new password before calling the server', () => {
    renderPage()

    type('현재 비밀번호', 'same-password-1')
    type('새 비밀번호', 'same-password-1')
    type('새 비밀번호 확인', 'different-2')
    fireEvent.click(screen.getByRole('button', { name: '비밀번호 변경' }))

    expect(screen.getByLabelText('새 비밀번호')).toHaveAccessibleDescription('새 비밀번호가 현재 비밀번호와 같습니다.')
    expect(screen.getByLabelText('새 비밀번호 확인')).toHaveAccessibleDescription('비밀번호가 일치하지 않습니다.')
    expect(authClient.changePassword).not.toHaveBeenCalled()
  })

  it('keeps the user on the page when the current password is wrong', async () => {
    authClient.changePassword.mockResolvedValue(fail(400, 'INVALID_PASSWORD'))
    renderPage()

    type('현재 비밀번호', 'wrong-password')
    type('새 비밀번호', 'new-password-2')
    type('새 비밀번호 확인', 'new-password-2')
    fireEvent.click(screen.getByRole('button', { name: '비밀번호 변경' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('현재 비밀번호가 올바르지 않습니다.')
    expect(hardNavigate).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: '비밀번호 변경' })).toBeEnabled()
  })

  it('does not go to login when no response arrives, and allows a retry', async () => {
    const request = deferred<typeof ok>()
    authClient.changePassword.mockReturnValueOnce(request.promise).mockResolvedValueOnce(ok)
    renderPage()

    type('현재 비밀번호', 'old-password-1')
    type('새 비밀번호', 'new-password-2')
    type('새 비밀번호 확인', 'new-password-2')
    fireEvent.click(screen.getByRole('button', { name: '비밀번호 변경' }))
    expect(screen.getByRole('button', { name: '변경 중…' })).toBeDisabled()

    request.reject(offline())
    expect(await screen.findByRole('alert')).toHaveTextContent('서버 응답을 받지 못했습니다.')
    expect(hardNavigate).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '비밀번호 변경' }))
    await vi.waitFor(() => expect(hardNavigate).toHaveBeenCalledWith('/login?notice=password-changed'))
    expect(authClient.changePassword).toHaveBeenCalledTimes(2)
  })

  // 비밀번호 수단이 없는 계정(예전 Google 가입 등)은 Admin에게 안내합니다.
  it('hides the form for an account without a password and points to an Admin', () => {
    renderPage({ providers: ['google'] })
    expect(screen.getByText('비밀번호로 로그인하지 않는 계정입니다. 비밀번호 설정은 Admin에게 문의하세요.')).toBeInTheDocument()
    expect(screen.queryByLabelText('현재 비밀번호')).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: '로그인 수단 관리' })).not.toBeInTheDocument()
  })

  it('shows no login methods link for a password account either', () => {
    renderPage()
    expect(screen.queryByRole('link', { name: '로그인 수단 관리' })).not.toBeInTheDocument()
  })
})

describe('sessions', () => {
  const table = () => within(screen.getByRole('table', { name: '로그인된 기기' }))

  it('lists devices with the current one marked and not revocable', () => {
    renderPage()

    const current = within(table().getByRole('row', { name: /Chrome · Windows/u }))
    expect(current.getByText('현재 기기')).toBeInTheDocument()
    expect(current.queryByRole('button')).not.toBeInTheDocument()
    expect(table().getByRole('row', { name: /Safari · iOS/u })).toBeInTheDocument()
    expect(screen.getByText('지금 로그인되어 있는 기기 2대')).toBeInTheDocument()
  })

  it('shows a readable IP for local, unknown and remote devices', () => {
    renderPage({}, [{ ...sessions[0]!, ipAddress: '0000:0000:0000:0000:0000:0000:0000:0000' }, sessions[1]!])

    expect(within(table().getByRole('row', { name: /Chrome · Windows/u })).getByText('로컬 접속')).toBeInTheDocument()
    expect(within(table().getByRole('row', { name: /Safari · iOS/u })).getByText('-')).toBeInTheDocument()
    cleanup()

    renderPage()
    expect(within(table().getByRole('row', { name: /Chrome · Windows/u })).getByText('10.0.0.1')).toBeInTheDocument()
  })

  it('signs out one other device by id and refreshes', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }))
    renderPage()

    fireEvent.click(screen.getByRole('button', { name: 'Safari · iOS 로그아웃' }))

    expect(await screen.findByRole('status')).toHaveTextContent('Safari · iOS 기기를 로그아웃했습니다.')
    expect(fetchMock).toHaveBeenCalledWith('/api/settings/sessions/phone', { method: 'DELETE' })
    expect(refresh).toHaveBeenCalledOnce()
  })

  it('signs out all other devices', async () => {
    authClient.revokeOtherSessions.mockResolvedValue(ok)
    renderPage()

    fireEvent.click(screen.getByRole('button', { name: '다른 기기 모두 로그아웃' }))

    expect(await screen.findByRole('status')).toHaveTextContent('다른 기기를 모두 로그아웃했습니다.')
    expect(refresh).toHaveBeenCalledOnce()
  })

  it('explains a failed bulk sign-out (no response, HTTP error) and allows a retry', async () => {
    const request = deferred<typeof ok>()
    authClient.revokeOtherSessions.mockReturnValueOnce(request.promise).mockResolvedValueOnce(fail(429)).mockResolvedValueOnce(ok)
    renderPage()
    const bulk = () => screen.getByRole('button', { name: '다른 기기 모두 로그아웃' })

    fireEvent.click(bulk())
    expect(bulk()).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Safari · iOS 로그아웃' })).toBeDisabled()

    request.reject(offline())
    expect(await screen.findByRole('alert')).toHaveTextContent('서버 응답을 받지 못했습니다.')
    expect(bulk()).toBeEnabled()

    fireEvent.click(bulk())
    await vi.waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('요청이 너무 많습니다.'))
    expect(bulk()).toBeEnabled()
    expect(refresh).not.toHaveBeenCalled()

    fireEvent.click(bulk())
    expect(await screen.findByRole('status')).toHaveTextContent('다른 기기를 모두 로그아웃했습니다.')
    expect(refresh).toHaveBeenCalledOnce()
  })

  it('shows why a device could not be signed out and hides the bulk button when alone', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ error: 'SESSION_NOT_FOUND' }, { status: 404 }))
    renderPage()

    fireEvent.click(screen.getByRole('button', { name: 'Safari · iOS 로그아웃' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('이미 로그아웃된 기기입니다.')
    cleanup()

    renderPage({}, [sessions[0]])
    expect(screen.queryByRole('button', { name: '다른 기기 모두 로그아웃' })).not.toBeInTheDocument()
  })
})
