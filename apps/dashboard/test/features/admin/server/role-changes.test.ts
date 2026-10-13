// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'

import type { Queryable } from '@/lib/db'
import { listRoleChanges, ROLE_CHANGES_LIMIT } from '@/features/admin/server/role-changes'

describe('listRoleChanges', () => {
  it('reads the newest changes first with a limit and keeps a missing actor as null', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          id: 'c1',
          changed_at: new Date('2026-09-26T03:00:00Z'),
          target_name: 'Kim_Dev',
          changed_by_name: null,
          previous_role: 'viewer',
          new_role: 'admin',
        },
      ],
    })

    await expect(listRoleChanges({ query } as unknown as Queryable)).resolves.toEqual([
      {
        id: 'c1',
        changedAt: '2026-09-26T03:00:00.000Z',
        target: 'Kim_Dev',
        changedBy: null,
        previousRole: 'viewer',
        newRole: 'admin',
      },
    ])
    const [sql, params] = query.mock.calls[0]
    expect(sql).toMatch(/ORDER BY c\.changed_at DESC/u)
    expect(params).toEqual([ROLE_CHANGES_LIMIT])
  })

  // 이메일은 자동값이라 현재 username을 보여 주고, 삭제된 사용자만 남아 있는 이메일을 보여 줍니다.
  it('shows current usernames and falls back to the recorded email for deleted users', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] })
    await listRoleChanges({ query } as unknown as Queryable)

    const sql = String(query.mock.calls[0][0]).replace(/\s+/gu, ' ')
    expect(sql).toContain('COALESCE(t.display_username, t.username, c.target_email) AS target_name')
    expect(sql).toContain('CASE WHEN c.changed_by_email IS NOT NULL THEN COALESCE(a.display_username, a.username, c.changed_by_email) END')
  })
})
