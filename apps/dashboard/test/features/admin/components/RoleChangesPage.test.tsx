import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import type { RoleOption } from '@/lib/auth/common/roles'
import { RoleChangesPage } from '@/features/admin'

const roles: RoleOption[] = [
  { code: 'viewer', name: 'Viewer', description: '', rank: 10 },
  { code: 'editor', name: 'Editor', description: '', rank: 20 },
  { code: 'admin', name: 'Admin', description: '', rank: 30 },
]

afterEach(cleanup)

describe('RoleChangesPage', () => {
  it('labels changes made on the admin page and directly in the database', () => {
    render(
      <RoleChangesPage
        limit={100}
        roles={roles}
        changes={[
          {
            id: 'c1',
            changedAt: '2026-09-26T03:00:00.000Z',
            target: 'Kim_Dev',
            changedBy: 'Jump_Top',
            previousRole: 'viewer',
            newRole: 'editor',
          },
          {
            id: 'c2',
            changedAt: '2026-09-25T03:00:00.000Z',
            target: 'old@example.com',
            changedBy: null,
            previousRole: 'viewer',
            newRole: 'admin',
          },
        ]}
      />,
    )

    expect(screen.getByRole('heading', { name: '권한 변경 이력' })).toBeInTheDocument()
    expect(screen.getByText(/최근 100건/u)).toBeInTheDocument()

    const table = within(screen.getByRole('table', { name: '권한 변경 이력' }))
    const byAdmin = within(table.getByRole('row', { name: /Kim_Dev/u }))
    expect(byAdmin.getByText('Viewer → Editor')).toBeInTheDocument()
    expect(byAdmin.getByText('Jump_Top')).toBeInTheDocument()
    expect(byAdmin.getByText('Admin 페이지')).toBeInTheDocument()
    expect(byAdmin.getByText('2026. 09. 26. 12:00')).toBeInTheDocument()

    const direct = within(table.getByRole('row', { name: /old@example.com/u }))
    expect(direct.getByText('Viewer → Admin')).toBeInTheDocument()
    expect(direct.getByText('DB 직접 수정')).toBeInTheDocument()
  })

  it('shows an empty state', () => {
    render(<RoleChangesPage limit={100} roles={roles} changes={[]} />)
    expect(screen.getByText('아직 권한 변경 이력이 없습니다.')).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })
})
