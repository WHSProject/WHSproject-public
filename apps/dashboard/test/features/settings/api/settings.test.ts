// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'

import { revokeSession, SETTINGS_API } from '@/features/settings/api/settings'
import { SETTINGS_REQUEST_FAILED_MESSAGE } from '@/features/settings/model/errors'

describe('settings API client', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('encodes the session id and reports success, API errors and network failures', async () => {
    expect(SETTINGS_API.session('a/b')).toBe('/api/settings/sessions/a%2Fb')
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }))
    await expect(revokeSession('s1')).resolves.toEqual({ ok: true })

    fetchMock.mockResolvedValueOnce(Response.json({ error: 'unauthorized' }, { status: 401 }))
    await expect(revokeSession('s1')).resolves.toEqual({ ok: false, message: '로그인이 만료되었습니다. 다시 로그인하세요.' })

    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    await expect(revokeSession('s1')).resolves.toEqual({ ok: false, message: SETTINGS_REQUEST_FAILED_MESSAGE })
  })
})
