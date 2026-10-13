import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NpmTokenPanel } from '@/features/settings/components/NpmTokenPanel'

const fetchMock = vi.fn()
beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock) })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('npm token settings', () => {
  it('shows the issued token only until revoke and displays expiration', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ token: 'issued-once', expiresAt: '2026-10-11T00:00:00Z' }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
    render(<NpmTokenPanel expiresAt={null} canInstall />)
    fireEvent.click(screen.getByRole('button', { name: 'npm 토큰 발급' }))
    expect(await screen.findByLabelText('발급된 npm 토큰')).toHaveValue('issued-once')
    expect(screen.getByText(/토큰 만료 시각:/u)).toHaveTextContent('2026. 10. 11.')
    expect(screen.getByText(/90일간 유효/u)).toBeInTheDocument()
    // 발급 직후에는 토큰이 채워진 설정 명령을 그대로 복사할 수 있습니다.
    expect(screen.getByText(/npm config set \/\/<Gateway주소>\/npm\/:_authToken issued-once/u)).toBeInTheDocument()
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/settings/npm-token', { method: 'POST' })
    fireEvent.click(screen.getByRole('button', { name: 'npm 토큰 폐기' }))
    expect(await screen.findByRole('status')).toHaveTextContent('폐기했습니다')
    expect(screen.queryByLabelText('발급된 npm 토큰')).not.toBeInTheDocument()
    expect(screen.queryByText(/issued-once/u)).not.toBeInTheDocument()
    expect(screen.getByText(/_authToken <발급된 토큰>/u)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'npm 토큰 폐기' })).toBeDisabled()
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/settings/npm-token', { method: 'DELETE' })
  })

  it('lets a Viewer revoke but not reissue an existing token', () => {
    render(<NpmTokenPanel expiresAt="2026-10-11T00:00:00Z" canInstall={false} />)
    expect(screen.getByRole('button', { name: 'npm 토큰 재발급' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'npm 토큰 폐기' })).toBeEnabled()
  })

  it('explains permission denial and never displays a token on failure', async () => {
    fetchMock.mockResolvedValue(Response.json({ error: 'INSTALL_NOT_PERMITTED' }, { status: 403 }))
    render(<NpmTokenPanel expiresAt={null} canInstall />)
    fireEvent.click(screen.getByRole('button', { name: 'npm 토큰 발급' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('권한과 계정 상태')
    expect(screen.queryByLabelText('발급된 npm 토큰')).not.toBeInTheDocument()
  })

  it('warns about unknown state after a network error', async () => {
    fetchMock.mockRejectedValue(new TypeError('network offline'))
    render(<NpmTokenPanel expiresAt={null} canInstall />)
    fireEvent.click(screen.getByRole('button', { name: 'npm 토큰 발급' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('변경되었을 수 있으므로')
    expect(screen.getByRole('button', { name: 'npm 토큰 발급' })).toBeEnabled()
  })
})
