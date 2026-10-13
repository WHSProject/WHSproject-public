// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireSession: vi.fn(),
  listLoginMethods: vi.fn(async () => ['credential']),
  listUserSessions: vi.fn(async () => [{ id: 's1', current: true }]),
  listRoles: vi.fn(async () => [{ code: 'editor', name: 'Editor', description: '', rank: 20 }]),
  pool: { name: 'pool' },
}))

vi.mock('@/lib/auth/server/session', () => ({ requireSession: mocks.requireSession }))
vi.mock('@/lib/db', () => ({ getPool: () => mocks.pool }))
vi.mock('@/features/settings/server/account', () => ({
  listLoginMethods: mocks.listLoginMethods,
  listUserSessions: mocks.listUserSessions,
}))
vi.mock('@/features/settings/server/npm-token', () => ({ npmTokenExpiresAt: vi.fn(async () => null) }))
vi.mock('@/lib/auth/server/roles', () => ({ listRoles: mocks.listRoles }))
vi.mock('@/features/settings', () => ({ SettingsPage: (props: unknown) => ({ page: 'settings', props }) }))

import SettingsRoute from '@/app/(dashboard)/settings/page'

describe('/settings', () => {
  beforeEach(() => vi.clearAllMocks())

  it('shows only the signed-in user’s own profile and sessions', async () => {
    mocks.requireSession.mockResolvedValue({
      user: {
        id: 'u1',
        name: 'Jump_Top',
        username: 'jump_top',
        displayUsername: 'Jump_Top',
        email: 'me@example.com',
        role: 'editor',
        emailVerified: true,
        createdAt: new Date('2026-09-25T00:00:00Z'),
      },
      session: { id: 's1' },
    })

    const element = (await SettingsRoute()) as unknown as { props: Record<string, unknown> }
    expect(element.props).toEqual({
      profile: {
        displayName: 'Jump_Top',
        roleName: 'Editor',
        providers: ['credential'],
        createdAt: '2026-09-25T00:00:00.000Z',
      },
      sessions: [{ id: 's1', current: true }],
      npmTokenExpiresAt: null,
      canInstall: true,
    })
    expect(mocks.listLoginMethods).toHaveBeenCalledWith(mocks.pool, 'u1')
    expect(mocks.listUserSessions).toHaveBeenCalledWith(mocks.pool, 'u1', 's1')
  })

  it('stops before reading data when signed out', async () => {
    mocks.requireSession.mockRejectedValue(new Error('REDIRECT /login'))

    await expect(SettingsRoute()).rejects.toThrow('REDIRECT /login')
    expect(mocks.listUserSessions).not.toHaveBeenCalled()
  })
})
