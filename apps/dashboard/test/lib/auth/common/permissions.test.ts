// @vitest-environment node
import { describe, expect, it } from 'vitest'

import { DEFAULT_ROLE, hasPermission, type Permission, roles, type RoleCode } from '@/lib/auth/common/permissions'

type Check = [resource: string, action: string, allowed: RoleCode[]]

// 설계 문서의 권한 매트릭스
const matrix: Check[] = [
  ['dashboard', 'read', ['viewer', 'developer', 'editor', 'admin']],
  ['decision', 'read', ['viewer', 'developer', 'editor', 'admin']],
  ['policy', 'read', ['viewer', 'developer', 'editor', 'admin']],
  ['policy', 'draft', ['editor', 'admin']],
  ['policy', 'publish', ['editor', 'admin']],
  ['llm_judgment', 'read', ['editor', 'admin']],
  ['predicate', 'manage', ['admin']],
  ['user', 'read', ['admin']],
  ['user', 'manage', ['admin']],
  ['audit', 'read', ['admin']],
  // Gateway를 거친 npm 설치. Viewer만 설치할 수 없습니다.
  ['package', 'install', ['developer', 'editor', 'admin']],
]

const roleCodes = Object.keys(roles) as RoleCode[]

function can(role: RoleCode, resource: string, action: string) {
  return roles[role].authorize({ [resource]: [action] }).success
}

describe('roles', () => {
  it('defines viewer, developer, editor, admin with viewer as the default', () => {
    expect(roleCodes).toEqual(['viewer', 'developer', 'editor', 'admin'])
    expect(DEFAULT_ROLE).toBe('viewer')
  })

  it.each(matrix)('%s:%s is allowed only for %j', (resource, action, allowed) => {
    for (const role of roleCodes) {
      expect(can(role, resource, action), role).toBe(allowed.includes(role))
    }
  })

  // 사용자 관리는 Admin API(/api/admin/*)로만 합니다. 플러그인 API는 어떤 역할에도 열지 않습니다.
  it('grants no admin plugin API to any role', () => {
    const pluginUserActions = [
      'create',
      'list',
      'get',
      'ban',
      'set-role',
      'delete',
      'impersonate',
      'impersonate-admins',
      'set-password',
      'set-email',
      'update',
    ]
    for (const role of roleCodes) {
      for (const action of pluginUserActions) expect(can(role, 'user', action), `${role} user:${action}`).toBe(false)
      for (const action of ['list', 'revoke', 'delete']) expect(can(role, 'session', action), `${role} session:${action}`).toBe(false)
    }
  })
})

describe('hasPermission', () => {
  it.each(matrix)('%s:%s follows the same matrix for %j', (resource, action, allowed) => {
    for (const role of roleCodes) {
      expect(hasPermission(role, `${resource}:${action}` as Permission), role).toBe(allowed.includes(role))
    }
  })

  it.each([null, undefined, '', 'superuser', 'toString', 'editor,admin'])('denies unknown role %j', (role) => {
    expect(hasPermission(role, 'dashboard:read')).toBe(false)
  })

  it('only accepts defined permission names at compile time', () => {
    const valid: Permission = 'policy:draft'
    // @ts-expect-error 정의되지 않은 action
    const unknownAction: Permission = 'policy:delete'
    // @ts-expect-error 정의되지 않은 resource
    const unknownResource: Permission = 'billing:read'
    expect([valid, unknownAction, unknownResource]).toHaveLength(3)
  })
})
