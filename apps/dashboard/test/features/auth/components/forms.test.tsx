import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { authClient, hardNavigate } = vi.hoisted(() => ({
  authClient: {
    signIn: { email: vi.fn(), username: vi.fn() },
    resetPassword: vi.fn(),
  },
  hardNavigate: vi.fn(),
}))

vi.mock('@/lib/auth/client', () => ({ authClient }))
vi.mock('@/lib/navigation', () => ({ hardNavigate }))

import { LoginPage, ResetPasswordPage } from '@/features/auth'

const ok = { data: {}, error: null }
const fail = (status: number, code?: string) => ({ data: null, error: { status, code } })

function type(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } })
}

function submit(name: string) {
  fireEvent.click(screen.getByRole('button', { name }))
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('LoginPage', () => {
  it('signs in by username (trimmed) and returns to the callback page', async () => {
    authClient.signIn.username.mockResolvedValue(ok)
    render(<LoginPage callbackURL="/requests" />)

    type('username', ' Jump_Top ')
    type('비밀번호', 'correct-horse-9')
    submit('로그인')

    await vi.waitFor(() => expect(hardNavigate).toHaveBeenCalledWith('/requests'))
    expect(authClient.signIn.username).toHaveBeenCalledWith({ username: 'Jump_Top', password: 'correct-horse-9' })
  })

  // 이메일 로그인은 없습니다. @가 있어도 username 로그인으로 보냅니다(서버가 규칙에 맞지 않아 거절).
  it('never signs in by email, even when the value has @', async () => {
    authClient.signIn.username.mockResolvedValue(fail(400, 'INVALID_USERNAME'))
    render(<LoginPage callbackURL="/" />)

    type('username', 'me@example.com')
    type('비밀번호', 'correct-horse-9')
    submit('로그인')

    expect(await screen.findByRole('alert')).toHaveTextContent('username이나 비밀번호가 올바르지 않습니다.')
    expect(authClient.signIn.username).toHaveBeenCalledWith({ username: 'me@example.com', password: 'correct-horse-9' })
    expect(authClient.signIn.email).not.toHaveBeenCalled()
  })

  it('shows one message for wrong credentials', async () => {
    authClient.signIn.username.mockResolvedValue(fail(401, 'INVALID_USERNAME_OR_PASSWORD'))
    render(<LoginPage callbackURL="/" />)

    type('username', 'JUMP_TOP')
    type('비밀번호', 'wrong-pass')
    submit('로그인')

    expect(await screen.findByRole('alert')).toHaveTextContent('username이나 비밀번호가 올바르지 않습니다.')
    expect(authClient.signIn.username).toHaveBeenCalledWith({ username: 'JUMP_TOP', password: 'wrong-pass' })
    expect(hardNavigate).not.toHaveBeenCalled()
  })

  it('shows the password-changed notice above the form', () => {
    render(<LoginPage callbackURL="/" notice="password-changed" />)
    expect(screen.getByRole('status')).toHaveTextContent('비밀번호를 변경했습니다.')
  })

  it('has no sign-up or forgot-password link and no email field, and tells to ask an admin', () => {
    render(<LoginPage callbackURL="/" />)
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
    expect(screen.queryByLabelText(/이메일/u)).not.toBeInTheDocument()
    expect(screen.getByText('비밀번호를 잊으셨다면 관리자에게 문의하세요.')).toBeInTheDocument()
  })
})

describe('ResetPasswordPage', () => {
  it('shows an expired link message without a token and points to an Admin', () => {
    render(<ResetPasswordPage error="INVALID_TOKEN" />)
    expect(screen.getByRole('alert')).toHaveTextContent('만료되었거나 이미 사용되었습니다. Admin에게 새 링크를 요청하세요.')
    expect(screen.queryByRole('link', { name: '재설정 메일 다시 받기' })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: '로그인으로 돌아가기' })).toHaveAttribute('href', '/login')
  })

  it('resets the password with the token and points to login', async () => {
    authClient.resetPassword.mockResolvedValue(ok)
    render(<ResetPasswordPage token="tok-123" />)

    type('새 비밀번호', 'brand-new-pass-456')
    type('새 비밀번호 확인', 'brand-new-pass-456')
    submit('비밀번호 저장')

    expect(await screen.findByRole('status')).toHaveTextContent('비밀번호를 저장했습니다. 다른 기기의 로그인은 모두 해제')
    expect(authClient.resetPassword).toHaveBeenCalledWith({ newPassword: 'brand-new-pass-456', token: 'tok-123' })
    expect(screen.getByRole('link', { name: '로그인하기' })).toHaveAttribute('href', '/login')
  })

  it('tells to ask an Admin for a new link when the token was already used', async () => {
    authClient.resetPassword.mockResolvedValue(fail(400, 'INVALID_TOKEN'))
    render(<ResetPasswordPage token="used" />)

    type('새 비밀번호', 'brand-new-pass-456')
    type('새 비밀번호 확인', 'brand-new-pass-456')
    submit('비밀번호 저장')

    expect(await screen.findByRole('alert')).toHaveTextContent('Admin에게 새 링크를 요청하세요.')
    expect(screen.queryByRole('link', { name: '재설정 메일 다시 받기' })).not.toBeInTheDocument()
  })

  it('stops when the new password confirmation does not match', () => {
    render(<ResetPasswordPage token="tok-123" />)

    type('새 비밀번호', 'brand-new-pass-456')
    type('새 비밀번호 확인', 'brand-new-pass-457')
    submit('비밀번호 저장')

    expect(screen.getByLabelText('새 비밀번호 확인')).toHaveAccessibleDescription('비밀번호가 일치하지 않습니다.')
    expect(authClient.resetPassword).not.toHaveBeenCalled()
  })
})

