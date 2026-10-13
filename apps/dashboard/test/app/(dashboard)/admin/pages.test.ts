// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requirePermission: vi.fn(),
  listUsers: vi.fn(async () => [{ id: 'u1' }]),
  listRoles: vi.fn(async () => [{ code: 'viewer' }]),
  listRoleChanges: vi.fn(async () => [{ id: 'c1' }]),
  pool: { name: 'pool' },
}))

vi.mock('@/lib/auth/server/session', () => ({ requirePermission: mocks.requirePermission }))
vi.mock('@/lib/db', () => ({ getPool: () => mocks.pool }))
vi.mock('@/features/admin/server/users', () => ({ listUsers: mocks.listUsers }))
vi.mock('@/lib/auth/server/roles', () => ({ listRoles: mocks.listRoles }))
vi.mock('@/features/admin/server/role-changes', () => ({ listRoleChanges: mocks.listRoleChanges, ROLE_CHANGES_LIMIT: 100 }))
vi.mock('next/navigation', () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT ${url}`)
  }),
}))
vi.mock('@/features/admin', () => ({
  AdminUsersPage: (props: unknown) => ({ page: 'users', props }),
  RoleChangesPage: (props: unknown) => ({ page: 'role-changes', props }),
}))

import AdminRoute from '@/app/(dashboard)/admin/page'
import RoleChangesRoute from '@/app/(dashboard)/admin/role-changes/page'
import UsersRoute from '@/app/(dashboard)/admin/users/page'

const adminSession = { user: { id: 'me', role: 'admin' } }

describe('admin pages', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.requirePermission.mockResolvedValue(adminSession)
  })

  it('/admin checks the permission first and then opens user management', async () => {
    await expect(AdminRoute()).rejects.toThrow('REDIRECT /admin/users')
    expect(mocks.requirePermission).toHaveBeenCalledWith('user:read')
  })

  it('/admin/users loads users and roles for the signed-in admin', async () => {
    const element = (await UsersRoute()) as unknown as { props: Record<string, unknown> }

    expect(mocks.requirePermission).toHaveBeenCalledWith('user:read')
    expect(element.props).toEqual({
      users: [{ id: 'u1' }],
      roles: [{ code: 'viewer' }],
      currentUserId: 'me',
    })
    expect(mocks.listUsers).toHaveBeenCalledWith(mocks.pool)
  })

  it('/admin/role-changes requires audit:read', async () => {
    const element = (await RoleChangesRoute()) as unknown as { props: Record<string, unknown> }

    expect(mocks.requirePermission).toHaveBeenCalledWith('audit:read')
    expect(element.props).toEqual({ changes: [{ id: 'c1' }], roles: [{ code: 'viewer' }], limit: 100 })
  })

  // 권한이 없으면 requirePermission이 forbidden()으로 멈추므로 DB를 읽지 않습니다.
  it.each([
    ['/admin', AdminRoute],
    ['/admin/users', UsersRoute],
    ['/admin/role-changes', RoleChangesRoute],
  ])('%s stops before reading data when the permission check fails', async (_, Page) => {
    mocks.requirePermission.mockRejectedValue(new Error('FORBIDDEN'))

    await expect(Page()).rejects.toThrow('FORBIDDEN')
    expect(mocks.listUsers).not.toHaveBeenCalled()
    expect(mocks.listRoleChanges).not.toHaveBeenCalled()
  })
})
